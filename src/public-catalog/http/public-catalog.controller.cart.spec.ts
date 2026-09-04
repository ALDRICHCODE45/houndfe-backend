import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import type { IPublicCatalogRepository } from '../application/ports/public-catalog.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

describe('ValidatePublicCartUseCase', () => {
  let useCase: ValidatePublicCartUseCase;
  let tenantPrisma: {
    getClient: jest.Mock;
  };
  let mockClient: {
    product: { findMany: jest.Mock };
  };
  let repo: { findTenantCatalogDefaultPriceListId: jest.Mock };

  function makeDbProduct(overrides: Record<string, unknown> = {}) {
    return {
      id: 'prod-1',
      name: 'Royal Canin 13.6kg',
      type: 'PRODUCT',
      includeInOnlineCatalog: true,
      useStock: true,
      quantity: 50,
      minQuantity: 5,
      hasVariants: false,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      images: [{ url: 'https://cdn.example.com/img1.jpg' }],
      priceLists: [{ priceCents: 125000 }],
      variants: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    mockClient = {
      product: { findMany: jest.fn() },
    };
    tenantPrisma = {
      getClient: jest.fn().mockReturnValue(mockClient),
    };
    repo = {
      findTenantCatalogDefaultPriceListId: jest
        .fn()
        .mockResolvedValue('gpl-default-1'),
    };
    useCase = new ValidatePublicCartUseCase(
      tenantPrisma as unknown as TenantPrismaService,
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('should validate happy path with 2 available items and correct totals', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
      makeDbProduct({
        id: 'prod-2',
        name: 'Pedigree',
        priceLists: [{ priceCents: 50000 }],
      }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', quantity: 2 },
        { productId: 'prod-2', quantity: 1 },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].unitPriceCents).toBe(100000);
    expect(result.items[0].lineTotalCents).toBe(200000);
    expect(result.totalCents).toBe(250000);
    expect(result.warnings).toEqual([]);
  });

  it('should return NOT_FOUND warning for missing product', async () => {
    mockClient.product.findMany.mockResolvedValue([]);

    const result = await useCase.execute({
      items: [{ productId: 'non-existent', quantity: 1 }],
    });

    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toContain('NOT_FOUND');
  });

  it('should return NOT_IN_CATALOG warning for non-catalog product', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', includeInOnlineCatalog: false }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', quantity: 1 }],
    });

    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toContain('NOT_IN_CATALOG');
  });

  it('should reject SERVICE product with NOT_IN_CATALOG and no metadata disclosure', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', type: 'SERVICE' }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', quantity: 2 }],
    });

    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toEqual(['NOT_IN_CATALOG']);
    expect(result.items[0].productName).toBe('');
    expect(result.items[0].variantName).toBeNull();
    expect(result.items[0].image).toBeNull();
    expect(result.items[0].unitPriceCents).toBeNull();
    expect(result.items[0].lineTotalCents).toBeNull();
    expect(result.items[0].availability).toBe('out_of_stock');
    expect(result.items[0].priceHidden).toBe(false);
  });

  it('should not disclose metadata for unpublished product even when requested variant is ON', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        includeInOnlineCatalog: false,
        hasVariants: true,
        variants: [
          {
            id: 'var-1',
            name: '1kg',
            quantity: 10,
            minQuantity: 1,
            catalogPublishMode: 'ON',
            variantPrices: [{ priceCents: 90000 }],
          },
        ],
      }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', variantId: 'var-1', quantity: 1 }],
    });

    // Parent gate wins over an ON variant — ON never widens a false parent
    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toEqual(['NOT_IN_CATALOG']);
    expect(result.items[0].productName).toBe('');
    expect(result.items[0].variantName).toBeNull();
    expect(result.items[0].image).toBeNull();
    // No downstream stock/price acceptance for the blocked row
    expect(result.items[0].unitPriceCents).toBeNull();
    expect(result.items[0].lineTotalCents).toBeNull();
    expect(result.items[0].availability).toBe('out_of_stock');
    expect(result.totalCents).toBe(0);
  });

  it('should return OUT_OF_STOCK warning and valid=false', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', quantity: 0 }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', quantity: 1 }],
    });

    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toContain('OUT_OF_STOCK');
    expect(result.items[0].availability).toBe('out_of_stock');
  });

  it('should return LOW_STOCK warning but item still contributes to total', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        quantity: 3,
        minQuantity: 5,
        priceLists: [{ priceCents: 100000 }],
      }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', quantity: 1 }],
    });

    expect(result.valid).toBe(true);
    expect(result.items[0].warnings).toContain('LOW_STOCK');
    expect(result.totalCents).toBe(100000);
  });

  it('should return PRICE_HIDDEN warning with null prices', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', requiresPrescription: true }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', quantity: 1 }],
    });

    expect(result.items[0].warnings).toContain('PRICE_HIDDEN');
    expect(result.items[0].priceHidden).toBe(true);
    expect(result.items[0].unitPriceCents).toBeNull();
    expect(result.items[0].lineTotalCents).toBeNull();
    expect(result.totalCents).toBeNull();
  });

  it('should return VARIANT_NOT_FOUND warning', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', hasVariants: true, variants: [] }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', variantId: 'non-existent-var', quantity: 1 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toContain('VARIANT_NOT_FOUND');
  });

  it('should allow INHERIT variant through stock and price decisions', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        hasVariants: true,
        variants: [
          {
            id: 'var-1',
            name: '1kg',
            quantity: 10,
            minQuantity: 1,
            catalogPublishMode: 'INHERIT',
            variantPrices: [{ priceCents: 90000 }],
          },
        ],
      }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', variantId: 'var-1', quantity: 2 }],
    });

    expect(result.valid).toBe(true);
    expect(result.items[0].warnings).toEqual([]);
    expect(result.items[0].variantName).toBe('1kg');
    expect(result.items[0].unitPriceCents).toBe(90000);
    expect(result.items[0].lineTotalCents).toBe(180000);
    expect(result.totalCents).toBe(180000);
  });

  it('should allow ON variant through stock and price decisions', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        hasVariants: true,
        variants: [
          {
            id: 'var-1',
            name: '1kg',
            quantity: 10,
            minQuantity: 1,
            catalogPublishMode: 'ON',
            variantPrices: [{ priceCents: 90000 }],
          },
        ],
      }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', variantId: 'var-1', quantity: 2 }],
    });

    expect(result.valid).toBe(true);
    expect(result.items[0].warnings).toEqual([]);
    expect(result.items[0].variantName).toBe('1kg');
    expect(result.items[0].unitPriceCents).toBe(90000);
    expect(result.items[0].lineTotalCents).toBe(180000);
    expect(result.totalCents).toBe(180000);
  });

  it('should treat OFF variant as VARIANT_NOT_FOUND without metadata disclosure', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        hasVariants: true,
        variants: [
          {
            id: 'var-off',
            name: '2kg',
            quantity: 10,
            minQuantity: 1,
            catalogPublishMode: 'OFF',
            variantPrices: [{ priceCents: 80000 }],
          },
        ],
      }),
    ]);

    const result = await useCase.execute({
      items: [{ productId: 'prod-1', variantId: 'var-off', quantity: 1 }],
    });

    expect(result.valid).toBe(false);
    expect(result.items[0].warnings).toEqual(['VARIANT_NOT_FOUND']);
    expect(result.items[0].productName).toBe('');
    expect(result.items[0].variantName).toBeNull();
    expect(result.items[0].image).toBeNull();
    expect(result.items[0].unitPriceCents).toBeNull();
    expect(result.items[0].lineTotalCents).toBeNull();
    expect(result.items[0].availability).toBe('out_of_stock');
    expect(result.totalCents).toBe(0);
  });

  it('should keep ordering and sanitize blocked rows in a mixed cart', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
      makeDbProduct({ id: 'prod-2', name: 'Grooming', type: 'SERVICE' }),
      makeDbProduct({ id: 'prod-3', includeInOnlineCatalog: false }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', quantity: 1 },
        { productId: 'prod-2', quantity: 2 },
        { productId: 'prod-3', quantity: 3 },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.items.map((i) => i.productId)).toEqual([
      'prod-1',
      'prod-2',
      'prod-3',
    ]);
    expect(result.items[1].warnings).toEqual(['NOT_IN_CATALOG']);
    expect(result.items[1].productName).toBe('');
    expect(result.items[1].image).toBeNull();
    expect(result.items[2].warnings).toEqual(['NOT_IN_CATALOG']);
    expect(result.items[2].productName).toBe('');
    expect(result.items[2].image).toBeNull();
    // Only the passing published product contributes to the total
    expect(result.totalCents).toBe(100000);
    expect(result.warnings).toEqual(['NOT_IN_CATALOG']);
  });

  it('should be idempotent for gated carts (same result on repeated validation)', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        hasVariants: true,
        variants: [
          {
            id: 'var-1',
            name: '1kg',
            quantity: 0,
            minQuantity: 1,
            catalogPublishMode: 'INHERIT',
            variantPrices: [{ priceCents: 90000 }],
          },
        ],
      }),
      makeDbProduct({ id: 'prod-2', name: 'Grooming', type: 'SERVICE' }),
    ]);

    const input = {
      items: [
        { productId: 'prod-1', variantId: 'var-1', quantity: 1 },
        { productId: 'prod-2', quantity: 1 },
      ],
    };

    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(second).toEqual(first);
    // Existing stock behavior is preserved for passing INHERIT variants
    expect(first.items[0].warnings).toContain('OUT_OF_STOCK');
    expect(first.items[0].unitPriceCents).toBe(90000);
    expect(first.valid).toBe(false);
  });

  it('should set totalCents to null when any item has hidden price', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
      makeDbProduct({ id: 'prod-2', requiresPrescription: true }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', quantity: 1 },
        { productId: 'prod-2', quantity: 1 },
      ],
    });

    expect(result.totalCents).toBeNull();
  });

  it('should exclude out_of_stock items from totalCents (CRITICAL-03 regression)', async () => {
    mockClient.product.findMany.mockResolvedValue([
      // Item 1: available with visible price — contributes to total
      makeDbProduct({
        id: 'prod-1',
        quantity: 50,
        priceLists: [{ priceCents: 100000 }],
      }),
      // Item 2: out_of_stock with visible price — must NOT contribute to total
      makeDbProduct({
        id: 'prod-2',
        name: 'Out of stock item',
        quantity: 0,
        priceLists: [{ priceCents: 50000 }],
      }),
      // Item 3: price hidden — must NOT contribute to total
      makeDbProduct({
        id: 'prod-3',
        name: 'Rx item',
        hidePriceInOnlineCatalog: true,
        priceLists: [{ priceCents: 75000 }],
      }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', quantity: 2 },
        { productId: 'prod-2', quantity: 1 },
        { productId: 'prod-3', quantity: 1 },
      ],
    });

    // totalCents should be null because at least one item has hidden price
    // but the key assertion is: out_of_stock item does NOT contribute
    expect(result.totalCents).toBeNull();
    // The out_of_stock item should still have lineTotalCents (it has a visible price)
    // but it should not contribute to the total sum
    expect(result.items[1].availability).toBe('out_of_stock');
    expect(result.items[2].priceHidden).toBe(true);
  });

  it('should exclude out_of_stock from totalCents when no hidden prices exist', async () => {
    mockClient.product.findMany.mockResolvedValue([
      // Item 1: available — contributes 200000
      makeDbProduct({
        id: 'prod-1',
        quantity: 50,
        priceLists: [{ priceCents: 100000 }],
      }),
      // Item 2: out_of_stock — must NOT contribute (even though price is visible)
      makeDbProduct({
        id: 'prod-2',
        name: 'OOS',
        quantity: 0,
        priceLists: [{ priceCents: 50000 }],
      }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', quantity: 2 },
        { productId: 'prod-2', quantity: 1 },
      ],
    });

    // Only prod-1 contributes: 100000 * 2 = 200000
    // prod-2 is out_of_stock — does NOT contribute even though price is visible
    expect(result.totalCents).toBe(200000);
  });

  it('should include low_stock items in totalCents', async () => {
    mockClient.product.findMany.mockResolvedValue([
      makeDbProduct({
        id: 'prod-1',
        quantity: 50,
        priceLists: [{ priceCents: 100000 }],
      }),
      makeDbProduct({
        id: 'prod-2',
        quantity: 3,
        minQuantity: 5,
        priceLists: [{ priceCents: 50000 }],
      }),
    ]);

    const result = await useCase.execute({
      items: [
        { productId: 'prod-1', quantity: 1 },
        { productId: 'prod-2', quantity: 1 },
      ],
    });

    // low_stock items DO contribute: 100000 + 50000 = 150000
    expect(result.totalCents).toBe(150000);
  });

  it('should produce NO persistence side effects', async () => {
    mockClient.product.findMany.mockResolvedValue([makeDbProduct()]);

    await useCase.execute({
      items: [{ productId: 'prod-1', quantity: 1 }],
    });

    // Only findMany should have been called — no create/update
    expect(mockClient.product.findMany).toHaveBeenCalledTimes(1);
  });

  // F1.WU5d2 — tenant catalog-default compatibility for cart pricing.
  // Price acceptance is by exact resolved global PriceList ID only; a
  // missing/empty default fails closed through the existing price-missing
  // (PRICE_HIDDEN) shape without weakening WU5d1 publication gates.
  describe('F1.WU5d2 — tenant catalog-default pricing', () => {
    it('should resolve the tenant catalog default exactly once per request and reuse the exact ID for duplicates and multi-item carts', async () => {
      mockClient.product.findMany.mockResolvedValue([
        makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
        makeDbProduct({
          id: 'prod-2',
          name: 'Pedigree',
          priceLists: [{ priceCents: 50000 }],
        }),
      ]);

      const result = await useCase.execute({
        items: [
          { productId: 'prod-1', quantity: 2 },
          { productId: 'prod-1', quantity: 1 },
          { productId: 'prod-2', quantity: 3 },
        ],
      });

      // Exactly one resolver call per cart validation request
      expect(repo.findTenantCatalogDefaultPriceListId).toHaveBeenCalledTimes(1);
      // One DB read reusing the same resolved ID for every duplicate
      expect(mockClient.product.findMany).toHaveBeenCalledTimes(1);
      expect(result.items[0].unitPriceCents).toBe(100000);
      expect(result.items[0].lineTotalCents).toBe(200000);
      expect(result.items[1].unitPriceCents).toBe(100000);
      expect(result.items[1].lineTotalCents).toBe(100000);
      expect(result.items[2].unitPriceCents).toBe(50000);
      expect(result.items[2].lineTotalCents).toBe(150000);
      expect(result.totalCents).toBe(450000);
      expect(result.valid).toBe(true);
    });

    it('should filter prices by the exact resolved global ID only — never a name, legacy isDefault fallback, or tenant-local shadow list', async () => {
      mockClient.product.findMany.mockResolvedValue([
        makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
        makeDbProduct({
          id: 'prod-2',
          name: 'Pedigree',
          hasVariants: true,
          variants: [
            {
              id: 'var-1',
              name: '1kg',
              quantity: 10,
              minQuantity: 1,
              catalogPublishMode: 'INHERIT',
              variantPrices: [{ priceCents: 90000 }],
            },
          ],
        }),
      ]);

      const result = await useCase.execute({
        items: [
          { productId: 'prod-1', quantity: 1 },
          { productId: 'prod-2', variantId: 'var-1', quantity: 2 },
        ],
      });

      const args = (
        mockClient.product.findMany.mock.calls as Array<
          [
            {
              include: {
                priceLists: { where: Record<string, unknown> };
                variants: {
                  include: {
                    variantPrices: { where: Record<string, unknown> };
                  };
                };
              };
            },
          ]
        >
      )[0][0];
      // Parent rows accept only the exact resolved global price-list ID
      expect(args.include.priceLists.where).toEqual({
        globalPriceListId: 'gpl-default-1',
      });
      // Variant rows accept only the exact resolved global price-list ID
      expect(args.include.variants.include.variantPrices.where).toEqual({
        priceList: { globalPriceListId: 'gpl-default-1' },
      });
      // No legacy global-default fallback and no name-based matching
      const serialized = JSON.stringify(args);
      expect(serialized).not.toContain('isDefault');
      expect(serialized).not.toContain('name');

      expect(result.items[0].unitPriceCents).toBe(100000);
      expect(result.items[1].unitPriceCents).toBe(90000);
      expect(result.items[1].lineTotalCents).toBe(180000);
      expect(result.totalCents).toBe(280000);
    });

    it('should fail closed with the existing price-missing shape when the resolver returns null', async () => {
      repo.findTenantCatalogDefaultPriceListId.mockResolvedValue(null);
      mockClient.product.findMany.mockResolvedValue([
        makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
      ]);

      const result = await useCase.execute({
        items: [{ productId: 'prod-1', quantity: 2 }],
      });

      // No price accepted — even though the DB returned a row
      expect(result.items[0].warnings).toEqual(['PRICE_HIDDEN']);
      expect(result.items[0].priceHidden).toBe(true);
      expect(result.items[0].unitPriceCents).toBeNull();
      expect(result.items[0].lineTotalCents).toBeNull();
      expect(result.totalCents).toBeNull();
      // Existing non-blocking hidden-price semantics are preserved
      expect(result.valid).toBe(true);
      // No price query can leak an unintended list
      const args = (
        mockClient.product.findMany.mock.calls as Array<
          [{ include: { priceLists: { where: Record<string, unknown> } } }]
        >
      )[0][0];
      expect(args.include.priceLists.where).not.toHaveProperty(
        'globalPriceListId',
      );
      expect(args.include.priceLists.where).not.toHaveProperty(
        'globalPriceList',
      );
    });

    it('should fail closed with the existing price-missing shape when the resolver returns undefined', async () => {
      repo.findTenantCatalogDefaultPriceListId.mockResolvedValue(undefined);
      mockClient.product.findMany.mockResolvedValue([makeDbProduct()]);

      const result = await useCase.execute({
        items: [{ productId: 'prod-1', quantity: 1 }],
      });

      expect(result.items[0].warnings).toContain('PRICE_HIDDEN');
      expect(result.items[0].unitPriceCents).toBeNull();
      expect(result.items[0].lineTotalCents).toBeNull();
      expect(result.totalCents).toBeNull();
    });

    it('should fail closed when the resolver method is absent (legacy port implementation)', async () => {
      const legacyRepo = {} as IPublicCatalogRepository;
      const legacyUseCase = new ValidatePublicCartUseCase(
        tenantPrisma as unknown as TenantPrismaService,
        legacyRepo,
      );
      mockClient.product.findMany.mockResolvedValue([makeDbProduct()]);

      const result = await legacyUseCase.execute({
        items: [{ productId: 'prod-1', quantity: 1 }],
      });

      expect(result.items[0].warnings).toContain('PRICE_HIDDEN');
      expect(result.items[0].unitPriceCents).toBeNull();
      expect(result.items[0].lineTotalCents).toBeNull();
      expect(result.totalCents).toBeNull();
    });

    it('should keep WU5d1 publication gates when the default is missing and never disclose blocked metadata', async () => {
      repo.findTenantCatalogDefaultPriceListId.mockResolvedValue(null);
      mockClient.product.findMany.mockResolvedValue([
        makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
        makeDbProduct({ id: 'prod-2', name: 'Grooming', type: 'SERVICE' }),
      ]);

      const result = await useCase.execute({
        items: [
          { productId: 'prod-1', quantity: 1 },
          { productId: 'prod-2', quantity: 1 },
        ],
      });

      // Published row fails closed on price; blocked row stays blocked
      expect(result.items[0].warnings).toEqual(['PRICE_HIDDEN']);
      expect(result.items[0].unitPriceCents).toBeNull();
      expect(result.items[1].warnings).toEqual(['NOT_IN_CATALOG']);
      expect(result.items[1].productName).toBe('');
      expect(result.items[1].image).toBeNull();
      expect(result.items[1].unitPriceCents).toBeNull();
      expect(result.valid).toBe(false);
      expect(result.totalCents).toBeNull();
    });

    it('should keep blocked WU5d1 rows blocked before price acceptance while INHERIT/ON/non-variant rows use the default', async () => {
      mockClient.product.findMany.mockResolvedValue([
        makeDbProduct({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
        makeDbProduct({
          id: 'prod-2',
          name: 'Pedigree INHERIT',
          hasVariants: true,
          variants: [
            {
              id: 'var-inh',
              name: '1kg',
              quantity: 10,
              minQuantity: 1,
              catalogPublishMode: 'INHERIT',
              variantPrices: [{ priceCents: 90000 }],
            },
          ],
        }),
        makeDbProduct({
          id: 'prod-3',
          name: 'Pedigree ON',
          hasVariants: true,
          variants: [
            {
              id: 'var-on',
              name: '2kg',
              quantity: 10,
              minQuantity: 1,
              catalogPublishMode: 'ON',
              variantPrices: [{ priceCents: 80000 }],
            },
          ],
        }),
        makeDbProduct({
          id: 'prod-4',
          name: 'Hidden service',
          type: 'SERVICE',
          hasVariants: true,
          variants: [
            {
              id: 'var-off-parent',
              name: '3kg',
              quantity: 10,
              minQuantity: 1,
              catalogPublishMode: 'ON',
              variantPrices: [{ priceCents: 70000 }],
            },
          ],
        }),
      ]);

      const result = await useCase.execute({
        items: [
          { productId: 'prod-1', quantity: 1 },
          { productId: 'prod-2', variantId: 'var-inh', quantity: 1 },
          { productId: 'prod-3', variantId: 'var-on', quantity: 1 },
          { productId: 'prod-4', variantId: 'var-off-parent', quantity: 1 },
        ],
      });

      expect(result.items[0].unitPriceCents).toBe(100000);
      expect(result.items[1].unitPriceCents).toBe(90000);
      expect(result.items[2].unitPriceCents).toBe(80000);
      // Blocked before any price acceptance — no metadata, no price
      expect(result.items[3].warnings).toEqual(['NOT_IN_CATALOG']);
      expect(result.items[3].productName).toBe('');
      expect(result.items[3].unitPriceCents).toBeNull();
      expect(result.totalCents).toBe(270000);
      expect(result.valid).toBe(false);
      expect(repo.findTenantCatalogDefaultPriceListId).toHaveBeenCalledTimes(1);
    });
  });
});
