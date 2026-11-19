/**
 * Unit spec of the notification retention schedule (contract §5.2: 90 days;
 * §10.1 R11; unit 7b). The delete itself is proven against PostgreSQL in
 * `notification-retention.integration.spec.ts`; here the store is a double and
 * the clock is injected.
 */
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  NOTIFICATION_RETENTION_DAYS,
  NotificationRetentionScheduler,
  type NotificationRetentionPort,
} from './notification-retention.scheduler';
import { PrismaNotificationRetentionStore } from './prisma-notification-retention.store';

const T0 = new Date('2026-11-11T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

function setup(
  options: {
    batchSize?: number;
    maxBatchesPerTick?: number;
    intervalMs?: number;
  } = {},
  removals: Array<number | Error> = [],
) {
  let nowMs = T0.getTime();
  const calls: Array<{ cutoff: Date; batch: number }> = [];
  const queue = [...removals];
  const store: NotificationRetentionPort = {
    purgeOlderThan: (cutoff, batch) => {
      calls.push({ cutoff, batch });
      const next = queue.shift() ?? 0;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const scheduler = new NotificationRetentionScheduler(store, {
    clock: () => new Date(nowMs),
    ...options,
  });
  return {
    scheduler,
    calls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('NotificationRetentionScheduler.purge', () => {
  it('retains 90 days: the cutoff is exactly now minus 90 days of the injected clock', async () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    const { scheduler, calls } = setup({ batchSize: 250 }, [0]);
    const run = await scheduler.purge();
    expect(calls).toEqual([
      { cutoff: new Date(T0.getTime() - 90 * DAY), batch: 250 },
    ]);
    expect(run).toEqual({ removed: 0, batches: 1, hasMore: false });
  });

  it('stops at the first short batch', async () => {
    const { scheduler, calls } = setup({ batchSize: 10 }, [10, 10, 4, 99]);
    const run = await scheduler.purge();
    expect(calls).toHaveLength(3);
    expect(run).toEqual({ removed: 24, batches: 3, hasMore: false });
  });

  it('is bounded by maxBatchesPerTick and reports there is more', async () => {
    const { scheduler, calls } = setup(
      { batchSize: 10, maxBatchesPerTick: 3 },
      [10, 10, 10, 10, 10],
    );
    const run = await scheduler.purge();
    expect(calls).toHaveLength(3);
    expect(run).toEqual({ removed: 30, batches: 3, hasMore: true });
  });

  it('defaults to batches of 1 000', async () => {
    const { scheduler, calls } = setup({}, [0]);
    await scheduler.purge();
    expect(calls[0].batch).toBe(1000);
  });

  it('rejects options that are not positive integers', () => {
    const store: NotificationRetentionPort = {
      purgeOlderThan: () => Promise.resolve(0),
    };
    expect(
      () => new NotificationRetentionScheduler(store, { batchSize: 0 }),
    ).toThrow(/batchSize/);
    expect(
      () =>
        new NotificationRetentionScheduler(store, { maxBatchesPerTick: 1.5 }),
    ).toThrow(/maxBatchesPerTick/);
    expect(
      () => new NotificationRetentionScheduler(store, { intervalMs: -1 }),
    ).toThrow(/intervalMs/);
  });
});

describe('NotificationRetentionScheduler.poll', () => {
  it('runs on the first tick, then waits for the interval (injected clock)', async () => {
    const { scheduler, calls, advance } = setup(
      { intervalMs: HOUR },
      [0, 0, 0],
    );
    await scheduler.poll();
    expect(calls).toHaveLength(1);

    advance(HOUR - 1);
    await scheduler.poll();
    expect(calls).toHaveLength(1);

    advance(1);
    await scheduler.poll();
    expect(calls).toHaveLength(2);
    expect(calls[1].cutoff.getTime()).toBe(T0.getTime() + HOUR - 90 * DAY);
  });

  it('keeps draining on the next tick while the previous run hit the batch cap', async () => {
    const { scheduler, calls } = setup(
      { batchSize: 5, maxBatchesPerTick: 2, intervalMs: HOUR },
      [5, 5, 5, 2],
    );
    await scheduler.poll();
    await scheduler.poll();
    expect(calls).toHaveLength(4);
    await scheduler.poll();
    expect(calls).toHaveLength(4);
  });

  it('never overlaps a run already in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const scheduler = new NotificationRetentionScheduler(
      {
        purgeOlderThan: async () => {
          started += 1;
          await gate;
          return 0;
        },
      },
      { clock: () => T0, intervalMs: 0 },
    );
    const first = scheduler.poll();
    await scheduler.poll();
    expect(started).toBe(1);
    release();
    await first;
  });

  it('never rejects out of the tick: a failure is retried at the next interval', async () => {
    const { scheduler, calls, advance } = setup({ intervalMs: HOUR }, [
      new Error('connection terminated'),
      0,
    ]);
    await expect(scheduler.poll()).resolves.toBeUndefined();
    await scheduler.poll();
    expect(calls).toHaveLength(1);
    advance(HOUR);
    await scheduler.poll();
    expect(calls).toHaveLength(2);
  });
});

describe('PrismaNotificationRetentionStore.purgeOlderThan query shape', () => {
  function capture(affected: number) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const prisma = {
      $executeRaw: (query: { sql: string; values: unknown[] }) => {
        queries.push(query);
        return Promise.resolve(affected);
      },
    } as unknown as PrismaService;
    return { store: new PrismaNotificationRetentionStore(prisma), queries };
  }

  it('deletes one oldest-first batch behind (createdAt) with FOR UPDATE SKIP LOCKED, strictly before the cutoff', async () => {
    const { store, queries } = capture(7);
    const cutoff = new Date('2026-08-13T12:00:00.000Z');
    expect(await store.purgeOlderThan(cutoff, 500)).toBe(7);
    const text = queries[0].sql.replace(/\s+/g, ' ');
    expect(text).toContain('"createdAt" < ');
    expect(text).toContain('ORDER BY "createdAt"');
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain('DELETE FROM "notifications"');
    // Only `notifications`: nothing else is retained or purged here.
    expect(text.match(/"[a-z_]+"/g)).not.toContain('"chatbot_requests"');
    expect(queries[0].values).toEqual([cutoff, 500]);
  });

  it('refuses a batch that is not a positive integer', async () => {
    const { store, queries } = capture(0);
    await expect(store.purgeOlderThan(new Date(), 0)).rejects.toThrow(/batch/);
    expect(queries).toHaveLength(0);
  });
});
