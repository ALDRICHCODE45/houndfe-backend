/**
 * Seller sales report — stable response contract (seller-sales-report / v1).
 *
 * Two independent sections: `confirmed` (attributed by `confirmedAt`, with the
 * derived current-balance summary and its bounded rows) and `canceled`
 * (informational, attributed by `canceledAt`). Every monetary value is a
 * non-negative integer number of cents.
 *
 * sales-history-redesign (contract §2, §4, §5.1, §6): every row carries the
 * sale's CURRENT customer as `{ id, name }` or `null` (público en general or a
 * deleted customer) — only id and display name, never contact data. Three
 * top-level blocks read from the same snapshot: `topProducts` (top 5 by units
 * over the CONFIRMED lines, line NET after line discounts/promotions; order
 * discounts are not distributed, so their sum can exceed
 * `confirmed.summary.netSalesCents`), `dailyTotals` (one zero-filled entry per
 * local day of `[from, to)`, same definition as `confirmed.summary`) and
 * `previousPeriod` (same day count ending at `from`, aggregate only). No
 * cashier, free-text cancellation reason or currency field is projected.
 */
import { ANALYTICS_TIME_ZONE } from './branch-sales-summary-query.dto';
import {
  SELLER_REPORT_ATTRIBUTION,
  SELLER_REPORT_BALANCES,
  SELLER_SALES_REPORT_ROW_LIMIT,
} from '../domain/analytics.constants';
import type { SellerReportPaymentStatus } from '../domain/seller-sales-report.repository';

/** Canonical ordered top-level field list — runtime shape and type share one source. */
export const SELLER_SALES_REPORT_RESPONSE_KEYS = [
  'seller',
  'tenantId',
  'timeZone',
  'from',
  'to',
  'generatedAt',
  'attribution',
  'balances',
  'rowLimit',
  'rowCount',
  'confirmed',
  'canceled',
  'topProducts',
  'dailyTotals',
  'previousPeriod',
] as const;

export const SELLER_SALES_REPORT_CUSTOMER_KEYS = ['id', 'name'] as const;

export const SELLER_SALES_REPORT_TOP_PRODUCT_KEYS = [
  'productId',
  'variantId',
  'productName',
  'variantName',
  'quantity',
  'netSalesCents',
] as const;

export const SELLER_SALES_REPORT_DAILY_TOTAL_KEYS = [
  'date',
  'saleCount',
  'netSalesCents',
] as const;

export const SELLER_SALES_REPORT_PREVIOUS_PERIOD_KEYS = [
  'from',
  'to',
  'saleCount',
  'netSalesCents',
] as const;

export const SELLER_SALES_REPORT_CONFIRMED_KEYS = [
  'dateBasis',
  'summary',
  'rows',
] as const;

export const SELLER_SALES_REPORT_CONFIRMED_SUMMARY_KEYS = [
  'saleCount',
  'netSalesCents',
  'collectedCents',
  'outstandingDebtCents',
  'averageTicketCents',
] as const;

export const SELLER_SALES_REPORT_CONFIRMED_ROW_KEYS = [
  'id',
  'folio',
  'confirmedAt',
  'totalCents',
  'paidCents',
  'debtCents',
  'paymentStatus',
  'customer',
] as const;

export const SELLER_SALES_REPORT_CANCELED_KEYS = [
  'dateBasis',
  'saleCount',
  'rows',
] as const;

export const SELLER_SALES_REPORT_CANCELED_ROW_KEYS = [
  'id',
  'folio',
  'confirmedAt',
  'canceledAt',
  'totalCents',
  'customer',
] as const;

export interface SellerSalesReportSellerDto {
  id: string;
  name: string;
}

/** Current customer: `firstName lastName` (or `firstName`); null = público en general. */
export interface SellerSalesReportCustomerDto {
  id: string;
  name: string;
}

export interface SellerSalesReportTopProductDto {
  productId: string;
  variantId: string | null;
  /** From the most recent line of the group in the period. */
  productName: string;
  variantName: string | null;
  quantity: number;
  /** Line totals after line discounts/promotions; order discounts not distributed. */
  netSalesCents: number;
}

export interface SellerSalesReportDailyTotalDto {
  /** Local `YYYY-MM-DD` in `timeZone`. */
  date: string;
  saleCount: number;
  netSalesCents: number;
}

export interface SellerSalesReportPreviousPeriodDto {
  /** Local `YYYY-MM-DD`; the period has the same day count as `[from, to)`. */
  from: string;
  /** Always the report's `from` (half-open). */
  to: string;
  saleCount: number;
  netSalesCents: number;
}

export interface SellerSalesReportConfirmedRowDto {
  id: string;
  folio: string | null;
  /** ISO UTC instant derived from `confirmedAt`. */
  confirmedAt: string;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  paymentStatus: SellerReportPaymentStatus;
  customer: SellerSalesReportCustomerDto | null;
}

export interface SellerSalesReportSummaryDto {
  saleCount: number;
  netSalesCents: number;
  collectedCents: number;
  outstandingDebtCents: number;
  averageTicketCents: number;
}

export interface SellerSalesReportConfirmedSectionDto {
  dateBasis: 'confirmedAt';
  summary: SellerSalesReportSummaryDto;
  rows: SellerSalesReportConfirmedRowDto[];
}

export interface SellerSalesReportCanceledRowDto {
  id: string;
  folio: string | null;
  /** ISO UTC instant when the sale was confirmed, or null when unattributed. */
  confirmedAt: string | null;
  /** ISO UTC instant derived from `canceledAt`. */
  canceledAt: string;
  totalCents: number;
  customer: SellerSalesReportCustomerDto | null;
}

export interface SellerSalesReportCanceledSectionDto {
  dateBasis: 'canceledAt';
  saleCount: number;
  rows: SellerSalesReportCanceledRowDto[];
}

export interface SellerSalesReportResponseDto {
  seller: SellerSalesReportSellerDto;
  tenantId: string;
  timeZone: typeof ANALYTICS_TIME_ZONE;
  from: string;
  to: string;
  /** Generation time (ISO UTC), never a historical accounting cutoff. */
  generatedAt: string;
  attribution: typeof SELLER_REPORT_ATTRIBUTION;
  balances: typeof SELLER_REPORT_BALANCES;
  rowLimit: typeof SELLER_SALES_REPORT_ROW_LIMIT;
  rowCount: number;
  confirmed: SellerSalesReportConfirmedSectionDto;
  canceled: SellerSalesReportCanceledSectionDto;
  /** At most 5: `quantity` desc, `netSalesCents` desc, `productId`. */
  topProducts: SellerSalesReportTopProductDto[];
  dailyTotals: SellerSalesReportDailyTotalDto[];
  previousPeriod: SellerSalesReportPreviousPeriodDto;
}
