/**
 * OI-2 / S2 service tests (strict TDD) — `BranchSalesTimeseriesService`.
 *
 * Proves: one port call with an exact `{from,to}`; one ordered point per
 * Gregorian local date in the half-open range; zero fill for absent rows; the
 * average ticket derived only from repository sums/counts; fail-fast on contract
 * violations. Expectations are absolute dates, free of host timezone/locale.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import {
  BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE,
  BranchSalesTimeseriesContractViolationError,
  type BranchSalesDailyAggregateRow,
} from '../domain/branch-sales-timeseries.repository';
import {
  BRANCH_SALES_TIMESERIES_INTERVAL,
  BranchSalesTimeseriesQueryDto,
} from '../dto/branch-sales-timeseries-query.dto';
import {
  BRANCH_SALES_TIMESERIES_POINT_KEYS,
  BRANCH_SALES_TIMESERIES_RESPONSE_KEYS,
  type BranchSalesTimeseriesPointDto,
} from '../dto/branch-sales-timeseries-response.dto';
import { BranchSalesTimeseriesService } from './branch-sales-timeseries.service';

const FROM = '2026-01-01';
const TO = '2026-01-03';

/** Validated transport shape: the DTO owns the omitted-`interval` default. */
const dto = (from: string, to: string) =>
  plainToInstance(BranchSalesTimeseriesQueryDto, { from, to });

const row = (
  date: string,
  overrides: Partial<BranchSalesDailyAggregateRow> = {},
): BranchSalesDailyAggregateRow => ({
  date,
  grossSalesCents: 100_000,
  netSalesCents: 95_000,
  collectedCents: 80_000,
  outstandingDebtCents: 15_000,
  saleCount: 12,
  ...overrides,
});

const zeroPoint = (date: string): BranchSalesTimeseriesPointDto => ({
  date,
  grossSalesCents: 0,
  netSalesCents: 0,
  collectedCents: 0,
  outstandingDebtCents: 0,
  saleCount: 0,
  averageTicketCents: 0,
});

const datesOf = (entries: Array<{ date: string }>) =>
  entries.map((entry) => entry.date);

/** Zero-arg mock: TS accepts it where the port expects `(range) => ...`. */
const serviceWith = (result: BranchSalesDailyAggregateRow[]) => {
  const findDailyAggregates = jest.fn(() => Promise.resolve(result));
  return {
    service: new BranchSalesTimeseriesService({ findDailyAggregates }),
    findDailyAggregates,
  };
};

