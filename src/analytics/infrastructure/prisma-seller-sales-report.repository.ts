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
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { SellerNotFoundError } from '../../sales/domain/sale.errors';
import {
  ANALYTICS_TIME_ZONE,
  SELLER_SALES_REPORT_ROW_LIMIT,
} from '../domain/analytics.constants';
import {
  SellerReportRowLimitExceededError,
  SellerSalesReportContractError,
  type ISellerSalesReportRepository,
  type SellerReportPaymentStatus,
  type SellerSalesReportCanceledRow,
  type SellerSalesReportConfirmedRow,
  type SellerSalesReportRange,
  type SellerSalesReportResult,
} from '../domain/seller-sales-report.repository';

type Raw = Record<string, unknown>;

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
      SELECT "id", "folio", "confirmedAt", "totalCents", "paidCents", "debtCents", "paymentStatus"
      FROM "sales"
      WHERE "tenantId" = ${tenantId} AND "sellerUserId" = ${sellerUserId}
        AND "status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL
        AND "confirmedAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        AND "confirmedAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      ORDER BY "confirmedAt" ASC, "id" ASC
    `;
    const canceledRows = await prisma.$queryRaw<Raw[]>`
      SELECT "id", "folio", "confirmedAt", "canceledAt", "totalCents"
      FROM "sales"
      WHERE "tenantId" = ${tenantId} AND "sellerUserId" = ${sellerUserId}
        AND "status" = 'CANCELED' AND "canceledAt" IS NOT NULL
        AND "canceledAt" >= ((${range.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        AND "canceledAt" < ((${range.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      ORDER BY "canceledAt" ASC, "id" ASC
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

    return { tenantId, seller, confirmed, canceled, rowCount };
  }
}
