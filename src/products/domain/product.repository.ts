/**
 * PORT: IProductRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for persistence.
 * Lives in domain, implemented in infrastructure.
 */
import { Product } from './product.entity';

export type { ProductServiceDetail } from './product.entity';

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
   * Edit-path re-arm contract. After a direct product/variant edit
   * (`update` / `updateVariant`) raises the resulting `quantity` strictly
   * above `minQuantity`, this method flips the `StockAlertState.alerted`
   * flag back to `false` for the right key:
   *   - simple product (no `variantId`): key = `'__PRODUCT__'`
   *   - variant (`variantId` provided): key = `variantId`
   *
   * The implementation MUST:
   *   - Assert the ambient-tx guard (`rearmAlertAfterEdit` must run inside the edit transaction).
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