describe('BranchSalesTimeseriesService', () => {
  it('calls the port once with an exact {from,to} and no interval/tenant', async () => {
    const { service, findDailyAggregates } = serviceWith([]);
    await service.getTimeseries(dto(FROM, TO));
    expect(findDailyAggregates).toHaveBeenCalledTimes(1);
    // Exact object match: an extra `interval` or tenant key would fail here.
    expect(findDailyAggregates).toHaveBeenCalledWith({ from: FROM, to: TO });
  });
  it('attaches canonical metadata and the exact declared key sets', async () => {
    const { service } = serviceWith([row(FROM)]);
    const result = await service.getTimeseries(dto(FROM, '2026-01-02'));
    expect(result).toEqual({
      timeZone: ANALYTICS_TIME_ZONE,
      from: FROM,
      to: '2026-01-02',
      interval: BRANCH_SALES_TIMESERIES_INTERVAL,
      points: [{ ...row(FROM), averageTicketCents: 7_917 }],
    });
    expect(Object.keys(result)).toEqual(BRANCH_SALES_TIMESERIES_RESPONSE_KEYS);
    expect(Object.keys(result.points[0])).toEqual(
      BRANCH_SALES_TIMESERIES_POINT_KEYS,
    );
  });
  it('zero-fills every local calendar day across a month boundary', async () => {
    const { service } = serviceWith([]);
    const result = await service.getTimeseries(dto('2026-01-30', '2026-02-02'));
    expect(result.points).toEqual([
      zeroPoint('2026-01-30'),
      zeroPoint('2026-01-31'),
      zeroPoint('2026-02-01'),
    ]);
  });
  it('orders sparse unsorted rows, zero-fills gaps and preserves sums/counts', async () => {
    const present = row(FROM, { netSalesCents: 3, saleCount: 3 });
    const rows = [row('2026-01-02'), present];
    const { service } = serviceWith(rows);
    const result = await service.getTimeseries(dto(FROM, '2026-01-04'));
    expect(result.points).toEqual([
      { ...present, averageTicketCents: 1 },
      { ...row('2026-01-02'), averageTicketCents: 7_917 },
      zeroPoint('2026-01-03'),
    ]);
    // The adapter's returned order is never mutated in place.
    expect(datesOf(rows)).toEqual(['2026-01-02', FROM]);
  });
  it('rounds the average ticket to the nearest cent, pinning a .5 tie up', async () => {
    const { service } = serviceWith([
      row(FROM, { netSalesCents: 1_000, saleCount: 3 }),
      row('2026-01-02', { netSalesCents: 5, saleCount: 2 }),
    ]);
    const result = await service.getTimeseries(dto(FROM, TO));
    expect(result.points.map((point) => point.averageTicketCents)).toEqual([
      333, 3,
    ]);
  });
  it('reports a zero average ticket instead of dividing by zero sales', async () => {
    const empty = row('2026-01-02', { netSalesCents: 0, saleCount: 0 });
    const { service } = serviceWith([empty]);
    const result = await service.getTimeseries(dto(FROM, TO));
    expect(result.points[1]).toEqual({ ...empty, averageTicketCents: 0 });
  });

  const calendarCases: Array<[string, string, string]> = [
    ['2024-02-28', '2024-03-01', '2024-02-28,2024-02-29'],
    ['2023-02-28', '2023-03-01', '2023-02-28'],
    ['2025-12-31', '2026-01-02', '2025-12-31,2026-01-01'],
    ['0001-01-01', '0001-01-03', '0001-01-01,0001-01-02'],
  ];

  for (const [from, to, days] of calendarCases) {
    it(`enumerates ${from} to ${to}`, async () => {
      const { service } = serviceWith([]);
      const result = await service.getTimeseries(dto(from, to));
      expect(datesOf(result.points)).toEqual(days.split(','));
    });
  }

  it('emits one point per day for the 366-day cap and for a leap year', async () => {
    const { service } = serviceWith([]);
    const capped = await service.getTimeseries(dto('2026-01-01', '2027-01-02'));
    const leap = await service.getTimeseries(dto('2024-01-01', '2025-01-01'));
    expect(datesOf(capped.points)).toHaveLength(366);
    expect(datesOf(capped.points)[365]).toBe('2027-01-01');
    expect(datesOf(leap.points)).toHaveLength(366);
    expect(datesOf(leap.points)).toContain('2024-02-29');
    expect(datesOf(leap.points)[365]).toBe('2024-12-31');
  });
  it('is deterministic across repeated calls', async () => {
    const { service } = serviceWith([row('2026-01-02')]);
    const first = await service.getTimeseries(dto(FROM, TO));
    expect(await service.getTimeseries(dto(FROM, TO))).toEqual(first);
  });

  describe('host-timezone independence across a Mexico DST-era span', () => {
    const originalTimeZone = process.env.TZ;
    const expectedDays = [
      '2022-10-28',
      '2022-10-29',
      '2022-10-30',
      '2022-10-31',
      '2022-11-01',
    ];

    afterAll(() => {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    });

    for (const timeZone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      it(`enumerates the same days under TZ=${timeZone}`, async () => {
        process.env.TZ = timeZone;
        const { service } = serviceWith([]);
        const result = await service.getTimeseries(
          dto('2022-10-28', '2022-11-02'),
        );
        expect(datesOf(result.points)).toEqual(expectedDays);
      });
    }
  });
  const violations: Array<[string, BranchSalesDailyAggregateRow[]]> = [
    [
      'duplicate date',
      [row('2026-01-02'), row('2026-01-02', { saleCount: 1 })],
    ],
    ['date at the exclusive upper bound', [row(TO)]],
    ['date before the inclusive lower bound', [row('2025-12-31')]],
  ];

  for (const [name, rows] of violations) {
    it(`fails fast on a repository ${name}`, async () => {
      const { service, findDailyAggregates } = serviceWith(rows);
      const error = await service
        .getTimeseries(dto(FROM, TO))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BranchSalesTimeseriesContractViolationError);
      expect(error).toMatchObject({
        code: BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE,
      });
      expect(findDailyAggregates).toHaveBeenCalledTimes(1);
    });
  }
});
