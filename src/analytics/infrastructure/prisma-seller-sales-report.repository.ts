/**
 * ADAPTER: PrismaSellerSalesReportRepository (seller-sales-report / v1).
 *
 * One `tenantPrisma.runInTransaction(work, 'RepeatableRead')` owns the whole
 * read: target eligibility, the combined row count, and both bounded row
 * sections. `getClient()` is read INSIDE the work callback, so it resolves to
 * the ambient scoped transaction client; an explicit RepeatableRead request
 * inside a weaker ambient transaction fails closed upstream. Raw SQL bypasses
 * the CLS tenant extension, so every tenant-sensitive source carries an
 * explicit `"tenantId" = $N`, and the `User` join is scoped through a
 * `tenant_memberships`/`sales` EXISTS — never `isActive`.
 *
 * `confirmedAt`/`canceledAt` are UTC-naive `timestamp(3)`; both bounds use the
 * double `AT TIME ZONE` (Mexico City then UTC) so the local `[from,to)` range
 * maps onto the stored clock.
 *
 * sales-history-redesign (S5–S8): both row queries LEFT JOIN the current
 * customer (tenant-scoped; id + name parts only) and confirmed rows carry their
 * local business day for `dailyTotals`; after the cap, the same snapshot reads
 * `topProducts` (line NET over the same CONFIRMED set) and the uncapped
 * `previousPeriod` aggregate (same day count, ending at `from`).
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { SellerNotFoundError } from '../../sales/domain/sale.errors';
import {
  ANALYTICS_TIME_ZONE,
  SELLER_SALES_REPORT_ROW_LIMIT,
  SELLER_SALES_REPORT_TOP_PRODUCTS_LIMIT,
} from '../domain/analytics.constants';
import {
  SellerReportRowLimitExceededError,
  SellerSalesReportContractError,
  type ISellerSalesReportRepository,
  type SellerReportPaymentStatus,
  type SellerSalesReportCanceledRow,
  type SellerSalesReportConfirmedRow,
  type SellerSalesReportCustomer,
  type SellerSalesReportPreviousPeriod,
  type SellerSalesReportRange,
  type SellerSalesReportResult,
  type SellerSalesReportTopProduct,
} from '../domain/seller-sales-report.repository';

type Raw = Record<string, unknown>;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PAYMENT_STATUSES: readonly SellerReportPaymentStatus[] = [
  'PAID',
  'PARTIAL',
  'CREDIT',
];

function safeNonNegativeInt(value: unknown, label: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SellerSalesReportContractError(`Range exceeded: ${label}`);
    }
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new SellerSalesReportContractError(`Bad integer: ${label}`);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new SellerSalesReportContractError(`Bad string: ${label}`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : requiredText(value, label);
}

function localDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
    throw new SellerSalesReportContractError(`Bad local date: ${label}`);
  }
  return value;
}

/** Same naming rule as the `GET /sales` rows: `firstName lastName` or `firstName`. */
function customer(row: Raw): SellerSalesReportCustomer | null {
  if (row['customerId'] === null) {
    return null;
  }
  const firstName = requiredText(
    row['customerFirstName'],
    'customer.firstName',
  );
  const lastName = nullableText(row['customerLastName'], 'customer.lastName');
  return {
    id: requiredText(row['customerId'], 'customer.id'),
    name: lastName ? `${firstName} ${lastName}` : firstName,
  };
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SellerSalesReportContractError(`Bad date: ${label}`);
  }
  return value;
}

function paymentStatus(
  value: unknown,
  label: string,
): SellerReportPaymentStatus {
  if (
    typeof value !== 'string' ||
    !PAYMENT_STATUSES.includes(value as SellerReportPaymentStatus)
  ) {
    throw new SellerSalesReportContractError(`Bad paymentStatus: ${label}`);
  }
  return value as SellerReportPaymentStatus;
}

function mapConfirmed(row: Raw): SellerSalesReportConfirmedRow {
  return {
    id: requiredText(row['id'], 'id'),
    folio: nullableText(row['folio'], 'folio'),
    confirmedAt: validDate(row['confirmedAt'], 'confirmedAt'),
    totalCents: safeNonNegativeInt(row['totalCents'], 'totalCents'),
    paidCents: safeNonNegativeInt(row['paidCents'], 'paidCents'),
    debtCents: safeNonNegativeInt(row['debtCents'], 'debtCents'),
    paymentStatus: paymentStatus(row['paymentStatus'], 'paymentStatus'),
    localDate: localDate(row['localDate'], 'localDate'),
    customer: customer(row),
  };
}

function mapCanceled(row: Raw): SellerSalesReportCanceledRow {
  return {
    id: requiredText(row['id'], 'id'),
    folio: nullableText(row['folio'], 'folio'),
    confirmedAt:
      row['confirmedAt'] === null
        ? null
        : validDate(row['confirmedAt'], 'confirmedAt'),
    canceledAt: validDate(row['canceledAt'], 'canceledAt'),
    totalCents: safeNonNegativeInt(row['totalCents'], 'totalCents'),
    customer: customer(row),
  };
}

