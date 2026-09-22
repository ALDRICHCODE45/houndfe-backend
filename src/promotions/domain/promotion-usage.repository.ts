/**
 * PORT: IPromotionUsageRepository — ambient-transaction-only capacity ledger.
 *
 * The caller must already be inside `TenantPrismaService.runInTransaction`;
 * the ledger insert, the guarded counter increment, the restore stamp, the
 * guarded counter decrement, and every earlier claim commit or roll back
 * together with the sale state change.
 */

/** One promotion's benefited-unit demand within a single sale. */
export interface PromotionCapacityClaim {
  promotionId: string;
  units: number;
}

export interface IPromotionUsageRepository {
  /** Atomically claim `claims` units for `saleId` in the ambient transaction. */
  claimForSale(saleId: string, claims: PromotionCapacityClaim[]): Promise<void>;

  /**
   * Atomically return every active ledger row of `saleId` to its promotion
   * in the ambient transaction. The persisted ledger supplies the units; the
   * caller never passes quantities. Empty ledgers and rows already stamped
   * by a concurrent retry are idempotent no-ops.
   */
  restoreForSale(saleId: string): Promise<void>;
}

export const PROMOTION_USAGE_REPOSITORY = Symbol('PROMOTION_USAGE_REPOSITORY');
