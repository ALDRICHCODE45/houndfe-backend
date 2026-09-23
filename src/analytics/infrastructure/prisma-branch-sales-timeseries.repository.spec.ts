/** OI-2 / S3 adapter unit tests: captured `$queryRaw` shape + malformed guards. */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import { BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE } from '../domain/branch-sales-timeseries.repository';
import { PrismaBranchSalesTimeseriesRepository } from './prisma-branch-sales-timeseries.repository';

const TENANT = 'tenant-1';
const FROM = '2026-01-01';
const TO = '2026-01-03';
const ROW = {
  date: '2026-01-01',
  grossSalesCents: 113n,
  netSalesCents: 224n,
  collectedCents: 156n,
  outstandingDebtCents: 68n,
  saleCount: 3n,
};

function makeRepo(rows: unknown[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('__VALUE__'), values });
    return Promise.resolve(rows);
  };
  const tenantPrisma = {
    getClient: () => ({ $queryRaw: jest.fn($queryRaw) }),
    getTenantId: () => TENANT,
  };
  return {
    repo: new PrismaBranchSalesTimeseriesRepository(
      tenantPrisma as unknown as TenantPrismaService,
    ),
    calls,
  };
}

async function run(rows: unknown[] = [ROW]) {
  const harness = makeRepo(rows);
  const result = await harness.repo.findDailyAggregates({ from: FROM, to: TO });
  return { ...harness, result };
}

describe('PrismaBranchSalesTimeseriesRepository.findDailyAggregates', () => {
  it('maps every row to safe integers, keeping the SQL date, and stays sparse', async () => {
    const { result } = await run();
    expect(Object.entries(result[0])).toEqual([
      ['date', '2026-01-01'],
      ['grossSalesCents', 113],
      ['netSalesCents', 224],
      ['collectedCents', 156],
      ['outstandingDebtCents', 68],
      ['saleCount', 3],
    ]);
    const { result: empty } = await run([]);
    expect(empty).toEqual([]);
  });
  it('scopes by tenant once, normalizes both sides to UTC, and reads only CONFIRMED sales', async () => {
    const { calls } = await run();
    const { text, values } = calls[0];
    expect(calls).toHaveLength(1);
    expect(values.filter((v) => v === TENANT)).toHaveLength(1);
    expect(values.filter((v) => v === ANALYTICS_TIME_ZONE)).toHaveLength(3);
    expect(values).toEqual(expect.arrayContaining([FROM, TO]));
    expect(text.match(/\(?"tenantId" = /g)).toHaveLength(1);
    expect(text.match(/::date::timestamp AT TIME ZONE /g)).toHaveLength(2);
    expect(text.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(3);
    expect(text.match(/\) AT TIME ZONE 'UTC'\)/g)).toHaveLength(2);
    expect(text.match(/"confirmedAt" >= |"confirmedAt" < /g)).toHaveLength(2);
    expect(text).toMatch(/to_char\(.*'YYYY-MM-DD'\)/);
    expect(text).toMatch(/"status" = 'CONFIRMED'/);
    expect(text).toMatch(/"confirmedAt" IS NOT NULL/);
    expect(text).not.toMatch(
      /AVG|average|sale_payments|sale_refunds|sale_refund_settlements/,
    );
    expect(ANALYTICS_TIME_ZONE).toBe('America/Mexico_City');
  });

  it.each([undefined, null, '113', 1.5])(
    'rejects a malformed metric (%p) with the stable code',
    async (malformed) => {
      const failure = run([{ ...ROW, netSalesCents: malformed }]);
      await expect(failure).rejects.toMatchObject({
        code: BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE,
      });
    },
  );

  it('rejects an out-of-range aggregate and a malformed date', async () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    for (const bad of [{ saleCount: huge }, { date: '2026-1-1' }]) {
      await expect(run([{ ...ROW, ...bad }])).rejects.toMatchObject({
        code: BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE,
      });
    }
  });
});
