/**
 * The tick of the schedule sweep (unit 14): keyset paging past rows it could
 * not act on, bounded per tick, every counter summed and logged.
 */
import { Logger } from '@nestjs/common';
import { ScheduleSweepScheduler } from './schedule-sweep.scheduler';
import type {
  ScheduleDueCursor,
  ScheduleSweepResult,
} from './schedule-sweep.store';

const EMPTY: ScheduleSweepResult = {
  candidates: 0,
  reminders: 0,
  notices: 0,
  flagged: 0,
  settled: 0,
  stale: 0,
  skipped: 0,
  failed: 0,
};
const NOW = new Date('2026-11-12T12:00:00.000Z');
const cursor = (n: number): ScheduleDueCursor => ({
  dueAt: new Date(NOW.getTime() - 1000 + n),
  id: `id-${n}`,
});

function fakeStore(pages: Array<Partial<ScheduleSweepResult>>) {
  const runBatch = jest.fn();
  pages.forEach((page, n) =>
    runBatch.mockResolvedValueOnce({
      ...EMPTY,
      ...page,
      last: page.candidates ? cursor(n + 1) : null,
    }),
  );
  const store = { batchSize: 100, runBatch };
  return { store, scheduler: new ScheduleSweepScheduler(store as never) };
}

describe('ScheduleSweepScheduler.tick', () => {
  it('pages past a batch that was all stale, skipped or failed and reaches the due row behind it', async () => {
    const { store, scheduler } = fakeStore([
      { candidates: 100, stale: 50, skipped: 20, failed: 30 },
      { candidates: 1, reminders: 1 },
    ]);
    const total = await scheduler.tick(NOW);
    expect(store.runBatch).toHaveBeenCalledTimes(2);
    expect(store.runBatch).toHaveBeenNthCalledWith(1, NOW, null);
    expect(store.runBatch).toHaveBeenNthCalledWith(2, NOW, cursor(1));
    expect(total).toMatchObject({
      candidates: 101,
      reminders: 1,
      stale: 50,
      skipped: 20,
      failed: 30,
    });
  });

  it('stops on a short batch', async () => {
    const { store, scheduler } = fakeStore([{ candidates: 3, notices: 3 }]);
    await scheduler.tick(NOW);
    expect(store.runBatch).toHaveBeenCalledTimes(1);
  });

  it('is bounded per tick: five full pages and a warning', async () => {
    const { store, scheduler } = fakeStore(
      Array<Partial<ScheduleSweepResult>>(8).fill({
        candidates: 100,
        skipped: 100,
      }),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await scheduler.tick(NOW);
      expect(store.runBatch).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs every counter of a tick that did something, and never rejects', async () => {
    const { store, scheduler } = fakeStore([
      { candidates: 2, reminders: 1, notices: 1, flagged: 1 },
    ]);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      await scheduler.poll();
      expect(log).toHaveBeenCalledWith(
        'schedule sweep: 1 reminders, 1 notices, 1 flagged, 0 settled, 0 stale, 0 skipped, 0 failed',
      );
      store.runBatch.mockRejectedValueOnce(new Error('db down'));
      await expect(scheduler.poll()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
