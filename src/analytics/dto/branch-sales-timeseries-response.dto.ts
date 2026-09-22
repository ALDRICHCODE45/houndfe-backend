/**
 * Branch sales daily timeseries — stable response contract (OI-2 / S1).
 *
 * One ordered, zero-filled point per local calendar day in the half-open range
 * `[from, to)`. Every monetary value is an integer number of cents and the
 * contract reports the same accounting lines as the summary; it never derives
 * an ambiguous cash-net total and never exposes a payment-method mix, currency,
 * or prior-period comparison.
 */
import {
  ANALYTICS_TIME_ZONE,
  BRANCH_SALES_TIMESERIES_INTERVAL,
} from './branch-sales-timeseries-query.dto';

/** Canonical ordered point field list — runtime shape and static type share one source. */
export const BRANCH_SALES_TIMESERIES_POINT_KEYS = [
  'date',
  'grossSalesCents',
  'netSalesCents',
  'collectedCents',
  'outstandingDebtCents',
  'saleCount',
  'averageTicketCents',
] as const;

/** Canonical ordered top-level field list — runtime shape and static type share one source. */
export const BRANCH_SALES_TIMESERIES_RESPONSE_KEYS = [
  'timeZone',
  'from',
  'to',
  'interval',
  'points',
] as const;

export interface BranchSalesTimeseriesPointDto {
  /** Local calendar day (YYYY-MM-DD) this point aggregates. */
  date: string;
  /** Pre-discount confirmed-sale subtotal, in cents. */
  grossSalesCents: number;
  /** Post-discount confirmed-sale total, in cents. */
  netSalesCents: number;
  /** Confirmed-sale paid amount, in cents. */
  collectedCents: number;
  /** Confirmed-sale outstanding balance, in cents. */
  outstandingDebtCents: number;
  /** Number of confirmed sales on this local day. */
  saleCount: number;
  /** Derived net-sale average ticket, in cents (0 when there are no sales). */
  averageTicketCents: number;
}

export interface BranchSalesTimeseriesResponseDto {
  timeZone: typeof ANALYTICS_TIME_ZONE;
  /** Inclusive local start date (YYYY-MM-DD). */
  from: string;
  /** Exclusive local end date (YYYY-MM-DD). */
  to: string;
  interval: typeof BRANCH_SALES_TIMESERIES_INTERVAL;
  /** Ascending, zero-filled point per local calendar day in [from, to). */
  points: BranchSalesTimeseriesPointDto[];
}
