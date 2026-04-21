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
  updateStatus(
    id: string,
    status: 'ENDED' | 'ACTIVE' | 'SCHEDULED',
    endDate?: Date | null,
  ): Promise<void>;
}

export const PROMOTION_REPOSITORY = Symbol('PROMOTION_REPOSITORY');
