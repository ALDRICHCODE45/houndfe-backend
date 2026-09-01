export interface TenantCatalogPriceListBindingProps {
  id: string;
  tenantId: string;
  globalPriceListId: string;
  isCatalogDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  globalPriceList: { id: string; name: string };
}

export class TenantCatalogPriceListBinding {
  readonly id: string;
  readonly tenantId: string;
  readonly globalPriceListId: string;
  readonly isCatalogDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly globalPriceList: { id: string; name: string };

  private constructor(p: TenantCatalogPriceListBindingProps) {
    Object.assign(this, p);
  }
  static fromPersistence(p: TenantCatalogPriceListBindingProps) {
    return new TenantCatalogPriceListBinding({
      ...p,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    });
  }
}
