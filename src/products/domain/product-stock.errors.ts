import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';

export const STOCK_QUANTITY_READ_ONLY = 'STOCK_QUANTITY_READ_ONLY';
export const LOT_HAS_STOCK = 'LOT_HAS_STOCK';
export const STOCK_TRACKING_HAS_STOCK = 'STOCK_TRACKING_HAS_STOCK';

/** 400: stock is only changed by inventory adjustments, sales and removals (O1/S2). */
export class StockQuantityReadOnlyError extends InvalidArgumentError {
  constructor(resource: 'product' | 'variant' | 'lot') {
    super(
      `quantity: the stock of a ${resource} cannot be edited directly; use an inventory adjustment`,
      STOCK_QUANTITY_READ_ONLY,
    );
  }
}

/**
 * Rejects a PATCH body that carries `quantity` (even `null`/`0`). Checks the
 * value, not key presence: DTO instances from the ValidationPipe declare the
 * optional field as an own `undefined` property, and JSON cannot send undefined.
 */
export function assertNoDirectQuantityEdit(
  dto: { quantity?: unknown } | null | undefined,
  resource: 'product' | 'variant' | 'lot',
): void {
  if (dto && dto.quantity !== undefined) {
    throw new StockQuantityReadOnlyError(resource);
  }
}

/** 409: a lot with stock cannot be deleted; adjust it to 0 first (O1/S8). */
export class LotHasStockError extends BusinessRuleViolationError {
  constructor(lotId: string, quantity: number) {
    super(
      `Lot ${lotId} still has ${quantity} units; adjust it to 0 before deleting it`,
      LOT_HAS_STOCK,
      { lotId, quantity },
    );
  }
}

/** 409: stock tracking cannot be switched off while units remain; adjust to 0 first (O1/L8). */
export class StockTrackingHasStockError extends BusinessRuleViolationError {
  constructor(productId: string, quantity: number) {
    super(
      `Product ${productId} still has ${quantity} units; adjust it to 0 before turning stock tracking off`,
      STOCK_TRACKING_HAS_STOCK,
      { productId, quantity },
    );
  }
}
