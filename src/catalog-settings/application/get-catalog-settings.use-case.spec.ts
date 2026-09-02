import {
  GetCatalogSettingsUseCase,
  CatalogSettingsNotFoundError,
} from './get-catalog-settings.use-case';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';
import { TenantCatalogPriceListBinding } from '../domain/tenant-catalog-price-list.entity';
import { ICatalogSettingsRepository } from '../domain/catalog-settings.repository';

const repo = () =>
  ({
    findByTenantId: jest.fn(),
    replace: jest.fn(),
    findGlobalPriceListsByIds: jest.fn(),
    countDefaultContextCoverage: jest.fn(),
  }) satisfies ICatalogSettingsRepository;
const binding = (
  tenantId: string,
  globalPriceListId: string,
  isCatalogDefault: boolean,
) =>
  TenantCatalogPriceListBinding.fromPersistence({
    id: `b-${globalPriceListId}`,
    tenantId,
    globalPriceListId,
    isCatalogDefault,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    globalPriceList: { id: globalPriceListId, name: globalPriceListId },
  });
const settings = (
  tenantId = 't1',
  bindings: ReturnType<typeof binding>[] = [],
) =>
  TenantCatalogSettings.fromPersistence({
    tenant: {
      tenantId,
      isActive: true,
      catalogPublished: false,
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
      updatedAt: new Date('2024-01-01'),
    },
    bindings,
  });

describe('GetCatalogSettingsUseCase', () => {
  it('loads once by exact tenant and returns internal result', async () => {
    const r = repo();
    r.findByTenantId.mockResolvedValue(settings('t1'));
    const result = await new GetCatalogSettingsUseCase(r).execute({
      tenantId: 't1',
    });
    expect(r.findByTenantId).toHaveBeenCalledTimes(1);
    expect(r.findByTenantId).toHaveBeenCalledWith('t1');
    expect(result).toMatchObject({
      tenantId: 't1',
      priceContexts: [],
      effectivePublication: false,
    });
  });
  it('throws a clear not-found error', async () => {
    const r = repo();
    r.findByTenantId.mockResolvedValue(null);
    const execution = new GetCatalogSettingsUseCase(r).execute({
      tenantId: 'missing',
    });
    await expect(execution).rejects.toMatchObject({ tenantId: 'missing' });
    await expect(execution).rejects.toBeInstanceOf(
      CatalogSettingsNotFoundError,
    );
    expect(r.findByTenantId).toHaveBeenCalledTimes(1);
  });
  describe('executeWithCoverage (WU3A3)', () => {
    it('returns settings + 0 coverage when default context has no positive prices', async () => {
      const r = repo();
      r.findByTenantId.mockResolvedValue(
        settings('t1', [binding('t1', 'gpl-default', true)]),
      );
      r.countDefaultContextCoverage.mockResolvedValue(0);
      const result = await new GetCatalogSettingsUseCase(r).executeWithCoverage(
        {
          tenantId: 't1',
        },
      );
      expect(r.countDefaultContextCoverage).toHaveBeenCalledTimes(1);
      expect(r.countDefaultContextCoverage).toHaveBeenCalledWith(
        't1',
        'gpl-default',
      );
      expect(result.defaultContextProductCount).toBe(0);
      expect(result.settings.priceContexts[0].isCatalogDefault).toBe(true);
    });
    it('returns null coverage when there is no default binding (empty bindings)', async () => {
      const r = repo();
      r.findByTenantId.mockResolvedValue(settings('t1', []));
      const result = await new GetCatalogSettingsUseCase(r).executeWithCoverage(
        {
          tenantId: 't1',
        },
      );
      expect(r.countDefaultContextCoverage).not.toHaveBeenCalled();
      expect(result.defaultContextProductCount).toBeNull();
    });
    it('propagates CatalogSettingsNotFoundError without calling coverage', async () => {
      const r = repo();
      r.findByTenantId.mockResolvedValue(null);
      await expect(
        new GetCatalogSettingsUseCase(r).executeWithCoverage({
          tenantId: 'missing',
        }),
      ).rejects.toBeInstanceOf(CatalogSettingsNotFoundError);
      expect(r.countDefaultContextCoverage).not.toHaveBeenCalled();
    });
  });
});
