/**
 * bas-3a service tests: exact aggregate delegation + response composition.
 */
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import type { BranchSalesSummaryMetrics } from '../domain/branch-sales-summary.repository';
import { BranchSalesSummaryService } from './branch-sales-summary.service';

const FROM = '2026-01-01';
const TO = '2026-02-01';
const metrics = (
  overrides: Partial<BranchSalesSummaryMetrics> = {},
): BranchSalesSummaryMetrics => ({
  grossSalesCents: 100_000,
  netSalesCents: 95_000,
  collectedCents: 80_000,
  outstandingDebtCents: 15_000,
  saleCount: 12,
  averageTicketCents: 7_917,
  settledRefundsCents: 4_000,
  pendingRefundObligationsCents: 2_500,
  ...overrides,
});
const makeService = (result: BranchSalesSummaryMetrics) => {
  // TS allows the zero-arg mock where the port expects `(range) => ...`;
  // jest still records every received argument.
  const aggregate = jest.fn(() => Promise.resolve(result));
  return { service: new BranchSalesSummaryService({ aggregate }), aggregate };
};

describe('BranchSalesSummaryService', () => {
  it('calls aggregate exactly once with the normalized range', async () => {
    const { service, aggregate } = makeService(metrics());
    await service.summarize({ from: FROM, to: TO });
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(aggregate).toHaveBeenCalledWith({ from: FROM, to: TO });
  });

  it('composes the canonical timezone with the original range strings', async () => {
    const { service } = makeService(metrics());
    const result = await service.summarize({ from: FROM, to: TO });
    expect(result.timeZone).toBe(ANALYTICS_TIME_ZONE);
    expect(result.from).toBe(FROM);
    expect(result.to).toBe(TO);
  });

  it('maps all eight repository metrics without recomputation', async () => {
    const source = metrics();
    const { service } = makeService(source);
    const result = await service.summarize({ from: FROM, to: TO });
    expect(result).toEqual({
      timeZone: ANALYTICS_TIME_ZONE,
      from: FROM,
      to: TO,
      ...source,
    });
  });

  it('preserves empty metrics unchanged', async () => {
    const empty = metrics({
      grossSalesCents: 0,
      netSalesCents: 0,
      collectedCents: 0,
      outstandingDebtCents: 0,
      saleCount: 0,
      averageTicketCents: 0,
      settledRefundsCents: 0,
      pendingRefundObligationsCents: 0,
    });
    const { service, aggregate } = makeService(empty);
    const result = await service.summarize({ from: FROM, to: TO });
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      timeZone: ANALYTICS_TIME_ZONE,
      from: FROM,
      to: TO,
      ...empty,
    });
  });
});
