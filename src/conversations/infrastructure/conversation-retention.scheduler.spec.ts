/**
 * Unit spec of the conversation retention schedule (contract §3.6, §10.1
 * "Purga de 12 meses"). The purge itself is proven against PostgreSQL in
 * `conversation-retention.integration.spec.ts`; here it is a double and the
 * clock is injected, so the cadence is deterministic.
 */
import type { ConversationRetentionResult } from '../application/conversation-retention.service';
import {
  ConversationRetentionScheduler,
  type ConversationRetentionPort,
} from './conversation-retention.scheduler';

const T0 = new Date('2026-11-12T12:00:00.000Z');
const HOUR = 3_600_000;

const result = (hasMore: boolean): ConversationRetentionResult => ({
  mediaClaimed: 0,
  mediaPurged: 1,
  mediaFailed: 0,
  messagesDeleted: 2,
  conversationsDeleted: 0,
  hasMore,
});

function setup(
  options: { maxBatchesPerTick?: number; intervalMs?: number } = {},
  answers: Array<boolean | Error> = [],
) {
  let nowMs = T0.getTime();
  const calls: Array<{ batchSize?: number; runStartedAt?: Date }> = [];
  const queue = [...answers];
  const port: ConversationRetentionPort = {
    purgeBatch: (input) => {
      calls.push(input ?? {});
      const next = queue.shift() ?? false;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(result(next));
    },
  };
  const scheduler = new ConversationRetentionScheduler(port, {
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

describe('ConversationRetentionScheduler.purge', () => {
  it('stamps the whole run with ONE instant (rows that fail wait for the next run)', async () => {
    const { scheduler, calls } = setup({}, [true, true, false]);
    const run = await scheduler.purge();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.runStartedAt?.getTime()))).toEqual(
      new Set([T0.getTime()]),
    );
    expect(run).toMatchObject({ batches: 3, hasMore: false });
    expect(run.messagesDeleted).toBe(6);
  });

  it('asks for batches of 1 000 messages (contract performance row)', async () => {
    const { scheduler, calls } = setup({}, [false]);
    await scheduler.purge();
    expect(calls[0].batchSize).toBe(1000);
  });

  it('is bounded: never more than maxBatchesPerTick batches, and says there is more', async () => {
    const { scheduler, calls } = setup({ maxBatchesPerTick: 3 }, [
      true,
      true,
      true,
      true,
    ]);
    const run = await scheduler.purge();
    expect(calls).toHaveLength(3);
    expect(run).toMatchObject({ batches: 3, hasMore: true });
  });

  it('rejects a batch cap or interval that is not valid', () => {
    const port: ConversationRetentionPort = {
      purgeBatch: () => Promise.resolve(result(false)),
    };
    expect(
      () => new ConversationRetentionScheduler(port, { maxBatchesPerTick: 0 }),
    ).toThrow(/maxBatchesPerTick/);
    expect(
      () => new ConversationRetentionScheduler(port, { intervalMs: -1 }),
    ).toThrow(/intervalMs/);
  });
});

describe('ConversationRetentionScheduler.poll', () => {
  it('runs on the first tick, then waits for the interval', async () => {
    const { scheduler, calls, advance } = setup({ intervalMs: HOUR });
    await scheduler.poll();
    expect(calls).toHaveLength(1);
    advance(HOUR - 1);
    await scheduler.poll();
    expect(calls).toHaveLength(1);
    advance(1);
    await scheduler.poll();
    expect(calls).toHaveLength(2);
    expect(calls[1].runStartedAt?.getTime()).toBe(T0.getTime() + HOUR);
  });

  it('keeps draining on the next tick while the previous run hit the batch cap', async () => {
    const { scheduler, calls } = setup(
      { maxBatchesPerTick: 2, intervalMs: HOUR },
      [true, true, true, false],
    );
    await scheduler.poll(); // two full batches: more remains
    await scheduler.poll(); // still catching up: one full, one short
    expect(calls).toHaveLength(4);
    await scheduler.poll(); // drained: back to the interval
    expect(calls).toHaveLength(4);
  });

  it('never overlaps a run already in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const scheduler = new ConversationRetentionScheduler(
      {
        purgeBatch: async () => {
          started += 1;
          await gate;
          return result(false);
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

  it('never rejects out of the tick: a failing purge is retried at the next interval', async () => {
    const { scheduler, calls, advance } = setup({ intervalMs: HOUR }, [
      new Error('connection terminated'),
    ]);
    await expect(scheduler.poll()).resolves.toBeUndefined();
    await scheduler.poll(); // not due yet
    expect(calls).toHaveLength(1);
    advance(HOUR);
    await scheduler.poll();
    expect(calls).toHaveLength(2);
  });

  it('does not log customer data or storage keys when it fails', async () => {
    const lines: string[] = [];
    const { scheduler } = setup({}, [
      new Error('delete conversation-media/tenant/secret.jpg failed'),
    ]);
    const logger = (scheduler as unknown as { logger: { error: jest.Mock } })
      .logger;
    jest.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
    await scheduler.poll();
    expect(lines.join('\n')).not.toContain('conversation-media');
  });
});
