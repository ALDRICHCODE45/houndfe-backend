/**
 * Branch sales daily timeseries — sparse raw-daily-row read port (OI-2 / S2).
 *
 * The adapter owns every SQL rule: tenant scope (implicit via
 * `TenantPrismaService`/CLS, hence no `tenantId` argument), the `CONFIRMED`
 * cohort, and `America/Mexico_City` bucketing of `confirmedAt`. This port only
 * promises SPARSE rows for an exact local-calendar range: at most one row per
 * in-range date, none outside `[from,to)`. Days without sales are absent, so
 * `averageTicketCents` is never a port concern — the service derives it.
 */

/** Stable code for a repository result that violates this port contract. */
export const BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE =
  'ANALYTICS_TIMESERIES_AGGREGATE_INVALID';

/**
 * Internal invariant violation, deliberately not a `DomainError`: it must never
 * be mapped to a client-facing status by `DomainExceptionFilter`, so a
 * malformed adapter result always fails as a server-side error.
 */
export class BranchSalesTimeseriesContractViolationError extends Error {
  readonly code = BRANCH_SALES_TIMESERIES_CONTRACT_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'BranchSalesTimeseriesContractViolationError';
  }
}

/** Local half-open business-day range `[from, to)`. */
export interface BranchSalesTimeseriesRange {
  from: string;
  to: string;
}

/** One sparse raw daily bucket; monetary values are integer cents. */
export interface BranchSalesDailyAggregateRow {
  /** Local calendar day (`YYYY-MM-DD`) this bucket aggregates. */
  date: string;
  grossSalesCents: number;
  netSalesCents: number;
  collectedCents: number;
  outstandingDebtCents: number;
  saleCount: number;
}

/** Read-only sparse daily-row port. Tenant scope is implicit in the adapter. */
export interface IBranchSalesTimeseriesRepository {
  findDailyAggregates(
    range: BranchSalesTimeseriesRange,
  ): Promise<BranchSalesDailyAggregateRow[]>;
}

export const BRANCH_SALES_TIMESERIES_REPOSITORY = Symbol(
  'BRANCH_SALES_TIMESERIES_REPOSITORY',
);
