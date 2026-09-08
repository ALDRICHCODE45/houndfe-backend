import { Logger, NotFoundException } from '@nestjs/common';
import {
  toPublicProductCard,
  toPublicProductDetail,
  toPublicProductDetailForContext,
  type ProductWithIncludes,
  type ProductDetailWithIncludes,
  type PublicContextualDetailProjection,
} from './public-product.mapper';

function makeProduct(
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin 13.6kg',
    description: 'Dog food',
    hasVariants: false,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento Seco' },
    brand: { name: 'Royal Canin' },
    images: [{ url: 'https://cdn.example.com/img1.jpg' }],
    priceLists: [{ priceCents: 125000 }],
    variants: [],
    ...overrides,
  };
}

type DetailVariant = ProductDetailWithIncludes['variants'][number];

/** Compact detail-variant fixture for the WU5c2 tests. */
function makeDetailVariant(
  id: string,
  priceCents: number,
  overrides: Partial<DetailVariant> = {},
): DetailVariant {
  return {
    id,
    name: `Variant ${id}`,
    option: 'Talla',
    value: id,
    quantity: 10,
    minQuantity: 2,
    images: [],
    variantPrices: [{ priceCents }],
    ...overrides,
  };
}

type CardVariant = ProductWithIncludes['variants'][number];

/** Compact card-variant fixture for the WU5c2 tests. */
function makeVariant(
  id: string,
  priceCents: number,
  overrides: Partial<CardVariant> = {},
): CardVariant {
  return {
    id,
    name: `Variant ${id}`,
    option: 'Talla',
    value: id,
    quantity: 10,
    minQuantity: 2,
    variantPrices: [{ priceCents }],
    ...overrides,
  };
}

