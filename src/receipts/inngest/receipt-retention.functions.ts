/**
 * Inngest cron — 5-year retention purge of stored receipt files
 * (transfer-receipts / T2). Daily at 03:00 Mexico City, one run at a time.
 * Each bounded batch runs in its own checkpointed step, so a crash resumes
 * after the last completed batch; the purge itself is idempotent.
 *
 * The clock is read once, inside the `read-clock` step: Inngest re-runs the
 * handler body on every step, so a reading outside a step would move the
 * cutoff between batches. Rows that fail are stamped with that run time and
 * skipped by the following batches, so the loop stops on a short batch
 * (nothing more is due) or at `maxBatches`.
 */
import type { Inngest } from 'inngest';
import type {
  ReceiptRetentionResult,
  ReceiptRetentionService,
} from '../application/receipt-retention.service';

export const RECEIPT_RETENTION_FUNCTION_ID = 'receipt-retention-purge';

export interface BuildReceiptRetentionFunctionsInput {
  inngestClient: Inngest;
  retention: Pick<ReceiptRetentionService, 'purgeBatch'>;
  batchSize?: number;
  maxBatches?: number;
  now?: () => Date;
}

type CronContext = {
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
};

export function buildReceiptRetentionFunctions(
  input: BuildReceiptRetentionFunctionsInput,
): unknown[] {
  const batchSize = input.batchSize ?? 100;
  const maxBatches = input.maxBatches ?? 50;
  const now = input.now ?? (() => new Date());

  const fn = input.inngestClient.createFunction(
    {
      id: RECEIPT_RETENTION_FUNCTION_ID,
      triggers: [{ cron: 'TZ=America/Mexico_City 0 3 * * *' }],
      concurrency: { limit: 1 },
      retries: 3,
    },
    async (ctx: CronContext) => {
      const runAt = new Date(
        (await ctx.step.run('read-clock', () =>
          Promise.resolve(now().toISOString()),
        )) as string,
      );
      let batches = 0;
      let purged = 0;
      let failed = 0;

      while (batches < maxBatches) {
        batches += 1;
        const result = (await ctx.step.run(`purge-batch-${batches}`, () =>
          input.retention.purgeBatch({ now: runAt, batchSize }),
        )) as ReceiptRetentionResult;
        purged += result.purged;
        failed += result.failed;
        if (result.scanned < batchSize) break;
      }

      return { batches, purged, failed };
    },
  );

  return [fn];
}
