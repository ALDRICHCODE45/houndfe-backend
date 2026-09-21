/** bas-2a adapter tests: one captured `$queryRaw` call, stubbed aggregate row. */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import {
  BRANCH_SALES_SUMMARY_AGGREGATE_ERROR,
  BranchSalesSummaryAggregateError,
} from '../domain/branch-sales-summary.repository';
import { PrismaBranchSalesSummaryRepository } from './prisma-branch-sales-summary.repository';

const TENANT = 'tenant-1';
const FROM = '2026-01-01';
const TO = '2026-02-01';

type RawCall = { sql: string; text: string; values: unknown[] };

const row = (overrides: Record<string, unknown> = {}) => ({
  grossSalesCents: 100_000n,
  netSalesCents: 95_000n,
  collectedCents: 80_000n,
  outstandingDebtCents: 15_000n,
  saleCount: 12n,
  settledRefundsCents: 4_000n,
  pendingRefundObligationsCents: 2_500n,
  ...overrides,
});

function makeRepo() {
  const calls: RawCall[] = [];
  let responses: unknown[][] = [];
  const $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = '';
    for (let i = 0; i < strings.length; i += 1) {
      sql += strings[i] + (i < values.length ? `$${i + 1}` : '');
    }
    calls.push({ sql, text: strings.join('__VALUE__'), values });
    return Promise.resolve(responses.shift() ?? []);
  };
  const tenantPrisma = {
    getClient: () => ({ $queryRaw: jest.fn($queryRaw) }),
    getTenantId: () => TENANT,
  };
  return {
    repo: new PrismaBranchSalesSummaryRepository(
      tenantPrisma as unknown as TenantPrismaService,
    ),
    calls,
    setRows: (rows: unknown[]) => {
      responses = [rows];
    },
  };
}

async function run(overrides: Record<string, unknown> = {}) {
  const harness = makeRepo();
  harness.setRows([row(overrides)]);
  const result = await harness.repo.aggregate({ from: FROM, to: TO });
  return { ...harness, result };
}

describe('PrismaBranchSalesSummaryRepository.aggregate', () => {
  it('maps the aggregate row into integer-cent metrics', async () => {
    const { result } = await run();
    expect(result).toEqual({
      grossSalesCents: 100_000,
      netSalesCents: 95_000,
      collectedCents: 80_000,
      outstandingDebtCents: 15_000,
      saleCount: 12,
      averageTicketCents: 7_917,
      settledRefundsCents: 4_000,
      pendingRefundObligationsCents: 2_500,
    });
  });

  it.each([
    [5n, 2n, 3], // .5 rounds up
    [1n, 2n, 1],
    [1n, 3n, 0],
    [2n, 3n, 1],
  ])(
    'rounds average ticket for net=%s count=%s to %s',
    async (net, count, expected) => {
      const { result } = await run({ netSalesCents: net, saleCount: count });
      expect(result.averageTicketCents).toBe(expected);
    },
  );

  it('returns zero metrics on an empty range', async () => {
    const { result } = await run({
      grossSalesCents: 0n,
      netSalesCents: 0n,
      collectedCents: 0n,
      outstandingDebtCents: 0n,
      saleCount: 0n,
      settledRefundsCents: 0n,
      pendingRefundObligationsCents: 0n,
    });
    expect(Object.values(result)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('binds the tenant into every tenant-sensitive SQL source', async () => {
    const { calls } = await run();
    expect(calls).toHaveLength(1);
    expect(calls[0].values.filter((v) => v === TENANT)).toHaveLength(4);
    expect(calls[0].sql.match(/"tenantId" = \$\d+/g)).toHaveLength(4);
  });

  it('derives both boundaries from Mexico City in SQL', async () => {
    const { calls } = await run();
    expect(ANALYTICS_TIME_ZONE).toBe('America/Mexico_City');
    expect(
      calls[0].values.filter((v) => v === ANALYTICS_TIME_ZONE),
    ).toHaveLength(2);
    expect(
      calls[0].sql.match(/::date::timestamp AT TIME ZONE \$\d+/g),
    ).toHaveLength(2);
    expect(calls[0].values).toEqual(expect.arrayContaining([FROM, TO]));
  });

  it('never reads tendered payments or the cached refund counter', async () => {
    const { calls } = await run();
    expect(calls[0].text).not.toMatch(/sale_payments/);
    expect(calls[0].text).not.toMatch(/settledCents/);
  });

  it('keeps the ledger all-time while refund rows are range-scoped', async () => {
    const { text } = (await run()).calls[0];
    const ledger = text.slice(
      text.indexOf('ledger_all_time AS ('),
      text.indexOf('pending_agg AS ('),
    );
    expect(ledger).toMatch(/FROM "sale_refund_settlements"/);
    expect(ledger).toMatch(/GROUP BY "saleRefundId"/);
    expect(ledger).not.toMatch(/range_start|range_end|settledAt/);

    const settled = text.slice(
      text.indexOf('settled_agg AS ('),
      text.indexOf('ledger_all_time AS ('),
    );
    expect(settled).toMatch(
      /"settledAt" >= \(SELECT range_start FROM bounds\)/,
    );

    const pending = text.slice(text.indexOf('pending_agg AS ('));
    expect(pending).toMatch(/GREATEST/);
    expect(pending).toMatch(
      /"sale_refunds"\."createdAt" >= \(SELECT range_start FROM bounds\)/,
    );
    expect(pending).toMatch(
      /"sale_refunds"\."createdAt" < \(SELECT range_end FROM bounds\)/,
    );
  });

  it('throws a stable error when the aggregate row is missing', async () => {
    const harness = makeRepo();
    harness.setRows([]);
    await expect(
      harness.repo.aggregate({ from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: BRANCH_SALES_SUMMARY_AGGREGATE_ERROR });
  });

  it.each([undefined, null, '95000', 1.5])(
    'throws a stable error on malformed metric (%p)',
    async (malformed) => {
      const harness = makeRepo();
      harness.setRows([row({ netSalesCents: malformed })]);
      const failure = harness.repo.aggregate({ from: FROM, to: TO });
      await expect(failure).rejects.toBeInstanceOf(
        BranchSalesSummaryAggregateError,
      );
      await expect(failure).rejects.toMatchObject({
        code: BRANCH_SALES_SUMMARY_AGGREGATE_ERROR,
      });
    },
  );

  it('throws when a metric exceeds the safe integer range', async () => {
    const harness = makeRepo();
    harness.setRows([
      row({
        pendingRefundObligationsCents: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ]);
    await expect(
      harness.repo.aggregate({ from: FROM, to: TO }),
    ).rejects.toBeInstanceOf(BranchSalesSummaryAggregateError);
  });
});
