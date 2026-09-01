import { TenantCatalogPriceListBinding } from './tenant-catalog-price-list.entity';
import {
  CatalogSettingsInvariantError,
  TenantCatalogSettings,
  TenantBaseProps,
} from './tenant-catalog-settings.aggregate';

const binding = (p: Partial<TenantCatalogPriceListBinding> = {}) =>
  TenantCatalogPriceListBinding.fromPersistence({
    id: 'b1',
    tenantId: 't1',
    globalPriceListId: 'p1',
    isCatalogDefault: true,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    globalPriceList: { id: 'p1', name: 'Prices' },
    ...p,
  });
const tenant = (p: Partial<TenantBaseProps> = {}): TenantBaseProps => ({
  tenantId: 't1',
  isActive: true,
  catalogPublished: false,
  catalogStockPresentationDefault: 'SYSTEM_STATUS',
  catalogStockPresentationDefaultCustomQty: null,
  updatedAt: new Date('2024-01-01'),
  ...p,
});
const make = (t = tenant(), bs: TenantCatalogPriceListBinding[] = []) =>
  TenantCatalogSettings.fromPersistence({ tenant: t, bindings: bs });
const rejects = (
  code: string,
  t?: Partial<TenantBaseProps>,
  bs?: readonly TenantCatalogPriceListBinding[],
) =>
  expect(() => make(tenant(t), bs ? [...bs] : undefined)).toThrow(
    expect.objectContaining({ code }),
  );

describe('TenantCatalogSettings', () => {
  it.each([
    [
      'duplicate binding ids',
      'DUPLICATE_BINDING_ID',
      {},
      [
        binding(),
        binding({ globalPriceListId: 'p2', isCatalogDefault: false }),
      ],
    ],
    [
      'duplicate price lists',
      'DUPLICATE_PRICE_LIST',
      {},
      [binding(), binding({ id: 'b2', isCatalogDefault: false })],
    ],
    [
      'tenant mismatch',
      'TENANT_MISMATCH',
      {},
      [binding({ tenantId: 'other' })],
    ],
    [
      'non-empty without default',
      'DEFAULT_CARDINALITY',
      {},
      [binding({ isCatalogDefault: false })],
    ],
    [
      'multiple defaults',
      'DEFAULT_CARDINALITY',
      {},
      [binding(), binding({ id: 'b2', globalPriceListId: 'p2' })],
    ],
    [
      'published empty',
      'PUBLISH_REQUIRES_DEFAULT',
      { catalogPublished: true },
      [],
    ],
    [
      'custom quantity missing',
      'INVALID_CUSTOM_QUANTITY',
      { catalogStockPresentationDefault: 'CUSTOM_QUANTITY' },
      [],
    ],
    [
      'custom quantity fractional',
      'INVALID_CUSTOM_QUANTITY',
      {
        catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
        catalogStockPresentationDefaultCustomQty: 1.5,
      },
      [],
    ],
    [
      'custom quantity negative',
      'INVALID_CUSTOM_QUANTITY',
      {
        catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
        catalogStockPresentationDefaultCustomQty: -1,
      },
      [],
    ],
    [
      'non-custom quantity',
      'INVALID_CUSTOM_QUANTITY',
      { catalogStockPresentationDefaultCustomQty: 1 },
      [],
    ],
  ] as const)('%s', (_name, code, t, bs) => rejects(code, t, bs));

  it('accepts empty bindings and zero custom quantity', () => {
    expect(
      make(
        tenant({
          catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
          catalogStockPresentationDefaultCustomQty: 0,
        }),
      ).defaultBinding,
    ).toBeNull();
  });
  it('requires and exposes one default when published', () => {
    const a = make(tenant({ catalogPublished: true }), [binding()]);
    expect(a.defaultBinding?.globalPriceListId).toBe('p1');
    expect(a.effectivePublication).toBe(true);
  });
  it('effective publication also requires active tenant', () => {
    expect(
      make(tenant({ isActive: false, catalogPublished: true }), [binding()])
        .effectivePublication,
    ).toBe(false);
  });
  it('projects internal application data', () => {
    expect(make(tenant(), [binding()]).toInternalResult()).toMatchObject({
      tenantId: 't1',
      priceContexts: [
        { priceListId: 'p1', name: 'Prices', isCatalogDefault: true },
      ],
      effectivePublication: false,
    });
  });
  it('uses one compact domain error', () =>
    expect(() => make(tenant({ catalogPublished: true }))).toThrow(
      CatalogSettingsInvariantError,
    ));
});
