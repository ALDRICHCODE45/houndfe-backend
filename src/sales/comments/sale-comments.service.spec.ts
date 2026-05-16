import { SaleCommentsService } from './sale-comments.service';
import { SaleComment } from './domain/sale-comment.entity';
import {
  CommentAuthorForbiddenError,
  SaleCommentNotFoundError,
} from './domain/sale-comment.errors';

function makeRepo() {
  return {
    findById: jest.fn(),
    findActiveBySale: jest.fn(),
    save: jest.fn(),
    softDelete: jest.fn(),
  };
}

describe('SaleCommentsService', () => {
  it('creates comment when sale exists', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue({ id: 'sale-1' }) },
      }),
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);

    repo.save.mockImplementation(async (comment: SaleComment) => comment);

    const result = await service.create('sale-1', 'author-1', {
      body: 'hello',
    });

    expect(result.saleId).toBe('sale-1');
    expect(repo.save).toHaveBeenCalled();
  });

  it('updates comment when author matches', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue({ id: 'sale-1' }) },
      }),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);

    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'hello',
    });

    repo.findById.mockResolvedValue(comment);
    repo.save.mockImplementation(async (entity: SaleComment) => entity);

    const result = await service.update('sale-1', comment.id, 'author-1', {
      body: 'updated',
    });

    expect(result.body).toBe('updated');
  });

  it('throws 403 error when non-author updates', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue({ id: 'sale-1' }) },
      }),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'hello',
    });

    repo.findById.mockResolvedValue(comment);

    await expect(
      service.update('sale-1', comment.id, 'other-author', { body: 'updated' }),
    ).rejects.toBeInstanceOf(CommentAuthorForbiddenError);
  });

  it('soft-deletes comment when author matches', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue({ id: 'sale-1' }) },
      }),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'hello',
    });
    repo.findById.mockResolvedValue(comment);

    await service.softDelete('sale-1', comment.id, 'author-1');
    expect(repo.save).toHaveBeenCalled();
  });

  it('throws not found when comment is missing', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue({ id: 'sale-1' }) },
      }),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);
    repo.findById.mockResolvedValue(null);

    await expect(
      service.update('sale-1', 'comment-404', 'author-1', { body: 'updated' }),
    ).rejects.toBeInstanceOf(SaleCommentNotFoundError);
  });

  it('throws 403 when non-author deletes', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue({ id: 'sale-1' }) },
      }),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);
    const comment = SaleComment.create({
      saleId: 'sale-1',
      tenantId: 'tenant-1',
      authorUserId: 'author-1',
      body: 'hello',
    });
    repo.findById.mockResolvedValue(comment);

    await expect(
      service.softDelete('sale-1', comment.id, 'other-author'),
    ).rejects.toBeInstanceOf(CommentAuthorForbiddenError);
  });

  it('throws sale not found when creating comment for missing sale', async () => {
    const repo = makeRepo();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        sale: { findUnique: jest.fn().mockResolvedValue(null) },
      }),
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
    } as any;
    const service = new SaleCommentsService(repo as any, tenantPrisma);

    await expect(
      service.create('sale-404', 'author-1', { body: 'hello' }),
    ).rejects.toThrow('SALE_NOT_FOUND');
  });
});
