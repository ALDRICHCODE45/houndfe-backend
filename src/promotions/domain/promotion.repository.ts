import { Promotion } from './promotion.entity';

export interface PromotionFindAllQuery {
  page: number;
  limit: number;
  type?: string;
  status?: string;
  method?: string;
  customerScope?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PromotionFindAllResult {
  data: Promotion[];
  total: number;
}

/**
 * Result of one bounded read of the whole ACTIVE AUTOMATIC promotion set.
 *
 * `complete` is `false` when the tenant holds more rows than the adapter's
 * hard cap: `promotions` is then a strict prefix of the set and the caller
 * CANNOT prove it saw every row (an unseen row may carry a restrictive
 * eligibility axis). Callers must fail closed rather than quote a discount
 * built on a partial view.
 */
export interface ActiveAutomaticPromotionSnapshot {
  promotions: Promotion[];
  complete: boolean;
}

export interface IPromotionRepository {
  save(promotion: Promotion): Promise<Promotion>;
  findById(id: string): Promise<Promotion | null>;
  findAll(query: PromotionFindAllQuery): Promise<PromotionFindAllResult>;
  /**
   * Reads the whole ACTIVE AUTOMATIC promotion set — parent row plus the
   * target/customer/price-list/weekday relations — as ONE bounded,
   * tenant-scoped snapshot.
   *
   * Implementations MUST NOT paginate: `skip`/`take` plus a separate count
   * can miss a row when a concurrent delete+insert keeps the total unchanged
   * (a later offset then shifts over an unread row). A single `id`-ordered
   * capped read (`cap + 1` sentinel rows) inside a RepeatableRead transaction
   * yields a stable set, and `complete` reports whether the cap hid a row.
   */
  findActiveAutomaticSnapshot(): Promise<ActiveAutomaticPromotionSnapshot>;
  delete(id: string): Promise<void>;
  /**
   * Hard-deletes every promotion whose id is in `ids` and returns
   * the number of rows removed. Caller is responsible for any
   * pre-flight validation (FK guards, tenant ownership) — this
   * method does no validation and assumes the caller already ran
   * `BatchDeletableService.validateForBatchDeletion`.
   *
   * Implementation MUST use `tenantPrisma.getClient()` so the
   * batch-delete orchestrator's ambient CLS tx wraps the delete.
   */
  deleteMany(ids: string[]): Promise<number>;
  updateStatus(
    id: string,
    status: 'ENDED' | 'ACTIVE' | 'SCHEDULED',
    endDate?: Date | null,
    manuallyEnded?: boolean,
  ): Promise<void>;
}

export const PROMOTION_REPOSITORY = Symbol('PROMOTION_REPOSITORY');
