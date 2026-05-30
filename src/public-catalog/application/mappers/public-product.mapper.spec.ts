import {
  toPublicProductCard,
  toPublicProductDetail,
  type ProductWithIncludes,
  type ProductDetailWithIncludes,
} from './public-product.mapper';

function makeProduct(overrides: Partial<ProductWithIncludes> = {}): ProductWithIncludes {
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
      variants: [
        { quantity: 10, minQuantity: 2, variantPrices: [{ priceCents: 100000 }] },
        { quantity: 5, minQuantity: 2, variantPrices: [{ priceCents: 80000 }] },
      ],
    });
    const result = toPublicProductCard(product);
    expect(result.price.fromPriceCents).toBe(80000);
  });

  it('should aggregate availability from variants when hasVariants', () => {
    const product = makeProduct({
      hasVariants: true,
      useStock: true,
      variants: [
        { quantity: 0, minQuantity: 2, variantPrices: [{ priceCents: 100000 }] },
        { quantity: 0, minQuantity: 2, variantPrices: [{ priceCents: 80000 }] },
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
});
