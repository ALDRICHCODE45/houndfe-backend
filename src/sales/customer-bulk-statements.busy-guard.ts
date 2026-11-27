/**
 * customers-bulk-actions / T3 (S5) — one bulk statements run per process
 * (`docs/proposals/customers-bulk-actions-contract.md` §3.3 guard 2).
 *
 * Rendering is CPU work on the API event loop; two users stacking 50-PDF runs
 * would double the stall. A second run while one is in progress fails fast
 * with `429 BULK_EXPORT_BUSY` (the controller adds `Retry-After`). The slot is
 * in memory (one Nest singleton per process; with several replicas the guard
 * is per replica) and is released in `finally`: success, error or abort.
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

export const BULK_EXPORT_BUSY = 'BULK_EXPORT_BUSY';
export const BULK_EXPORT_RETRY_AFTER_SECONDS = 10;

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

@Injectable()
export class CustomerBulkStatementsRunGuard {
  private running = false;

  get busy(): boolean {
    return this.running;
  }

  /** Runs `work` holding the process-wide slot; busy → `BulkExportBusyException`. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running) throw new BulkExportBusyException();
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }
}
