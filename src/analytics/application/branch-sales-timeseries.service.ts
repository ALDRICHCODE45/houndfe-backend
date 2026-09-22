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
import {
  BRANCH_SALES_TIMESERIES_REPOSITORY,
  BranchSalesTimeseriesContractViolationError,
  type BranchSalesDailyAggregateRow,
  type BranchSalesTimeseriesRange,
  type IBranchSalesTimeseriesRepository,
} from '../domain/branch-sales-timeseries.repository';
import type { BranchSalesTimeseriesQueryDto } from '../dto/branch-sales-timeseries-query.dto';
import type { BranchSalesTimeseriesResponseDto } from '../dto/branch-sales-timeseries-response.dto';

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a Gregorian month — pure arithmetic, never `Date`. */
function daysInMonth(year: number, month: number): number {
  if (month !== 2) return MONTH_LENGTHS[month - 1];
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return isLeapYear ? 29 : 28;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Every local calendar date in `[from,to)`, ascending. Both bounds are exact
 * `YYYY-MM-DD` strings, so byte order is chronological order and no `Date`
 * parsing (which reads a bare date as UTC midnight) participates. The year is
 * re-padded to four digits because valid DTO years run down to `0001`.
 */
function enumerateLocalCalendarDates(from: string, to: string): string[] {
  const dates: string[] = [];
  if (to <= from) return dates;
  const [startYear, startMonth, startDay] = from.split('-').map(Number);
  let year = startYear;
  let month = startMonth;
  let day = startDay;
  let date = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;

  while (date < to) {
    dates.push(date);
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    date = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  }

  return dates;
}

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
