/**
 * branch-analytics-summary / bas-1 — transport-boundary tests for the branch
 * summary contracts. Query bounds stay strings; the spec never uses host-local
 * `new Date('YYYY-MM-DD')`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ANALYTICS_TIME_ZONE,
  BranchSalesSummaryQueryDto,
  LOCAL_CALENDAR_DATE_PATTERN,
  isExactLocalCalendarDate,
} from './branch-sales-summary-query.dto';
import {
  BRANCH_SALES_SUMMARY_RESPONSE_KEYS,
  BranchSalesSummaryResponseDto,
} from './branch-sales-summary-response.dto';

describe('BranchSalesSummaryQueryDto', () => {
  const makeDto = (payload: Record<string, unknown>) =>
    plainToInstance(BranchSalesSummaryQueryDto, payload);

  const errorProperties = async (payload: Record<string, unknown>) => {
    const errors = await validate(makeDto(payload));
    return errors.map((error) => error.property);
  };

  it.each([
    ['2026-01-01', '2026-02-01'],
    ['2026-01-01', '2026-01-02'],
    ['2024-02-28', '2024-02-29'],
    ['2024-02-29', '2024-03-01'],
  ])('accepts the valid range [%s, %s) and keeps strings', async (from, to) => {
    const dto = makeDto({ from, to });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.from).toBe(from);
    expect(dto.to).toBe(to);
  });

  it.each([
    '2025-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-01-32',
    '2026-00-10',
  ])('rejects the impossible local date %s in either bound', async (value) => {
    expect(await errorProperties({ from: value, to: '2027-01-01' })).toContain(
      'from',
    );
    expect(await errorProperties({ from: '2025-01-01', to: value })).toContain(
      'to',
    );
  });

  it.each(['2026-1-01', '26-01-01', '2026/01/01', '20260101', ' 2026-01-01'])(
    'rejects the malformed local date %s',
    async (value) => {
      expect(
        await errorProperties({ from: value, to: '2027-01-01' }),
      ).toContain('from');
      expect(
        await errorProperties({ from: '2025-01-01', to: value }),
      ).toContain('to');
    },
  );

  it.each([
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00-06:00',
    '2026-01-01 00:00:00',
  ])('rejects the timestamp %s', async (value) => {
    expect(await errorProperties({ from: value, to: '2027-01-01' })).toContain(
      'from',
    );
  });

  it('rejects a missing from or to', async () => {
    expect(await errorProperties({ to: '2026-01-01' })).toContain('from');
    expect(await errorProperties({ from: '2026-01-01' })).toContain('to');
    expect(await errorProperties({})).toEqual(
      expect.arrayContaining(['from', 'to']),
    );
  });

  it('rejects equal and reversed ranges because to is exclusive', async () => {
    expect(
      await errorProperties({ from: '2026-01-01', to: '2026-01-01' }),
    ).toContain('to');
    expect(
      await errorProperties({ from: '2026-02-01', to: '2026-01-31' }),
    ).toContain('to');
  });

  it('rejects a non-string bound', async () => {
    expect(
      await errorProperties({ from: 20260101, to: '2026-02-01' }),
    ).toContain('from');
  });

  it('exposes the timezone, pattern, and host-timezone-free guard', () => {
    expect(ANALYTICS_TIME_ZONE).toBe('America/Mexico_City');
    expect(LOCAL_CALENDAR_DATE_PATTERN.test('2026-01-01')).toBe(true);
    expect(LOCAL_CALENDAR_DATE_PATTERN.test('2026-1-1')).toBe(false);
    expect(isExactLocalCalendarDate('2024-02-29')).toBe(true);
    expect(isExactLocalCalendarDate('1900-02-29')).toBe(false);
    expect(isExactLocalCalendarDate('2026-04-31')).toBe(false);
    expect(isExactLocalCalendarDate('2026-01-01T00:00:00Z')).toBe(false);
    expect(isExactLocalCalendarDate(undefined)).toBe(false);
  });
});

describe('BranchSalesSummaryResponseDto contract', () => {
  const sample: BranchSalesSummaryResponseDto = {
    timeZone: ANALYTICS_TIME_ZONE,
    from: '2026-01-01',
    to: '2026-02-01',
    grossSalesCents: 100_000,
    netSalesCents: 95_000,
    collectedCents: 80_000,
    outstandingDebtCents: 15_000,
    saleCount: 12,
    averageTicketCents: 7_916,
    settledRefundsCents: 4_000,
    pendingRefundObligationsCents: 2_500,
  };

  it('publishes exactly the agreed metric fields', () => {
    expect(Object.keys(sample).sort()).toEqual(
      [...BRANCH_SALES_SUMMARY_RESPONSE_KEYS].sort(),
    );
  });

  it('never exposes a cash-net or payment-method mix field', () => {
    const keys = Object.keys(sample);
    for (const forbidden of [
      'cashNetCents',
      'cashNet',
      'paymentMethodMix',
      'paymentMethods',
      'tenderedCents',
      'totalCents',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('keeps every cents and count metric an integer', () => {
    for (const value of [
      sample.grossSalesCents,
      sample.netSalesCents,
      sample.collectedCents,
      sample.outstandingDebtCents,
      sample.saleCount,
      sample.averageTicketCents,
      sample.settledRefundsCents,
      sample.pendingRefundObligationsCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
