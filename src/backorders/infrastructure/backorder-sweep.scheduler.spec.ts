/**
 * The tick of the backorder sweep (restock-backorder T2b): three phases in a
 * fixed order (due timers, lots, safety net), keyset paging past rows it could
 * not act on, bounded per phase, every counter summed, `@Interval(30 s)`, never
 * overlapping and never rejecting out of the interval.
 */
import { Logger } from '@nestjs/common';
import { SCHEDULE_INTERVAL_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import {
  BACKORDER_SWEEP_INTERVAL_MS,
  BackorderSweepScheduler,
} from './backorder-sweep.scheduler';
import type {
  BackorderSweepResult,
  DueCursor,
  LotCursor,
  QueueCursor,
} from './backorder-sweep.store';

const EMPTY: BackorderSweepResult = {
  candidates: 0,
  reminders: 0,
  expired: 0,
  swapped: 0,
  lost: 0,
  notHeld: 0,
  allocated: 0,
  stale: 0,
  skipped: 0,
  failed: 0,
};
const NOW = new Date('2026-11-21T12:00:00.000Z');
const dueCursor = (n: number): DueCursor => ({
  reservedUntil: new Date(NOW.getTime() - 1000 + n),
  id: `id-${n}`,
});

function page<Cursor>(
  result: Partial<BackorderSweepResult>,
  cursor: Cursor,
): BackorderSweepResult & { last: Cursor | null } {
  return { ...EMPTY, ...result, last: result.candidates ? cursor : null };
}

function fakeStore(
  pages: {
    due?: Array<Partial<BackorderSweepResult>>;
    lot?: Array<Partial<BackorderSweepResult>>;
    queue?: Array<Partial<BackorderSweepResult>>;
  } = {},
) {
  const runDueBatch = jest.fn();
  const runLotBatch = jest.fn();
  const runAllocateBatch = jest.fn();
  (pages.due ?? [{}]).forEach((p, n) =>
    runDueBatch.mockResolvedValueOnce(page(p, dueCursor(n + 1))),
  );
  (pages.lot ?? [{}]).forEach((p, n) =>
    runLotBatch.mockResolvedValueOnce(page<LotCursor>(p, { id: `l-${n + 1}` })),
  );
  (pages.queue ?? [{}]).forEach((p, n) =>
    runAllocateBatch.mockResolvedValueOnce(
      page<QueueCursor>(p, {
        tenantId: 't',
        productId: `p-${n + 1}`,
        variantKey: '',
      }),
    ),
  );
  const store = { batchSize: 100, runDueBatch, runLotBatch, runAllocateBatch };
  return {
    store,
    scheduler: new BackorderSweepScheduler(store as never),
  };
}

describe('BackorderSweepScheduler.tick', () => {
  it('runs due timers, then lots, then the safety net, once each on an idle sweep', async () => {
    const order: string[] = [];
    const idle = (name: string) =>
      jest.fn(() => {
        order.push(name);
        return Promise.resolve(page({}, null));
      });
    const store = {
      batchSize: 100,
      runDueBatch: idle('due'),
      runLotBatch: idle('lot'),
      runAllocateBatch: idle('queue'),
    };
    const scheduler = new BackorderSweepScheduler(store as never);
    expect(await scheduler.tick(NOW)).toEqual(EMPTY);
    expect(order).toEqual(['due', 'lot', 'queue']);
    expect(store.runDueBatch).toHaveBeenCalledWith(NOW, null);
    expect(store.runLotBatch).toHaveBeenCalledWith(NOW, null);
    expect(store.runAllocateBatch).toHaveBeenCalledWith(NOW, null);
  });

  it('pages past a due batch that was all stale, skipped or failed and reaches the row behind it', async () => {
    const { store, scheduler } = fakeStore({
      due: [
        { candidates: 100, stale: 50, skipped: 20, failed: 30 },
        { candidates: 1, expired: 1 },
      ],
    });
    const total = await scheduler.tick(NOW);
    expect(store.runDueBatch).toHaveBeenCalledTimes(2);
    expect(store.runDueBatch).toHaveBeenNthCalledWith(1, NOW, null);
    expect(store.runDueBatch).toHaveBeenNthCalledWith(2, NOW, dueCursor(1));
    expect(total).toMatchObject({
      candidates: 101,
      expired: 1,
      stale: 50,
      skipped: 20,
      failed: 30,
    });
  });

  it('sums the counters of the three phases', async () => {
    const { scheduler } = fakeStore({
      due: [{ candidates: 3, reminders: 2, expired: 1 }],
      lot: [{ candidates: 2, swapped: 1, lost: 1 }],
      queue: [{ candidates: 1, allocated: 2 }],
    });
    expect(await scheduler.tick(NOW)).toMatchObject({
      candidates: 6,
      reminders: 2,
      expired: 1,
      swapped: 1,
      lost: 1,
      allocated: 2,
    });
  });

  it('is bounded per phase: five full pages and a warning', async () => {
    const { store, scheduler } = fakeStore({
      queue: Array<Partial<BackorderSweepResult>>(8).fill({
        candidates: 100,
        skipped: 100,
      }),
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await scheduler.tick(NOW);
      expect(store.runAllocateBatch).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the counters of a tick that did something, never rejects, and never overlaps', async () => {
    const { store, scheduler } = fakeStore({
      due: [{ candidates: 2, reminders: 1, expired: 1 }],
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      await scheduler.poll();
      expect(log).toHaveBeenCalledWith(
        'backorder sweep: 1 reminders, 1 expired, 0 lots swapped, 0 reservations lost, 0 not held, 0 allocated, 0 stale, 0 skipped, 0 failed',
      );
      store.runDueBatch.mockRejectedValueOnce(new Error('db down'));
      await expect(scheduler.poll()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(1);

      // A second poll while one is running returns at once.
      let release!: () => void;
      store.runDueBatch.mockReturnValueOnce(
        new Promise((resolve) => {
          release = () => resolve(page({}, null));
        }),
      );
      const calls = store.runDueBatch.mock.calls.length;
      const first = scheduler.poll();
      await scheduler.poll();
      expect(store.runDueBatch.mock.calls.length).toBe(calls + 1);
      release();
      await first;
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('is an @Interval of 30 seconds', () => {
    expect(BACKORDER_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(
      Reflect.getMetadata(
        SCHEDULE_INTERVAL_OPTIONS,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- decorator metadata is read off the prototype function
        BackorderSweepScheduler.prototype.poll,
      ),
    ).toEqual({ timeout: 30_000 });
  });
});
