/**
 * PORT: IPromotionUsageRepository — ambient-transaction-only capacity ledger.
 *
 * The caller must already be inside `TenantPrismaService.runInTransaction`;
 * the ledger insert, the guarded counter increment, and every earlier claim
 * commit or roll back with the sale confirmation.
 */

/** One promotion's benefited-unit demand within a single sale. */
export interface PromotionCapacityClaim {
  promotionId: string;
  units: number;
}

export interface IPromotionUsageRepository {
  /** Atomically claim `claims` units for `saleId` in the ambient transaction. */
  claimForSale(saleId: string, claims: PromotionCapacityClaim[]): Promise<void>;
}

export const PROMOTION_USAGE_REPOSITORY = Symbol('PROMOTION_USAGE_REPOSITORY');
