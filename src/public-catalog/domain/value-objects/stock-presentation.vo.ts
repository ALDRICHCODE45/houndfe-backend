import type { CatalogStockPresentationValue } from '../../../catalog-settings/domain/tenant-catalog-settings.aggregate';

export interface StockPresentationSource {
  onlineStockPresentation: CatalogStockPresentationValue | null;
  onlineStockPresentationCustomQty: number | null;
}

export interface StockPresentationDefaults {
  catalogStockPresentationDefault: CatalogStockPresentationValue | null;
  catalogStockPresentationDefaultCustomQty: number | null;
}

export interface EffectiveStockPresentationConfig {
  mode: CatalogStockPresentationValue;
  customQuantity: number | null;
}

export function resolveProductStockPresentation(
  product: StockPresentationSource,
  tenant: StockPresentationDefaults,
): EffectiveStockPresentationConfig {
  return {
    mode:
      product.onlineStockPresentation ??
      tenant.catalogStockPresentationDefault ??
      'SYSTEM_STATUS',
    customQuantity:
      product.onlineStockPresentationCustomQty ??
      tenant.catalogStockPresentationDefaultCustomQty,
  };
}

export function resolveVariantStockPresentation(
  variant: StockPresentationSource,
  productConfig: EffectiveStockPresentationConfig,
): EffectiveStockPresentationConfig {
  return {
    mode: variant.onlineStockPresentation ?? productConfig.mode,
    customQuantity:
      variant.onlineStockPresentation == null
        ? productConfig.customQuantity
        : variant.onlineStockPresentationCustomQty,
  };
}
