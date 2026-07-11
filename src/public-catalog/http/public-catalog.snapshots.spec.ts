import {
  toPublicProductCard,
  toPublicProductDetail,
  type ProductWithIncludes,
  type ProductDetailWithIncludes,
} from '../application/mappers/public-product.mapper';

describe('Public catalog response snapshot tests', () => {
  function makeProduct(): ProductWithIncludes {
    return {
      id: 'prod-snap-1',
      name: 'Snapshot Product',
      description: 'For snapshot testing',
      hasVariants: false,
      useStock: true,
      quantity: 10,
      minQuantity: 2,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      category: { id: 'cat-1', name: 'Alimento' },
      brand: { name: 'TestBrand' },
      images: [{ url: 'https://cdn.example.com/snap.jpg' }],
      priceLists: [{ priceCents: 99900 }],
      variants: [],
    };
  }

  it('toPublicProductCard should ONLY contain whitelisted fields', () => {
    const result = toPublicProductCard(makeProduct());
    const keys = new Set(Object.keys(result));

    // Whitelisted fields
    const expected = new Set([
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
    expect(keys).toEqual(expected);
  });

  it('product card must NOT contain raw quantity fields', () => {
    const result = toPublicProductCard(makeProduct()) as Record<
      string,
      unknown
    >;
    expect(result).not.toHaveProperty('quantity');
    expect(result).not.toHaveProperty('minQuantity');
    expect(result).not.toHaveProperty('purchaseNetCostCents');
    expect(result).not.toHaveProperty('purchaseGrossCostCents');
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('sku');
    expect(result).not.toHaveProperty('barcode');
    expect(result).not.toHaveProperty('useStock');
    expect(result).not.toHaveProperty('categoryId');
    expect(result).not.toHaveProperty('brandId');
    expect(result).not.toHaveProperty('ivaRate');
    expect(result).not.toHaveProperty('iepsRate');
    expect(result).not.toHaveProperty('satKey');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('product detail must NOT contain raw quantity fields', () => {
    const detail: ProductDetailWithIncludes = {
      id: 'prod-snap-1',
      name: 'Snapshot Product',
      description: 'detail snap',
      hasVariants: true,
      useStock: true,
      quantity: 10,
      minQuantity: 2,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      category: { id: 'cat-1', name: 'Alimento' },
      brand: { name: 'TestBrand' },
      images: [
        { id: 'img-1', url: 'https://cdn.example.com/snap.jpg', isMain: true },
      ],
      priceLists: [{ priceCents: 99900 }],
      variants: [
        {
          id: 'var-1',
          name: 'Grande',
          option: 'Talla',
          value: 'G',
          quantity: 5,
          minQuantity: 1,
          images: [],
          variantPrices: [{ priceCents: 109900 }],
        },
      ],
    };

    const tenant = { id: 't1', slug: 'centro', name: 'Centro' };
    const result = toPublicProductDetail(detail, tenant) as Record<
      string,
      unknown
    >;

    expect(result).not.toHaveProperty('quantity');
    expect(result).not.toHaveProperty('minQuantity');
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('purchaseNetCostCents');

    // Check variants too
    const variantResult = (
      result.variants as Array<Record<string, unknown>>
    )[0];
    expect(variantResult).not.toHaveProperty('quantity');
    expect(variantResult).not.toHaveProperty('minQuantity');
  });

  it('product card price fields should match snapshot', () => {
    const result = toPublicProductCard(makeProduct());
    expect(result.price).toEqual({
      fromPriceCents: 99900,
      priceCents: 99900,
      hidden: false,
    });
  });
});
