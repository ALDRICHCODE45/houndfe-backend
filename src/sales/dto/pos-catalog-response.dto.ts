/**
 * Response contract types for POS catalog endpoint.
 * These are type-only exports (no class-validator needed for response shapes).
 */

export interface PosCatalogPrice {
  priceCents: number;
  priceDecimal: number;
  priceListName: string;
}

export interface PosCatalogStock {
  quantity: number;
  minQuantity: number;
  location: string | null;
}

export interface PosCatalogVariant {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  mainImage: string | null;
  price: PosCatalogPrice | null;
  stock: PosCatalogStock | null;
}

export interface PosCatalogCategory {
  id: string;
  name: string;
}

export interface PosCatalogBrand {
  id: string;
  name: string;
}

export interface PosCatalogItem {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  hasVariants: boolean;
  useStock: boolean;
  enabledForPos: boolean;
  category: PosCatalogCategory | null;
  brand: PosCatalogBrand | null;
  mainImage: string | null;
  images: string[];
  price: PosCatalogPrice | null;
  stock: PosCatalogStock | null;
  variants: PosCatalogVariant[];
}

export interface PosCatalogResponse {
  items: PosCatalogItem[];
  total: number;
  limit: number;
  offset: number;
}
