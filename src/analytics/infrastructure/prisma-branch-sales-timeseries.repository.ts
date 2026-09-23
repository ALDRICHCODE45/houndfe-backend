/**
 * ADAPTER: PrismaBranchSalesTimeseriesRepository (OI-2 / S3).
 *
 * One parameterized `$queryRaw` yields at most one sparse row per local day.
 * `Sale.confirmedAt` is a `timestamp(3)` whose Prisma storage is the UTC wall
 * clock, so both sides of every comparison are normalized to that UTC-naive
 * clock: buckets via `"confirmedAt" AT TIME ZONE 'UTC' AT TIME ZONE <zone>` and
 * bounds via `(<day>::timestamp AT TIME ZONE <zone>) AT TIME ZONE 'UTC'`. The
 * bare-`timestamp`-vs-`timestamptz` alternative would re-interpret the stored
 * clock in the session `TimeZone`, drifting the range and the buckets with it.
 * Raw SQL bypasses the CLS tenant extension, so the explicit `"tenantId" = $N`
 * predicate is what scopes; the tenant comes from `TenantPrismaService`.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import {
  BranchSalesTimeseriesContractViolationError,
  type BranchSalesDailyAggregateRow,
  type BranchSalesTimeseriesRange,
  type IBranchSalesTimeseriesRepository,
} from '../domain/branch-sales-timeseries.repository';

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type RawDailyRow = Record<string, unknown>;

@Injectable()
export class PrismaBranchSalesTimeseriesRepository implements IBranchSalesTimeseriesRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findDailyAggregates(
    input: BranchSalesTimeseriesRange,
  ): Promise<BranchSalesDailyAggregateRow[]> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const rows = await prisma.$queryRaw<RawDailyRow[]>`
      SELECT
        to_char(("confirmedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${ANALYTICS_TIME_ZONE})::date, 'YYYY-MM-DD') AS "date",
        COALESCE(SUM("subtotalCents"), 0)::bigint AS "grossSalesCents",
        COALESCE(SUM("totalCents"), 0)::bigint AS "netSalesCents",
        COALESCE(SUM("paidCents"), 0)::bigint AS "collectedCents",
        COALESCE(SUM("debtCents"), 0)::bigint AS "outstandingDebtCents",
        COUNT(*)::bigint AS "saleCount"
      FROM "sales"
      WHERE "tenantId" = ${tenantId}
        AND "status" = 'CONFIRMED'
        AND "confirmedAt" IS NOT NULL
        AND "confirmedAt" >= ((${input.from}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
        AND "confirmedAt" < ((${input.to}::date::timestamp AT TIME ZONE ${ANALYTICS_TIME_ZONE}) AT TIME ZONE 'UTC')
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((row) => ({
      date: toLocalDate(row['date']),
      grossSalesCents: cents(row['grossSalesCents'], 'grossSalesCents'),
      netSalesCents: cents(row['netSalesCents'], 'netSalesCents'),
      collectedCents: cents(row['collectedCents'], 'collectedCents'),
      outstandingDebtCents: cents(
        row['outstandingDebtCents'],
        'outstandingDebtCents',
      ),
      saleCount: cents(row['saleCount'], 'saleCount'),
    }));
  }
}

/** The grouped day must already be a `YYYY-MM-DD` string from `to_char`. */
function toLocalDate(value: unknown): string {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
    throw new BranchSalesTimeseriesContractViolationError('Malformed date');
  }
  return value;
}

/** Single bigint→number point; out-of-range or non-integer values raise. */
function cents(value: unknown, field: string): number {
  if (typeof value === 'bigint') {
    if (
      value < BigInt(Number.MIN_SAFE_INTEGER) ||
      value > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new BranchSalesTimeseriesContractViolationError(
        `Range exceeded: "${field}"`,
      );
    }
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new BranchSalesTimeseriesContractViolationError(
    `Bad metric "${field}"`,
  );
}
