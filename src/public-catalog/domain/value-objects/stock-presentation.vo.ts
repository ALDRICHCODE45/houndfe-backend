import type { CatalogStockPresentationValue } from '../../../catalog-settings/domain/tenant-catalog-settings.aggregate';
import { mapStockStatus, type PublicStockStatus } from './stock-status.vo';

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

export interface StockPresentationOperationalInput {
  useStock: boolean;
  quantity: number;
  minQuantity: number;
}

export interface RenderedStockPresentation {
  mode: CatalogStockPresentationValue;
  status: PublicStockStatus | null;
  customQuantity: number | null;
}

export function renderStockPresentation(
  config: EffectiveStockPresentationConfig,
  operational: StockPresentationOperationalInput,
): RenderedStockPresentation {
  switch (config.mode) {
    case 'HIDDEN':
      return { mode: config.mode, status: null, customQuantity: null };
    case 'CUSTOM_QUANTITY':
      return {
        mode: config.mode,
        status:
          operational.useStock && operational.quantity <= 0
            ? 'out_of_stock'
            : null,
        customQuantity: config.customQuantity,
      };
    case 'ABSTRACT_STATUS':
      return {
        mode: config.mode,
        status: !operational.useStock
          ? 'available'
          : operational.quantity <= 0
            ? 'out_of_stock'
            : 'available',
        customQuantity: null,
      };
    case 'SYSTEM_STATUS':
      return {
        mode: config.mode,
        status: operational.useStock
          ? mapStockStatus(operational.quantity, operational.minQuantity)
          : 'available',
        customQuantity: null,
      };
  }
}
