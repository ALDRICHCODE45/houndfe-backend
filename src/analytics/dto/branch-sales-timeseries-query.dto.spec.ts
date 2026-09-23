/**
 * OI-2 / S1 — transport-boundary tests for the branch sales daily timeseries
 * contracts.
 *
 * The timeseries query reuses the summary query, so the date rules (exact
 * Gregorian `YYYY-MM-DD`, `to > from`, half-open `[from, to)`, 366-day cap)
 * are inherited and must stay enforced — never duplicated. Bounds stay
 * strings; the spec never uses host-local `new Date('YYYY-MM-DD')`.
 *
 * Validation mirrors the controller transport: the global `ValidationPipe`
 * runs with `whitelist`, `forbidNonWhitelisted`, and `transform`, so these
 * tests validate `plainToInstance` output under the same options.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BranchSalesSummaryQueryDto } from './branch-sales-summary-query.dto';
import {
  ANALYTICS_TIME_ZONE,
  BRANCH_SALES_TIMESERIES_INTERVAL,
  BranchSalesTimeseriesQueryDto,
  MAX_ANALYTICS_RANGE_DAYS,
} from './branch-sales-timeseries-query.dto';
import {
  BRANCH_SALES_TIMESERIES_POINT_KEYS,
  BRANCH_SALES_TIMESERIES_RESPONSE_KEYS,
  BranchSalesTimeseriesPointDto,
  BranchSalesTimeseriesResponseDto,
} from './branch-sales-timeseries-response.dto';

describe('BranchSalesTimeseriesQueryDto', () => {
  const makeDto = (payload: Record<string, unknown>) =>
    plainToInstance(BranchSalesTimeseriesQueryDto, payload);

  const errorProperties = async (payload: Record<string, unknown>) => {
    const errors = await validate(makeDto(payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((error) => error.property);
  };

  it('inherits the summary date contract instead of duplicating it', () => {
    expect(BranchSalesTimeseriesQueryDto.prototype).toBeInstanceOf(
      BranchSalesSummaryQueryDto,
    );
    expect(new BranchSalesTimeseriesQueryDto()).toBeInstanceOf(
      BranchSalesSummaryQueryDto,
    );
  });

  it('defaults the omitted interval to the exact literal day', async () => {
    const dto = makeDto({ from: '2026-01-01', to: '2026-01-03' });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toHaveLength(0);
    expect(dto.interval).toBe('day');
    expect(BRANCH_SALES_TIMESERIES_INTERVAL).toBe('day');
  });

  it('accepts an explicit day interval and keeps string bounds', async () => {
    const dto = makeDto({
      from: '2026-01-01',
      to: '2026-01-03',
      interval: 'day',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toHaveLength(0);
    expect(dto.interval).toBe('day');
    expect(dto.from).toBe('2026-01-01');
    expect(dto.to).toBe('2026-01-03');
  });

  it.each(['week', 'month', 'DAY', 'Day', '', 'daily', 'day '])(
    'rejects the unsupported interval string %p',
    async (interval) => {
      await expect(
        errorProperties({ from: '2026-01-01', to: '2026-01-03', interval }),
      ).resolves.toContain('interval');
    },
  );

  it.each([1, true, null])(
    'rejects the non-string interval %p',
    async (interval) => {
      await expect(
        errorProperties({ from: '2026-01-01', to: '2026-01-03', interval }),
      ).resolves.toContain('interval');
    },
  );

  it('rejects an unknown query key the global forbidNonWhitelisted pipe would block', async () => {
    expect(
      await errorProperties({
        from: '2026-01-01',
        to: '2026-01-03',
        tenantId: 'tenant-1',
      }),
    ).toContain('tenantId');
  });

  it.each([
    ['2026-01-01', '2026-02-01'],
    ['2026-01-01', '2026-01-02'],
    ['2024-02-28', '2024-02-29'],
  ])('accepts the inherited valid range [%s, %s)', async (from, to) => {
    expect(await errorProperties({ from, to })).toEqual([]);
  });

  it.each(['2025-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '20260101'])(
    'keeps rejecting the inexact local date %s in either bound',
    async (value) => {
      expect(
        await errorProperties({ from: value, to: '2027-01-01' }),
      ).toContain('from');
      expect(
        await errorProperties({ from: '2025-01-01', to: value }),
      ).toContain('to');
    },
  );

  it('keeps rejecting equal and inverted ranges because to is exclusive', async () => {
    expect(
      await errorProperties({ from: '2026-01-01', to: '2026-01-01' }),
    ).toContain('to');
    expect(
      await errorProperties({ from: '2026-02-01', to: '2026-01-31' }),
    ).toContain('to');
  });

  it('keeps accepting the 366-day cap and rejecting 367 days', async () => {
    expect(
      await errorProperties({ from: '2024-01-01', to: '2025-01-01' }),
    ).toEqual([]);
    expect(
      await errorProperties({ from: '2024-01-01', to: '2025-01-02' }),
    ).toContain('to');
    expect(MAX_ANALYTICS_RANGE_DAYS).toBe(366);
  });
});

describe('BranchSalesTimeseriesResponseDto contract', () => {
  const point: BranchSalesTimeseriesPointDto = {
    date: '2026-01-01',
    grossSalesCents: 100_000,
    netSalesCents: 95_000,
    collectedCents: 80_000,
    outstandingDebtCents: 15_000,
    saleCount: 12,
    averageTicketCents: 7_916,
  };

  const sample: BranchSalesTimeseriesResponseDto = {
    timeZone: ANALYTICS_TIME_ZONE,
    from: '2026-01-01',
    to: '2026-01-03',
    interval: 'day',
    points: [point],
  };

  it('exposes the top-level keys in the canonical order', () => {
    expect(Object.keys(sample)).toEqual([
      ...BRANCH_SALES_TIMESERIES_RESPONSE_KEYS,
    ]);
  });

  it('exposes the point keys in the canonical order', () => {
    expect(Object.keys(point)).toEqual([...BRANCH_SALES_TIMESERIES_POINT_KEYS]);
  });

  it('pins the exact timeZone and interval literals', () => {
    expect(sample.timeZone).toBe('America/Mexico_City');
    expect(sample.interval).toBe('day');
    expect(BRANCH_SALES_TIMESERIES_RESPONSE_KEYS).toEqual([
      'timeZone',
      'from',
      'to',
      'interval',
      'points',
    ]);
  });

  it('never exposes tendered, comparison, currency, or product fields', () => {
    const keys = Object.keys(sample);
    const pointKeys = Object.keys(point);
    for (const forbidden of [
      'tenderedCents',
      'totalCents',
      'currency',
      'priorPeriodCents',
      'products',
      'refundsCents',
    ]) {
      expect(keys).not.toContain(forbidden);
      expect(pointKeys).not.toContain(forbidden);
    }
  });

  it('keeps every point metric an integer and its date a string', () => {
    expect(typeof point.date).toBe('string');
    for (const value of [
      point.grossSalesCents,
      point.netSalesCents,
      point.collectedCents,
      point.outstandingDebtCents,
      point.saleCount,
      point.averageTicketCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
