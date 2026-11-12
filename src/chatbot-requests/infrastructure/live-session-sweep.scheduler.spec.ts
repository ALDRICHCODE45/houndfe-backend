/**
 * The tick of the live session sweep (unit 11, review advisory A4): it pages
 * past rows it could not act on, is bounded per tick, and counts every
 * phase's failures.
 */
import { Logger } from '@nestjs/common';
import { LiveSessionSweepScheduler } from './live-session-sweep.scheduler';
import type { DueCursor, SessionSweepResult } from './live-session-sweep.store';

const EMPTY: SessionSweepResult = {
  candidates: 0,
  reverted: 0,
  ended: 0,
  idleEnded: 0,
  noticed: 0,
  settledDeferred: 0,
  skipped: 0,
  failed: 0,
};
const NOW = new Date('2026-11-12T12:00:00.000Z');
const cursor = (n: number): DueCursor => ({
  dueAt: new Date(NOW.getTime() - 1000 + n),
  id: `id-${n}`,
});

function fakeStore(pages: Array<Partial<SessionSweepResult>>) {
  const runBatch = jest.fn();
  pages.forEach((page, n) =>
    runBatch.mockResolvedValueOnce({
      ...EMPTY,
      ...page,
      last: page.candidates ? cursor(n + 1) : null,
    }),
  );
  const store = {
    batchSize: 100,
    runBatch,
    runNoticeBatch: jest.fn().mockResolvedValue({ noticed: 0, failed: 0 }),
    runDeferredBatch: jest
      .fn()
      .mockResolvedValue({ settledDeferred: 0, failed: 0 }),
  };
  return { store, scheduler: new LiveSessionSweepScheduler(store as never) };
}

describe('LiveSessionSweepScheduler.tick', () => {
  it('pages past a batch that was all skipped or failed and processes the due row behind it', async () => {
    const { store, scheduler } = fakeStore([
      { candidates: 100, skipped: 60, failed: 40 },
      { candidates: 1, reverted: 1 },
    ]);
    const total = await scheduler.tick(NOW);
    expect(store.runBatch).toHaveBeenCalledTimes(2);
    expect(store.runBatch).toHaveBeenNthCalledWith(1, NOW, null);
    expect(store.runBatch).toHaveBeenNthCalledWith(2, NOW, cursor(1));
    expect(total).toMatchObject({
      candidates: 101,
      reverted: 1,
      skipped: 60,
      failed: 40,
    });
  });

  it('stops on a short batch', async () => {
    const { store, scheduler } = fakeStore([{ candidates: 3, ended: 3 }]);
    await scheduler.tick(NOW);
    expect(store.runBatch).toHaveBeenCalledTimes(1);
  });

  it('is bounded per tick: five full pages, then the notice and deferred phases still run', async () => {
    const full = { candidates: 100, skipped: 100 };
    const { store, scheduler } = fakeStore(
      Array<Partial<SessionSweepResult>>(8).fill(full),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await scheduler.tick(NOW);
      expect(store.runBatch).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(store.runNoticeBatch).toHaveBeenCalledTimes(1);
    expect(store.runDeferredBatch).toHaveBeenCalledTimes(1);
  });

  it('counts the failures of the notice and deferred phases in failed and sums every counter', async () => {
    const { store, scheduler } = fakeStore([{ candidates: 2, failed: 1 }]);
    store.runNoticeBatch.mockResolvedValue({ noticed: 4, failed: 2 });
    store.runDeferredBatch.mockResolvedValue({ settledDeferred: 3, failed: 5 });
    const total = await scheduler.tick(NOW);
    expect(total).toMatchObject({
      noticed: 4,
      settledDeferred: 3,
      failed: 1 + 2 + 5,
    });
  });

  it('logs every counter of a tick that did something', async () => {
    const { store, scheduler } = fakeStore([{ candidates: 1, ended: 1 }]);
    store.runNoticeBatch.mockResolvedValue({ noticed: 4, failed: 0 });
    store.runDeferredBatch.mockResolvedValue({ settledDeferred: 3, failed: 1 });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      await scheduler.poll();
      expect(log).toHaveBeenCalledWith(
        'live session sweep: 0 reverted, 1 ended, 0 idle-ended, 4 noticed, 3 deferred settled, 0 skipped, 1 failed',
      );
    } finally {
      log.mockRestore();
    }
  });
});
