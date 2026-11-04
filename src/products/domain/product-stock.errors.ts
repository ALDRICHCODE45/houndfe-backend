import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';

export const STOCK_QUANTITY_READ_ONLY = 'STOCK_QUANTITY_READ_ONLY';
export const LOT_HAS_STOCK = 'LOT_HAS_STOCK';

/** 400: stock is only changed by inventory adjustments, sales and removals (O1/S2). */
export class StockQuantityReadOnlyError extends InvalidArgumentError {
  constructor(resource: 'product' | 'variant' | 'lot') {
    super(
      `quantity: the stock of a ${resource} cannot be edited directly; use an inventory adjustment`,
      STOCK_QUANTITY_READ_ONLY,
    );
  }
}

/** Rejects a PATCH body that carries a `quantity` key (even `null`/`0`). */
export function assertNoDirectQuantityEdit(
  dto: object | null | undefined,
  resource: 'product' | 'variant' | 'lot',
): void {
  if (dto && Object.prototype.hasOwnProperty.call(dto, 'quantity')) {
    throw new StockQuantityReadOnlyError(resource);
  }
}

/** 409 (products-scoped filter): a lot with stock cannot be deleted; adjust it to 0 first (O1/S8). */
export class LotHasStockError extends BusinessRuleViolationError {
  constructor(lotId: string, quantity: number) {
    super(
      `Lot ${lotId} still has ${quantity} units; adjust it to 0 before deleting it`,
      LOT_HAS_STOCK,
      { lotId, quantity },
    );
  }
}
