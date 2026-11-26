/**
 * customers-listing — the ONE definition of a customer's sales metrics
 * (`docs/proposals/customers-list-contract.md` §2.1). The listing row
 * (`GET /customers/listing`) and the KPI strip
 * (`GET /customers/:customerId/sales-summary`, §6.2) must both run this
 * fragment so their numbers always match.
 *
 * Raw SQL is not tenant-scoped by the Prisma extension: the caller passes
 * `tenantId` explicitly and it is applied to `sales` here.
 */
import { Prisma } from '@prisma/client';
import { businessToday } from '../../inventory/domain/fefo-allocator';
import type { CustomerSalesMetrics } from './customer-listing.types';

/** `PROMOTIONS_BUSINESS_TIMEZONE` default, the one `GET /sales` uses. */
export const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';

/**
 * The overdue cut-off of `GET /sales` (`SalesService.listSales`): 00:00Z of
 * today's LOCAL date in the business timezone, built from the same
 * `businessToday` helper. The due day of a sale is the UTC calendar date of
 * `dueDate`, so a sale is overdue when `dueDate < cutoff`.
 */
export function overdueCutoff(now: Date, timeZone: string): Date {
  return new Date(`${businessToday(now, timeZone)}T00:00:00.000Z`);
}

export interface CustomerSalesMetricsSqlInput {
  tenantId: string;
  /** SQL expression of the customer id: `Prisma.sql\`c."id"\`` or a bound value. */
  customerId: Prisma.Sql;
  /** `overdueCutoff(now, timeZone)`, computed once per request. */
  overdueBefore: Date;
}

/**
 * One-row aggregate over the customer's CONFIRMED sales (any channel), the
 * same set as `GET /sales` `summary`. Use it as
 * `LEFT JOIN LATERAL (${customerSalesMetricsSql(...)}) m ON true`, or alone
 * with a bound customer id. It always returns exactly one row; map it with
 * `toCustomerSalesMetrics`.
 *
 * Output columns: `salesCount` int, `totalSoldCents` bigint, `openDebtCents`
 * bigint, `overdueCount` int, `overdueDebtCents` bigint,
 * `oldestOverdueDueDate` timestamp|null, `lastPurchaseAt` timestamp|null,
 * `averageTicketCents` bigint|null.
 *
 * Served by the partial covering index `sales_tenant_customer_confirmed_idx`
 * (migration `20261126110000_customers_listing_sales_index`).
 */
export function customerSalesMetricsSql(
  input: CustomerSalesMetricsSqlInput,
): Prisma.Sql {
  // `timestamp(3)` columns hold the UTC wall clock: compare against the
  // cut-off instant converted to UTC wall clock.
  const cutoff = Prisma.sql`(${input.overdueBefore.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const overdue = Prisma.sql`s."openDebtCents" > 0 AND s."dueDate" < ${cutoff}`;
  return Prisma.sql`
    SELECT
      COUNT(*)::int AS "salesCount",
      COALESCE(SUM(s."totalCents"), 0)::bigint AS "totalSoldCents",
      COALESCE(SUM(s."openDebtCents"), 0)::bigint AS "openDebtCents",
      (COUNT(*) FILTER (WHERE ${overdue}))::int AS "overdueCount",
      COALESCE(SUM(s."openDebtCents") FILTER (WHERE ${overdue}), 0)::bigint AS "overdueDebtCents",
      MIN(s."dueDate") FILTER (WHERE ${overdue}) AS "oldestOverdueDueDate",
      MAX(s."confirmedAt") AS "lastPurchaseAt",
      CASE WHEN COUNT(*) = 0 THEN NULL
           ELSE ROUND(SUM(s."totalCents")::numeric / COUNT(*))::bigint
      END AS "averageTicketCents"
    FROM "sales" s
    WHERE s."tenantId" = ${input.tenantId}
      AND s."customerId" = ${input.customerId}
      AND s."status" = 'CONFIRMED'`;
}

/** Raw columns of `customerSalesMetricsSql` as Prisma returns them. */
export interface CustomerSalesMetricsRecord {
  salesCount: number;
  totalSoldCents: bigint | number;
  openDebtCents: bigint | number;
  overdueCount: number;
  overdueDebtCents: bigint | number;
  oldestOverdueDueDate: Date | null;
  lastPurchaseAt: Date | null;
  averageTicketCents: bigint | number | null;
}

/** Contract §2.1 shape; `oldestOverdueDueDate` like `summary.oldestOverdueDueDate`. */
export function toCustomerSalesMetrics(
  raw: CustomerSalesMetricsRecord,
): CustomerSalesMetrics {
  return {
    openDebtCents: Number(raw.openDebtCents),
    overdueDebtCents: Number(raw.overdueDebtCents),
    overdueCount: Number(raw.overdueCount),
    oldestOverdueDueDate: raw.oldestOverdueDueDate
      ? raw.oldestOverdueDueDate.toISOString().slice(0, 10)
      : null,
    salesCount: Number(raw.salesCount),
    totalSoldCents: Number(raw.totalSoldCents),
    averageTicketCents:
      raw.averageTicketCents === null ? null : Number(raw.averageTicketCents),
    lastPurchaseAt: raw.lastPurchaseAt
      ? raw.lastPurchaseAt.toISOString()
      : null,
  };
}
