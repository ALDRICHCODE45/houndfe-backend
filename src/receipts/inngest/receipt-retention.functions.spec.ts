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
  buildReceiptRetentionFunctions({
    inngestClient,
    retention: { purgeBatch },
    batchSize: 2,
    maxBatches: 5,
    now: () => new Date('2031-11-06T09:00:00.000Z'),
  });
  const steps: string[] = [];
  const run = () =>
    captured[0].handler({
      step: {
        run: (name, fn) => {
          steps.push(name);
          return fn();
        },
      },
    });
  return { captured, run, purgeBatch, steps };
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
    expect(steps).toEqual(['purge-batch-1', 'purge-batch-2']);
    expect(purgeBatch.mock.calls[0][0]).toEqual({
      now: new Date('2031-11-06T09:00:00.000Z'),
      batchSize: 2,
    });
  });

  it('stops when a full batch purges nothing (only failing rows left)', async () => {
    const { run, steps } = setup([{ scanned: 2, purged: 0, failed: 2 }]);

    await expect(run()).resolves.toEqual({ batches: 1, purged: 0, failed: 2 });
    expect(steps).toHaveLength(1);
  });

  it('caps the number of batches per run', async () => {
    const full = { scanned: 2, purged: 2, failed: 0 };
    const { run, steps } = setup([full, full, full, full, full, full, full]);

    await run();

    expect(steps).toHaveLength(5);
  });
});
