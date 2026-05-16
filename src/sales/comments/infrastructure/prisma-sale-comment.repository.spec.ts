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
        include: {
          author: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
    );
  });

  it('returns active comments with author join payload for timeline merge', async () => {
    const client = makeMockPrisma();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(client),
    } as any;
    const repo = new PrismaSaleCommentRepository(tenantPrisma);

    client.saleComment.findMany.mockResolvedValue([
      {
        id: 'comment-1',
        saleId: 'sale-1',
        tenantId: 'tenant-1',
        authorUserId: 'user-1',
        body: 'Comentario',
        createdAt: new Date('2026-05-08T10:02:00.000Z'),
        updatedAt: new Date('2026-05-08T10:02:00.000Z'),
        deletedAt: null,
        author: { id: 'user-1', name: 'Lucía' },
      },
    ]);

    const result = await repo.findActiveBySale('sale-1');

    expect(result[0]).toEqual(
      expect.objectContaining({
        authorUserId: 'user-1',
        body: 'Comentario',
      }),
    );
  });
});
