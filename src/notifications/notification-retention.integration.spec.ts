/**
 * Notification retention against real PostgreSQL (contract §5.2: 90 days;
 * §10.1 R11; unit 7b):
 *   - the boundary: a notice 1 ms older than 90 days goes, one exactly 90 days
 *     old (and one 1 ms younger) stays; read or unread makes no difference;
 *   - bounded batches: a batch never exceeds its size and a tick is capped;
 *   - two concurrent runs delete every old row exactly once and neither fails;
 *   - the purge is index-backed (`notifications_createdAt_idx`, migration
 *     20261111060000_notification_retention).
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../test/integration/reset-db';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { NotificationRetentionScheduler } from './infrastructure/notification-retention.scheduler';
import { PrismaNotificationRetentionStore } from './infrastructure/prisma-notification-retention.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DAY = 86_400_000;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 90 * DAY);

describeIfDb('notification retention (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const store = new PrismaNotificationRetentionStore(
    prisma as unknown as PrismaService,
  );
  const tenants: string[] = [];
  const users: string[] = [];
  let tenantId: string;
  let userId: string;

  function scheduler(
    options: { batchSize?: number; maxBatchesPerTick?: number } = {},
  ) {
    return new NotificationRetentionScheduler(store, {
      clock: () => NOW,
      ...options,
    });
  }

  const notice = (createdAt: Date, over: Record<string, unknown> = {}) => ({
    tenantId,
    userId,
    type: 'REQUEST_CREATED',
    payload: {},
    createdAt,
    ...over,
  });

  const cursorsLeft = async () =>
    (
      await prisma.notification.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true },
      })
    ).map((n) => n.createdAt.getTime());

  beforeAll(async () => {
    tenantId = randomUUID();
    userId = randomUUID();
    tenants.push(tenantId);
    users.push(userId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Centro', slug: `nr-${tenantId}` },
    });
    await prisma.user.create({
      data: {
        id: userId,
        email: `nr-${userId}@nt.test`,
        hashedPassword: 'x',
        name: 'Ana',
      },
    });
  });

  beforeEach(async () => {
    // Test database only: the purge is global, so start from an empty table.
    await prisma.notification.deleteMany({});
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  it('deletes strictly older than 90 days: just before goes, the cutoff and just after stay', async () => {
    await prisma.notification.createMany({
      data: [
        notice(new Date(CUTOFF.getTime() - 1)),
        notice(CUTOFF),
        notice(new Date(CUTOFF.getTime() + 1)),
      ],
    });

    const run = await scheduler().purge();

    expect(run).toEqual({ removed: 1, batches: 1, hasMore: false });
    expect(await cursorsLeft()).toEqual([
      CUTOFF.getTime(),
      CUTOFF.getTime() + 1,
    ]);
  });

  it('removes old notices read or unread and keeps recent ones either way', async () => {
    const old = new Date(NOW.getTime() - 120 * DAY);
    const recent = new Date(NOW.getTime() - 5 * DAY);
    await prisma.notification.createMany({
      data: [
        notice(old),
        notice(old, { readAt: old }),
        notice(recent),
        notice(recent, { readAt: recent }),
      ],
    });

    await scheduler().purge();

    expect(await cursorsLeft()).toEqual([recent.getTime(), recent.getTime()]);
  });

  it('a single batch never exceeds the batch size', async () => {
    const old = new Date(NOW.getTime() - 100 * DAY);
    await prisma.notification.createMany({
      data: Array.from({ length: 25 }, () => notice(old)),
    });

    const run = await scheduler({
      batchSize: 10,
      maxBatchesPerTick: 1,
    }).purge();

    expect(run).toEqual({ removed: 10, batches: 1, hasMore: true });
    expect(await prisma.notification.count()).toBe(15);
  });

  it('is bounded per tick and the next tick keeps draining', async () => {
    const old = new Date(NOW.getTime() - 100 * DAY);
    await prisma.notification.createMany({
      data: Array.from({ length: 25 }, () => notice(old)),
    });
    const s = scheduler({ batchSize: 10, maxBatchesPerTick: 2 });

    await s.poll();
    expect(await prisma.notification.count()).toBe(5);
    await s.poll();
    expect(await prisma.notification.count()).toBe(0);
  });

  it('two concurrent runs delete every old row exactly once and neither fails', async () => {
    const old = new Date(NOW.getTime() - 100 * DAY);
    await prisma.notification.createMany({
      data: Array.from({ length: 300 }, () => notice(old)),
    });
    const fresh = new Date(NOW.getTime() - DAY);
    await prisma.notification.create({ data: notice(fresh) });

    const runs = await Promise.all([
      scheduler({ batchSize: 10 }).purge(),
      scheduler({ batchSize: 10 }).purge(),
      scheduler({ batchSize: 10 }).purge(),
    ]);

    expect(runs.reduce((sum, r) => sum + r.removed, 0)).toBe(300);
    expect(await cursorsLeft()).toEqual([fresh.getTime()]);
  });

  it('is index-backed: the purge query can be served by notifications_createdAt_idx', async () => {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_indexes
      WHERE tablename = 'notifications'
        AND indexname = 'notifications_createdAt_idx'`;
    expect(Number(count)).toBe(1);

    // With sequential scans disabled the planner must pick an index; the only
    // one that can answer `ORDER BY "createdAt" LIMIT` without a sort is ours.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN SELECT "id" FROM "notifications"
          WHERE "createdAt" < '2026-08-13T12:00:00Z'
          ORDER BY "createdAt" LIMIT 1000`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('notifications_createdAt_idx');
    expect(plan).not.toContain('Sort');
  });
});
