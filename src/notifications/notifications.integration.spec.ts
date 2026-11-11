/**
 * human-intervention / unit 6 — notifications against real PostgreSQL
 * (contract §5.1, §5.2, §6.3; §10.1 R3, R8, R10):
 *   - producers in the same transaction as the state change (bot intake, the
 *     wrapped zone hook, staff reassign, customer cancel) and rollback;
 *   - recipients from permissions: inactive user, another tenant and a user
 *     without the grant are excluded; `manage:all` counts;
 *   - R8: a tenant without NotificationSettings still gets notices;
 *   - D5: batched "new request" emails per person per 2-minute window, and
 *     TALK_TO_HUMAN / COMPLAINT immediate and alone;
 *   - preferences: emailEnabled=false keeps the in-app row, sends no email;
 *   - the email built from a real request has no customer name or phone;
 *   - R3: the generic poller never claims a dedicated type, the dedicated
 *     ones do;
 *   - API scoping: nobody reads or marks another person's notifications.
 *
 * Resend is never called: the mailer and Inngest are test doubles.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import type { Inngest } from 'inngest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PrismaDeliveryZoneBotRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaExpirationIntakeRepository } from '../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import {
  BotRequestIntakeService,
  type BotCreateResult,
} from '../chatbot-requests/application/bot-request-intake.service';
import { ChatbotRequestCommandsService } from '../chatbot-requests/application/chatbot-request-commands.service';
import { ChatbotRequestWrapper } from '../chatbot-requests/infrastructure/chatbot-request-wrapper';
import { LegacyIntakeAdapter } from '../chatbot-requests/infrastructure/legacy-intake.adapter';
import { PrismaBotIntakeStore } from '../chatbot-requests/infrastructure/prisma-bot-intake.store';
import { PrismaChatbotRequestCommandStore } from '../chatbot-requests/infrastructure/prisma-chatbot-request-command.store';
import { OutboxPollerService } from '../shared/outbox/outbox-poller.service';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { NotificationsService } from './application/notifications.service';
import {
  NOTICE_EMAIL_EVENT_TYPE,
  NOTICE_NOTIFY_EVENT_TYPE,
  batchWindowEnd,
  noticeText,
} from './domain/chatbot-request-notice';
import type { NotificationEventsPort } from './domain/notification-events.port';
import type { SendMailInput } from './email/mailer.port';
import { buildChatbotRequestEmailFunctions } from './inngest/chatbot-request-email.functions';
import { enqueueNotice } from './infrastructure/chatbot-request-notice.writer';
import { PrismaNoticeEmailLoader } from './infrastructure/prisma-notice-email.loader';
import {
  ChatbotRequestEmailDispatcher,
  groupJobs,
  type NoticeEmailEvent,
} from './outbox/chatbot-request-email.dispatcher';
import { ChatbotRequestNotifyConsumer } from './outbox/chatbot-request-notify.consumer';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const CRED = 'cred-notify-1';
const PHONE = { phoneCountryCode: '52', phone: '5512345678' };

describeIfDb('notifications (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const root = prisma as unknown as PrismaService;
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const wrapper = new ChatbotRequestWrapper(tenantPrisma);
  const intake = new BotRequestIntakeService(
    new PrismaBotIntakeStore(tenantPrisma),
    new LegacyIntakeAdapter(
      new PrismaRestockIntakeRepository(tenantPrisma, wrapper),
      new PrismaExpirationIntakeRepository(tenantPrisma, wrapper),
      new PrismaDeliveryZoneBotRepository(tenantPrisma, wrapper),
    ),
    wrapper,
  );
  const commands = new ChatbotRequestCommandsService(
    new PrismaChatbotRequestCommandStore(tenantPrisma),
    { resolve: () => Promise.reject(new Error('resolver not expected')) },
  );
  const api = new NotificationsService(tenantPrisma, root);

  const published: Array<{ userId: string; type: string }> = [];
  const events: NotificationEventsPort = {
    publishCreated: (_tx, event) => {
      published.push({ userId: event.userId, type: event.type });
      return Promise.resolve();
    },
  };
  const consumer = new ChatbotRequestNotifyConsumer(
    root,
    events,
    () => new Date(),
    25,
    3,
  );
  const inngestSend = jest
    .fn<Promise<{ ids: string[] }>, [string, unknown, string]>()
    .mockResolvedValue({ ids: ['evt'] });
  const dispatcher = new ChatbotRequestEmailDispatcher(
    root,
    { send: inngestSend } as never,
    () => new Date(),
    100,
    60_000,
    3,
  );

  const tenants: string[] = [];
  const userIds: string[] = [];

  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  const grant = (subject: string, action: string) =>
    prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      update: {},
      create: { subject, action },
    });

  interface Fixture {
    tenantId: string;
    ana: string;
    luis: string;
    boss: string;
    escal: string;
    nobody: string;
    inactive: string;
    foreign: string;
    quiet: string;
  }

  /** A tenant with one user per case; `quiet` has turned email off. */
  async function fixture(): Promise<Fixture> {
    const tenantId = randomUUID();
    const other = randomUUID();
    tenants.push(tenantId, other);
    for (const id of [tenantId, other]) {
      await prisma.tenant.create({
        data: { id, name: 'Sucursal Centro', slug: `nt-${id}` },
      });
    }
    const [read, update, escalation, all] = await Promise.all([
      grant('ChatbotRequest', 'read'),
      grant('ChatbotRequest', 'update'),
      grant('ChatbotEscalation', 'read'),
      grant('all', 'manage'),
    ]);
    const role = (tid: string, name: string, ids: string[]) =>
      prisma.role.create({
        data: {
          tenantId: tid,
          name: `${name} ${tid}`,
          permissions: {
            create: ids.map((permissionId) => ({ permissionId })),
          },
        },
      });
    const handlers = await role(tenantId, 'Atiende', [read.id, update.id]);
    const admin = await role(tenantId, 'Admin', [all.id]);
    const escalRole = await role(tenantId, 'Escala', [escalation.id]);
    const bare = await role(tenantId, 'Nada', []);
    const foreignRole = await role(other, 'Atiende', [read.id, update.id]);

    const f = {
      tenantId,
      ana: randomUUID(),
      luis: randomUUID(),
      boss: randomUUID(),
      escal: randomUUID(),
      nobody: randomUUID(),
      inactive: randomUUID(),
      foreign: randomUUID(),
      quiet: randomUUID(),
    };
    for (const [name, id] of Object.entries(f)) {
      if (name === 'tenantId') continue;
      userIds.push(id);
      await prisma.user.create({
        data: {
          id,
          email: `${name}-${id}@nt.test`,
          hashedPassword: 'x',
          name,
          isActive: name !== 'inactive',
        },
      });
    }
    await prisma.tenantMembership.createMany({
      data: [
        { userId: f.ana, tenantId, roleId: handlers.id },
        { userId: f.luis, tenantId, roleId: handlers.id },
        { userId: f.quiet, tenantId, roleId: handlers.id },
        { userId: f.inactive, tenantId, roleId: handlers.id },
        { userId: f.boss, tenantId, roleId: admin.id },
        { userId: f.escal, tenantId, roleId: escalRole.id },
        { userId: f.nobody, tenantId, roleId: bare.id },
        { userId: f.foreign, tenantId: other, roleId: foreignRole.id },
      ],
    });
    await prisma.notificationPreference.create({
      data: { userId: f.quiet, emailEnabled: false },
    });
    return f;
  }

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const MSG_AT = new Date(Date.now() - 3_600_000);
  const direct = (over: Record<string, unknown> = {}) => ({
    sourceRequestId: randomUUID(),
    subtype: 'UNKNOWN_QUESTION',
    customer: PHONE,
    conversationRef: 'wa:5215512345678',
    lastCustomerMessageAt: MSG_AT.toISOString(),
    summary: 'Pregunta privada del cliente',
    needs: 'Necesita saber algo',
    triggerWaMessageId: 'wamid.1',
    ...over,
  });
  const zoneBody = () => {
    const sourceRequestId = randomUUID();
    return {
      sourceRequestId,
      subtype: 'DELIVERY_ZONE',
      customer: PHONE,
      detail: {
        sourceRequestId,
        type: 'DELIVERY_ZONE',
        zipCode: '64000',
        state: 'Nuevo León',
        municipality: 'Monterrey',
        neighborhood: 'Centro',
        ...PHONE,
        conversationRef: 'wa:5215512345678',
        lastCustomerMessageAt: MSG_AT.toISOString(),
      },
    };
  };
  const create = (
    tenantId: string,
    body: { sourceRequestId: string; [key: string]: unknown },
  ): Promise<BotCreateResult> =>
    inTenant(tenantId, () =>
      intake.create({
        credentialId: CRED,
        idempotencyKey: body.sourceRequestId,
        body,
      }),
    );

  const reqId = (made: BotCreateResult): string => made.body.id as string;

  /** Runs the consumer until nothing due is left (other tests' rows too). */
  async function drain(): Promise<void> {
    for (let i = 0; i < 200 && (await consumer.processOne()); i++) {
      /* keep going */
    }
  }
  const notificationsOf = (tenantId: string, userId?: string) =>
    prisma.notification.findMany({
      where: { tenantId, ...(userId ? { userId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  const emailJobs = (tenantId: string) =>
    prisma.outboxEvent.findMany({
      where: { tenantId, eventType: NOTICE_EMAIL_EVENT_TYPE },
    });
  const notifyRows = (tenantId: string) =>
    prisma.outboxEvent.findMany({
      where: { tenantId, eventType: NOTICE_NOTIFY_EVENT_TYPE },
    });
  const ids = (rows: Array<{ userId: string }>) =>
    rows.map((r) => r.userId).sort();

  describe('recipients come from permissions (R8)', () => {
    it('a new request reaches active members with read+update, manage:all included', async () => {
      const f = await fixture();
      // R8: this tenant has no NotificationSettings row at all.
      expect(
        await prisma.notificationSettings.count({
          where: { tenantId: f.tenantId },
        }),
      ).toBe(0);

      const made = await create(f.tenantId, direct());
      expect(await notifyRows(f.tenantId)).toHaveLength(1);
      await drain();

      const rows = await notificationsOf(f.tenantId);
      // ana, luis, quiet (handlers) and boss (manage:all). NOT: escal and
      // nobody (no grant), inactive (isActive=false), foreign (other tenant).
      expect(ids(rows)).toEqual([f.ana, f.luis, f.quiet, f.boss].sort());
      expect(rows.every((r) => r.requestId === reqId(made))).toBe(true);
      expect(rows[0]).toMatchObject({ type: 'REQUEST_CREATED' });
      // Payload is folio + subtype only: no customer data.
      expect(Object.keys(rows[0].payload as object).sort()).toEqual([
        'folio',
        'subtype',
      ]);
      expect(await notificationsOf(f.foreign)).toHaveLength(0);
      expect(
        published.filter((p) => p.type === 'REQUEST_CREATED').length,
      ).toBeGreaterThanOrEqual(4);
    });

    it('the wrapped zone hook notifies too', async () => {
      const f = await fixture();
      await create(f.tenantId, zoneBody());
      await drain();
      expect(ids(await notificationsOf(f.tenantId))).toEqual(
        [f.ana, f.luis, f.quiet, f.boss].sort(),
      );
    });

    it('escalation types go to read:ChatbotEscalation holders only', async () => {
      const f = await fixture();
      const made = await create(f.tenantId, direct());
      await drain();
      await root.$transaction(async (tx) => {
        await enqueueNotice(tx as never, f.tenantId, {
          type: 'REQUEST_ESCALATION',
          requestId: reqId(made),
          folio: 1,
          subtype: 'UNKNOWN_QUESTION',
          dedupKey: `escalation:${reqId(made)}`,
        });
      });
      await drain();
      const rows = (await notificationsOf(f.tenantId)).filter(
        (r) => r.type === 'REQUEST_ESCALATION',
      );
      // boss holds manage:all (so it reads escalations too); ana does not.
      expect(ids(rows)).toEqual([f.escal, f.boss].sort());
    });

    it('reassign notifies the new assignee only; the customer cancel notifies the assignee', async () => {
      const f = await fixture();
      const made = await create(f.tenantId, direct());
      await drain();
      const run = (actor: string, expectedVersion: number, command: never) =>
        inTenant(f.tenantId, () =>
          commands.execute({
            requestId: reqId(made),
            actorUserId: actor,
            actorCanReassign: true,
            idempotencyKey: randomUUID(),
            expectedVersion,
            command,
          }),
        );
      await run(f.ana, 1, { kind: 'claim' } as never);
      await run(f.ana, 2, { kind: 'reassign', toUserId: f.luis } as never);
      await drain();

      const reassigned = (await notificationsOf(f.tenantId)).filter(
        (r) => r.type === 'REQUEST_REASSIGNED',
      );
      expect(ids(reassigned)).toEqual([f.luis]);

      // A second reassign (luis -> ana) tells ana, the new assignee; luis, who
      // made it, is never told. The notice to oneself is dropped by the writer
      // (writer spec): the state machine rejects a reassign to the same person.
      await expect(
        run(f.luis, 3, { kind: 'reassign', toUserId: f.ana } as never),
      ).resolves.toBeDefined();
      await drain();
      expect(
        (await notificationsOf(f.tenantId)).filter(
          (r) => r.type === 'REQUEST_REASSIGNED',
        ),
      ).toHaveLength(2);

      await inTenant(f.tenantId, () =>
        intake.cancel({
          credentialId: CRED,
          idempotencyKey: randomUUID(),
          requestId: reqId(made),
          body: { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'w.c' },
        }),
      );
      await drain();
      const cancelled = (await notificationsOf(f.tenantId)).filter(
        (r) => r.type === 'REQUEST_CANCELLED',
      );
      // ana holds it after the second reassign.
      expect(ids(cancelled)).toEqual([f.ana]);
      // A cancel is in-app only: no email job for it.
      expect(
        (await emailJobs(f.tenantId)).filter(
          (j) =>
            (j.payload as { notificationId: string }).notificationId ===
            cancelled[0].id,
        ),
      ).toHaveLength(0);
    });

    it('qualifies a user whose read and update come from different roles (CASL merges grants)', async () => {
      const f = await fixture();
      const [read, update] = await Promise.all([
        grant('ChatbotRequest', 'read'),
        grant('ChatbotRequest', 'update'),
      ]);
      const roleWith = (name: string, permissionId: string) =>
        prisma.role.create({
          data: {
            tenantId: f.tenantId,
            name: `${name} ${f.tenantId}`,
            permissions: { create: { permissionId } },
          },
        });
      const reads = await roleWith('Solo lee', read.id);
      const updates = await roleWith('Solo actualiza', update.id);
      const split = randomUUID();
      const readOnly = randomUUID();
      const updateOnly = randomUUID();
      for (const [name, id] of [
        ['split', split],
        ['readOnly', readOnly],
        ['updateOnly', updateOnly],
      ]) {
        userIds.push(id);
        await prisma.user.create({
          data: {
            id,
            email: `${name}-${id}@nt.test`,
            hashedPassword: 'x',
            name,
          },
        });
      }
      await prisma.tenantMembership.createMany({
        data: [
          // read from one role and update from another, same tenant
          { userId: split, tenantId: f.tenantId, roleId: reads.id },
          { userId: split, tenantId: f.tenantId, roleId: updates.id },
          { userId: readOnly, tenantId: f.tenantId, roleId: reads.id },
          { userId: updateOnly, tenantId: f.tenantId, roleId: updates.id },
        ],
      });

      await create(f.tenantId, direct());
      await drain();

      const notified = new Set(
        (await notificationsOf(f.tenantId)).map((r) => r.userId),
      );
      expect(notified.has(split)).toBe(true);
      expect(notified.has(readOnly)).toBe(false);
      expect(notified.has(updateOnly)).toBe(false);
    });

    it('a request closed by someone else tells the assignee, with the cause; never the actor', async () => {
      const f = await fixture();
      const made = await create(f.tenantId, direct());
      await drain();
      const run = (actor: string, expectedVersion: number, command: never) =>
        inTenant(f.tenantId, () =>
          commands.execute({
            requestId: reqId(made),
            actorUserId: actor,
            actorCanReassign: true,
            idempotencyKey: randomUUID(),
            expectedVersion,
            command,
          }),
        );
      await run(f.ana, 1, { kind: 'claim' } as never);
      // luis cancels the request ana was attending.
      await run(f.luis, 2, { kind: 'cancel', reason: 'DUPLICATE' } as never);
      await drain();

      const closed = (await notificationsOf(f.tenantId)).filter(
        (r) => r.type === 'REQUEST_CANCELLED',
      );
      expect(ids(closed)).toEqual([f.ana]);
      expect(closed[0].payload).toMatchObject({ cause: 'CANCELLED_BY_OTHER' });
      expect(
        noticeText('REQUEST_CANCELLED', closed[0].payload as never).title,
      ).toBe('Otra persona canceló la solicitud');
      // In-app only: no email job for a close.
      expect(
        (await emailJobs(f.tenantId)).filter(
          (j) =>
            (j.payload as { notificationId: string }).notificationId ===
            closed[0].id,
        ),
      ).toHaveLength(0);
    });

    it('cancelling a request you hold yourself tells nobody', async () => {
      const f = await fixture();
      const made = await create(f.tenantId, direct());
      await drain();
      const run = (expectedVersion: number, command: never) =>
        inTenant(f.tenantId, () =>
          commands.execute({
            requestId: reqId(made),
            actorUserId: f.ana,
            actorCanReassign: true,
            idempotencyKey: randomUUID(),
            expectedVersion,
            command,
          }),
        );
      await run(1, { kind: 'claim' } as never);
      await run(2, { kind: 'cancel', reason: 'DUPLICATE' } as never);
      await drain();
      expect(
        (await notificationsOf(f.tenantId)).filter(
          (r) => r.type === 'REQUEST_CANCELLED',
        ),
      ).toHaveLength(0);
    });

    it('a cancel of a request nobody took notifies nobody', async () => {
      const f = await fixture();
      const made = await create(f.tenantId, direct());
      await drain();
      const before = (await notificationsOf(f.tenantId)).length;
      await inTenant(f.tenantId, () =>
        intake.cancel({
          credentialId: CRED,
          idempotencyKey: randomUUID(),
          requestId: reqId(made),
          body: { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'w.c' },
        }),
      );
      await drain();
      expect(await notificationsOf(f.tenantId)).toHaveLength(before);
    });
  });

  describe('same transaction as the state change', () => {
    it('a rollback leaves no outbox row and no notification', async () => {
      const f = await fixture();
      const requestId = randomUUID();
      await expect(
        inTenant(f.tenantId, () =>
          tenantPrisma.runInTransaction(async () => {
            await enqueueNotice(tenantPrisma.getClient(), f.tenantId, {
              type: 'REQUEST_CREATED',
              requestId,
              folio: 1,
              subtype: 'RESTOCK',
              dedupKey: `created:${requestId}`,
            });
            throw new Error('state change failed');
          }),
        ),
      ).rejects.toThrow('state change failed');

      expect(await notifyRows(f.tenantId)).toHaveLength(0);
      await drain();
      expect(await notificationsOf(f.tenantId)).toHaveLength(0);
    });

    it('a failed create (limit exceeded) leaves no notice behind', async () => {
      const f = await fixture();
      const limited = new BotRequestIntakeService(
        new PrismaBotIntakeStore(tenantPrisma),
        {} as never,
        wrapper,
        { openLimit: 1, creationsPerHour: 10 },
      );
      const call = (body: { sourceRequestId: string }) =>
        inTenant(f.tenantId, () =>
          limited.create({
            credentialId: CRED,
            idempotencyKey: body.sourceRequestId,
            body,
          }),
        );
      await call(direct());
      await expect(call(direct())).rejects.toBeDefined();
      expect(await notifyRows(f.tenantId)).toHaveLength(1);
    });

    it('a re-run of the same notice never duplicates (dedupKey)', async () => {
      const f = await fixture();
      const made = await create(f.tenantId, direct());
      await drain();
      const before = (await notificationsOf(f.tenantId)).length;
      await root.$transaction(async (tx) => {
        await enqueueNotice(tx as never, f.tenantId, {
          type: 'REQUEST_CREATED',
          requestId: reqId(made),
          folio: 1,
          subtype: 'UNKNOWN_QUESTION',
          dedupKey: `created:${reqId(made)}`,
        });
      });
      const jobsBefore = (await emailJobs(f.tenantId)).length;
      await drain();
      expect(await notificationsOf(f.tenantId)).toHaveLength(before);
      expect(await emailJobs(f.tenantId)).toHaveLength(jobsBefore);
    });
  });

  describe('email rule (D5) and preferences', () => {
    it('batches new-request emails per person in one window, honoring emailEnabled', async () => {
      const f = await fixture();
      for (let i = 0; i < 3; i++) await create(f.tenantId, direct());
      await drain();

      // In-app rows exist for everyone, including who turned email off.
      expect(await notificationsOf(f.tenantId, f.quiet)).toHaveLength(3);
      const jobs = await emailJobs(f.tenantId);
      const emailed = new Set(
        jobs.map((j) => (j.payload as { userId: string }).userId),
      );
      expect([...emailed].sort()).toEqual([f.ana, f.luis, f.boss].sort());
      expect(emailed.has(f.quiet)).toBe(false);

      // All BATCH rows of the window share its end, which is in the future.
      const dueAts = new Set(jobs.map((j) => j.nextAttemptAt.getTime()));
      expect(dueAts.size).toBe(1);
      expect([...dueAts][0]).toBe(batchWindowEnd(new Date()).getTime());
      const early = (await dispatcher.claimDue()).filter(
        (e) => e.tenantId === f.tenantId,
      );
      expect(early).toHaveLength(0);

      // The window closes: each person gets ONE event with the three notices.
      await prisma.outboxEvent.updateMany({
        where: { tenantId: f.tenantId, eventType: NOTICE_EMAIL_EVENT_TYPE },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      inngestSend.mockClear();
      const due = (await dispatcher.claimDue()).filter(
        (e) => e.tenantId === f.tenantId,
      );
      const groups = groupJobs(due);
      expect(groups).toHaveLength(3);
      for (const group of groups) await dispatcher.dispatch(group);

      const sent = inngestSend.mock.calls.map(
        (call) => call[1] as NoticeEmailEvent,
      );
      expect(sent).toHaveLength(3);
      for (const event of sent) {
        expect(event.mode).toBe('BATCH');
        expect(event.notificationIds).toHaveLength(3);
      }
      expect(
        await prisma.outboxEvent.count({
          where: {
            tenantId: f.tenantId,
            eventType: NOTICE_EMAIL_EVENT_TYPE,
            status: 'PUBLISHED',
          },
        }),
      ).toBe(9);
    });

    it("claims a person's due batch whole even when it is larger than the claim size", async () => {
      const f = await fixture();
      const job = (userId: string, n: number, at: string) =>
        prisma.outboxEvent.create({
          data: {
            tenantId: f.tenantId,
            aggregateType: 'Notification',
            aggregateId: randomUUID(),
            eventType: NOTICE_EMAIL_EVENT_TYPE,
            payload: {
              notificationId: `n-${userId}-${n}`,
              userId,
              mode: 'BATCH',
            },
            // Year 2000 sorts ahead of any leftover row of another test.
            nextAttemptAt: new Date(at),
          },
        });
      for (let i = 0; i < 5; i++) await job(f.ana, i, '2000-01-01T00:00:00Z');
      for (let i = 0; i < 3; i++) await job(f.luis, i, '2000-01-01T00:00:01Z');

      // Claim size 2: ana has 5 due jobs, luis 3.
      const small = new ChatbotRequestEmailDispatcher(
        root,
        { send: inngestSend } as never,
        () => new Date(),
        2,
        60_000,
        3,
      );
      const first = (await small.claimDue()).filter(
        (e) => e.tenantId === f.tenantId,
      );
      expect(first).toHaveLength(5);
      expect(groupJobs(first)).toHaveLength(1);
      const second = (await small.claimDue()).filter(
        (e) => e.tenantId === f.tenantId,
      );
      expect(second).toHaveLength(3);
      expect(groupJobs(second)).toHaveLength(1);
    });

    it('TALK_TO_HUMAN and COMPLAINT are due now and leave alone', async () => {
      const f = await fixture();
      await create(f.tenantId, direct({ subtype: 'TALK_TO_HUMAN' }));
      await create(f.tenantId, direct({ subtype: 'COMPLAINT' }));
      await drain();

      const jobs = await emailJobs(f.tenantId);
      expect(jobs.length).toBe(6); // 3 emailed people x 2 notices
      expect(
        jobs.every(
          (j) =>
            (j.payload as { mode: string }).mode === 'IMMEDIATE' &&
            j.nextAttemptAt.getTime() <= Date.now() + 1000,
        ),
      ).toBe(true);

      inngestSend.mockClear();
      const due = (await dispatcher.claimDue()).filter(
        (e) => e.tenantId === f.tenantId,
      );
      const groups = groupJobs(due);
      expect(groups.every((g) => g.length === 1)).toBe(true);
      for (const group of groups) await dispatcher.dispatch(group);
      const sent = inngestSend.mock.calls.map((c) => c[1] as NoticeEmailEvent);
      expect(sent).toHaveLength(6);
      expect(sent.every((e) => e.notificationIds.length === 1)).toBe(true);
    });

    it('the email of a real request has no customer name or phone (§6.3)', async () => {
      const f = await fixture();
      await prisma.customer.create({
        data: {
          tenantId: f.tenantId,
          firstName: 'María',
          lastName: 'Pérez',
          ...PHONE,
        },
      });
      const made = await create(f.tenantId, direct({ subtype: 'COMPLAINT' }));
      await drain();
      const due = (await dispatcher.claimDue()).filter(
        (e) => e.tenantId === f.tenantId,
      );
      inngestSend.mockClear();
      for (const group of groupJobs(due)) await dispatcher.dispatch(group);
      const anaEvent = inngestSend.mock.calls
        .map((c) => c[1] as NoticeEmailEvent)
        .find((e) => e.userId === f.ana);
      expect(anaEvent).toBeDefined();

      // Run the real Inngest function with the real loader; the mailer is a
      // double, so nothing leaves the process.
      type Handler = (ctx: unknown) => Promise<unknown>;
      let handler: Handler | undefined;
      const mails: SendMailInput[] = [];
      buildChatbotRequestEmailFunctions({
        inngestClient: {
          createFunction: (_o: unknown, h: Handler) => {
            handler = h;
            return {};
          },
        } as unknown as Inngest,
        loader: new PrismaNoticeEmailLoader(root),
        mailer: {
          send: (mail) => {
            mails.push(mail);
            return Promise.resolve();
          },
        },
        appBaseUrl: 'https://app.example.com',
      });
      await handler?.({
        event: { id: 'e1', name: 'x', data: anaEvent },
        step: { run: (_n: string, fn: () => Promise<unknown>) => fn() },
      });

      expect(mails).toHaveLength(1);
      const [mail] = mails;
      expect(mail.to).toEqual([`ana-${f.ana}@nt.test`]);
      expect(mail.subject).toMatch(
        /^\[HoundFe\] Nueva solicitud: Queja \(Sucursal Centro\) · S-\d{6}$/,
      );
      expect(mail.html).toContain(
        `https://app.example.com/chatbot/solicitudes/${reqId(made)}`,
      );
      for (const forbidden of [
        'María',
        'Pérez',
        '5512345678',
        'Pregunta privada',
      ]) {
        expect(mail.html).not.toContain(forbidden);
        expect(mail.subject).not.toContain(forbidden);
      }
    });

    it('the loader drops the email when the person turned it off or went inactive after queueing', async () => {
      const f = await fixture();
      await create(f.tenantId, direct({ subtype: 'COMPLAINT' }));
      await drain();
      const note = (await notificationsOf(f.tenantId, f.luis))[0];
      const event: NoticeEmailEvent = {
        tenantId: f.tenantId,
        userId: f.luis,
        mode: 'IMMEDIATE',
        notificationIds: [note.id],
      };
      const loader = new PrismaNoticeEmailLoader(root);
      expect(await loader.load(event)).not.toBeNull();

      await prisma.notificationPreference.create({
        data: { userId: f.luis, emailEnabled: false },
      });
      expect(await loader.load(event)).toBeNull();
      await prisma.notificationPreference.update({
        where: { userId: f.luis },
        data: { emailEnabled: true },
      });
      await prisma.user.update({
        where: { id: f.luis },
        data: { isActive: false },
      });
      expect(await loader.load(event)).toBeNull();
    });
  });

  describe('R3 — generic poller exclusion', () => {
    it('the generic poller claims no chatbot_request.* row; the dedicated ones do', async () => {
      const f = await fixture();
      const mine = [NOTICE_NOTIFY_EVENT_TYPE, NOTICE_EMAIL_EVENT_TYPE];
      const rows = await Promise.all(
        mine.map((eventType) =>
          prisma.outboxEvent.create({
            data: {
              tenantId: f.tenantId,
              aggregateType: 'ChatbotRequest',
              aggregateId: randomUUID(),
              eventType,
              payload: { malformed: true },
            },
          }),
        ),
      );
      // A normal event type is still claimed by the generic poller.
      const normal = await prisma.outboxEvent.create({
        data: {
          tenantId: f.tenantId,
          aggregateType: 'Sale',
          aggregateId: randomUUID(),
          eventType: 'sale.confirmed',
          payload: {},
        },
      });

      const dispatched: string[] = [];
      const generic = new OutboxPollerService(
        root,
        {
          dispatch: (event: { id: string }) => {
            dispatched.push(event.id);
            return Promise.resolve();
          },
        } as never,
        0,
        500,
        30_000,
      );
      await generic.poll();

      for (const row of rows) expect(dispatched).not.toContain(row.id);
      expect(dispatched).toContain(normal.id);
      const stillPending = await prisma.outboxEvent.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      expect(stillPending.every((r) => r.status === 'PENDING')).toBe(true);
      expect(stillPending.every((r) => r.lockToken === null)).toBe(true);

      // The dedicated claimers do take theirs.
      const claimed = await dispatcher.claimDue();
      expect(claimed.map((e) => e.id)).toContain(rows[1].id);
    });

    it('a poison notify row backs off and ends FAILED without blocking the rest', async () => {
      const f = await fixture();
      const poison = await prisma.outboxEvent.create({
        data: {
          tenantId: f.tenantId,
          aggregateType: 'ChatbotRequest',
          aggregateId: randomUUID(),
          eventType: NOTICE_NOTIFY_EVENT_TYPE,
          payload: { malformed: true },
          createdAt: new Date(Date.now() - 60_000),
        },
      });
      await create(f.tenantId, direct());
      // maxRetries is 3: fail it three times, making it due each time.
      for (let i = 0; i < 3; i++) {
        await prisma.outboxEvent.update({
          where: { id: poison.id },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
        await drain();
      }
      const after = await prisma.outboxEvent.findUnique({
        where: { id: poison.id },
      });
      expect(after).toMatchObject({ status: 'FAILED', retryCount: 3 });
      expect(after?.lastError).toContain('malformed');
      // The good row behind it was still delivered.
      expect(await notificationsOf(f.tenantId)).not.toHaveLength(0);
    });
  });

  describe('API scoping (§5.2)', () => {
    const asUser = <T>(f: Fixture, userId: string, work: () => Promise<T>) =>
      cls.runWith({ tenantId: f.tenantId, userId, isSuperAdmin: false }, work);

    it('a user lists, counts and reads only their own notifications', async () => {
      const f = await fixture();
      for (let i = 0; i < 3; i++) await create(f.tenantId, direct());
      await drain();

      const mine = await asUser(f, f.ana, () => api.list(f.ana, {}));
      expect(mine.items).toHaveLength(3);
      expect(mine.items[0]).toMatchObject({
        type: 'REQUEST_CREATED',
        title: 'Nueva solicitud',
        readAt: null,
      });
      expect(mine.items[0].body).toMatch(/^Pregunta sin respuesta · S-\d{6}$/);
      expect(await asUser(f, f.ana, () => api.unreadCount(f.ana))).toEqual({
        count: 3,
      });
      // Someone with no notices sees none, and another tenant sees none.
      expect(
        (await asUser(f, f.nobody, () => api.list(f.nobody, {}))).items,
      ).toHaveLength(0);
      const luisNote = (await notificationsOf(f.tenantId, f.luis))[0];

      // Marking another person's notification is a 404 and changes nothing.
      await expect(
        asUser(f, f.ana, () => api.markRead(f.ana, luisNote.id)),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (await prisma.notification.findUnique({ where: { id: luisNote.id } }))
          ?.readAt,
      ).toBeNull();

      // Another tenant's session cannot see it either, even for the same user id.
      const otherTenant = await fixture();
      await expect(
        cls.runWith(
          {
            tenantId: otherTenant.tenantId,
            userId: f.luis,
            isSuperAdmin: false,
          },
          () => api.markRead(f.luis, luisNote.id),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('read is idempotent, read-all touches only the caller, unread filter and cursor work', async () => {
      const f = await fixture();
      for (let i = 0; i < 5; i++) await create(f.tenantId, direct());
      await drain();

      const page1 = await asUser(f, f.ana, () => api.list(f.ana, { limit: 2 }));
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await asUser(f, f.ana, () =>
        api.list(f.ana, { limit: 2, cursor: page1.nextCursor ?? '' }),
      );
      const page3 = await asUser(f, f.ana, () =>
        api.list(f.ana, { limit: 2, cursor: page2.nextCursor ?? '' }),
      );
      const seen = [...page1.items, ...page2.items, ...page3.items].map(
        (i) => i.id,
      );
      expect(new Set(seen).size).toBe(5);
      expect(page3.nextCursor).toBeNull();

      const first = await asUser(f, f.ana, () =>
        api.markRead(f.ana, page1.items[0].id),
      );
      const again = await asUser(f, f.ana, () =>
        api.markRead(f.ana, page1.items[0].id),
      );
      expect(again.readAt).toBe(first.readAt);
      expect(await asUser(f, f.ana, () => api.unreadCount(f.ana))).toEqual({
        count: 4,
      });
      expect(
        (await asUser(f, f.ana, () => api.list(f.ana, { unread: true }))).items,
      ).toHaveLength(4);

      expect(await asUser(f, f.ana, () => api.markAllRead(f.ana))).toEqual({
        updated: 4,
      });
      expect(await asUser(f, f.ana, () => api.unreadCount(f.ana))).toEqual({
        count: 0,
      });
      // Luis' notices are untouched by Ana's read-all.
      expect(await asUser(f, f.luis, () => api.unreadCount(f.luis))).toEqual({
        count: 5,
      });
    });

    it('preferences default to on, follow the person and keep the other flag', async () => {
      const f = await fixture();
      expect(await api.getPreferences(f.ana)).toEqual({
        emailEnabled: true,
        soundEnabled: true,
      });
      expect(await api.setPreferences(f.ana, { soundEnabled: false })).toEqual({
        emailEnabled: true,
        soundEnabled: false,
      });
      expect(await api.setPreferences(f.ana, { emailEnabled: false })).toEqual({
        emailEnabled: false,
        soundEnabled: false,
      });
      expect(await api.getPreferences(f.ana)).toEqual({
        emailEnabled: false,
        soundEnabled: false,
      });
      // Someone else's preference is untouched.
      expect(await api.getPreferences(f.luis)).toEqual({
        emailEnabled: true,
        soundEnabled: true,
      });
    });
  });
});
