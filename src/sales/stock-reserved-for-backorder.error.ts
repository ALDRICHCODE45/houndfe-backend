import { BusinessRuleViolationError } from '../shared/domain/domain-error';

export const STOCK_RESERVED_FOR_BACKORDER = 'STOCK_RESERVED_FOR_BACKORDER';

/**
 * restock-backorder / T5b (contract v1 §4) — a counter sale cannot be charged
 * because the missing units are held for RESERVED backorders:
 * `available + reserved ≥ requested` for the failing line.
 *
 * `error` and `message` carry the code like `STOCK_INSUFFICIENT_AT_CONFIRM`;
 * `details` (`available` = what the counter can sell now, `reserved` = what the
 * backorders hold) ride at the root of the body. The 409 is produced by
 * `StockReservedForBackorderFilter` on the counter charge route.
 */
export class StockReservedForBackorderError extends BusinessRuleViolationError {
  constructor(
    readonly available: number,
    readonly reserved: number,
  ) {
    super(STOCK_RESERVED_FOR_BACKORDER, STOCK_RESERVED_FOR_BACKORDER, {
      available,
      reserved,
    });
  }
}
