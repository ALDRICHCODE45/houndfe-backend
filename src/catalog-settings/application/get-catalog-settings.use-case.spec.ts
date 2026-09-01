import {
  GetCatalogSettingsUseCase,
  CatalogSettingsNotFoundError,
} from './get-catalog-settings.use-case';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';

const repo = () => ({ findByTenantId: jest.fn() });
const settings = (tenantId = 't1') =>
  TenantCatalogSettings.fromPersistence({
    tenant: {
      tenantId,
      isActive: true,
      catalogPublished: false,
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
      updatedAt: new Date('2024-01-01'),
    },
    bindings: [],
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
    const error = await new GetCatalogSettingsUseCase(r)
      .execute({ tenantId: 'missing' })
      .catch((error) => error);
    expect(error).toBeInstanceOf(CatalogSettingsNotFoundError);
    expect(error.tenantId).toBe('missing');
    expect(r.findByTenantId).toHaveBeenCalledTimes(1);
  });
});
