/**
 * seller-sales-report / v1 adapter tests: single RepeatableRead snapshot,
 * target eligibility, combined row cap, explicit tenant + CDMX→UTC bounds, and
 * adversarial raw-row validation.
 *
 * Runtime acceptance limit: these query-shape mocks do NOT prove real
 * PostgreSQL snapshot/isolation semantics, the `AT TIME ZONE` conversion, or
 * production query performance.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { SellerNotFoundError } from '../../sales/domain/sale.errors';
import {
  ANALYTICS_TIME_ZONE,
  SELLER_SALES_REPORT_ROW_LIMIT,
} from '../domain/analytics.constants';
import { SELLER_SALES_REPORT_CONTRACT_ERROR } from '../domain/seller-sales-report.repository';
import { PrismaSellerSalesReportRepository } from './prisma-seller-sales-report.repository';

const TENANT = 'tenant-1';
const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const FROM = '2026-01-01';
const TO = '2026-02-01';
const at = (iso: string): Date => new Date(iso);

const target = [{ id: SELLER_ID, name: 'Vendedor Uno' }];
const counts = (confirmedCount = 1n, canceledCount = 1n) => ({
  confirmedCount,
  canceledCount,
});
const confirmedSqlRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sale-1',
  folio: 'A-1',
  confirmedAt: at('2026-01-05T18:30:00.000Z'),
  totalCents: 10_000n,
  paidCents: 4_000n,
  debtCents: 6_000n,
  paymentStatus: 'PARTIAL',
  localDate: '2026-01-05',
  customerId: 'cust-1',
  customerFirstName: 'Ana',
  customerLastName: 'López',
  ...overrides,
});
const canceledSqlRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sale-2',
  folio: null,
  confirmedAt: at('2026-01-02T10:00:00.000Z'),
  canceledAt: at('2026-01-03T10:00:00.000Z'),
  totalCents: 5_000n,
  customerId: null,
  customerFirstName: null,
  customerLastName: null,
  ...overrides,
});
const topProductSqlRow = (overrides: Record<string, unknown> = {}) => ({
  productId: 'prod-1',
  variantId: null,
  productName: 'Croquetas',
  variantName: null,
  quantity: 3n,
  netSalesCents: 9_000n,
  ...overrides,
});
const previousSqlRow = (overrides: Record<string, unknown> = {}) => ({
  from: '2025-12-01',
  saleCount: 2n,
  netSalesCents: 5_000n,
  ...overrides,
});
const standard = () => [
  target,
  [counts()],
  [confirmedSqlRow()],
  [canceledSqlRow()],
  [topProductSqlRow()],
  [previousSqlRow()],
];

function makeRepo(responses: unknown[][]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const queue = [...responses];
  const $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('__VALUE__'), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  let inTransaction = false;
  const txClient = { $queryRaw: jest.fn($queryRaw) };
  const runInTransaction = jest.fn(
    (work: () => Promise<unknown>, isolationLevel?: string) => {
      void isolationLevel;
      inTransaction = true;
      return work().finally(() => {
        inTransaction = false;
      });
    },
  );
  const getClient = jest.fn(() => {
    if (!inTransaction) {
      throw new Error('getClient called outside the transaction');
    }
    return txClient;
  });
  const tenantPrisma = {
    runInTransaction,
    getClient,
    getTenantId: () => TENANT,
  };
  return {
    repo: new PrismaSellerSalesReportRepository(
      tenantPrisma as unknown as TenantPrismaService,
    ),
    calls,
    runInTransaction,
    getClient,
  };
}

const run = async (responses: unknown[][] = standard()) => {
  const harness = makeRepo(responses);
  const result = await harness.repo.findBySeller(SELLER_ID, {
    from: FROM,
    to: TO,
  });
  return { ...harness, result };
};

describe('PrismaSellerSalesReportRepository.findBySeller', () => {
  it('runs one RepeatableRead transaction and reads the ambient client inside it', async () => {
    const { runInTransaction, getClient, calls } = await run();
    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect(runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      'RepeatableRead',
    );
    expect(getClient).toHaveBeenCalled();
    expect(calls).toHaveLength(6);
  });

  it('maps the snapshot into normalized rows and the combined rowCount', async () => {
    const { result } = await run();
    expect(result).toEqual({
      tenantId: TENANT,
      seller: { id: SELLER_ID, name: 'Vendedor Uno' },
      rowCount: 2,
      confirmed: [
        {
          id: 'sale-1',
          folio: 'A-1',
          confirmedAt: at('2026-01-05T18:30:00.000Z'),
          totalCents: 10_000,
          paidCents: 4_000,
          debtCents: 6_000,
          paymentStatus: 'PARTIAL',
          localDate: '2026-01-05',
          customer: { id: 'cust-1', name: 'Ana López' },
        },
      ],
      canceled: [
        {
          id: 'sale-2',
          folio: null,
          confirmedAt: at('2026-01-02T10:00:00.000Z'),
          canceledAt: at('2026-01-03T10:00:00.000Z'),
          totalCents: 5_000,
          customer: null,
        },
      ],
      topProducts: [
        {
          productId: 'prod-1',
          variantId: null,
          productName: 'Croquetas',
          variantName: null,
          quantity: 3,
          netSalesCents: 9_000,
        },
      ],
      previousPeriod: {
        from: '2025-12-01',
        to: FROM,
        saleCount: 2,
        netSalesCents: 5_000,
      },
    });
  });

  it('names the customer by firstName alone when lastName is null or empty', async () => {
    for (const lastName of [null, '']) {
      const { result } = await run([
        target,
        [counts(1n, 1n)],
        [confirmedSqlRow({ customerLastName: lastName })],
        [
          canceledSqlRow({
            customerId: 'cust-2',
            customerFirstName: 'Beto',
            customerLastName: lastName,
          }),
        ],
        [],
        [previousSqlRow()],
      ]);
      expect(result.confirmed[0].customer).toEqual({
        id: 'cust-1',
        name: 'Ana',
      });
      expect(result.canceled[0].customer).toEqual({
        id: 'cust-2',
        name: 'Beto',
      });
    }
  });

  it('reads the customer through a tenant-scoped LEFT JOIN on both row queries', async () => {
    const { calls } = await run();
    for (const call of [calls[2], calls[3]]) {
      expect(call.text).toMatch(
        /LEFT JOIN "customers" c ON c\."id" = s\."customerId" AND c\."tenantId" = /,
      );
      expect(call.text).toMatch(/c\."firstName"/);
      expect(call.text).toMatch(/c\."lastName"/);
    }
  });

  it('aggregates top products over the confirmed lines of the range only', async () => {
    const { calls } = await run();
    const top = calls[4];
    expect(top.text).toMatch(/FROM "sale_items" si/);
    expect(top.text).toMatch(/JOIN "sales" s ON s\."id" = si\."saleId"/);
    expect(top.text.match(/"tenantId" = /g)).toHaveLength(2);
    expect(top.text).toMatch(/s\."status" = 'CONFIRMED'/);
    expect(top.text).not.toMatch(/'CANCELED'/);
    expect(top.text).toMatch(/s\."sellerUserId" = /);
    expect(top.text).toMatch(/GROUP BY/);
    expect(top.text).toMatch(/DISTINCT ON/);
    expect(top.text).toMatch(
      /ORDER BY "quantity" DESC, "netSalesCents" DESC, a\."productId" COLLATE "C" ASC/,
    );
    expect(top.text).toMatch(/LIMIT __VALUE__\s*$/);
    expect(top.values[top.values.length - 1]).toBe(5);
    expect(top.values).toContain(SELLER_ID);
    expect(top.values).toContain(TENANT);
    expect(top.values.filter((v) => v === ANALYTICS_TIME_ZONE)).toHaveLength(2);
  });

  it('aggregates the previous period ending at from, with the same day count', async () => {
    const { calls } = await run();
    const previous = calls[5];
    expect(previous.text).toMatch(/"status" = 'CONFIRMED'/);
    expect(previous.text).toMatch(/COUNT\(s\."id"\)/);
    expect(previous.text).toMatch(/SUM\(s\."totalCents"\)/);
    expect(previous.text.match(/"tenantId" = /g)).toHaveLength(1);
    // previous from = from - (to - from) days, upper bound = from
    expect(previous.text).toMatch(/::date - \(/);
    expect(previous.values).toContain(FROM);
    expect(previous.values).toContain(TO);
    expect(previous.values).toContain(SELLER_ID);
  });

  it('maps a null confirmedAt on a canceled row without any fallback', async () => {
    const { result } = await run([
      target,
      [counts(0n, 1n)],
      [],
      [canceledSqlRow({ confirmedAt: null })],
      [],
      [previousSqlRow()],
    ]);
    expect(result.canceled[0].confirmedAt).toBeNull();
    expect(result.canceled[0].canceledAt).toEqual(
      at('2026-01-03T10:00:00.000Z'),
    );
  });

  it('raises SELLER_NOT_FOUND for a missing or foreign target and reads nothing else', async () => {
    const harness = makeRepo([[]]);
    await expect(
      harness.repo.findBySeller(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toBeInstanceOf(SellerNotFoundError);
    expect(harness.calls).toHaveLength(1);
  });

  it('keeps an inactive member with zero sales eligible (no isActive filter)', async () => {
    const { result, calls } = await run([
      target,
      [counts(0n, 0n)],
      [],
      [],
      [],
      [previousSqlRow({ saleCount: 0n, netSalesCents: 0n })],
    ]);
    expect(result.rowCount).toBe(0);
    expect(result.confirmed).toEqual([]);
    expect(result.canceled).toEqual([]);
    expect(calls[0].text).not.toMatch(/isActive/);
    expect(calls[0].text).toMatch(/EXISTS/);
    expect(calls[0].text).toMatch(/"tenant_memberships"/);
    expect(calls[0].text).toMatch(/"sales"/);
  });

  it('rejects a combined count above the cap before loading any row', async () => {
    const harness = makeRepo([target, [counts(1000n, 1n)]]);
    await expect(
      harness.repo.findBySeller(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({
      code: 'SELLER_REPORT_ROW_LIMIT_EXCEEDED',
      details: { rowLimit: SELLER_SALES_REPORT_ROW_LIMIT, rowCount: 1001 },
    });
    expect(harness.calls).toHaveLength(2);
  });

  it('accepts the exact combined cap and loads the bounded rows', async () => {
    const rows = Array.from({ length: SELLER_SALES_REPORT_ROW_LIMIT }, (_, i) =>
      confirmedSqlRow({ id: `sale-${i}` }),
    );
    const { result, calls } = await run([
      target,
      [counts(1000n, 0n)],
      rows,
      [],
      [],
      [previousSqlRow()],
    ]);
    expect(result.rowCount).toBe(SELLER_SALES_REPORT_ROW_LIMIT);
    expect(result.confirmed).toHaveLength(SELLER_SALES_REPORT_ROW_LIMIT);
    expect(calls).toHaveLength(6);
  });

  it('scopes every source by the explicit tenant and converts both bounds twice', async () => {
    const { calls } = await run();
    const [targetCall, countsCall, confirmedCall, canceledCall] = calls;
    expect(targetCall.text.match(/"tenantId" = /g)).toHaveLength(2);
    expect(countsCall.text.match(/"tenantId" = /g)).toHaveLength(2);
    // sales + tenant-scoped customers join
    expect(confirmedCall.text.match(/"tenantId" = /g)).toHaveLength(2);
    expect(canceledCall.text.match(/"tenantId" = /g)).toHaveLength(2);
    expect(ANALYTICS_TIME_ZONE).toBe('America/Mexico_City');
    // The combined-count query repeats both bounds once per status subquery.
    expect(
      countsCall.values.filter((v) => v === ANALYTICS_TIME_ZONE),
    ).toHaveLength(4);
    // confirmed rows also derive the local business day of confirmedAt
    expect(
      confirmedCall.values.filter((v) => v === ANALYTICS_TIME_ZONE),
    ).toHaveLength(3);
    expect(
      canceledCall.values.filter((v) => v === ANALYTICS_TIME_ZONE),
    ).toHaveLength(2);
    expect(confirmedCall.text).toMatch(
      /to_char\(\(s\."confirmedAt" AT TIME ZONE 'UTC' AT TIME ZONE /,
    );
    for (const call of [countsCall, confirmedCall, canceledCall]) {
      const bounds = call === countsCall ? 4 : 2;
      expect(call.text.match(/::date::timestamp AT TIME ZONE /g)).toHaveLength(
        bounds,
      );
      expect(call.text.match(/\) AT TIME ZONE 'UTC'\)/g)).toHaveLength(bounds);
    }
    expect(countsCall.text).toMatch(/'CONFIRMED'/);
    expect(countsCall.text).toMatch(/'CANCELED'/);
    expect(confirmedCall.text).toMatch(/"status" = 'CONFIRMED'/);
    expect(confirmedCall.text).toMatch(/"confirmedAt" IS NOT NULL/);
    expect(confirmedCall.text).toMatch(
      /ORDER BY s\."confirmedAt" ASC, s\."id" ASC/,
    );
    expect(canceledCall.text).toMatch(/"status" = 'CANCELED'/);
    expect(canceledCall.text).toMatch(/"canceledAt" IS NOT NULL/);
    expect(canceledCall.text).toMatch(
      /ORDER BY s\."canceledAt" ASC, s\."id" ASC/,
    );
    for (const call of [confirmedCall, canceledCall]) {
      // Only the customer id and name are projected — never contact data.
      expect(call.text).not.toMatch(
        /email|phone|address|cashier|cancelReason/i,
      );
    }
  });

  it.each([
    ['negative cents', { totalCents: -1n }],
    ['unsafe cents', { totalCents: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    ['malformed cents', { paidCents: '4000' }],
    ['invalid confirmedAt', { confirmedAt: 'not-a-date' }],
    ['invalid paymentStatus', { paymentStatus: 'REFUNDED' }],
    ['non-string folio', { folio: 7 }],
    ['malformed localDate', { localDate: '2026-1-5' }],
    ['customer id without a name', { customerFirstName: null }],
    ['non-string customer lastName', { customerLastName: 7 }],
  ])('rejects an invalid confirmed raw row (%s)', async (_case, overrides) => {
    const harness = makeRepo([
      target,
      [counts(1n, 0n)],
      [confirmedSqlRow(overrides)],
      [],
      [],
      [previousSqlRow()],
    ]);
    await expect(
      harness.repo.findBySeller(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });

  it.each([
    ['negative quantity', { quantity: -1n }],
    ['negative net', { netSalesCents: -1n }],
    ['non-string productName', { productName: null }],
    ['non-string variantId', { variantId: 7 }],
  ])(
    'rejects an invalid top product raw row (%s)',
    async (_case, overrides) => {
      const harness = makeRepo([
        target,
        [counts(1n, 0n)],
        [confirmedSqlRow()],
        [],
        [topProductSqlRow(overrides)],
        [previousSqlRow()],
      ]);
      await expect(
        harness.repo.findBySeller(SELLER_ID, { from: FROM, to: TO }),
      ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
    },
  );

  it.each([
    ['missing row', []],
    ['malformed from', [previousSqlRow({ from: '2025/12/01' })]],
    ['negative count', [previousSqlRow({ saleCount: -1n })]],
  ])('rejects an invalid previous period row (%s)', async (_case, rows) => {
    const harness = makeRepo([
      target,
      [counts(1n, 0n)],
      [confirmedSqlRow()],
      [],
      [],
      rows,
    ]);
    await expect(
      harness.repo.findBySeller(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });

  it('rejects a count/row mismatch without emitting a partial report', async () => {
    const harness = makeRepo([
      target,
      [counts(2n, 0n)],
      [confirmedSqlRow()],
      [],
    ]);
    await expect(
      harness.repo.findBySeller(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });
});
