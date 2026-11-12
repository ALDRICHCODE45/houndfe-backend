/**
 * human-intervention / unit 11 (T11d) — the live conversation notices through
 * the REAL notify consumer against PostgreSQL (proposal §5.1, §4.6):
 *
 *   CONVERSATION_CUSTOMER_MESSAGE  only the attendee, in-app only
 *   CONVERSATION_UNANSWERED 5 min  the attendee, in-app only
 *   CONVERSATION_UNANSWERED 15 min the people who hold
 *                                  update:ChatbotRequestAssignment, in-app only
 *
 * No email job is ever written for them (§5.1 "Correo: No"), and a re-run of
 * the same `dedupKey` adds nothing.
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../test/integration/reset-db';
import type { PrismaService } from '../shared/prisma/prisma.service';
import {
  noticeText,
  type ChatbotRequestNotice,
} from './domain/chatbot-request-notice';
import type { NotificationEventsPort } from './domain/notification-events.port';
import {
  enqueueNotice,
  type OutboxClient,
} from './infrastructure/chatbot-request-notice.writer';
import { ChatbotRequestNotifyConsumer } from './outbox/chatbot-request-notify.consumer';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('live conversation notices: real consumer (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const root = prisma as unknown as PrismaService;
  const events: NotificationEventsPort = {
    publishCreated: () => Promise.resolve(),
  };
  const consumer = new ChatbotRequestNotifyConsumer(
    root,
    events,
    () => new Date(),
    25,
    3,
  );
  const tenants: string[] = [];
  const userIds: string[] = [];
  let tenantId: string;
  let attendee: string;
  let manager: string;
  let outsider: string;
  let requestId: string;

  async function drain(): Promise<void> {
    for (let i = 0; i < 200 && (await consumer.processOne()); i++) {
      /* keep going */
    }
  }
  const notices = (type: string) =>
    prisma.notification.findMany({
      where: { tenantId, requestId, type },
      orderBy: { createdAt: 'asc' },
    });
  const emailJobs = () =>
    prisma.outboxEvent.count({
      where: { tenantId, eventType: 'chatbot_request.email' },
    });
  const enqueue = (notice: ChatbotRequestNotice) =>
    enqueueNotice(prisma as unknown as OutboxClient, tenantId, notice);
  const base = (over: Partial<ChatbotRequestNotice>): ChatbotRequestNotice => ({
    type: 'CONVERSATION_UNANSWERED',
    requestId,
    folio: 7,
    subtype: 'TALK_TO_HUMAN',
    dedupKey: `t:${randomUUID()}`,
    ...over,
  });

  async function user(name: string, grants: Array<[string, string]>) {
    const id = randomUUID();
    userIds.push(id);
    await prisma.user.create({
      data: {
        id,
        email: `${name}-${id}@lc.test`,
        hashedPassword: 'x',
        name,
      },
    });
    if (grants.length > 0) {
      const permissions = await Promise.all(
        grants.map(([subject, action]) =>
          prisma.permission.upsert({
            where: { subject_action: { subject, action } },
            update: {},
            create: { subject, action },
          }),
        ),
      );
      const role = await prisma.role.create({
        data: {
          tenantId,
          name: `${name} ${id}`,
          permissions: {
            create: permissions.map((p) => ({ permissionId: p.id })),
          },
        },
      });
      await prisma.tenantMembership.create({
        data: { userId: id, tenantId, roleId: role.id },
      });
    }
    return id;
  }

  beforeAll(async () => {
    tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Aviso', slug: `lcn-${tenantId}` },
    });
    attendee = await user('attendee', [
      ['ChatbotRequest', 'read'],
      ['ChatbotRequest', 'update'],
    ]);
    manager = await user('manager', [
      ['ChatbotRequest', 'read'],
      ['ChatbotRequestAssignment', 'update'],
    ]);
    outsider = await user('outsider', [['ChatbotRequest', 'read']]);
    const request = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: 7,
        kind: 'CONVERSATION',
        subtype: 'TALK_TO_HUMAN',
        customerKey: '5255830001',
        conversationRef: 'wa:5255830001',
        summary: 'Quiere hablar',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      },
    });
    requestId = request.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('"el cliente escribió" reaches only the attendee, with no email and no customer data', async () => {
    await enqueue(
      base({
        type: 'CONVERSATION_CUSTOMER_MESSAGE',
        recipientUserId: attendee,
        dedupKey: `wrote:${randomUUID()}`,
      }),
    );
    await drain();
    const rows = await notices('CONVERSATION_CUSTOMER_MESSAGE');
    expect(rows.map((r) => r.userId)).toEqual([attendee]);
    expect(rows[0].payload).toEqual({ folio: 7, subtype: 'TALK_TO_HUMAN' });
    expect(await emailJobs()).toBe(0);
    expect(
      noticeText('CONVERSATION_CUSTOMER_MESSAGE', rows[0].payload as never),
    ).toEqual({
      title: 'El cliente escribió',
      body: 'Conversación en vivo · S-000007',
    });
  });

  it('5 minutes unanswered reaches the attendee only; 15 minutes reaches the people with update:ChatbotRequestAssignment only; neither sends email; the same dedupKey adds nothing', async () => {
    const five = base({
      level: 5,
      recipientUserId: attendee,
      dedupKey: `unanswered:5:${randomUUID()}`,
    });
    const fifteen = base({
      level: 15,
      dedupKey: `unanswered:15:${randomUUID()}`,
    });
    await enqueue(five);
    await enqueue(fifteen);
    await enqueue(five);
    await enqueue(fifteen);
    await drain();
    const rows = await notices('CONVERSATION_UNANSWERED');
    const byLevel = (level: number) =>
      rows.filter((r) => (r.payload as { level?: number }).level === level);
    expect(byLevel(5).map((r) => r.userId)).toEqual([attendee]);
    expect(byLevel(15).map((r) => r.userId)).toEqual([manager]);
    expect(rows.some((r) => r.userId === outsider)).toBe(false);
    expect(rows).toHaveLength(2);
    expect(await emailJobs()).toBe(0);
    expect(
      noticeText('CONVERSATION_UNANSWERED', rows[0].payload as never).title,
    ).toBe('Cliente esperando respuesta (5 min)');
    expect(
      noticeText('CONVERSATION_UNANSWERED', rows[1].payload as never).title,
    ).toBe('Cliente esperando respuesta (15 min)');
  });

  it('a level-5 notice without a recipient writes nothing', async () => {
    const wrote = await enqueue(
      base({ level: 5, dedupKey: `x:${randomUUID()}` }),
    );
    expect(wrote).toBe(false);
  });
});
