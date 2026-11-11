/**
 * Public catalog v0 (S3) — `stockPresentation.exactQuantity` through the
 * contextual card and detail mappers. Variant products: the product row is
 * always null, a variant row carries that variant's own quantity.
 */
import {
  toPublicProductCardForContext,
  toPublicProductDetailForContext,
  type PublicContextualDetailProjection,
  type PublicContextualListProjection,
} from './public-product.mapper';

const tenant = { id: 'tenant-1', slug: 'centro', name: 'Centro' };
const exactDefaults = {
  catalogStockPresentationDefault: 'SYSTEM_STATUS_EXACT_LOW_STOCK' as const,
  catalogStockPresentationDefaultCustomQty: null,
};
const systemDefaults = {
  catalogStockPresentationDefault: 'SYSTEM_STATUS' as const,
  catalogStockPresentationDefaultCustomQty: null,
};

const base = {
  id: 'p1',
  name: 'Croquetas',
  description: null,
  useStock: true,
  hidePriceInOnlineCatalog: false,
  requiresPrescription: false,
  category: null,
  brand: null,
  priceLists: [{ priceCents: 1000 }],
};

function card(
  overrides: Partial<PublicContextualListProjection> = {},
): PublicContextualListProjection {
  return {
    ...base,
    hasVariants: false,
    quantity: 2,
    minQuantity: 3,
    images: [],
    variants: [],
    stockPresentationParticipants: [],
    ...overrides,
  };
}

function detail(
  overrides: Partial<PublicContextualDetailProjection> = {},
): PublicContextualDetailProjection {
  return {
    ...base,
    hasVariants: false,
    quantity: 2,
    minQuantity: 3,
    images: [],
    variants: [],
    stockPresentationParticipants: [],
    ...overrides,
  };
}

const variant = (id: string, quantity: number) => ({
  id,
  name: `Variante ${id}`,
  option: 'Talla',
  value: id,
  quantity,
  minQuantity: 3,
  images: [],
  variantPrices: [{ priceCents: 1000 }],
});

describe('exactQuantity on a simple product', () => {
  it('card: carries the real quantity while low_stock under the exact mode', () => {
    expect(
      toPublicProductCardForContext(card(), exactDefaults).stockPresentation,
    ).toEqual({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      status: 'low_stock',
      customQuantity: null,
      exactQuantity: 2,
    });
  });

  it('card: is null once the product is available', () => {
    expect(
      toPublicProductCardForContext(card({ quantity: 40 }), exactDefaults)
        .stockPresentation.exactQuantity,
    ).toBeNull();
  });

  it('card: a product override can opt in while the tenant default stays SYSTEM_STATUS', () => {
    const result = toPublicProductCardForContext(
      card({
        onlineStockPresentation: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        onlineStockPresentationCustomQty: null,
      }),
      systemDefaults,
    );
    expect(result.stockPresentation.exactQuantity).toBe(2);
  });

  it('detail: carries the real quantity while low_stock', () => {
    const result = toPublicProductDetailForContext(
      detail(),
      tenant,
      exactDefaults,
    );
    expect(result.stockPresentation.exactQuantity).toBe(2);
    expect(result.availability).toBe('low_stock');
  });

  it('previous behavior holds: the default tenant keeps the exact three-key presentation', () => {
    const cardResult = toPublicProductCardForContext(card(), systemDefaults);
    expect(cardResult.stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'low_stock',
      customQuantity: null,
    });
    expect(Object.keys(cardResult.stockPresentation).sort()).toEqual([
      'customQuantity',
      'mode',
      'status',
    ]);
    const detailResult = toPublicProductDetailForContext(
      detail(),
      tenant,
      systemDefaults,
    );
    expect(detailResult.stockPresentation).not.toHaveProperty('exactQuantity');
  });
});

describe('exactQuantity on a variant product', () => {
  const variants = [variant('s', 2), variant('m', 40), variant('l', 0)];
  const participants = variants.map(({ quantity, minQuantity }) => ({
    quantity,
    minQuantity,
  }));

  it('detail: the product row is null, each variant row carries its own quantity', () => {
    const result = toPublicProductDetailForContext(
      detail({
        hasVariants: true,
        variants,
        stockPresentationParticipants: participants,
      }),
      tenant,
      exactDefaults,
    );
    expect(result.stockPresentation.exactQuantity).toBeNull();
    expect(
      result.variants.map((v) => [
        v.id,
        v.stockPresentation.status,
        v.stockPresentation.exactQuantity,
      ]),
    ).toEqual([
      ['s', 'low_stock', 2],
      ['m', 'available', null],
      ['l', 'out_of_stock', null],
    ]);
  });

  it('card: the product row is null even when the aggregate is low_stock', () => {
    const lowOnly = [variant('s', 1), variant('m', 2)];
    const result = toPublicProductCardForContext(
      card({
        hasVariants: true,
        variants: lowOnly,
        stockPresentationParticipants: lowOnly.map((v) => ({
          quantity: v.quantity,
          minQuantity: v.minQuantity,
        })),
      }),
      exactDefaults,
    );
    expect(result.stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      status: 'low_stock',
      customQuantity: null,
      exactQuantity: null,
    });
  });
});