describe('toPublicProductCard', () => {
  it('should map a product with visible price', () => {
    const result = toPublicProductCard(makeProduct());

    expect(result).toEqual({
      id: 'prod-1',
      name: 'Royal Canin 13.6kg',
      slug: null,
      description: 'Dog food',
      category: { id: 'cat-1', name: 'Alimento Seco' },
      brand: { name: 'Royal Canin' },
      image: { url: 'https://cdn.example.com/img1.jpg' },
      price: { fromPriceCents: 125000, priceCents: 125000, hidden: false },
      availability: 'available',
      hasVariants: false,
      rating: null,
      featuredLabel: null,
    });
  });

  it('should set price fields to null when price is hidden', () => {
    const result = toPublicProductCard(
      makeProduct({ requiresPrescription: true }),
    );

    expect(result.price).toEqual({
      fromPriceCents: null,
      priceCents: null,
      hidden: true,
    });
  });

  it('should map out_of_stock when quantity is 0', () => {
    const result = toPublicProductCard(makeProduct({ quantity: 0 }));
    expect(result.availability).toBe('out_of_stock');
  });

  it('should return null category when product has no category', () => {
    const result = toPublicProductCard(makeProduct({ category: null }));
    expect(result.category).toBeNull();
  });

  it('should return null brand when product has no brand', () => {
    const result = toPublicProductCard(makeProduct({ brand: null }));
    expect(result.brand).toBeNull();
  });

  it('should return null image when product has no images', () => {
    const result = toPublicProductCard(makeProduct({ images: [] }));
    expect(result.image).toBeNull();
  });

  it('should always have rating and featuredLabel as null', () => {
    const result = toPublicProductCard(makeProduct());
    expect(result.rating).toBeNull();
    expect(result.featuredLabel).toBeNull();
  });

  it('should NEVER include quantity, minQuantity, or cost fields', () => {
    const result = toPublicProductCard(makeProduct());
    const keys = Object.keys(result);
    expect(keys).not.toContain('quantity');
    expect(keys).not.toContain('minQuantity');
    expect(keys).not.toContain('purchaseNetCostCents');
    expect(keys).not.toContain('purchaseGrossCostCents');
    expect(keys).not.toContain('tenantId');
  });

  it('should compute fromPriceCents from min variant price when hasVariants', () => {
    const product = makeProduct({
      hasVariants: true,
      variants: [makeVariant('v-a', 100000), makeVariant('v-b', 80000)],
    });
    const result = toPublicProductCard(product);
    expect(result.price.fromPriceCents).toBe(80000);
  });

  it('should aggregate availability from variants when hasVariants', () => {
    const product = makeProduct({
      hasVariants: true,
      useStock: true,
      variants: [
        makeVariant('v-a', 100000, { quantity: 0 }),
        makeVariant('v-b', 80000, { quantity: 0 }),
      ],
    });
    const result = toPublicProductCard(product);
    expect(result.availability).toBe('out_of_stock');
  });

  it('should return available when useStock is false', () => {
    const product = makeProduct({ useStock: false, quantity: 0 });
    const result = toPublicProductCard(product);
    expect(result.availability).toBe('available');
  });

  // ------------------------------------------------------------------
  // F1.WU5c2 — defensive public variant mapping. The repository already
  // filters OFF variants in SQL (WU5c1); the mapper must never let an OFF
  // variant leak through alternate/legacy callers either.
  // ------------------------------------------------------------------

  it('must NOT let an OFF cheap variant lower card fromPriceCents (F1.WU5c2)', () => {
    const product = makeProduct({
      hasVariants: true,
      variants: [
        makeVariant('v-on', 100000, { catalogPublishMode: 'ON' }),
        makeVariant('v-off', 50000, { catalogPublishMode: 'OFF' }),
      ],
    });

    // The OFF variant is 50000 — if it leaked, fromPrice would drop below the ON price.
    expect(toPublicProductCard(product).price.fromPriceCents).toBe(100000);
  });

  it('must NOT let an OFF in-stock variant raise card availability (F1.WU5c2)', () => {
    const product = makeProduct({
      hasVariants: true,
      useStock: true,
      quantity: 0,
      variants: [makeVariant('v-off', 80000, { catalogPublishMode: 'OFF' })],
    });

    // The OFF variant is in stock; the product itself is out: availability
    // must follow the product, not the unpublished variant.
    expect(toPublicProductCard(product).availability).toBe('out_of_stock');
  });

  it('includes INHERIT and ON variants in card derivations but never OFF (F1.WU5c2)', () => {
    const product = makeProduct({
      hasVariants: true,
      useStock: true,
      variants: [
        makeVariant('v-inherit', 90000, { catalogPublishMode: 'INHERIT' }),
        makeVariant('v-on', 100000, { catalogPublishMode: 'ON' }),
        makeVariant('v-off', 10000, { catalogPublishMode: 'OFF' }),
      ],
    });

    const result = toPublicProductCard(product);

    expect(result.price.fromPriceCents).toBe(90000);
    expect(result.availability).toBe('available');
  });

  it('treats missing/undefined catalogPublishMode as inherited (legacy fixtures, F1.WU5c2)', () => {
    const product = makeProduct({
      hasVariants: true,
      variants: [makeVariant('v-legacy', 70000)],
    });

    expect(toPublicProductCard(product).price.fromPriceCents).toBe(70000);
  });

  it('defensive all-OFF input must not expose variant-derived price or availability (F1.WU5c2)', () => {
    const product = makeProduct({
      hasVariants: true,
      useStock: true,
      quantity: 0,
      variants: [
        makeVariant('v-off', 1, {
          catalogPublishMode: 'OFF',
          quantity: 99,
          minQuantity: 1,
        }),
      ],
    });

    // Fallback semantics stay exactly the existing F1 ones: product-level
    // price list and product-level stock — no new fields, no errors.
    const result = toPublicProductCard(product);

    expect(result.price.fromPriceCents).toBe(125000);
    expect(result.availability).toBe('out_of_stock');
  });

  it('keeps the exact F1 card payload keys when filtering OFF variants (F1.WU5c2)', () => {
    const result = toPublicProductCard(
      makeProduct({
        hasVariants: true,
        variants: [makeVariant('v-off', 1, { catalogPublishMode: 'OFF' })],
      }),
    );

    expect(Object.keys(result)).toEqual([
      'id',
      'name',
      'slug',
      'description',
      'category',
      'brand',
      'image',
      'price',
      'availability',
      'hasVariants',
      'rating',
      'featuredLabel',
    ]);
  });
});

