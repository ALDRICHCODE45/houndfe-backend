/**
 * ADAPTER: PrismaBranchSalesSummaryRepository
 * (branch-analytics-summary / bas-2a).
 *
 * Read-only tenant-scoped aggregate over confirmed sales, the refund ledger,
 * and refund obligations, produced by ONE parameterized `$queryRaw`. Raw SQL
 * bypasses the CLS tenant extension, so every tenant-sensitive source carries
 * explicit `"tenantId" = $N`. Boundaries use `<date>::timestamp AT TIME ZONE
 * ANALYTICS_TIME_ZONE` (half-open `[from,to)`). `sale_payments` and
 * `SaleRefund.settledCents` are never read; the ledger is authoritative.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import {
  BranchSalesSummaryAggregateError,
  type BranchSalesSummaryMetrics,
  type BranchSalesSummaryRange,
  type IBranchSalesSummaryRepository,
} from '../domain/branch-sales-summary.repository';

type RawAggregateRow = Record<string, unknown>;

const METRIC_FIELDS = [
  'grossSalesCents',
  'netSalesCents',
  'collectedCents',
  'outstandingDebtCents',
  'saleCount',
  'settledRefundsCents',
  'pendingRefundObligationsCents',
] as const;

type MetricField = (typeof METRIC_FIELDS)[number];

@Injectable()
export class PrismaBranchSalesSummaryRepository implements IBranchSalesSummaryRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async aggregate(
    input: BranchSalesSummaryRange,
  ): Promise<BranchSalesSummaryMetrics> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const rows = await prisma.$queryRaw<RawAggregateRow[]>`
      WITH bounds AS (
        SELECT
          (${input.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AS range_start,
          (${input.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AS range_end
      ),
      sales_agg AS (
        SELECT
          COALESCE(SUM("subtotalCents"), 0)::bigint AS "grossSalesCents",
          COALESCE(SUM("totalCents"), 0)::bigint AS "netSalesCents",
          COALESCE(SUM("paidCents"), 0)::bigint AS "collectedCents",
          COALESCE(SUM("debtCents"), 0)::bigint AS "outstandingDebtCents",
          COUNT(*)::bigint AS "saleCount"
        FROM "sales"
        WHERE "tenantId" = ${tenantId}
          AND "status" = 'CONFIRMED'
          AND "confirmedAt" IS NOT NULL
          AND "confirmedAt" >= (SELECT range_start FROM bounds)
          AND "confirmedAt" < (SELECT range_end FROM bounds)
      ),
      settled_agg AS (
        SELECT COALESCE(SUM("amountCents"), 0)::bigint AS "settledRefundsCents"
        FROM "sale_refund_settlements"
        WHERE "tenantId" = ${tenantId}
          AND "settledAt" >= (SELECT range_start FROM bounds)
          AND "settledAt" < (SELECT range_end FROM bounds)
      ),
      ledger_all_time AS (
        SELECT "saleRefundId" AS refund_id,
               SUM("amountCents")::bigint AS settled_cents
        FROM "sale_refund_settlements"
        WHERE "tenantId" = ${tenantId}
        GROUP BY "saleRefundId"
      ),
      pending_agg AS (
        SELECT COALESCE(
          SUM(GREATEST(
            "sale_refunds"."amountCents" - COALESCE(ledger_all_time.settled_cents, 0),
            0
          )),
          0
        )::bigint AS "pendingRefundObligationsCents"
        FROM "sale_refunds"
        LEFT JOIN ledger_all_time
          ON ledger_all_time.refund_id = "sale_refunds"."id"
        WHERE "sale_refunds"."tenantId" = ${tenantId}
          AND "sale_refunds"."createdAt" >= (SELECT range_start FROM bounds)
          AND "sale_refunds"."createdAt" < (SELECT range_end FROM bounds)
      )
      SELECT
        sales_agg."grossSalesCents",
        sales_agg."netSalesCents",
        sales_agg."collectedCents",
        sales_agg."outstandingDebtCents",
        sales_agg."saleCount",
        settled_agg."settledRefundsCents",
        pending_agg."pendingRefundObligationsCents"
      FROM sales_agg, settled_agg, pending_agg
    `;

    if (rows.length !== 1) {
      throw new BranchSalesSummaryAggregateError(
        `Expected exactly one aggregate row, received ${rows.length}`,
      );
    }

    const row = rows[0];
    const metrics = {} as Record<MetricField, number>;
    for (const field of METRIC_FIELDS) {
      metrics[field] = toSafeIntegerCent(row[field], field);
    }

    const averageTicketCents =
      metrics.saleCount === 0
        ? 0
        : Math.round(metrics.netSalesCents / metrics.saleCount);

    return { ...metrics, averageTicketCents };
  }
}

/**
 * The single bigint→number conversion point: out-of-range or non-integer
 * aggregates raise a stable error instead of silently losing precision.
 */
function toSafeIntegerCent(value: unknown, field: string): number {
  if (typeof value === 'bigint') {
    if (
      value < BigInt(Number.MIN_SAFE_INTEGER) ||
      value > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new BranchSalesSummaryAggregateError(
        `Field "${field}" exceeds the safe integer range`,
      );
    }
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new BranchSalesSummaryAggregateError(`Field "${field}" is malformed`);
}
