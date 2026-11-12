/**
 * human-intervention / unit 8 — the notification producers of the realtime log
 * against real PostgreSQL (contract §5.1, §5.2, §5.3, §12.8):
 *   - `notification.created`: one event per recipient, written by the notify
 *     consumer in the transaction that creates the notification (a re-run that
 *     creates nothing writes nothing; a rollback leaves no event);
 *   - `notification.read`: written by read and read-all in the same
 *     transaction as the update, only when something actually changed, always
 *     for the caller alone.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../test/integration/reset-db';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { NotificationsService } from './application/notifications.service';
import {
  enqueueNotice,
  type OutboxClient,
} from './infrastructure/chatbot-request-notice.writer';
import { RealtimeNotificationEvents } from './infrastructure/realtime-notification-events';
import { ChatbotRequestNotifyConsumer } from './outbox/chatbot-request-notify.consumer';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('notification realtime producers (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const root = prisma as unknown as PrismaService;
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const adapter = new RealtimeNotificationEvents();
  const api = new NotificationsService(tenantPrisma, root, adapter);
  const consumer = new ChatbotRequestNotifyConsumer(
    root,
    adapter,
    () => new Date(),
    25,
    3,
  );

  const tenants: string[] = [];
  const userIds: string[] = [];
  let tenantId: string;
  let ana: string;
  let luis: string;
  let requestId: string;

  const inTenant = <T>(work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  const grant = (subject: string, action: string) =>
    prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      update: {},
      create: { subject, action },
    });

  const events = (type: string, userId?: string) =>
    prisma.$queryRaw<
      {
        id: bigint;
        userId: string | null;
        requestId: string | null;
        payload: Record<string, unknown>;
      }[]
    >`SELECT id, "userId", "requestId", payload FROM realtime_events
      WHERE "tenantId" = ${tenantId} AND type = ${type}
        AND (${userId ?? null}::text IS NULL OR "userId" = ${userId ?? null})
      ORDER BY id`;

  const notice = (userId: string, dedupKey = randomUUID()) =>
    prisma.notification.create({
      data: {
        tenantId,
        userId,
        type: 'REQUEST_CREATED',
        requestId,
        payload: { folio: 7, subtype: 'UNKNOWN_QUESTION' },
        dedupKey,
      },
      select: { id: true },
    });

  beforeEach(async () => {
    tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal RT', slug: `nrt-${tenantId}` },
    });
    const [read, update] = await Promise.all([
      grant('ChatbotRequest', 'read'),
      grant('ChatbotRequest', 'update'),
    ]);
    const role = await prisma.role.create({
      data: {
        tenantId,
        name: `Atiende ${tenantId}`,
        permissions: {
          create: [{ permissionId: read.id }, { permissionId: update.id }],
        },
      },
    });
    ana = randomUUID();
    luis = randomUUID();
    for (const [name, id] of [
      ['ana', ana],
      ['luis', luis],
    ]) {
      userIds.push(id);
      await prisma.user.create({
        data: {
          id,
          email: `${name}-${id}@nrt.test`,
          hashedPassword: 'x',
          name,
        },
      });
      await prisma.tenantMembership.create({
        data: { userId: id, tenantId, roleId: role.id },
      });
    }
    const request = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: 7,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: '525512345678',
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      },
      select: { id: true },
    });
    requestId = request.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe('notification.created', () => {
    const enqueueCreated = (dedupKey: string) =>
      enqueueNotice(prisma as unknown as OutboxClient, tenantId, {
        type: 'REQUEST_CREATED',
        requestId,
        folio: 7,
        subtype: 'UNKNOWN_QUESTION',
        dedupKey,
      });

    it('writes one personal event per recipient with the consumer commit', async () => {
      await enqueueCreated('created:1');
      expect(await consumer.processOne()).toBe(true);
      const notifications = await prisma.notification.findMany({
        where: { tenantId },
        select: { id: true, userId: true },
      });
      expect(notifications).toHaveLength(2);
      const created = await events('notification.created');
      expect(created).toHaveLength(2);
      expect(created.map((e) => e.userId).sort()).toEqual([ana, luis].sort());
      for (const event of created) {
        const mine = notifications.find((n) => n.userId === event.userId);
        expect(event.payload).toEqual({ notificationId: mine?.id });
        expect(event.requestId).toBe(requestId);
      }
    });

    it('a duplicate notice creates no notification and no event', async () => {
      await enqueueCreated('created:dup');
      await consumer.processOne();
      await enqueueCreated('created:dup');
      await consumer.processOne();
      expect(await events('notification.created')).toHaveLength(2);
    });

    it('a rollback after the event leaves no event behind', async () => {
      const row = await notice(ana);
      await expect(
        prisma.$transaction(async (tx) => {
          await adapter.publishCreated(tx, {
            tenantId,
            userId: ana,
            notificationId: row.id,
            type: 'REQUEST_CREATED',
            requestId,
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await events('notification.created')).toEqual([]);
    });
  });

  describe('notification.read', () => {
    it('read writes one event for the caller, and only the first time', async () => {
      const a = await notice(ana);
      const l = await notice(luis);
      await inTenant(() => api.markRead(ana, a.id));
      await inTenant(() => api.markRead(ana, a.id));
      const read = await events('notification.read');
      expect(read).toHaveLength(1);
      expect(read[0].userId).toBe(ana);
      expect(read[0].payload).toEqual({ ids: [a.id], all: false });
      expect(
        (await prisma.notification.findUnique({ where: { id: l.id } }))?.readAt,
      ).toBeNull();
    });

    it('a notice of someone else changes nothing and announces nothing', async () => {
      const l = await notice(luis);
      await expect(inTenant(() => api.markRead(ana, l.id))).rejects.toThrow();
      expect(await events('notification.read')).toEqual([]);
    });

    it('read-all writes one event for what it changed, none when nothing was unread', async () => {
      await notice(ana);
      await notice(ana);
      await notice(luis);
      expect(await inTenant(() => api.markAllRead(ana))).toEqual({
        updated: 2,
      });
      const read = await events('notification.read', ana);
      expect(read).toHaveLength(1);
      expect(read[0].payload).toEqual({ ids: null, all: true });
      expect(await inTenant(() => api.markAllRead(ana))).toEqual({
        updated: 0,
      });
      expect(await events('notification.read')).toHaveLength(1);
    });

    it('the update and its event commit or roll back together', async () => {
      const a = await notice(ana);
      const failing = new NotificationsService(tenantPrisma, root, {
        ...adapter,
        publishRead: () => Promise.reject(new Error('writer down')),
      });
      await expect(inTenant(() => failing.markRead(ana, a.id))).rejects.toThrow(
        'writer down',
      );
      expect(
        (await prisma.notification.findUnique({ where: { id: a.id } }))?.readAt,
      ).toBeNull();
      expect(await events('notification.read')).toEqual([]);
    });
  });
});