describe('toPublicProductDetail', () => {
  const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };

  function makeDetailProduct(
    overrides: Partial<ProductDetailWithIncludes> = {},
  ): ProductDetailWithIncludes {
    return {
      id: 'prod-1',
      name: 'Royal Canin 13.6kg',
      description: 'Dog food',
      hasVariants: false,
      useStock: true,
      quantity: 50,
      minQuantity: 5,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      category: { id: 'cat-1', name: 'Alimento Seco' },
      brand: { name: 'Royal Canin' },
      images: [
        { id: 'img-1', url: 'https://cdn.example.com/img1.jpg', isMain: true },
      ],
      priceLists: [{ priceCents: 125000 }],
      variants: [],
      ...overrides,
    };
  }

  it('should map detail with correct shape and no forbidden fields', () => {
    const result = toPublicProductDetail(makeDetailProduct(), tenant);

    expect(result.id).toBe('prod-1');
    expect(result.name).toBe('Royal Canin 13.6kg');
    expect(result.slug).toBeNull();
    expect(result.rating).toBeNull();
    expect(result.featuredLabel).toBeNull();
    expect(result.variants).toEqual([]);

    const keys = Object.keys(result);
    expect(keys).not.toContain('quantity');
    expect(keys).not.toContain('minQuantity');
    expect(keys).not.toContain('tenantId');
  });

  it('should map variants with single-entry availabilityByBranch', () => {
    const detail = makeDetailProduct({
      hasVariants: true,
      variants: [
        {
          id: 'var-1',
          name: 'Grande',
          option: 'Talla',
          value: 'G',
          quantity: 10,
          minQuantity: 2,
          images: [{ url: 'https://cdn.example.com/var1.jpg' }],
          variantPrices: [{ priceCents: 130000 }],
        },
      ],
    });
    const result = toPublicProductDetail(detail, tenant);

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].availabilityByBranch).toEqual([
      {
        branchId: 'tenant-1',
        branchName: 'Sucursal Centro',
        branchSlug: 'centro',
        availability: 'available',
        isSelected: true,
      },
    ]);
    expect(result.variants[0].price.priceCents).toBe(130000);
    expect(result.variants[0].price.hidden).toBe(false);
  });

  // ------------------------------------------------------------------
  // F1.WU5c2 — detail must return no OFF variant row, identity, image,
  // price, or availability.
  // ------------------------------------------------------------------

  it('must NOT map an OFF variant row, identity, image, or price in detail (F1.WU5c2)', () => {
    const detail = makeDetailProduct({
      hasVariants: true,
      variants: [
        makeDetailVariant('v-on', 130000, { name: 'Grande' }),
        makeDetailVariant('v-off', 1, {
          name: 'Secreto',
          catalogPublishMode: 'OFF',
          images: [{ url: 'https://cdn.example.com/var-off.jpg' }],
        }),
      ],
    });

    const result = toPublicProductDetail(detail, tenant);

    expect(result.variants.map((v) => v.id)).toEqual(['v-on']);
    expect(JSON.stringify(result)).not.toContain('v-off');
    expect(JSON.stringify(result)).not.toContain('Secreto');
    expect(JSON.stringify(result)).not.toContain('var-off.jpg');
  });

  it('must NOT let an OFF variant raise detail aggregate availability (F1.WU5c2)', () => {
    const detail = makeDetailProduct({
      hasVariants: true,
      useStock: true,
      quantity: 0,
      variants: [makeDetailVariant('v-off', 1, { catalogPublishMode: 'OFF' })],
    });

    const result = toPublicProductDetail(detail, tenant);

    expect(result.variants).toHaveLength(0);
    expect(result.availability).toBe('out_of_stock');
  });

  it('includes INHERIT and ON variant rows in detail but never OFF (F1.WU5c2)', () => {
    const detail = makeDetailProduct({
      hasVariants: true,
      variants: [
        makeDetailVariant('v-inherit', 120000, {
          catalogPublishMode: 'INHERIT',
        }),
        makeDetailVariant('v-on', 130000, { catalogPublishMode: 'ON' }),
        makeDetailVariant('v-off', 1, { catalogPublishMode: 'OFF' }),
      ],
    });

    expect(
      toPublicProductDetail(detail, tenant).variants.map((v) => v.id),
    ).toEqual(['v-inherit', 'v-on']);
  });

  it('keeps the exact F1 payload keys when filtering OFF variants (F1.WU5c2)', () => {
    const result = toPublicProductDetail(
      makeDetailProduct({
        hasVariants: true,
        variants: [
          makeDetailVariant('v-off', 1, { catalogPublishMode: 'OFF' }),
        ],
      }),
      tenant,
    );

    expect(Object.keys(result)).toEqual([
      'id',
      'name',
      'slug',
      'description',
      'category',
      'brand',
      'images',
      'price',
      'availability',
      'hasVariants',
      'variants',
      'rating',
      'featuredLabel',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F3.WU9 slice 7 — contextual-only stock-presentation activation. The
// legacy `toPublicProductDetail` above stays untouched; this contextual
// mapper reads the resolved context defaults only, aggregates variant
// products over the preserved participants, and never revives product
// quantities as an aggregate fallback.
// ─────────────────────────────────────────────────────────────────────────
describe('toPublicProductDetailForContext', () => {
  const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
  const systemDefaults = {
    catalogStockPresentationDefault: 'SYSTEM_STATUS' as const,
    catalogStockPresentationDefaultCustomQty: null,
  };

  function makeProjection(
    overrides: Partial<PublicContextualDetailProjection> = {},
  ): PublicContextualDetailProjection {
    return {
      id: 'prod-1',
      name: 'Royal Canin 13.6kg',
      description: 'Dog food',
      hasVariants: false,
      useStock: true,
      quantity: 50,
      minQuantity: 5,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      category: { id: 'cat-1', name: 'Alimento Seco' },
      brand: { name: 'Royal Canin' },
      images: [
        { id: 'img-1', url: 'https://cdn.example.com/img1.jpg', isMain: true },
      ],
      priceLists: [{ priceCents: 125000 }],
      variants: [],
      stockPresentationParticipants: [],
      ...overrides,
    };
  }

  const variantOf = (
    id: string,
    quantity: number,
    overrides: Partial<PublicContextualDetailProjection['variants'][number]> = {},
  ) => ({
    id,
    name: `Variant ${id}`,
    option: 'Talla',
    value: id,
    quantity,
    minQuantity: 2,
    images: [],
    variantPrices: [{ priceCents: 130000 }],
    ...overrides,
  });

  it('maps a simple product from the tenant defaults and exposes the exact contextual key set', () => {
    const result = toPublicProductDetailForContext(
      makeProjection(),
      tenant,
      systemDefaults,
    );

    expect(result.stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'available',
      customQuantity: null,
    });
    expect(result.availability).toBe('available');
    expect(Object.keys(result)).toEqual([
      'id',
      'name',
      'slug',
      'description',
      'category',
      'brand',
      'images',
      'price',
      'availability',
      'stockPresentation',
      'hasVariants',
      'variants',
      'rating',
      'featuredLabel',
    ]);
  });

  it('passes the context stock defaults unchanged to the presentation resolution', () => {
    const result = toPublicProductDetailForContext(
      makeProjection({ quantity: 0 }),
      tenant,
      {
        catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
        catalogStockPresentationDefaultCustomQty: 4,
      },
    );

    expect(result.stockPresentation).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: 'out_of_stock',
      customQuantity: 4,
    });
  });

  it('aggregates variant products over participants only and never revives product quantities', () => {
    const result = toPublicProductDetailForContext(
      makeProjection({
        hasVariants: true,
        quantity: 999,
        variants: [variantOf('v-a', 0)],
        stockPresentationParticipants: [{ quantity: 0, minQuantity: 0 }],
      }),
      tenant,
      systemDefaults,
    );

    expect(result.stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'out_of_stock',
      customQuantity: null,
    });
    expect(result.availability).toBe('out_of_stock');
  });

  it('maps each visible variant row with its own presentation and mirrors branch availability', () => {
    const result = toPublicProductDetailForContext(
      makeProjection({
        hasVariants: true,
        variants: [
          variantOf('v-a', 10),
          variantOf('v-b', 0),
          variantOf('v-off', 99, { catalogPublishMode: 'OFF' }),
        ],
        stockPresentationParticipants: [
          { quantity: 10, minQuantity: 2 },
          { quantity: 0, minQuantity: 2 },
        ],
      }),
      tenant,
      systemDefaults,
    );

    expect(result.variants.map((v) => v.id)).toEqual(['v-a', 'v-b']);
    expect(result.variants[0].stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'available',
      customQuantity: null,
    });
    expect(result.variants[1].stockPresentation.status).toBe('out_of_stock');
    expect(result.variants[1].availabilityByBranch[0].availability).toBe(
      'out_of_stock',
    );
    expect(Object.keys(result.variants[0])).toEqual([
      'id',
      'name',
      'option',
      'value',
      'image',
      'price',
      'availabilityByBranch',
      'stockPresentation',
    ]);
  });

  it('leaks no operational stock keys in the serialized contextual output', () => {
    const result = toPublicProductDetailForContext(
      makeProjection({
        hasVariants: true,
        variants: [variantOf('v-a', 10)],
        stockPresentationParticipants: [{ quantity: 10, minQuantity: 2 }],
      }),
      tenant,
      systemDefaults,
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('"quantity"');
    expect(serialized).not.toContain('"minQuantity"');
    expect(serialized).not.toContain('stockPresentationParticipants');
    expect(serialized).not.toContain('"tenantId"');
    expect(serialized).not.toContain('catalogPublishMode');
  });

  it('mirrors HIDDEN as null availability on the product and every branch row', () => {
    const result = toPublicProductDetailForContext(
      makeProjection({
        hasVariants: true,
        variants: [variantOf('v-a', 10)],
        stockPresentationParticipants: [{ quantity: 10, minQuantity: 2 }],
      }),
      tenant,
      {
        catalogStockPresentationDefault: 'HIDDEN',
        catalogStockPresentationDefaultCustomQty: null,
      },
    );

    expect(result.availability).toBeNull();
    expect(result.stockPresentation).toEqual({
      mode: 'HIDDEN',
      status: null,
      customQuantity: null,
    });
    expect(result.variants[0].availabilityByBranch[0].availability).toBeNull();
  });

  it.each([
    ['missing participants', undefined],
    ['malformed participant rows', [{ quantity: '10', minQuantity: 0 }]],
  ])(
    'responds as a generic miss with one safe warning on %s',
    (_label, participants) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      expect(() =>
        toPublicProductDetailForContext(
          makeProjection({
            hasVariants: true,
            variants: [variantOf('v-a', 0)],
            stockPresentationParticipants:
              participants as unknown as PublicContextualDetailProjection['stockPresentationParticipants'],
          }),
          tenant,
          systemDefaults,
        ),
      ).toThrow(new NotFoundException('Not Found'));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('quantity');
      warn.mockRestore();
    },
  );
});
