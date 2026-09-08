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

export interface VariantOperationalStock {
  quantity: number;
  minQuantity: number;
}

export type NonEmptyVariantOperationalStocks = readonly [
  VariantOperationalStock,
  ...VariantOperationalStock[],
];

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

export function renderAggregateVariantStockPresentation(
  config: EffectiveStockPresentationConfig,
  productUseStock: boolean,
  variants: NonEmptyVariantOperationalStocks,
): RenderedStockPresentation {
  if (config.mode === 'HIDDEN') {
    return { mode: config.mode, status: null, customQuantity: null };
  }
  if (!productUseStock) {
    return { mode: config.mode, status: 'available', customQuantity: null };
  }
  let anyAvailable = false;
  let anyLow = false;
  for (const variant of variants) {
    const status = mapStockStatus(variant.quantity, variant.minQuantity);
    if (status === 'available') {
      anyAvailable = true;
    } else if (status === 'low_stock') {
      anyLow = true;
    }
  }
  const status: PublicStockStatus =
    config.mode === 'ABSTRACT_STATUS'
      ? anyAvailable || anyLow
        ? 'available'
        : 'out_of_stock'
      : anyAvailable
        ? 'available'
        : anyLow
          ? 'low_stock'
          : 'out_of_stock';
  return { mode: config.mode, status, customQuantity: null };
}
