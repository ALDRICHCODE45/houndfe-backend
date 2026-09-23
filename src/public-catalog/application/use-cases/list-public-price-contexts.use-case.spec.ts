import { ListPublicPriceContextsUseCase } from './list-public-price-contexts.use-case';
import type { IPublicCatalogRepository } from '../ports/public-catalog.repository';

describe('ListPublicPriceContextsUseCase', () => {
  const tenant = { id: 'tenant-1', slug: 'centro', name: 'Centro' };

  it('delegates only the guarded tenant ID to the tenant-bound repository', async () => {
    const listTenantPublicPriceContexts = jest
      .fn()
      .mockResolvedValue([
        { priceListId: 'list-1', name: 'General', isCatalogDefault: true },
      ]);
    const useCase = new ListPublicPriceContextsUseCase({
      listTenantPublicPriceContexts,
    } as unknown as IPublicCatalogRepository);

    await expect(useCase.execute(tenant)).resolves.toEqual([
      { priceListId: 'list-1', name: 'General', isCatalogDefault: true },
    ]);
    expect(listTenantPublicPriceContexts).toHaveBeenCalledTimes(1);
    expect(listTenantPublicPriceContexts).toHaveBeenCalledWith(tenant.id);
  });
});
