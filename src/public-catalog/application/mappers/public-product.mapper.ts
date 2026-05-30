import type { PublicCatalogProductCard } from '../dto/public-product-card.dto';
import type {
  PublicCatalogProductDetail,
  PublicVariantDto,
} from '../dto/public-product-detail.dto';
import {
  mapStockStatus,
  type PublicStockStatus,
} from '../../domain/value-objects/stock-status.vo';
import { isEffectivelyPriceHidden } from '../../domain/value-objects/effective-price-hidden.vo';

// Input types — what we expect from Prisma includes
export interface ProductWithIncludes {
  id: string;
  name: string;
  description: string | null;
  hasVariants: boolean;
  useStock: boolean;
  quantity: number;
  minQuantity: number;
  hidePriceInOnlineCatalog: boolean;
  requiresPrescription: boolean;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  images: Array<{ url: string }>;
  priceLists: Array<{ priceCents: number }>;
  variants: Array<{
    quantity: number;
    minQuantity: number;
    variantPrices: Array<{ priceCents: number }>;
  }>;
}

export interface ProductDetailWithIncludes {
  id: string;
  name: string;
  description: string | null;
  hasVariants: boolean;
  useStock: boolean;
  quantity: number;
  minQuantity: number;
  hidePriceInOnlineCatalog: boolean;
  requiresPrescription: boolean;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  images: Array<{ id: string; url: string; isMain: boolean }>;
  priceLists: Array<{ priceCents: number }>;
  variants: Array<{
    id: string;
    name: string;
    option: string | null;
    value: string | null;
    quantity: number;
    minQuantity: number;
    images: Array<{ url: string }>;
    variantPrices: Array<{ priceCents: number }>;
  }>;
}

function computeAggregateAvailability(
  product: ProductWithIncludes,
): PublicStockStatus {
  if (!product.useStock) return 'available';

  if (!product.hasVariants || product.variants.length === 0) {
    return mapStockStatus(product.quantity, product.minQuantity);
  }

  const statuses = product.variants.map((v) =>
    mapStockStatus(v.quantity, v.minQuantity),
  );
  if (statuses.includes('available')) return 'available';
  if (statuses.includes('low_stock')) return 'low_stock';
  return 'out_of_stock';
}

function computeFromPrice(product: ProductWithIncludes): number | null {
  const productPrice = product.priceLists[0]?.priceCents ?? null;

  if (!product.hasVariants || product.variants.length === 0) {
    return productPrice;
  }

  const variantPrices = product.variants
    .map((v) => v.variantPrices[0]?.priceCents)
    .filter((p): p is number => p != null);

  if (variantPrices.length === 0) return productPrice;
  return Math.min(...variantPrices);
}

export function toPublicProductCard(
  product: ProductWithIncludes,
): PublicCatalogProductCard {
  const priceHidden = isEffectivelyPriceHidden(product);

  return {
    id: product.id,
    name: product.name,
    slug: null,
    description: product.description,
    category: product.category
      ? { id: product.category.id, name: product.category.name }
      : null,
    brand: product.brand ? { name: product.brand.name } : null,
    image: product.images[0] ? { url: product.images[0].url } : null,
    price: priceHidden
      ? { fromPriceCents: null, priceCents: null, hidden: true }
      : {
          fromPriceCents: computeFromPrice(product),
          priceCents: product.priceLists[0]?.priceCents ?? null,
          hidden: false,
        },
    availability: computeAggregateAvailability(product),
    hasVariants: product.hasVariants,
    rating: null,
    featuredLabel: null,
  };
}

export function toPublicProductDetail(
  product: ProductDetailWithIncludes,
  tenant: { id: string; slug: string; name: string },
): PublicCatalogProductDetail {
  const priceHidden = isEffectivelyPriceHidden(product);

  const variants: PublicVariantDto[] = product.variants.map((v) => ({
    id: v.id,
    name: v.name,
    option: v.option,
    value: v.value,
    image: v.images[0] ? { url: v.images[0].url } : null,
    price: priceHidden
      ? { priceCents: null, hidden: true }
      : {
          priceCents: v.variantPrices[0]?.priceCents ?? null,
          hidden: false,
        },
    availabilityByBranch: [
      {
        branchId: tenant.id,
        branchName: tenant.name,
        branchSlug: tenant.slug,
        availability: product.useStock
          ? mapStockStatus(v.quantity, v.minQuantity)
          : 'available',
        isSelected: true,
      },
    ],
  }));

  return {
    id: product.id,
    name: product.name,
    slug: null,
    description: product.description,
    category: product.category
      ? { id: product.category.id, name: product.category.name }
      : null,
    brand: product.brand ? { name: product.brand.name } : null,
    images: product.images.map((img) => ({
      id: img.id,
      url: img.url,
      isMain: img.isMain,
    })),
    price: priceHidden
      ? { priceCents: null, hidden: true }
      : {
          priceCents: product.priceLists[0]?.priceCents ?? null,
          hidden: false,
        },
    availability: computeAggregateAvailability(product as ProductWithIncludes),
    hasVariants: product.hasVariants,
    variants,
    rating: null,
    featuredLabel: null,
  };
}
