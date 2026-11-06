import type { Inngest } from 'inngest';
import type { ReceiptRetentionService } from '../application/receipt-retention.service';
import { buildReceiptRetentionFunctions } from './receipt-retention.functions';

type Handler = (ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

function setup(
  results: Array<{ scanned: number; purged: number; failed: number }>,
) {
  const captured: Array<{
    options: Record<string, unknown>;
    handler: Handler;
  }> = [];
  const inngestClient = {
    createFunction: (options: Record<string, unknown>, handler: Handler) => {
      captured.push({ options, handler });
      return { options };
    },
  } as unknown as Inngest;
  const purgeBatch = jest.fn<
    ReturnType<ReceiptRetentionService['purgeBatch']>,
    Parameters<ReceiptRetentionService['purgeBatch']>
  >();
  for (const result of results) purgeBatch.mockResolvedValueOnce(result);
  purgeBatch.mockResolvedValue({ scanned: 0, purged: 0, failed: 0 });
  const clockReads: Array<string | null> = [];
  let currentStep: string | null = null;
  buildReceiptRetentionFunctions({
    inngestClient,
    retention: { purgeBatch },
    batchSize: 2,
    maxBatches: 5,
    now: () => {
      clockReads.push(currentStep);
      return new Date('2031-11-06T09:00:00.000Z');
    },
  });
  const steps: string[] = [];
  const run = () =>
    captured[0].handler({
      step: {
        run: async (name, fn) => {
          steps.push(name);
          currentStep = name;
          try {
            // Step results are JSON-serialized, as Inngest memoizes them.
            return JSON.parse(JSON.stringify(await fn())) as unknown;
          } finally {
            currentStep = null;
          }
        },
      },
    });
  return { captured, run, purgeBatch, steps, clockReads };
}

describe('receipt-retention-purge Inngest cron', () => {
  it('runs daily on a cron trigger with a single concurrent run', () => {
    const { captured } = setup([]);

    expect(captured[0].options).toMatchObject({
      id: 'receipt-retention-purge',
      triggers: [{ cron: 'TZ=America/Mexico_City 0 3 * * *' }],
      concurrency: { limit: 1 },
    });
  });

  it('purges full batches until one comes back short, each in its own step', async () => {
    const { run, purgeBatch, steps } = setup([
      { scanned: 2, purged: 2, failed: 0 },
      { scanned: 1, purged: 1, failed: 0 },
    ]);

    await expect(run()).resolves.toEqual({ batches: 2, purged: 3, failed: 0 });
    expect(steps).toEqual(['read-clock', 'purge-batch-1', 'purge-batch-2']);
    expect(purgeBatch.mock.calls[0][0]).toEqual({
      now: new Date('2031-11-06T09:00:00.000Z'),
      batchSize: 2,
    });
  });

  it('reads the clock once, inside a step, so replays keep the same cutoff', async () => {
    const { run, purgeBatch, clockReads } = setup([
      { scanned: 2, purged: 2, failed: 0 },
      { scanned: 0, purged: 0, failed: 0 },
    ]);

    await run();

    expect(clockReads).toEqual(['read-clock']);
    for (const [call] of purgeBatch.mock.calls) {
      expect(call.now).toEqual(new Date('2031-11-06T09:00:00.000Z'));
    }
  });

  it('keeps going after a full batch that purged nothing (failing rows are skipped)', async () => {
    const { run, steps } = setup([
      { scanned: 2, purged: 0, failed: 2 },
      { scanned: 1, purged: 1, failed: 0 },
    ]);

    await expect(run()).resolves.toEqual({ batches: 2, purged: 1, failed: 2 });
    expect(steps).toEqual(['read-clock', 'purge-batch-1', 'purge-batch-2']);
  });

  it('caps the number of batches per run', async () => {
    const full = { scanned: 2, purged: 2, failed: 0 };
    const { run, steps } = setup([full, full, full, full, full, full, full]);

    await run();

    expect(steps.filter((name) => name.startsWith('purge-batch'))).toHaveLength(
      5,
    );
  });
});
