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

export interface IPromotionRepository {
  save(promotion: Promotion): Promise<Promotion>;
  findById(id: string): Promise<Promotion | null>;
  findAll(query: PromotionFindAllQuery): Promise<PromotionFindAllResult>;
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
