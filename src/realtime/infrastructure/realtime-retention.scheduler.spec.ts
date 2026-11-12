/**
 * Unit spec of the realtime retention schedule (contract §5.3, §10.1 R11). The
 * purge SQL is proven against PostgreSQL in `realtime-event-log.integration.spec.ts`;
 * here the store is a double and the clock is injected.
 */
import { Logger } from '@nestjs/common';
import {
  RealtimeRetentionScheduler,
  type RealtimePurgePort,
} from './realtime-retention.scheduler';

const T0 = new Date('2026-11-11T12:00:00.000Z');
const MIN = 60_000;

function setup(
  options: {
    batchSize?: number;
    maxBatchesPerTick?: number;
    intervalMs?: number;
  } = {},
  removals: Array<number | Error> = [],
) {
  let nowMs = T0.getTime();
  const calls: Array<{ now: Date; batch: number }> = [];
  const queue = [...removals];
  const store: RealtimePurgePort = {
    purgeExpired: (now, batch) => {
      calls.push({ now, batch });
      const next = queue.shift() ?? 0;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const scheduler = new RealtimeRetentionScheduler(store, {
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

describe('RealtimeRetentionScheduler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes the injected instant and the batch size to the store', async () => {
    const { scheduler, calls } = setup({ batchSize: 250 }, [0]);
    expect(await scheduler.purge()).toEqual({
      removed: 0,
      batches: 1,
      hasMore: false,
    });
    expect(calls).toEqual([{ now: T0, batch: 250 }]);
  });

  it('stops at the first short batch', async () => {
    const { scheduler, calls } = setup({ batchSize: 10 }, [10, 10, 4, 99]);
    expect(await scheduler.purge()).toEqual({
      removed: 24,
      batches: 3,
      hasMore: false,
    });
    expect(calls).toHaveLength(3);
  });

  it('is bounded per tick and reports a backlog', async () => {
    const { scheduler, calls } = setup(
      { batchSize: 10, maxBatchesPerTick: 3 },
      [10, 10, 10, 10, 10],
    );
    expect(await scheduler.purge()).toEqual({
      removed: 30,
      batches: 3,
      hasMore: true,
    });
    expect(calls).toHaveLength(3);
  });

  it('runs once per interval and catches up immediately after a capped run', async () => {
    const { scheduler, calls, advance } = setup(
      { batchSize: 5, maxBatchesPerTick: 1, intervalMs: 10 * MIN },
      [5, 5, 0],
    );
    await scheduler.poll(); // runs, capped: backlog
    advance(MIN);
    await scheduler.poll(); // catching up: runs again at once
    advance(MIN);
    await scheduler.poll(); // drained: waits for the interval
    expect(calls).toHaveLength(3);
    advance(MIN);
    await scheduler.poll();
    expect(calls).toHaveLength(3);
    advance(10 * MIN);
    await scheduler.poll();
    expect(calls).toHaveLength(4);
  });

  it('a failing purge never rejects and is retried at the next interval', async () => {
    const { scheduler, calls, advance } = setup({ intervalMs: 10 * MIN }, [
      new Error('db down'),
      0,
    ]);
    await expect(scheduler.poll()).resolves.toBeUndefined();
    advance(MIN);
    await scheduler.poll();
    expect(calls).toHaveLength(1);
    advance(10 * MIN);
    await scheduler.poll();
    expect(calls).toHaveLength(2);
  });

  it('does not overlap two ticks of one process', async () => {
    let release: (n: number) => void = () => undefined;
    const store: RealtimePurgePort = {
      purgeExpired: () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    };
    const scheduler = new RealtimeRetentionScheduler(store, {
      intervalMs: 0,
      clock: () => T0,
    });
    const first = scheduler.poll();
    await scheduler.poll();
    release(0);
    await first;
  });

  it('rejects invalid options', () => {
    expect(
      () =>
        new RealtimeRetentionScheduler(
          { purgeExpired: () => Promise.resolve(0) },
          {
            batchSize: 0,
          },
        ),
    ).toThrow('batchSize');
  });
});
