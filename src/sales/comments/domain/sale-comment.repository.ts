import { SaleComment } from './sale-comment.entity';

export interface ISaleCommentRepository {
  findById(id: string): Promise<SaleComment | null>;
  findActiveBySale(saleId: string): Promise<SaleComment[]>;
  save(comment: SaleComment): Promise<SaleComment>;
  softDelete(id: string, deletedAt: Date): Promise<void>;
}

export const SALE_COMMENT_REPOSITORY = Symbol('ISaleCommentRepository');
