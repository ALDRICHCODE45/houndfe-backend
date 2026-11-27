/**
 * customers-bulk-actions / T3 (S5) — one bulk statements run per process
 * (contract §3.3 guard 2): a second run while one is in progress →
 * `429 BULK_EXPORT_BUSY`; the slot is released in `finally` (success, error).
 */
import { HttpStatus } from '@nestjs/common';
import {
  BULK_EXPORT_RETRY_AFTER_SECONDS,
  BULK_STATEMENTS_RUN_DEADLINE_MS,
  BulkExportBusyException,
  BulkExportTimeoutException,
  BulkStatementsAbortedError,
  CustomerBulkStatementsRunGuard,
} from './customer-bulk-statements.busy-guard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CustomerBulkStatementsRunGuard', () => {
  it('runs the work and returns its result', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    await expect(guard.run(() => Promise.resolve(42))).resolves.toBe(42);
    expect(guard.busy).toBe(false);
  });

  it('a second run while one is in progress → 429 BULK_EXPORT_BUSY, the second work never starts', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    const gate = deferred<string>();
    const first = guard.run(() => gate.promise);
    expect(guard.busy).toBe(true);

    const second = jest.fn(() => Promise.resolve('second'));
    try {
      const error = await guard.run(second).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BulkExportBusyException);
      expect((error as BulkExportBusyException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect((error as BulkExportBusyException).getResponse()).toEqual({
        statusCode: 429,
        code: 'BULK_EXPORT_BUSY',
        message: 'another bulk statements download is in progress; retry later',
        details: { retryAfterSeconds: BULK_EXPORT_RETRY_AFTER_SECONDS },
      });
      expect(second).not.toHaveBeenCalled();
    } finally {
      gate.resolve('first');
    }
    await expect(first).resolves.toBe('first');
    expect(guard.busy).toBe(false);
    await expect(guard.run(second)).resolves.toBe('second');
  });

  it('releases the slot when the work rejects', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    await expect(
      guard.run(() => Promise.reject(new Error('render failed'))),
    ).rejects.toThrow('render failed');
    expect(guard.busy).toBe(false);
    await expect(guard.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('releases the slot when the work throws synchronously', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    await expect(
      guard.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(guard.busy).toBe(false);
  });

  it('Retry-After is 10 seconds', () => {
    expect(BULK_EXPORT_RETRY_AFTER_SECONDS).toBe(10);
  });
});

/**
 * R4-001: the slot is time-bounded. A run that does not settle within the
 * deadline (stalled query, stuck render) fails with `503
 * BULK_EXPORT_TIMEOUT` and frees the slot without waiting for the work; a
 * client abort frees it at once too. A late-settling work never re-takes or
 * double-releases the slot.
 */
describe('CustomerBulkStatementsRunGuard — deadline and abort', () => {
  const gates: Array<{ resolve: (value: string) => void }> = [];
  const held = () => {
    const gate = deferred<string>();
    gates.push(gate);
    return gate;
  };
  // A failing assertion must not leave a pending work behind.
  afterEach(() => {
    for (const gate of gates.splice(0)) gate.resolve('released');
  });

  it('the default per-run deadline is 120 s', () => {
    expect(BULK_STATEMENTS_RUN_DEADLINE_MS).toBe(120_000);
  });

  it('a work that never settles → 503 BULK_EXPORT_TIMEOUT after the deadline; the slot is free and the work signal aborted', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    const gate = held();
    let workSignal: AbortSignal | undefined;
    const error = await guard
      .run(
        (signal) => {
          workSignal = signal;
          return gate.promise;
        },
        { deadlineMs: 20 },
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BulkExportTimeoutException);
    expect((error as BulkExportTimeoutException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((error as BulkExportTimeoutException).getResponse()).toEqual({
      statusCode: 503,
      code: 'BULK_EXPORT_TIMEOUT',
      message:
        'the bulk statements download took too long and was stopped; retry with fewer customers',
      details: { deadlineSeconds: 0.02 },
    });
    expect(guard.busy).toBe(false);
    expect(workSignal?.aborted).toBe(true);
  });

  it('a late-settling work neither re-takes nor double-releases the slot held by the next run', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    const stuck = held();
    await expect(
      guard.run(() => stuck.promise, { deadlineMs: 10 }),
    ).rejects.toBeInstanceOf(BulkExportTimeoutException);

    const next = held();
    const second = guard.run(() => next.promise);
    expect(guard.busy).toBe(true);

    // The stuck work finally settles: the next run keeps the slot.
    stuck.resolve('late');
    await new Promise(setImmediate);
    expect(guard.busy).toBe(true);
    await expect(guard.run(() => Promise.resolve('x'))).rejects.toBeInstanceOf(
      BulkExportBusyException,
    );

    next.resolve('second');
    await expect(second).resolves.toBe('second');
    expect(guard.busy).toBe(false);
  });

  it('a late rejection of a timed-out work is swallowed (no unhandled rejection) and leaves the slot alone', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    const stuck = deferred<string>();
    await expect(
      guard.run(() => stuck.promise, { deadlineMs: 10 }),
    ).rejects.toBeInstanceOf(BulkExportTimeoutException);
    const next = held();
    const second = guard.run(() => next.promise);

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      stuck.reject(new Error('late failure'));
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      expect(unhandled).not.toHaveBeenCalled();
      expect(guard.busy).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    next.resolve('second');
    await expect(second).resolves.toBe('second');
  });

  it('a client abort during a stuck work frees the slot at once (no wait for the work) and aborts the work signal', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    const client = new AbortController();
    const gate = held();
    let workSignal: AbortSignal | undefined;
    const run = guard.run(
      (signal) => {
        workSignal = signal;
        return gate.promise;
      },
      { signal: client.signal },
    );
    await new Promise(setImmediate);
    expect(guard.busy).toBe(true);

    client.abort();
    await expect(run).rejects.toBeInstanceOf(BulkStatementsAbortedError);
    expect(guard.busy).toBe(false);
    expect(workSignal?.aborted).toBe(true);
  });

  it('an already-aborted client signal never starts the work', async () => {
    const guard = new CustomerBulkStatementsRunGuard();
    const client = new AbortController();
    client.abort();
    const work = jest.fn(() => Promise.resolve('x'));
    await expect(
      guard.run(work, { signal: client.signal }),
    ).rejects.toBeInstanceOf(BulkStatementsAbortedError);
    expect(work).not.toHaveBeenCalled();
    expect(guard.busy).toBe(false);
  });

  it('a work that finishes in time clears the deadline timer (no timeout afterwards)', async () => {
    jest.useFakeTimers();
    try {
      const guard = new CustomerBulkStatementsRunGuard();
      await expect(
        guard.run(() => Promise.resolve('ok'), { deadlineMs: 1_000 }),
      ).resolves.toBe('ok');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