function mapTopProduct(row: Raw): SellerSalesReportTopProduct {
  return {
    productId: requiredText(row['productId'], 'top.productId'),
    variantId: nullableText(row['variantId'], 'top.variantId'),
    productName: requiredText(row['productName'], 'top.productName'),
    variantName: nullableText(row['variantName'], 'top.variantName'),
    quantity: safeNonNegativeInt(row['quantity'], 'top.quantity'),
    netSalesCents: safeNonNegativeInt(
      row['netSalesCents'],
      'top.netSalesCents',
    ),
  };
}

function mapPreviousPeriod(
  rows: Raw[],
  range: SellerSalesReportRange,
): SellerSalesReportPreviousPeriod {
  if (rows.length !== 1) {
    throw new SellerSalesReportContractError('Missing previous period row');
  }
  const [row] = rows;
  return {
    from: localDate(row['from'], 'previous.from'),
    to: range.from,
    saleCount: safeNonNegativeInt(row['saleCount'], 'previous.saleCount'),
    netSalesCents: safeNonNegativeInt(
      row['netSalesCents'],
      'previous.netSalesCents',
    ),
  };
}

@Injectable()
export class PrismaSellerSalesReportRepository implements ISellerSalesReportRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  findBySeller(
    sellerUserId: string,
    range: SellerSalesReportRange,
  ): Promise<SellerSalesReportResult> {
    return this.tenantPrisma.runInTransaction(
      () => this.readSnapshot(sellerUserId, range),
      'RepeatableRead',
    );
  }

  private async readSnapshot(
    sellerUserId: string,
    range: SellerSalesReportRange,
  ): Promise<SellerSalesReportResult> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const target = await prisma.$queryRaw<Raw[]>`
      SELECT u."id" AS "id", u."name" AS "name"
      FROM "users" u
      WHERE u."id" = ${sellerUserId}
        AND (
          EXISTS (
            SELECT 1 FROM "tenant_memberships" tm
            WHERE tm."userId" = u."id" AND tm."tenantId" = ${tenantId}
          )
          OR EXISTS (
            SELECT 1 FROM "sales" s
            WHERE s."sellerUserId" = u."id" AND s."tenantId" = ${tenantId}
          )
        )
    `;
    if (target.length !== 1) {
      throw new SellerNotFoundError();
    }
    const seller = {
      id: requiredText(target[0]['id'], 'seller.id'),
      name: requiredText(target[0]['name'], 'seller.name'),
    };

    const countRows = await prisma.$queryRaw<Raw[]>`
      SELECT
        (
          SELECT COUNT(*) FROM "sales"
          WHERE "tenantId" = ${tenantId} AND "sellerUserId" = ${sellerUserId}
            AND "status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL
            AND "confirmedAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
            AND "confirmedAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        )::bigint AS "confirmedCount",
        (
          SELECT COUNT(*) FROM "sales"
          WHERE "tenantId" = ${tenantId} AND "sellerUserId" = ${sellerUserId}
            AND "status" = 'CANCELED' AND "canceledAt" IS NOT NULL
            AND "canceledAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
            AND "canceledAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        )::bigint AS "canceledCount"
    `;
    if (countRows.length !== 1) {
      throw new SellerSalesReportContractError('Missing combined count row');
    }
    const confirmedCount = safeNonNegativeInt(
      countRows[0]['confirmedCount'],
      'confirmedCount',
    );
    const canceledCount = safeNonNegativeInt(
      countRows[0]['canceledCount'],
      'canceledCount',
    );
    const rowCount = confirmedCount + canceledCount;
    if (!Number.isSafeInteger(rowCount)) {
      throw new SellerSalesReportContractError('Combined row count overflow');
    }
    if (rowCount > SELLER_SALES_REPORT_ROW_LIMIT) {
      throw new SellerReportRowLimitExceededError(
        rowCount,
        SELLER_SALES_REPORT_ROW_LIMIT,
      );
    }

    const confirmedRows = await prisma.$queryRaw<Raw[]>`
      SELECT s."id", s."folio", s."confirmedAt", s."totalCents", s."paidCents", s."debtCents", s."paymentStatus",
        to_char((s."confirmedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${ANALYTICS_TIME_ZONE})::date, 'YYYY-MM-DD') AS "localDate",
        c."id" AS "customerId", c."firstName" AS "customerFirstName", c."lastName" AS "customerLastName"
      FROM "sales" s
      LEFT JOIN "customers" c ON c."id" = s."customerId" AND c."tenantId" = ${tenantId}
      WHERE s."tenantId" = ${tenantId} AND s."sellerUserId" = ${sellerUserId}
        AND s."status" = 'CONFIRMED' AND s."confirmedAt" IS NOT NULL
        AND s."confirmedAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        AND s."confirmedAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      ORDER BY s."confirmedAt" ASC, s."id" ASC
    `;
    const canceledRows = await prisma.$queryRaw<Raw[]>`
      SELECT s."id", s."folio", s."confirmedAt", s."canceledAt", s."totalCents",
        c."id" AS "customerId", c."firstName" AS "customerFirstName", c."lastName" AS "customerLastName"
      FROM "sales" s
      LEFT JOIN "customers" c ON c."id" = s."customerId" AND c."tenantId" = ${tenantId}
      WHERE s."tenantId" = ${tenantId} AND s."sellerUserId" = ${sellerUserId}
        AND s."status" = 'CANCELED' AND s."canceledAt" IS NOT NULL
        AND s."canceledAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        AND s."canceledAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      ORDER BY s."canceledAt" ASC, s."id" ASC
    `;

    const confirmed = confirmedRows.map(mapConfirmed);
    const canceled = canceledRows.map(mapCanceled);
    if (
      confirmed.length !== confirmedCount ||
      canceled.length !== canceledCount
    ) {
      throw new SellerSalesReportContractError(
        'Row count does not match the materialized rows',
      );
    }

    // Line NET mirrors the receipt mapper: per-unit line discounts are baked
    // into "unitPriceCents"; a BUY_X_GET_Y/ADVANCED whole-line reward keeps the
    // full unit price and rides "discountAmountCents" (same discriminator as
    // `SaleItem.isBuyXGetYReward()`). Order-level discounts are not distributed.
    const topProductRows = await prisma.$queryRaw<Raw[]>`
      WITH lines AS (
        SELECT si."productId", si."variantId", si."productName", si."variantName", si."quantity",
          (si."unitPriceCents"::bigint * si."quantity"
            - CASE WHEN si."promotionId" IS NOT NULL
                AND COALESCE(si."discountAmountCents", 0) > 0
                AND si."prePriceCentsBeforeDiscount" IS NOT NULL
                AND si."unitPriceCents" = si."prePriceCentsBeforeDiscount"
              THEN si."discountAmountCents" ELSE 0 END) AS "lineNetCents",
          s."confirmedAt", si."createdAt", si."id"
        FROM "sale_items" si
        JOIN "sales" s ON s."id" = si."saleId" AND s."tenantId" = ${tenantId}
        WHERE si."tenantId" = ${tenantId} AND s."sellerUserId" = ${sellerUserId}
          AND s."status" = 'CONFIRMED' AND s."confirmedAt" IS NOT NULL
          AND s."confirmedAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
          AND s."confirmedAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      ),
      totals AS (
        SELECT "productId", "variantId", SUM("quantity")::bigint AS "quantity", SUM("lineNetCents")::bigint AS "netSalesCents"
        FROM lines
        GROUP BY "productId", "variantId"
      ),
      latest AS (
        SELECT DISTINCT ON ("productId", "variantId") "productId", "variantId", "productName", "variantName"
        FROM lines
        ORDER BY "productId", "variantId", "confirmedAt" DESC, "createdAt" DESC, "id" DESC
      )
      SELECT a."productId", a."variantId", l."productName", l."variantName", a."quantity", a."netSalesCents"
      FROM totals a
      JOIN latest l ON l."productId" = a."productId" AND l."variantId" IS NOT DISTINCT FROM a."variantId"
      ORDER BY "quantity" DESC, "netSalesCents" DESC, a."productId" COLLATE "C" ASC, a."variantId" COLLATE "C" ASC NULLS FIRST
      LIMIT ${SELLER_SALES_REPORT_TOP_PRODUCTS_LIMIT}
    `;
    const topProducts = topProductRows.map(mapTopProduct);

    // Previous period: same number of local days, ending where `from` starts.
    const previousRows = await prisma.$queryRaw<Raw[]>`
      WITH bounds AS (
        SELECT (${range.from}::date - (${range.to}::date - ${range.from}::date)) AS "previousFrom"
      )
      SELECT to_char(b."previousFrom", 'YYYY-MM-DD') AS "from",
        COUNT(s."id")::bigint AS "saleCount",
        COALESCE(SUM(s."totalCents"), 0)::bigint AS "netSalesCents"
      FROM bounds b
      LEFT JOIN "sales" s ON s."tenantId" = ${tenantId} AND s."sellerUserId" = ${sellerUserId}
        AND s."status" = 'CONFIRMED' AND s."confirmedAt" IS NOT NULL
        AND s."confirmedAt" >= ((b."previousFrom"::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        AND s."confirmedAt" < ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      GROUP BY b."previousFrom"
    `;
    const previousPeriod = mapPreviousPeriod(previousRows, range);

    return {
      tenantId,
      seller,
      confirmed,
      canceled,
      rowCount,
      topProducts,
      previousPeriod,
    };
  }
}
