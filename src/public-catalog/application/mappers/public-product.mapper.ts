import {
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PublicCatalogProductCard } from '../dto/public-product-card.dto';
import type {
  PublicCatalogProductDetail,
  PublicVariantDto,
} from '../dto/public-product-detail.dto';
import type {
  PublicCatalogContextualProductBody,
  PublicCatalogContextualProductCard,
  PublicContextualVariantDto,
} from '../dto/public-price-context.dto';
import type { PublicStockPresentationDto } from '../dto/public-stock-presentation.dto';
import {
  mapStockStatus,
  type PublicStockStatus,
} from '../../domain/value-objects/stock-status.vo';
import { isEffectivelyPriceHidden } from '../../domain/value-objects/effective-price-hidden.vo';
import type {
  StockPresentationDefaults,
  StockPresentationSource,
} from '../../domain/value-objects/stock-presentation.vo';

/**
 * F3.WU9 correction — persisted stock-presentation override scalars as they
 * reach the mapper from the runtime Prisma projection (nullable per product
 * and per variant; absent in legacy typed fixtures means "not persisted").
 * F3.WU9 slice 8 — exported so the internal contextual list projection
 * (port `PublicProductListProjection`) can reuse the exact same contract.
 */
export type PersistedStockPresentationOverrides = {
  onlineStockPresentation?: StockPresentationSource['onlineStockPresentation'];
  onlineStockPresentationCustomQty?: StockPresentationSource['onlineStockPresentationCustomQty'];
};
import {
  mapPublicAggregateVariantStockPresentation,
  mapPublicProductStockPresentation,
  mapPublicVariantStockPresentation,
  type StockPresentationMappingResult,
} from './public-stock-presentation.mapper';

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
    id: string;
    name: string;
    option: string | null;
    value: string | null;
    quantity: number;
    minQuantity: number;
    /** F1.WU5c2 — carried from the repository projection for the defensive OFF filter. */
    catalogPublishMode?: string | null;
    variantPrices: Array<{ priceCents: number }>;
  }>;
}

export interface ProductDetailWithIncludes extends PersistedStockPresentationOverrides {
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
    /** F1.WU5c2 — carried from the repository projection for the defensive OFF filter. */
    catalogPublishMode?: string | null;
    /** F3.WU9 correction — persisted per-variant presentation override. */
    onlineStockPresentation?: StockPresentationSource['onlineStockPresentation'];
    onlineStockPresentationCustomQty?: StockPresentationSource['onlineStockPresentationCustomQty'];
    images: Array<{ url: string }>;
    variantPrices: Array<{ priceCents: number }>;
  }>;
}

/**
 * F1.WU5c2 — defensive mapper boundary. An OFF variant is absent before
 * every public derivation, regardless of what reaches the mapper (the SQL
 * gates in WU5c1 remain the first line of defense). Missing/undefined mode
 * in legacy typed fixtures is treated as inherited (included); only an
 * explicit OFF is suppressed.
 */
function visibleVariants<V extends { catalogPublishMode?: string | null }>(
  variants: V[],
): V[] {
  return variants.filter((v) => v.catalogPublishMode !== 'OFF');
}

function computeAggregateAvailability(
  product: ProductWithIncludes,
): PublicStockStatus {
  if (!product.useStock) return 'available';

  // F1.WU5c2 — OFF variants are absent before the aggregate is derived.
  const publicVariants = visibleVariants(product.variants);

  if (!product.hasVariants || publicVariants.length === 0) {
    return mapStockStatus(product.quantity, product.minQuantity);
  }

  const statuses = publicVariants.map((v) =>
    mapStockStatus(v.quantity, v.minQuantity),
  );
  if (statuses.includes('available')) return 'available';
  if (statuses.includes('low_stock')) return 'low_stock';
  return 'out_of_stock';
}

