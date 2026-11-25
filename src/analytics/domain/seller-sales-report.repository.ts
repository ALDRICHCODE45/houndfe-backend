/**
 * Seller sales report — read-only tenant-scoped port (seller-sales-report / v1).
 *
 * Callers supply the seller user id and the local half-open range; `tenantId`
 * is absent because the adapter reads it from `TenantPrismaService`. The
 * adapter owns the single RepeatableRead snapshot, the combined row cap, and
 * the eligibility rule (current tenant membership OR any assigned sale, with no
 * `isActive` filter), so missing/foreign targets raise `SellerNotFoundError`.
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { SELLER_REPORT_ROW_LIMIT_EXCEEDED } from './analytics.constants';

/** Stable code for a malformed adapter result. Never a client-visible status. */
export const SELLER_SALES_REPORT_CONTRACT_ERROR =
  'SELLER_REPORT_CONTRACT_INVALID';

/**
 * Internal invariant violation, deliberately not a `DomainError`: it must never
 * be mapped to a client-facing status by `DomainExceptionFilter`, so a
 * malformed adapter result always fails as a sanitized server-side error.
 */
export class SellerSalesReportContractError extends Error {
  readonly code = SELLER_SALES_REPORT_CONTRACT_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'SellerSalesReportContractError';
  }
}

/** 422 when the combined confirmed+canceled count exceeds the report cap. */
export class SellerReportRowLimitExceededError extends BusinessRuleViolationError {
  constructor(rowCount: number, rowLimit: number) {
    super(SELLER_REPORT_ROW_LIMIT_EXCEEDED, SELLER_REPORT_ROW_LIMIT_EXCEEDED, {
      rowLimit,
      rowCount,
    });
  }
}

/** Payment state copied verbatim from `SalePaymentStatus`. */
export type SellerReportPaymentStatus = 'PAID' | 'PARTIAL' | 'CREDIT';

/** Local half-open business-day range `[from, to)`. */
export interface SellerSalesReportRange {
  from: string;
  to: string;
}

/** Current seller identity copied from the tenant-linked `User` row. */
export interface SellerSalesReportSeller {
  id: string;
  name: string;
}

/**
 * Current customer of the sale (no name snapshot exists on the sale): `name` is
 * `firstName lastName`, or `firstName` alone without a last name. `null` on the
 * row means público en general (or a deleted customer, `SetNull`).
 */
export interface SellerSalesReportCustomer {
  id: string;
  name: string;
}

/** One CONFIRMED sale attributed by `confirmedAt`. */
export interface SellerSalesReportConfirmedRow {
  id: string;
  folio: string | null;
  confirmedAt: Date;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  paymentStatus: SellerReportPaymentStatus;
  /** Business-timezone `YYYY-MM-DD` of `confirmedAt` (internal, for `dailyTotals`). */
  localDate: string;
  customer: SellerSalesReportCustomer | null;
}

/** One CANCELED sale attributed informationally by `canceledAt`. */
export interface SellerSalesReportCanceledRow {
  id: string;
  folio: string | null;
  confirmedAt: Date | null;
  canceledAt: Date;
  totalCents: number;
  customer: SellerSalesReportCustomer | null;
}

/**
 * One `(productId, variantId)` group over the report's CONFIRMED lines. Names
 * come from the most recent line in the period; `netSalesCents` is the sum of
 * line totals after line discounts/promotions (order-level discounts are not
 * distributed to lines).
 */
export interface SellerSalesReportTopProduct {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  netSalesCents: number;
}

/** Same-length CONFIRMED aggregate ending at the report's `from` (not capped). */
export interface SellerSalesReportPreviousPeriod {
  from: string;
  to: string;
  saleCount: number;
  netSalesCents: number;
}

/** Full snapshot: seller identity, both sections, and the combined row count. */
export interface SellerSalesReportResult {
  tenantId: string;
  seller: SellerSalesReportSeller;
  confirmed: SellerSalesReportConfirmedRow[];
  canceled: SellerSalesReportCanceledRow[];
  rowCount: number;
  /** At most `SELLER_SALES_REPORT_TOP_PRODUCTS_LIMIT`, already ordered. */
  topProducts: SellerSalesReportTopProduct[];
  previousPeriod: SellerSalesReportPreviousPeriod;
}

/** Read-only seller-report port. Tenant scope is implicit in the adapter. */
export interface ISellerSalesReportRepository {
  findBySeller(
    sellerUserId: string,
    range: SellerSalesReportRange,
  ): Promise<SellerSalesReportResult>;
}

export const SELLER_SALES_REPORT_REPOSITORY = Symbol(
  'SELLER_SALES_REPORT_REPOSITORY',
);
