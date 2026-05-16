import { SaleComment } from './sale-comment.entity';

export type ActiveSaleCommentWithAuthor = {
  id: string;
  saleId: string;
  tenantId: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  author: { id: string; name: string } | null;
};

export interface ISaleCommentRepository {
  findById(id: string): Promise<SaleComment | null>;
  findActiveBySale(saleId: string): Promise<ActiveSaleCommentWithAuthor[]>;
  save(comment: SaleComment): Promise<SaleComment>;
  softDelete(id: string, deletedAt: Date): Promise<void>;
}

export const SALE_COMMENT_REPOSITORY = Symbol('ISaleCommentRepository');
