/**
 * customers-bulk-actions / T3 (S5) — one bulk statements run per process
 * (`docs/proposals/customers-bulk-actions-contract.md` §3.3 guard 2).
 *
 * Rendering is CPU work on the API event loop; two users stacking 50-PDF runs
 * would double the stall. A second run while one is in progress fails fast
 * with `429 BULK_EXPORT_BUSY` (the controller adds `Retry-After`). The slot is
 * in memory (one Nest singleton per process; with several replicas the guard
 * is per replica) and is shared by ALL tenants of the process, on purpose: it
 * protects the process CPU, not a tenant.
 *
 * The slot is time-bounded (review R4-001): the work is raced against a
 * per-run deadline (`BULK_STATEMENTS_RUN_DEADLINE_MS`, 120 s) and against
 * the caller's abort signal (client disconnect). Whichever comes first — the
 * work settling, the deadline (`503 BULK_EXPORT_TIMEOUT`) or the abort
 * (`BulkStatementsAbortedError`) — settles the run and frees the slot at
 * once, without waiting for a stuck statement read or render. The work gets
 * an abort signal that fires on deadline / abort, so it stops before its
 * next step; whatever it does after that (a late render resolving or
 * rejecting) is ignored and never touches the slot again, which may already
 * belong to the next run (ownership is checked with a per-run token).
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

export const BULK_EXPORT_BUSY = 'BULK_EXPORT_BUSY';
export const BULK_EXPORT_RETRY_AFTER_SECONDS = 10;
export const BULK_EXPORT_TIMEOUT = 'BULK_EXPORT_TIMEOUT';
/**
 * Upper bound of one bulk statements run while it holds the slot. 50
 * statements take ≈ 3–11 s with the real renderer (T3 measurements), so 120 s
 * only cuts runs that are stuck (stalled query, renderer waiting on a remote
 * resource).
 */
export const BULK_STATEMENTS_RUN_DEADLINE_MS = 120_000;

export class BulkExportBusyException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: BULK_EXPORT_BUSY,
        message: 'another bulk statements download is in progress; retry later',
        details: { retryAfterSeconds: BULK_EXPORT_RETRY_AFTER_SECONDS },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class BulkExportTimeoutException extends HttpException {
  constructor(deadlineMs: number = BULK_STATEMENTS_RUN_DEADLINE_MS) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: BULK_EXPORT_TIMEOUT,
        message:
          'the bulk statements download took too long and was stopped; retry with fewer customers',
        details: { deadlineSeconds: deadlineMs / 1000 },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** The client closed the connection; the run was stopped. */
export class BulkStatementsAbortedError extends Error {
  constructor() {
    super('bulk statements request aborted by the client');
    this.name = 'BulkStatementsAbortedError';
  }
}

export interface BulkStatementsRunOptions {
  /** Caller abort (client disconnect): stops the run and frees the slot. */
  signal?: AbortSignal;
  /** Defaults to `BULK_STATEMENTS_RUN_DEADLINE_MS`. */
  deadlineMs?: number;
}

@Injectable()
export class CustomerBulkStatementsRunGuard {
  /** The run that holds the slot (`null` = free). */
  private holder: object | null = null;

  get busy(): boolean {
    return this.holder !== null;
  }

  /**
   * Runs `work` holding the process-wide slot; busy →
   * `BulkExportBusyException`. Settles on the first of: work settled,
   * deadline (`BulkExportTimeoutException`), caller abort
   * (`BulkStatementsAbortedError`). `work` receives a signal that fires on
   * deadline or abort.
   */
  async run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: BulkStatementsRunOptions = {},
  ): Promise<T> {
    if (this.holder !== null) throw new BulkExportBusyException();
    const token = {};
    this.holder = token;

    const deadlineMs = options.deadlineMs ?? BULK_STATEMENTS_RUN_DEADLINE_MS;
    const workAbort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onCallerAbort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const stop = (error: Error) => {
          workAbort.abort(error);
          reject(error);
        };
        if (options.signal?.aborted) {
          stop(new BulkStatementsAbortedError());
          return;
        }
        timer = setTimeout(
          () => stop(new BulkExportTimeoutException(deadlineMs)),
          deadlineMs,
        );
        // Never keep the process alive just for this timer.
        timer.unref();
        if (options.signal) {
          onCallerAbort = () => stop(new BulkStatementsAbortedError());
          options.signal.addEventListener('abort', onCallerAbort, {
            once: true,
          });
        }
        // A late settle after a stop is a no-op on this promise, and the
        // rejection is handled here: no unhandled rejection.
        Promise.resolve()
          .then(() => work(workAbort.signal))
          .then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      if (onCallerAbort) {
        options.signal?.removeEventListener('abort', onCallerAbort);
      }
      // Only the run that took the slot frees it, once.
      if (this.holder === token) this.holder = null;
    }
  }
}
