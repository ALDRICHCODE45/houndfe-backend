import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

describe('PrismaPublicCatalogRepository.listTenantPublicPriceContexts', () => {
  const tenantId = 'tenant-public';
  let findMany: jest.Mock;
  let repo: PrismaPublicCatalogRepository;

  beforeEach(() => {
    findMany = jest.fn();
    repo = new PrismaPublicCatalogRepository(
      {} as PrismaService,
      {
        getTenantId: () => tenantId,
        getClient: () => ({ tenantCatalogPriceList: { findMany } }),
      } as unknown as TenantPrismaService,
    );
  });

  it('queries only this tenant public bindings with default/name/id deterministic ordering', async () => {
    findMany.mockResolvedValue([]);

    await expect(repo.listTenantPublicPriceContexts(tenantId)).resolves.toEqual(
      [],
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId },
      select: {
        globalPriceListId: true,
        isCatalogDefault: true,
        globalPriceList: { select: { name: true } },
      },
      orderBy: [
        { isCatalogDefault: 'desc' },
        { globalPriceList: { name: 'asc' } },
        { globalPriceListId: 'asc' },
      ],
    });
  });

  it('fails closed before querying when guarded tenant ID differs from CLS', async () => {
    await expect(
      repo.listTenantPublicPriceContexts('other-tenant'),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('projects precisely three public fields, without tenant/private/product metadata', async () => {
    findMany.mockResolvedValue([
      {
        tenantId,
        globalPriceListId: 'default-id',
        isCatalogDefault: true,
        globalPriceList: { name: 'Principal', isDefault: false, cost: 42 },
      },
      {
        tenantId,
        globalPriceListId: 'other-id',
        isCatalogDefault: false,
        globalPriceList: { name: 'Mayorista' },
      },
    ]);

    const result = await repo.listTenantPublicPriceContexts(tenantId);
    expect(result).toEqual([
      { priceListId: 'default-id', name: 'Principal', isCatalogDefault: true },
      { priceListId: 'other-id', name: 'Mayorista', isCatalogDefault: false },
    ]);
    expect(Object.keys(result[0])).toEqual([
      'priceListId',
      'name',
      'isCatalogDefault',
    ]);
  });

  it('never invents a default when a published tenant has bindings without one', async () => {
    findMany.mockResolvedValue([
      {
        globalPriceListId: 'only-id',
        isCatalogDefault: false,
        globalPriceList: { name: 'Sólo selección explícita' },
      },
    ]);

    await expect(repo.listTenantPublicPriceContexts(tenantId)).resolves.toEqual(
      [
        {
          priceListId: 'only-id',
          name: 'Sólo selección explícita',
          isCatalogDefault: false,
        },
      ],
    );
  });
});
