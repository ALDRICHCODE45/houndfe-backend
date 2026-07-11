/**
 * PORT: IStockAlertStateRepository (Driven Port).
 *
 * Atomic one-shot machine for low-stock edge detection. The contract is
 * strictly two-phase:
 *
 *  1. `seedAndFlip(...)` — guarantees an armed `StockAlertState` row for
 *     `(tenantId, productId, variantKey)` AND attempts the conditional
 *     arm→alert flip in a single pair of raw statements. Returns the
 *     new `alertEpoch` ONLY when THIS transaction owns the flip
 *     (`UPDATE ... RETURNING` matched exactly one row). A `null` return
 *     means another transaction already flipped and committed — the
 *     caller MUST treat the crossing as not-new.
 *
 *  2. `rearm(...)` — strict `newQuantity > minQuantity` is enforced at
 *     the CALL SITE (the columns live on the product/variant, not on
 *     `stock_alert_states`). The repository issues an unguarded
 *     `UPDATE` setting `alerted = false`; if the precondition is not
 *     met at the caller, `rearm` is a no-op call.
 *
 * Both operations MUST be invoked with the transaction client that
 * performed the decrement (so the flip + outbox row are atomic with the
 * stock change). The repository accepts `Prisma.TransactionClient` (or
 * the tenant-scoped Prisma client — both expose `$queryRaw`).
 *
 * Spec coverage:
 *   - "First crossing fires one alert"
 *   - "Subsequent sale while low does NOT re-fire"
 *   - "Concurrent Crossings Collapse To One Alert" (E.4)
 *   - "Restock re-arms; later drop re-fires"   (Decision 6 — strict `>`)
 *   - "Lots/expiration products excluded"      (decision is at the
 *                                              decrement site; this port
 *                                              is only invoked when the
 *                                              PRE-gate passed)
 *
 * Isolation: READ COMMITTED. The design pins this explicitly (finding
 * #11) — REPEATABLE READ / SERIALIZABLE would surface a `P2034` instead
 * of a clean `count === 0` on the losing concurrent tx, changing the
 * contract.
 */
export interface IStockAlertStateRepository {
  /**
   * Seed an armed `StockAlertState` row (idempotent via
   * `INSERT ... ON CONFLICT DO NOTHING`) and run the guarded
   * `UPDATE ... RETURNING "alertEpoch"` to flip `alerted: false → true`
   * and increment the epoch counter. Returns the new epoch if the flip
   * won (`UPDATE` matched 1 row), otherwise `null`.
   *
   * Must be invoked with a transaction client that is also performing
   * the decrement + the outbox write — they are atomic together.
   */
  seedAndFlip(input: {
    tx: unknown;
    tenantId: string;
    productId: string;
    variantId: string | null;
  }): Promise<number | null>;

  /**
   * Re-arm: clear `alerted` back to `false` for the given item. Does NOT
   * touch `alertEpoch` (preserved for the next genuine crossing).
   *
   * Returns the number of rows matched. The caller decides whether to
   * invoke this at all (STRICT `newQuantity > minQuantity`).
   */
  rearm(input: {
    tx: unknown;
    tenantId: string;
    productId: string;
    variantId: string | null;
  }): Promise<number>;
}

/** NestJS injection token. `Symbol.for(...)` so dedupes across module instances. */
export const STOCK_ALERT_STATE_REPOSITORY = Symbol.for(
  'StockAlertStateRepository',
);
