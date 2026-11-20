import type { Sale } from './domain/sale.entity';
import { STOCK_RESERVED_FOR_BACKORDER } from './stock-reserved-for-backorder.error';

/**
 * restock-backorder / T5b — non-blocking warning on a draft line (contract v1
 * §4: POS add-item stays advisory). Present only on the line the request just
 * touched, only in that response (`POST /sales/drafts/:id/items`,
 * `PATCH /sales/drafts/:id/items/:itemId`); it is not persisted.
 */
export interface StockWarning {
  code: typeof STOCK_RESERVED_FOR_BACKORDER;
  /** Units the counter can sell now (`availableToSell`). */
  available: number;
  /** Units held for RESERVED backorders. */
  reserved: number;
}

type DraftResponse = ReturnType<Sale['toResponse']>;

export type DraftResponseWithStockWarning = Omit<DraftResponse, 'items'> & {
  items: Array<
    DraftResponse['items'][number] & { stockWarning?: StockWarning }
  >;
};

/**
 * The warning for a requested quantity that exceeds `availableToSell` but not
 * `stockOnHand` (`available + reserved ≥ requested`); `null` when the stock
 * covers it, when nothing is reserved, or when the reserved units would not
 * help either (the request is then refused as before).
 */
export function reservedStockWarning(
  availability: {
    available: boolean;
    currentStock: number | null;
    reservedForBackorders?: number;
  },
  requestedQuantity: number,
): StockWarning | null {
  if (availability.available || availability.currentStock === null) return null;
  const reserved = availability.reservedForBackorders ?? 0;
  if (reserved <= 0) return null;
  if (availability.currentStock + reserved < requestedQuantity) return null;
  return {
    code: STOCK_RESERVED_FOR_BACKORDER,
    available: availability.currentStock,
    reserved,
  };
}

export function withStockWarning(
  response: DraftResponse,
  itemId: string,
  warning: StockWarning | null,
): DraftResponseWithStockWarning {
  if (!warning) return response;
  return {
    ...response,
    items: response.items.map((item) =>
      item.id === itemId ? { ...item, stockWarning: warning } : item,
    ),
  };
}