function computeFromPrice(product: ProductWithIncludes): number | null {
  const productPrice = product.priceLists[0]?.priceCents ?? null;

  // F1.WU5c2 — OFF variants are absent before the price is derived.
  const publicVariants = visibleVariants(product.variants);

  if (!product.hasVariants || publicVariants.length === 0) {
    return productPrice;
  }

  const variantPrices = publicVariants
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

  const publicVariants = visibleVariants(product.variants);

  const variants: PublicVariantDto[] = publicVariants.map((v) => ({
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

/**
 * F3.WU9 slice 7 — internal contextual detail input: the exact-context
 * repository projection plus its preserved participant snapshot
 * (`PublicStockPresentationParticipant` rows, structurally compatible).
 */
export interface PublicContextualDetailProjection extends ProductDetailWithIncludes {
  stockPresentationParticipants: ReadonlyArray<{
    quantity: number;
    minQuantity: number;
  }>;
}

/**
 * F3.WU9 slice 9 — internal contextual list input: the exact-context list
 * projection (`PublicProductListProjection`, structurally compatible) plus
 * its preserved participant snapshot.
 */
export interface PublicContextualListProjection
  extends ProductWithIncludes,
    PersistedStockPresentationOverrides {
  stockPresentationParticipants: ReadonlyArray<{
    quantity: number;
    minQuantity: number;
  }>;
}

const contextualLogger = new Logger('PublicProductMapper');

/**
 * F3.WU9 slice 7 — approved `invalid-participants` policy: one safe internal
 * warning (no operational participant values, IDs, or configuration) and the
 * public response stays indistinguishable from a missing/unpublished product.
 */
function mappedStockOrThrow(
  result: StockPresentationMappingResult,
): PublicStockPresentationDto {
  if (result.kind === 'invalid-participants') {
    contextualLogger.warn(
      'Public detail context rejected invalid stock-presentation participants; responding as a generic miss.',
    );
    throw new NotFoundException('Not Found');
  }
  return result.value;
}

/**
 * F3.WU9 slice 9 — approved list `invalid-participants` policy: one
 * structured internal invariant error log (no operational values or
 * payloads) and a generic server error failing the entire contextual page.
 */
function mappedCardStockOrThrow(
  result: StockPresentationMappingResult,
): PublicStockPresentationDto {
  if (result.kind === 'invalid-participants') {
    contextualLogger.error(
      JSON.stringify({
        invariant: 'public_catalog_list_invalid_stock_presentation_participants',
      }),
    );
    throw new InternalServerErrorException('Internal Server Error');
  }
  return result.value;
}

/**
 * F3.WU9 slice 7 (corrected) — contextual-only stock-presentation mapping
 * (design §9.2/§9.3). Tenant defaults arrive unchanged from the resolved
 * `ResolvedPublicCatalogContext.stockPresentationDefaults`; persisted
 * product/variant presentation overrides participate in the canonical
 * resolution: product override → tenant default → SYSTEM_STATUS, with a
 * null-mode variant inheriting the resolved product configuration and an
 * explicit-mode variant using its own mode and custom quantity only. An
 * explicit custom quantity of `0` is preserved. Simple products map their
 * own operational stock; variant products aggregate exclusively over the
 * preserved `stockPresentationParticipants` rows using the product
 * effective configuration only — product `quantity`/`minQuantity` are
 * never revived as an aggregate fallback, and participant variant
 * presentation overrides never affect the aggregate configuration. The
 * legacy `toPublicProductDetail` behavior above is untouched.
 */
export function toPublicProductDetailForContext(
  product: PublicContextualDetailProjection,
  tenant: { id: string; slug: string; name: string },
  stockDefaults: StockPresentationDefaults,
): PublicCatalogContextualProductBody {
  const priceHidden = isEffectivelyPriceHidden(product);
  const publicVariants = visibleVariants(product.variants);

  // F3.WU9 correction — the persisted product override participates in the
  // canonical resolution (`?? null` preserves an explicit custom qty of 0).
  const productPresentationSource = {
    onlineStockPresentation: product.onlineStockPresentation ?? null,
    onlineStockPresentationCustomQty:
      product.onlineStockPresentationCustomQty ?? null,
  };

  const productStock = mappedStockOrThrow(
    product.hasVariants
      ? mapPublicAggregateVariantStockPresentation({
          product: { ...productPresentationSource, useStock: product.useStock },
          tenant: stockDefaults,
          variantParticipants: product.stockPresentationParticipants,
        })
      : mapPublicProductStockPresentation({
          product: {
            ...productPresentationSource,
            useStock: product.useStock,
            quantity: product.quantity,
            minQuantity: product.minQuantity,
          },
          tenant: stockDefaults,
        }),
  );

  const variants: PublicContextualVariantDto[] = publicVariants.map((v) => {
    const stock = mappedStockOrThrow(
      mapPublicVariantStockPresentation({
        // A null-mode variant inherits the resolved product configuration
        // (including product/tenant custom quantity) inside the domain VO.
        product: { ...productPresentationSource, useStock: product.useStock },
        variant: {
          onlineStockPresentation: v.onlineStockPresentation ?? null,
          onlineStockPresentationCustomQty:
            v.onlineStockPresentationCustomQty ?? null,
          quantity: v.quantity,
          minQuantity: v.minQuantity,
        },
        tenant: stockDefaults,
      }),
    );

    return {
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
          // Compatibility mirror of the variant's own presentation status.
          availability: stock.status,
          isSelected: true,
        },
      ],
      stockPresentation: stock,
    };
  });

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
    availability: productStock.status,
    stockPresentation: productStock,
    hasVariants: product.hasVariants,
    variants,
    rating: null,
    featuredLabel: null,
  };
}

/**
 * F3.WU9 slice 9 — contextual-only card mapping (design §9.2/§9.3), reusing
 * the detail path's stock-presentation mapper and effective product
 * configuration logic: persisted product override → context
 * `stockPresentationDefaults`, preserving an explicit custom quantity of `0`.
 * Simple products map their own operational stock; variant products
 * aggregate exclusively over the preserved `stockPresentationParticipants`
 * rows (product `quantity`/`minQuantity` are never a fallback). Public
 * `availability` mirrors the rendered status and is `null` for `HIDDEN`.
 * The legacy `toPublicProductCard` behavior above is untouched.
 */
export function toPublicProductCardForContext(
  product: PublicContextualListProjection,
  stockDefaults: StockPresentationDefaults,
): PublicCatalogContextualProductCard {
  const priceHidden = isEffectivelyPriceHidden(product);

  // Persisted product override participates in the canonical resolution
  // (`?? null` preserves an explicit custom qty of 0).
  const productPresentationSource = {
    onlineStockPresentation: product.onlineStockPresentation ?? null,
    onlineStockPresentationCustomQty:
      product.onlineStockPresentationCustomQty ?? null,
  };

  const stock = mappedCardStockOrThrow(
    product.hasVariants
      ? mapPublicAggregateVariantStockPresentation({
          product: { ...productPresentationSource, useStock: product.useStock },
          tenant: stockDefaults,
          variantParticipants: product.stockPresentationParticipants,
        })
      : mapPublicProductStockPresentation({
          product: {
            ...productPresentationSource,
            useStock: product.useStock,
            quantity: product.quantity,
            minQuantity: product.minQuantity,
          },
          tenant: stockDefaults,
        }),
  );

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
    availability: stock.status,
    stockPresentation: stock,
    hasVariants: product.hasVariants,
    rating: null,
    featuredLabel: null,
  };
}
