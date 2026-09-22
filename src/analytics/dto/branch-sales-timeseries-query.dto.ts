/**
 * Branch sales daily timeseries — request query contract (OI-2 / S1).
 *
 * Extends `BranchSalesSummaryQueryDto` so the business-day range rules are
 * inherited, never duplicated: exact Gregorian `YYYY-MM-DD` local calendar
 * dates in `America/Mexico_City`, `to > from`, half-open `[from, to)`, and the
 * `MAX_ANALYTICS_RANGE_DAYS` cap. `interval` is optional and accepts the one
 * supported granularity `'day'`; the range still travels as strings at the
 * transport boundary.
 */
import { IsIn } from 'class-validator';
import { BranchSalesSummaryQueryDto } from './branch-sales-summary-query.dto';

// Re-exported so the timeseries response DTO and specs share the summary
// module's single source of truth for the timezone and the range cap.
export {
  ANALYTICS_TIME_ZONE,
  MAX_ANALYTICS_RANGE_DAYS,
} from './branch-sales-summary-query.dto';

/** Only supported aggregation granularity: one point per local calendar day. */
export const BRANCH_SALES_TIMESERIES_INTERVAL = 'day';

export class BranchSalesTimeseriesQueryDto extends BranchSalesSummaryQueryDto {
  /** Aggregation granularity; an omitted value means `'day'`. */
  @IsIn([BRANCH_SALES_TIMESERIES_INTERVAL])
  interval: typeof BRANCH_SALES_TIMESERIES_INTERVAL =
    BRANCH_SALES_TIMESERIES_INTERVAL;
}
