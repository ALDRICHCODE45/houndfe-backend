import { TenantCatalogPriceListBinding } from './tenant-catalog-price-list.entity';

export type CatalogStockPresentationValue =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';
export interface TenantBaseProps {
  tenantId: string;
  isActive: boolean;
  catalogPublished: boolean;
  catalogStockPresentationDefault: CatalogStockPresentationValue;
  catalogStockPresentationDefaultCustomQty: number | null;
  updatedAt: Date;
}
export interface FromPersistenceInput {
  tenant: TenantBaseProps;
  bindings: TenantCatalogPriceListBinding[];
}
export interface CatalogSettingsInternalResult {
  tenantId: string;
  catalogPublished: boolean;
  effectivePublication: boolean;
  priceContexts: {
    priceListId: string;
    name: string;
    isCatalogDefault: boolean;
  }[];
  stockPresentationDefault: {
    mode: CatalogStockPresentationValue;
    customQuantity: number | null;
  };
  updatedAt: string;
}
export class CatalogSettingsInvariantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class TenantCatalogSettings {
  private constructor(
    private readonly tenant: TenantBaseProps,
    readonly bindings: TenantCatalogPriceListBinding[],
  ) {}

  static fromPersistence(input: FromPersistenceInput) {
    const result = new TenantCatalogSettings(input.tenant, input.bindings);
    result.validateInvariants();
    return result;
  }
  private validateInvariants() {
    const { tenant, bindings } = this;
    const ids = bindings.map((b) => b.id),
      lists = bindings.map((b) => b.globalPriceListId);
    if (new Set(ids).size !== ids.length)
      throw new CatalogSettingsInvariantError(
        'DUPLICATE_BINDING_ID',
        'Binding ids must be unique',
      );
    if (new Set(lists).size !== lists.length)
      throw new CatalogSettingsInvariantError(
        'DUPLICATE_PRICE_LIST',
        'Global price-list ids must be unique',
      );
    if (bindings.some((b) => b.tenantId !== tenant.tenantId))
      throw new CatalogSettingsInvariantError(
        'TENANT_MISMATCH',
        'Binding tenantId must match tenantId',
      );
    const defaults = bindings.filter((b) => b.isCatalogDefault);
    if (bindings.length === 0 ? defaults.length !== 0 : defaults.length !== 1)
      throw new CatalogSettingsInvariantError(
        'DEFAULT_CARDINALITY',
        'Bindings must have exactly one default when non-empty',
      );
    if (
      tenant.catalogPublished &&
      (bindings.length === 0 || defaults.length !== 1)
    )
      throw new CatalogSettingsInvariantError(
        'PUBLISH_REQUIRES_DEFAULT',
        'Published catalogs require a default binding',
      );
    const q = tenant.catalogStockPresentationDefaultCustomQty;
    if (tenant.catalogStockPresentationDefault === 'CUSTOM_QUANTITY') {
      if (q === null || !Number.isInteger(q) || q < 0)
        throw new CatalogSettingsInvariantError(
          'INVALID_CUSTOM_QUANTITY',
          'CUSTOM_QUANTITY requires an integer quantity >= 0',
        );
    } else if (q !== null)
      throw new CatalogSettingsInvariantError(
        'INVALID_CUSTOM_QUANTITY',
        'Non-CUSTOM modes require null custom quantity',
      );
  }
  get tenantId() {
    return this.tenant.tenantId;
  }
  get isActive() {
    return this.tenant.isActive;
  }
  get catalogPublished() {
    return this.tenant.catalogPublished;
  }
  get effectivePublication() {
    return this.tenant.isActive && this.tenant.catalogPublished;
  }
  get defaultBinding() {
    return this.bindings.find((b) => b.isCatalogDefault) ?? null;
  }
  get stockPresentationDefault() {
    return {
      mode: this.tenant.catalogStockPresentationDefault,
      customQuantity: this.tenant.catalogStockPresentationDefaultCustomQty,
    };
  }
  get updatedAt() {
    return this.tenant.updatedAt;
  }
  toInternalResult(): CatalogSettingsInternalResult {
    return {
      tenantId: this.tenantId,
      catalogPublished: this.catalogPublished,
      effectivePublication: this.effectivePublication,
      priceContexts: this.bindings.map((b) => ({
        priceListId: b.globalPriceListId,
        name: b.globalPriceList.name,
        isCatalogDefault: b.isCatalogDefault,
      })),
      stockPresentationDefault: this.stockPresentationDefault,
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
