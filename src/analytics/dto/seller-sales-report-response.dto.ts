/**
 * Seller sales report — stable response contract (seller-sales-report / v1).
 *
 * Two independent sections: `confirmed` (attributed by `confirmedAt`, with the
 * derived current-balance summary and its bounded rows) and `canceled`
 * (informational, attributed by `canceledAt`). Every monetary value is a
 * non-negative integer number of cents; no customer, cashier, item, free-text
 * cancellation reason or currency field is projected.
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
] as const;

export interface SellerSalesReportSellerDto {
  id: string;
  name: string;
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
}
