import { PublicPriceContextResolver } from './public-price-context-resolver';
import type {
  IPublicCatalogRepository,
  ResolvedPublicCatalogContext,
} from '../ports/public-catalog.repository';

const CONTEXT: ResolvedPublicCatalogContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'tenant-a',
  globalPriceListId: 'gpl-1',
  name: 'Lista Publico',
  isCatalogDefault: true,
  stockPresentationDefaults: {
    catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
    catalogStockPresentationDefaultCustomQty: 25,
  },
};

describe('PublicPriceContextResolver (F2.WU6)', () => {
  const setup = () => {
    const resolveTenantCatalogContext = jest.fn();
    const resolver = new PublicPriceContextResolver({
      resolveTenantCatalogContext,
    } as unknown as IPublicCatalogRepository);
    return { resolveTenantCatalogContext, resolver };
  };

  it('resolves through the port, threading omitted and supplied IDs', async () => {
    const { resolveTenantCatalogContext, resolver } = setup();
    resolveTenantCatalogContext
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce(CONTEXT);

    await expect(resolver.resolve('tenant-a')).resolves.toEqual(CONTEXT);
    await expect(resolver.resolve('tenant-a', 'gpl-9')).resolves.toEqual(
      CONTEXT,
    );
    expect(resolveTenantCatalogContext).toHaveBeenNthCalledWith(
      1,
      'tenant-a',
      undefined,
    );
    expect(resolveTenantCatalogContext).toHaveBeenNthCalledWith(
      2,
      'tenant-a',
      'gpl-9',
    );
  });

  it('threads tenant stock-presentation defaults unchanged (F3.WU9 slice 5)', async () => {
    const { resolveTenantCatalogContext, resolver } = setup();
    resolveTenantCatalogContext.mockResolvedValue(CONTEXT);

    const expected = {
      stockPresentationDefaults: {
        catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
        catalogStockPresentationDefaultCustomQty: 25,
      },
    };
    await expect(resolver.resolve('tenant-a')).resolves.toMatchObject(
      expected,
    );
    await expect(
      resolver.resolve('tenant-a', 'gpl-9'),
    ).resolves.toMatchObject(expected);
    expect(resolveTenantCatalogContext).toHaveBeenCalledTimes(2);
  });

  it('throws the one generic miss error on null and never looks up twice', async () => {
    const { resolveTenantCatalogContext, resolver } = setup();
    resolveTenantCatalogContext.mockResolvedValue(null);

    await expect(resolver.resolve('tenant-a', 'gpl-404')).rejects.toMatchObject(
      {
        code: 'PRICE_CONTEXT_NOT_AVAILABLE',
        message: 'Price context is not available',
      },
    );
    expect(resolveTenantCatalogContext).toHaveBeenCalledTimes(1);
  });
});
