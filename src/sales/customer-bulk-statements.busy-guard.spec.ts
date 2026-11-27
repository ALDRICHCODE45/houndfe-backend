/**
 * customers-bulk-actions / T3 (S5) — one bulk statements run per process
 * (contract §3.3 guard 2): a second run while one is in progress →
 * `429 BULK_EXPORT_BUSY`; the slot is released in `finally` (success, error).
 */
import { HttpStatus } from '@nestjs/common';
import {
  BULK_EXPORT_RETRY_AFTER_SECONDS,
  BulkExportBusyException,
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

    gate.resolve('first');
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
