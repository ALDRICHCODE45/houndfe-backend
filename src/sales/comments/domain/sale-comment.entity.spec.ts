import {
  CommentAuthorForbiddenError,
} from './sale-comment.errors';
import { SaleComment } from './sale-comment.entity';
import { BusinessRuleViolationError } from '../../../shared/domain/domain-error';

describe('SaleComment', () => {
  it('creates a comment with trimmed body', () => {
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: '  hello world  ',
    });

    expect(comment.saleId).toBe('sale-1');
    expect(comment.tenantId).toBe('tenant-1');
    expect(comment.authorUserId).toBe('author-1');
    expect(comment.body).toBe('hello world');
    expect(comment.deletedAt).toBeNull();
  });

  it('updates body when author matches', () => {
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'initial',
    });

    const previousUpdatedAt = comment.updatedAt;
    comment.updateBody('author-1', '  updated text  ');

    expect(comment.body).toBe('updated text');
    expect(comment.updatedAt.getTime()).toBeGreaterThanOrEqual(
      previousUpdatedAt.getTime(),
    );
  });

  it('throws when non-author updates body', () => {
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'initial',
    });

    expect(() => comment.updateBody('other-user', 'updated')).toThrow(
      CommentAuthorForbiddenError,
    );
  });

  it('soft-deletes by setting deletedAt', () => {
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'initial',
    });

    comment.softDelete();

    expect(comment.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects empty or oversized body', () => {
    expect(() =>
      SaleComment.create({
        saleId: 'sale-1',
        tenantId: 'tenant-1',
        authorUserId: 'author-1',
        body: '   ',
      }),
    ).toThrow(BusinessRuleViolationError);

    expect(() =>
      SaleComment.create({
        saleId: 'sale-1',
        tenantId: 'tenant-1',
        authorUserId: 'author-1',
        body: 'a'.repeat(2001),
      }),
    ).toThrow(BusinessRuleViolationError);
  });
});
