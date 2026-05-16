import { PrismaSaleCommentRepository } from './prisma-sale-comment.repository';

function makeMockPrisma() {
  return {
    saleComment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  } as const;
}

describe('PrismaSaleCommentRepository', () => {
  it('uses tenant-scoped reads and sorts active comments asc', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as any;
    const repo = new PrismaSaleCommentRepository(tenantPrisma);

    client.saleComment.findMany.mockResolvedValue([]);
    await repo.findActiveBySale('sale-1');

    expect(tenantPrisma.getClient).toHaveBeenCalled();
    expect(client.saleComment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { saleId: 'sale-1', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });
});
