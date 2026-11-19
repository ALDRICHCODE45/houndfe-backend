/**
 * human-intervention / unit 7c — the claim-cycle start is derived in TWO places:
 * the sweep (`computeClocks` / `LAST_RELEASED` in `chatbot-sla.ts`, which stamps
 * the reminder with `claimCycle`) and the notify consumer (`dropReason`, SQL,
 * which recomputes it when the held notice is consumed and drops the reminder as
 * CLAIM_CYCLE_CHANGED when the two differ). A divergence would drop EVERY
 * REQUEST_CLAIM_REMINDER silently, so nothing else ties them together except
 * this spec: it runs the REAL sweep and the REAL consumer, end to end, against
 * PostgreSQL, and asserts the reminder is DELIVERED (never dropped) for every
 * way a claim cycle can start:
 *
 *   (a) a fresh NEW request;
 *   (b) a request released (RELEASED or AUTO_RELEASED) and back to NEW: the new
 *       cycle's reminder is delivered, besides the one of the first cycle;
 *   (c) a scheduled request (`scheduledFor`): the cycle starts at the schedule;
 *   (d) a scheduled request released after its schedule.
 *
 * The schedule is the default (Mon-Sat 09:00-19:00 America/Mexico_City, UTC-6
 * in January 2030), no settings row, so the sweep releases the notices at once.
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../test/integration/reset-db';
import {
  slaColumnsForNew,
  slaColumnsForTransition,
  type RawDb,
} from '../chatbot-requests/infrastructure/chatbot-sla-policy';
import { ChatbotSlaSweepStore } from '../chatbot-requests/infrastructure/chatbot-sla-sweep.store';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { NotificationEventsPort } from './domain/notification-events.port';
import { ChatbotRequestNotifyConsumer } from './outbox/chatbot-request-notify.consumer';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const at = (v: string) => new Date(v);

describeIfDb('claim reminder: real sweep + real consumer (PostgreSQL)', () => {
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
  let handler: string;
  let folio = 0;

  const sweepAt = (now: Date) =>
    new ChatbotSlaSweepStore(root, { clock: () => now }).runBatch('due');

  /** Runs the consumer until nothing due is left (other specs' rows too). */
  async function drain(): Promise<void> {
    for (let i = 0; i < 200 && (await consumer.processOne()); i++) {
      /* keep going */
    }
  }

  beforeAll(async () => {
    tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Ciclo', slug: `cc-${tenantId}` },
    });
    const [read, update] = await Promise.all(
      (['read', 'update'] as const).map((action) =>
        prisma.permission.upsert({
          where: { subject_action: { subject: 'ChatbotRequest', action } },
          update: {},
          create: { subject: 'ChatbotRequest', action },
        }),
      ),
    );
    const role = await prisma.role.create({
      data: {
        tenantId,
        name: `Atiende ${tenantId}`,
        permissions: {
          create: [{ permissionId: read.id }, { permissionId: update.id }],
        },
      },
    });
    handler = randomUUID();
    userIds.push(handler);
    await prisma.user.create({
      data: {
        id: handler,
        email: `cycle-${handler}@nt.test`,
        hashedPassword: 'x',
        name: 'cycle',
      },
    });
    await prisma.tenantMembership.create({
      data: { userId: handler, tenantId, roleId: role.id },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /** A NEW request with the columns the real create path computes. */
  async function seed(input: {
    createdAt: Date;
    scheduledFor?: Date;
  }): Promise<string> {
    folio += 1;
    const scheduled = input.scheduledFor !== undefined;
    const kind = scheduled ? 'CONVERSATION' : 'CLARIFICATION';
    const subtype = scheduled ? 'TALK_TO_HUMAN' : 'UNKNOWN_QUESTION';
    const columns = await slaColumnsForNew(
      root as unknown as RawDb,
      tenantId,
      {
        subtype,
        createdAt: input.createdAt,
        scheduledFor: input.scheduledFor ?? null,
      },
      input.createdAt,
    );
    const created = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio,
        kind,
        subtype,
        customerKey: `5255${String(2000000 + folio)}`,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        createdAt: input.createdAt,
        scheduledFor: input.scheduledFor ?? null,
        claimDeadlineAt: columns.claimDeadlineAt,
        resolveDeadlineAt: columns.resolveDeadlineAt,
        slaPolicyVersion: columns.slaPolicyVersion,
        nextSlaCheckAt: columns.nextSlaCheckAt,
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Back to NEW with a release event at `when`, the clock restarted. */
  async function release(
    requestId: string,
    when: Date,
    type: 'RELEASED' | 'AUTO_RELEASED',
  ): Promise<void> {
    const user = type === 'RELEASED';
    await prisma.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId,
        type,
        actorKind: user ? 'USER' : 'SYSTEM',
        ...(user ? { actorId: handler, actorDisplayName: 'cycle' } : {}),
        fromStatus: 'IN_PROGRESS',
        toStatus: 'NEW',
        version: 3,
        data: {},
        createdAt: when,
      },
    });
    const columns = await slaColumnsForTransition(
      root as unknown as RawDb,
      tenantId,
      requestId,
      'NEW',
      when,
    );
    await prisma.chatbotRequest.update({
      where: { id: requestId },
      data: {
        claimDeadlineAt: columns?.claimDeadlineAt ?? null,
        resolveDeadlineAt: columns?.resolveDeadlineAt ?? null,
        slaPolicyVersion: columns?.slaPolicyVersion,
        nextSlaCheckAt: columns?.nextSlaCheckAt ?? null,
      },
    });
  }

  const reminders = (requestId: string) =>
    prisma.notification.findMany({
      where: { tenantId, requestId, type: 'REQUEST_CLAIM_REMINDER' },
      orderBy: { createdAt: 'asc' },
    });
  const notifyRows = (requestId: string) =>
    prisma.outboxEvent.findMany({
      where: {
        tenantId,
        aggregateId: requestId,
        eventType: 'chatbot_request.notify',
      },
      orderBy: { createdAt: 'asc' },
    });
  /** Every held reminder was consumed and none was dropped. */
  const noneDropped = async (requestId: string) => {
    for (const row of await notifyRows(requestId)) {
      expect(row.lastError).toBeNull();
      expect(row.status).toBe('PUBLISHED');
    }
  };
  const cycleOf = async (requestId: string) =>
    (await notifyRows(requestId)).map(
      (row) => (row.payload as { claimCycle: number }).claimCycle,
    );

  it('(a) a fresh NEW request reaches 50 %: the reminder is delivered once', async () => {
    // Monday 09:00; claim 30 min, so 50 % is 09:15.
    const createdAt = at('2030-01-07T09:00:00-06:00');
    const id = await seed({ createdAt });

    // Before 50 %: nothing for this request (the sweep is global, so judge the
    // request, not the batch).
    await sweepAt(at('2030-01-07T09:14:00-06:00'));
    await drain();
    expect(await notifyRows(id)).toHaveLength(0);
    await sweepAt(at('2030-01-07T09:15:00-06:00'));
    await drain();

    const sent = await reminders(id);
    expect(sent).toHaveLength(1);
    expect(sent[0].userId).toBe(handler);
    expect(await cycleOf(id)).toEqual([createdAt.getTime()]);
    await noneDropped(id);

    // A re-run of the sweep and the consumer delivers nothing more.
    await sweepAt(at('2030-01-07T09:15:00-06:00'));
    await drain();
    expect(await reminders(id)).toHaveLength(1);
  });

  it.each(['RELEASED', 'AUTO_RELEASED'] as const)(
    '(b) %s and back to NEW: the new cycle reaches 50 % and its reminder is delivered, not dropped',
    async (type) => {
      const createdAt = at('2030-01-07T09:00:00-06:00');
      const id = await seed({ createdAt });
      await sweepAt(at('2030-01-07T09:15:00-06:00'));
      await drain();
      expect(await reminders(id)).toHaveLength(1);

      // Claimed, then released at 09:40: the claim clock restarts (30 min, so
      // 50 % of the NEW cycle is 09:55).
      const releasedAt = at('2030-01-07T09:40:00-06:00');
      await release(id, releasedAt, type);
      await sweepAt(at('2030-01-07T09:54:00-06:00'));
      await drain();
      expect(await reminders(id)).toHaveLength(1);
      await sweepAt(at('2030-01-07T09:55:00-06:00'));
      await drain();

      const sent = await reminders(id);
      expect(sent).toHaveLength(2);
      expect(await cycleOf(id)).toEqual([
        createdAt.getTime(),
        releasedAt.getTime(),
      ]);
      await noneDropped(id);
    },
  );

  it('(c) a scheduled request reaches 50 % of its claim window counted from scheduledFor: delivered', async () => {
    // Created Monday 08:00, scheduled Tuesday 10:00; TALK_TO_HUMAN claims in
    // 10 min, so 50 % is Tuesday 10:05.
    const scheduledFor = at('2030-01-08T10:00:00-06:00');
    const id = await seed({
      createdAt: at('2030-01-07T08:00:00-06:00'),
      scheduledFor,
    });

    // Nothing runs while the schedule is ahead.
    await sweepAt(at('2030-01-07T12:00:00-06:00'));
    await drain();
    expect(await notifyRows(id)).toHaveLength(0);
    await sweepAt(at('2030-01-08T10:05:00-06:00'));
    await drain();

    expect(await reminders(id)).toHaveLength(1);
    expect(await cycleOf(id)).toEqual([scheduledFor.getTime()]);
    await noneDropped(id);
  });

  it('(d) a scheduled request released after its schedule: the release starts the cycle, delivered', async () => {
    const scheduledFor = at('2030-01-08T10:00:00-06:00');
    const id = await seed({
      createdAt: at('2030-01-07T08:00:00-06:00'),
      scheduledFor,
    });
    await sweepAt(at('2030-01-08T10:05:00-06:00'));
    await drain();
    expect(await reminders(id)).toHaveLength(1);

    const releasedAt = at('2030-01-08T11:00:00-06:00');
    await release(id, releasedAt, 'RELEASED');
    await sweepAt(at('2030-01-08T11:05:00-06:00'));
    await drain();

    expect(await reminders(id)).toHaveLength(2);
    expect(await cycleOf(id)).toEqual([
      scheduledFor.getTime(),
      releasedAt.getTime(),
    ]);
    await noneDropped(id);
  });
});
