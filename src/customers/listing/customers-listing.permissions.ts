import { BadRequestException } from '@nestjs/common';

/**
 * customers-listing — contract §10.1: the metric filter params, in the order
 * the `field` of the 400 reports the first offending one. T3 declares them on
 * `CustomersListingQueryDto`; the check below already covers them.
 */
export const METRIC_FILTER_PARAMS = [
  'hasDebt',
  'openDebtMin',
  'openDebtMax',
  'hasOverdue',
  'overdueMoreThanDays',
  'oldestOverdueFrom',
  'oldestOverdueTo',
  'totalSoldMin',
  'totalSoldMax',
  'salesCountMin',
  'salesCountMax',
  'averageTicketMin',
  'averageTicketMax',
  'lastPurchaseFrom',
  'lastPurchaseTo',
  'noPurchaseMoreThanDays',
] as const;

/** Contract §10.1: the `sortBy` values that need `read:Sale`. */
export const METRIC_SORT_KEYS: ReadonlySet<string> = new Set([
  'openDebt',
  'oldestOverdue',
  'lastPurchaseAt',
  'totalSold',
  'salesCount',
  'averageTicket',
]);

export const LISTING_PARAM_REQUIRES_PERMISSION =
  'LISTING_PARAM_REQUIRES_PERMISSION';

/**
 * Contract §10.1 — without `read:Sale` a metric param is rejected with the
 * listing envelope plus `details.required`. Runs after DTO validation, so a
 * malformed value still gets its normal validation error first. `field` is
 * the first offending filter (in `METRIC_FILTER_PARAMS` order), then `sortBy`.
 */
export function assertListingParamsPermitted(
  query: Readonly<Record<string, unknown>>,
  canReadSale: boolean,
): void {
  if (canReadSale) return;
  const field =
    METRIC_FILTER_PARAMS.find((key) => query[key] !== undefined) ??
    (typeof query.sortBy === 'string' && METRIC_SORT_KEYS.has(query.sortBy)
      ? 'sortBy'
      : undefined);
  if (!field) return;
  throw new BadRequestException({
    statusCode: 400,
    code: LISTING_PARAM_REQUIRES_PERMISSION,
    message: `${field} requires read:Sale`,
    field,
    details: { required: 'read:Sale' },
  });
}
