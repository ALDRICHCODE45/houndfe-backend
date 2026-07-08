/**
 * DOMAIN — Stock crossing & low-stock event payload types.
 *
 * Pure data shapes shared by the stock-alerts adapter, the products
 * repository's `decrementStockForCharge`, and the sales orchestrator.
 *
 * Spec coverage:
 *   - specs/stock-alerts/spec.md   → "One-Shot Edge Trigger At Or Below Min Quantity"
 *   - specs/sales/spec.md          → "Stock Decrement Returns Threshold Crossings"
 *                                    + "Sales Orchestrator Dispatches Low-Stock Alerts
 *                                      Only After Commit"
 *
 * `StockCrossing` is the return shape from `decrementStockForCharge`
 * (formerly `Promise<void>`). One entry per item that crossed downward
 * into the alert band (`newQuantity <= minQuantity`) for the first time
 * within the current transaction.
 */
export type StockCrossing = {
  productId: string;
  variantId: string | null;
  newQuantity: number;
  minQuantity: number;
};

/**
 * Enriched payload written to the outbox IN THE SAME TRANSACTION as the
 * decrement + flip. Carries everything the downstream Inngest function
 * needs so no second read is required at send time (design.md §Durable
 * dispatch flow, finding #10). `alertEpoch` is the integer counter the
 * idempotency key is derived from (`${tenantId}:${productId}:${variantKey}:${alertEpoch}`).
 *
 * `variantKey` is the sentinel-stored column on `StockAlertState`
 * (`variantId ?? '__PRODUCT__'`) so uniqueness works against Postgres'
 * NULL-distinct semantics.
 */
export type LowStockEventPayload = {
  tenantId: string;
  productId: string;
  variantId: string | null;
  variantKey: string;
  alertEpoch: number;
  newQuantity: number;
  minQuantity: number;
  productName: string;
  variantDescription: string | null;
  sku: string | null;
  category: string | null;
  deepLink: string;
  occurredAt: string;
};