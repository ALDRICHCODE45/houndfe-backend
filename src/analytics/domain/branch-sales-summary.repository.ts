/**
 * Branch analytics summary — read-only tenant-scoped aggregate port
 * (bas-2a). Callers supply only the local half-open range; `tenantId` is
 * absent because the adapter reads it from `TenantPrismaService`.
 */
import { DomainError } from '../../shared/domain/domain-error';

/** Stable code for an unusable aggregate result. */
export const BRANCH_SALES_SUMMARY_AGGREGATE_ERROR =
  'ANALYTICS_AGGREGATE_INVALID';

/** Raised when the aggregate row is missing, malformed, or unrepresentable. */
export class BranchSalesSummaryAggregateError extends DomainError {
  constructor(message: string) {
    super(message, BRANCH_SALES_SUMMARY_AGGREGATE_ERROR);
  }
}

/** Local half-open business-day range `[from, to)`. */
export interface BranchSalesSummaryRange {
  from: string;
  to: string;
}

/** The eight integer-cent metrics the summary reports. */
export interface BranchSalesSummaryMetrics {
  grossSalesCents: number;
  netSalesCents: number;
  collectedCents: number;
  outstandingDebtCents: number;
  saleCount: number;
  averageTicketCents: number;
  settledRefundsCents: number;
  pendingRefundObligationsCents: number;
}

/** Read-only aggregate port. Tenant scope is implicit (TenantPrismaService). */
export interface IBranchSalesSummaryRepository {
  aggregate(range: BranchSalesSummaryRange): Promise<BranchSalesSummaryMetrics>;
}

export const BRANCH_SALES_SUMMARY_REPOSITORY = Symbol(
  'BRANCH_SALES_SUMMARY_REPOSITORY',
);
