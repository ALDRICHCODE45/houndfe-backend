/**
 * APPLICATION: BranchSalesTimeseriesService (OI-2 / S2).
 *
 * Exactly ONE `findDailyAggregates({ from, to })` call, then one ordered,
 * zero-filled point per Gregorian local date in the half-open range `[from,to)`.
 * No `tenantId` parameter (tenant scope is implicit) and `interval` is never
 * forwarded to the port. Date enumeration is integer arithmetic, so host
 * timezone, locale and tzdata cannot change the output.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import { enumerateLocalCalendarDates } from '../domain/local-calendar-dates';
import {
  BRANCH_SALES_TIMESERIES_REPOSITORY,
  BranchSalesTimeseriesContractViolationError,
  type BranchSalesDailyAggregateRow,
  type BranchSalesTimeseriesRange,
  type IBranchSalesTimeseriesRepository,
} from '../domain/branch-sales-timeseries.repository';
import type { BranchSalesTimeseriesQueryDto } from '../dto/branch-sales-timeseries-query.dto';
import type { BranchSalesTimeseriesResponseDto } from '../dto/branch-sales-timeseries-response.dto';

@Injectable()
export class BranchSalesTimeseriesService {
  constructor(
    @Inject(BRANCH_SALES_TIMESERIES_REPOSITORY)
    private readonly repository: IBranchSalesTimeseriesRepository,
  ) {}

  async getTimeseries(
    query: BranchSalesTimeseriesQueryDto,
  ): Promise<BranchSalesTimeseriesResponseDto> {
    const rows = await this.repository.findDailyAggregates({
      from: query.from,
      to: query.to,
    });
    const byDate = this.indexRows(rows, query);

    return {
      timeZone: ANALYTICS_TIME_ZONE,
      from: query.from,
      to: query.to,
      interval: query.interval,
      points: enumerateLocalCalendarDates(query.from, query.to).map((date) => {
        const row = byDate.get(date);
        const netSalesCents = row?.netSalesCents ?? 0;
        const saleCount = row?.saleCount ?? 0;
        return {
          date,
          grossSalesCents: row?.grossSalesCents ?? 0,
          netSalesCents,
          collectedCents: row?.collectedCents ?? 0,
          outstandingDebtCents: row?.outstandingDebtCents ?? 0,
          saleCount,
          averageTicketCents:
            saleCount === 0 ? 0 : Math.round(netSalesCents / saleCount),
        };
      }),
    };
  }

  /**
   * Fail-fast on a duplicated date or a date outside `[from,to)`; the Map also
   * normalizes row order without mutating the adapter's returned array.
   */
  private indexRows(
    rows: BranchSalesDailyAggregateRow[],
    range: BranchSalesTimeseriesRange,
  ): Map<string, BranchSalesDailyAggregateRow> {
    const byDate = new Map<string, BranchSalesDailyAggregateRow>();

    for (const row of rows) {
      if (row.date < range.from || row.date >= range.to) {
        throw new BranchSalesTimeseriesContractViolationError(
          `Repository returned date "${row.date}" outside the requested range [${range.from}, ${range.to})`,
        );
      }
      if (byDate.has(row.date)) {
        throw new BranchSalesTimeseriesContractViolationError(
          `Repository returned more than one row for local date "${row.date}"`,
        );
      }
      byDate.set(row.date, row);
    }
    return byDate;
  }
}
