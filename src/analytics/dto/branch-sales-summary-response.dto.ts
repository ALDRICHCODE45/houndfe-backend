/**
 * Branch analytics summary — stable response contract (branch-analytics-summary / bas-1).
 *
 * Every monetary value is an integer number of cents in the sale currency.
 * The contract reports separate accounting lines on purpose: it never derives
 * an ambiguous cash-net total and never exposes a payment-method mix.
 * `grossSalesCents` is the pre-discount confirmed-sale subtotal and
 * `netSalesCents` the post-discount confirmed-sale total; settled refunds and
 * pending refund obligations stay distinct lines.
 */
import { ANALYTICS_TIME_ZONE } from './branch-sales-summary-query.dto';

/** Canonical ordered field list — runtime shape and static type share one source. */
export const BRANCH_SALES_SUMMARY_RESPONSE_KEYS = [
  'timeZone',
  'from',
  'to',
  'grossSalesCents',
  'netSalesCents',
  'collectedCents',
  'outstandingDebtCents',
  'saleCount',
  'averageTicketCents',
  'settledRefundsCents',
  'pendingRefundObligationsCents',
] as const;

export interface BranchSalesSummaryResponseDto {
  timeZone: typeof ANALYTICS_TIME_ZONE;
  /** Inclusive local start date (YYYY-MM-DD). */
  from: string;
  /** Exclusive local end date (YYYY-MM-DD). */
  to: string;
  /** Pre-discount confirmed-sale subtotal, in cents. */
  grossSalesCents: number;
  /** Post-discount confirmed-sale total, in cents. */
  netSalesCents: number;
  /** Confirmed-sale paid amount, in cents. */
  collectedCents: number;
  /** Confirmed-sale outstanding balance, in cents. */
  outstandingDebtCents: number;
  /** Number of confirmed sales in range. */
  saleCount: number;
  /** Derived net-sale average ticket, in cents (0 when there are no sales). */
  averageTicketCents: number;
  /** Settled refund ledger outflow, in cents. */
  settledRefundsCents: number;
  /** Positive refund balances still owed, in cents. */
  pendingRefundObligationsCents: number;
}
