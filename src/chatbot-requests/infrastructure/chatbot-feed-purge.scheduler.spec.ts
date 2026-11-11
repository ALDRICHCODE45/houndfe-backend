/**
 * Unit spec of the chatbot feed retention schedule (contract §3.3, §10.1 R11;
 * unit 7b). The purge itself (`PrismaChatbotFeedStore.purgeExpired`: 30 days,
 * `FOR UPDATE SKIP LOCKED`, watermark) is proven against PostgreSQL in
 * `chatbot-feed-purge.integration.spec.ts`; here the store is a double and the
 * clock is injected, so the schedule is deterministic.
 */
import {
  ChatbotFeedPurgeScheduler,
  type ChatbotFeedPurgePort,
} from './chatbot-feed-purge.scheduler';

const T0 = new Date('2026-11-11T12:00:00.000Z');
const HOUR = 3_600_000;

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
  const store: ChatbotFeedPurgePort = {
    purgeExpired: (now, batch) => {
      calls.push({ now, batch });
      const next = queue.shift() ?? 0;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const scheduler = new ChatbotFeedPurgeScheduler(store, {
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

describe('ChatbotFeedPurgeScheduler.purge', () => {
  it('passes the injected clock instant and the batch size to the store', async () => {
    const { scheduler, calls } = setup({ batchSize: 250 }, [0]);
    const run = await scheduler.purge();
    expect(calls).toEqual([{ now: T0, batch: 250 }]);
    expect(run).toEqual({ removed: 0, batches: 1, hasMore: false });
  });

  it('stops at the first short batch', async () => {
    const { scheduler, calls } = setup({ batchSize: 10 }, [10, 10, 4, 99]);
    const run = await scheduler.purge();
    expect(calls).toHaveLength(3);
    expect(run).toEqual({ removed: 24, batches: 3, hasMore: false });
  });

  it('is bounded: never runs more than maxBatchesPerTick batches, and reports there is more', async () => {
    const { scheduler, calls } = setup(
      { batchSize: 10, maxBatchesPerTick: 3 },
      [10, 10, 10, 10, 10],
    );
    const run = await scheduler.purge();
    expect(calls).toHaveLength(3);
    expect(run).toEqual({ removed: 30, batches: 3, hasMore: true });
  });

  it('defaults to batches of 1 000 (contract performance row)', async () => {
    const { scheduler, calls } = setup({}, [0]);
    await scheduler.purge();
    expect(calls[0].batch).toBe(1000);
  });

  it('rejects a batch size or batch cap that is not a positive integer', () => {
    const store: ChatbotFeedPurgePort = {
      purgeExpired: () => Promise.resolve(0),
    };
    expect(
      () => new ChatbotFeedPurgeScheduler(store, { batchSize: 0 }),
    ).toThrow(/batchSize/);
    expect(
      () => new ChatbotFeedPurgeScheduler(store, { maxBatchesPerTick: 1.5 }),
    ).toThrow(/maxBatchesPerTick/);
    expect(
      () => new ChatbotFeedPurgeScheduler(store, { intervalMs: -1 }),
    ).toThrow(/intervalMs/);
  });
});

describe('ChatbotFeedPurgeScheduler.poll', () => {
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
    expect(calls[1].now.getTime()).toBe(T0.getTime() + HOUR);
  });

  it('keeps draining on the next tick while the previous run hit the batch cap', async () => {
    const { scheduler, calls } = setup(
      { batchSize: 5, maxBatchesPerTick: 2, intervalMs: HOUR },
      [5, 5, 5, 2],
    );
    await scheduler.poll(); // 2 full batches: more remains
    await scheduler.poll(); // same instant, still catching up: 5 + 2
    expect(calls).toHaveLength(4);
    await scheduler.poll(); // drained: back to the interval
    expect(calls).toHaveLength(4);
  });

  it('never overlaps a run already in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const scheduler = new ChatbotFeedPurgeScheduler(
      {
        purgeExpired: async () => {
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

  it('never rejects out of the tick: a failing purge is logged and retried at the next interval', async () => {
    const { scheduler, calls, advance } = setup({ intervalMs: HOUR }, [
      new Error('connection terminated'),
      0,
    ]);
    await expect(scheduler.poll()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);

    await scheduler.poll(); // not due yet
    expect(calls).toHaveLength(1);

    advance(HOUR);
    await scheduler.poll();
    expect(calls).toHaveLength(2);
  });

  it('releases the in-flight guard after a failure', async () => {
    const { scheduler, calls } = setup({ intervalMs: 0 }, [
      new Error('boom'),
      0,
    ]);
    await scheduler.poll();
    await scheduler.poll();
    expect(calls).toHaveLength(2);
  });
});
