/**
 * PORT: IProductRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for persistence.
 * Lives in domain, implemented in infrastructure.
 */
import { Product } from './product.entity';

/**
 * Re-exported for callers that want to declare a return type locally
 * without importing from the stock-alerts bounded context. The shape
 * originates in `src/stock-alerts/domain/stock-crossing.ts` and is the
 * canonical "one-shot per item" record produced by `decrementStockForCharge`.
 */
export type { StockCrossing } from '../../stock-alerts/domain/stock-crossing';

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  findByBarcode(barcode: string): Promise<Product | null>;
  findAll(): Promise<Product[]>;
  save(product: Product): Promise<Product>;
  delete(id: string): Promise<void>;

  /** Check SKU uniqueness across products and variants */
  isSkuTaken(
    sku: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean>;

  /** Check barcode uniqueness across products and variants */
  isBarcodeTaken(
    barcode: string,
    exclude?: { productId?: string; variantId?: string },
  ): Promise<boolean>;

  /**
   * Charge-time stock decrement contract. Returns the list of items that
   * crossed downward into the alert band (`newQuantity <= minQuantity`)
   * for the FIRST TIME within the current transaction. Items that were
   * already alerted, lots/expiration items, and items that did not cross
   * MUST NOT appear in the returned array.
   *
   * Spec coverage:
   *   - specs/sales/spec.md — "Stock Decrement Returns Threshold Crossings"
   *   - specs/stock-alerts/spec.md — "One-Shot Edge Trigger At Or Below Min Quantity"
   *
   * The implementation MUST:
   *   - Use a raw `UPDATE ... RETURNING` per item (Prisma Client cannot
   *     RETURNING from `updateMany`).
   *   - Carry explicit `"tenantId" = $N` predicates on every raw statement
   *     (raw SQL bypasses the tenant-id extension).
   *   - Apply the PRE gate (`pre > minQuantity && newQty <= minQuantity &&
   *     !useLotsAndExpirations`) BEFORE invoking the flip + outbox write.
   *   - For non-stock products (`useStock = false`), continue silently —
   *     do NOT throw, do NOT add to the returned array.
   *   - Throw `STOCK_INSUFFICIENT_AT_CONFIRM` ONLY when stock is genuinely
   *     insufficient (no row matched the guarded UPDATE).
   */
  decrementStockForCharge(
    adjustments: Array<{
      productId: string;
      variantId?: string | null;
      quantity: number;
    }>,
  ): Promise<
    import('../../stock-alerts/domain/stock-crossing').StockCrossing[]
  >;

  incrementStockForRestock(
    adjustments: Array<{
      productId: string;
      variantId?: string | null;
      quantity: number;
    }>,
  ): Promise<void>;

  /**
   * Edit-path re-arm contract. After a direct product/variant edit
   * (`update` / `updateVariant`) raises the resulting `quantity` strictly
   * above `minQuantity`, this method flips the `StockAlertState.alerted`
   * flag back to `false` for the right key:
   *   - simple product (no `variantId`): key = `'__PRODUCT__'`
   *   - variant (`variantId` provided): key = `variantId`
   *
   * The implementation MUST:
   *   - Assert the ambient-tx guard (mirror of `incrementStockForRestock`).
   *     Calling this outside `tenantPrisma.runInTransaction(...)` throws —
   *     partial commits would block the next alert forever.
   *   - Re-read the CURRENT persisted `quantity`/`minQuantity` inside the
   *     SAME transaction (read-your-own-writes under READ COMMITTED) so
   *     the decision is on the RESULTING pair, not on the inbound DTO.
   *   - Apply the STRICT `>` gate; equality does NOT rearm.
   *   - Skip silently when the row does not exist or `useStock = false`
   *     (product path) / parent `useStock = false` (variant path — the
   *     variant SELECT MUST JOIN `products` to gate on the parent's flag
   *     because `Variant` has no `useStock` column).
   *   - NEVER call `seedAndFlip`. Edits MUST NOT seed a `StockAlertState`
   *     row.
   *
   * Spec coverage: `specs/stock-alerts/spec.md` — "Edit raises simple",
   * "Edit raises variant", "Edit lowers minQuantity only", "Edit leaves
   * stock == min → NO rearm (STRICT `>`)", "No pre-existing alert-state
   * row → harmless no-op", "Ambient-tx guard throws outside
   * runInTransaction; service wraps it", "useStock = false → no alert
   * logic runs, no error".
   */
  rearmAlertAfterEdit(item: {
    productId: string;
    variantId?: string | null;
  }): Promise<void>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');
