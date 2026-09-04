import { NotFoundException } from '@nestjs/common';
import { GetPublicProductDetailUseCase } from './get-public-product-detail.use-case';
import type { IPublicCatalogRepository } from '../ports/public-catalog.repository';
import type { ResolvedPublicCatalogContext } from '../ports/public-catalog.repository';
import type { ProductDetailWithIncludes } from '../mappers/public-product.mapper';
import type { PublicCatalogProductDetail } from '../dto/public-product-detail.dto';
import type {
  PublicCatalogProductDetailWithContextDto,
  PublicPriceContextDto,
} from '../dto/public-price-context.dto';

function makeDetail(
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
    variants: [
      {
        id: 'var-1',
        name: '13.6kg',
        option: 'weight',
        value: '13.6',
        quantity: 10,
        minQuantity: 2,
        images: [{ url: 'https://cdn.example.com/img1.jpg' }],
        variantPrices: [{ priceCents: 125000 }],
      },
    ],
    ...overrides,
  };
}

const tenant = { id: 'tenant-1', slug: 'petshop', name: 'Petshop' };

describe('GetPublicProductDetailUseCase', () => {
  let mockFindProductById: jest.Mock;
  let mockResolveDefault: jest.Mock;
  let useCase: GetPublicProductDetailUseCase;

  beforeEach(() => {
    mockFindProductById = jest.fn().mockResolvedValue(null);
    mockResolveDefault = jest.fn().mockResolvedValue(null);
    const repo = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findCategoryFacets: jest.fn().mockResolvedValue([]),
      findProductById: mockFindProductById,
      findTenantCatalogDefaultPriceListId: mockResolveDefault,
    };
    useCase = new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('resolves the tenant catalog default exactly once and threads the exact global price-list ID into findProductById', async () => {
    mockResolveDefault.mockResolvedValue('gpl-default-1');
    mockFindProductById.mockResolvedValue(makeDetail());

    const result = await useCase.execute('prod-1', tenant);

    expect(mockResolveDefault).toHaveBeenCalledTimes(1);
    expect(mockFindProductById).toHaveBeenCalledTimes(1);
    expect(mockFindProductById).toHaveBeenCalledWith('prod-1', 'gpl-default-1');
    expect(result).toMatchObject({
      id: 'prod-1',
      name: 'Royal Canin 13.6kg',
      price: { priceCents: 125000, hidden: false },
      variants: [
        expect.objectContaining({
          id: 'var-1',
          price: { priceCents: 125000, hidden: false },
        }),
      ],
    });
  });

  it.each([
    ['explicit null', null],
    ['undefined resolver result', undefined],
  ])(
    'fails closed when the resolver returns %s: throws NotFoundException without performing the product read',
    async (_label, resolverResult) => {
      mockResolveDefault.mockResolvedValue(resolverResult);

      await expect(useCase.execute('prod-1', tenant)).rejects.toThrow(
        new NotFoundException('Not Found'),
      );
      expect(mockResolveDefault).toHaveBeenCalledTimes(1);
      expect(mockFindProductById).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the repository does not implement the optional resolver', async () => {
    const repo: Record<string, unknown> = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findCategoryFacets: jest.fn().mockResolvedValue([]),
      findProductById: mockFindProductById,
      findTenantCatalogDefaultPriceListId: mockResolveDefault,
    };
    delete repo.findTenantCatalogDefaultPriceListId;
    const withoutResolver = new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );

    await expect(withoutResolver.execute('prod-1', tenant)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(mockFindProductById).not.toHaveBeenCalled();
  });

  it('keeps the existing not-found behavior when the product is missing despite a resolved default', async () => {
    mockResolveDefault.mockResolvedValue('gpl-default-1');

    await expect(useCase.execute('missing-1', tenant)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(mockFindProductById).toHaveBeenCalledWith(
      'missing-1',
      'gpl-default-1',
    );
  });
});

describe('GetPublicProductDetailUseCase.executeForContext (F2.WU6 slice 4b — dormant seam)', () => {
  const context: ResolvedPublicCatalogContext = {
    tenantId: 'tenant-1',
    tenantSlug: 'petshop',
    globalPriceListId: 'gpl-sel-1',
    name: 'Spring Catalog',
    isCatalogDefault: false,
  };

  const detailInput = { productId: 'prod-1', tenant, context };

  /** Visible projection with exact selected prices (2500 product / 2600 variant). */
  const priced = (
    overrides: Partial<ProductDetailWithIncludes> = {},
  ): ProductDetailWithIncludes =>
    makeDetail({
      priceLists: [{ priceCents: 2500 }],
      variants: [
        {
          ...makeDetail().variants[0],
          variantPrices: [{ priceCents: 2600 }],
        },
      ],
      ...overrides,
    });

  let seam: jest.Mock;
  let legacyRead: jest.Mock;
  let resolveDefault: jest.Mock;
  let resolveContext: jest.Mock;
  let useCase: GetPublicProductDetailUseCase;

  const makeUseCase = (withSeam = true) => {
    seam = jest.fn().mockResolvedValue(null);
    legacyRead = jest.fn().mockResolvedValue(null);
    resolveDefault = jest.fn().mockResolvedValue(null);
    resolveContext = jest.fn().mockResolvedValue(null);
    const repo: Record<string, unknown> = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findCategoryFacets: jest.fn().mockResolvedValue([]),
      findProductById: legacyRead,
      findTenantCatalogDefaultPriceListId: resolveDefault,
      resolveTenantCatalogContext: resolveContext,
      getPublicProductDetail: seam,
    };
    if (!withSeam) delete repo.getPublicProductDetail;
    return new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  };

  beforeEach(() => {
    useCase = makeUseCase();
  });

  it('maps the exact repository projection once with the exact seam args and appends exact public metadata with excludedCount zero', async () => {
    seam.mockResolvedValue(priced());

    const result = await useCase.executeForContext(detailInput);

    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      productId: 'prod-1',
      context,
    });
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
      'priceContext',
      'excludedCount',
    ]);
    expect(result).toMatchObject({
      id: 'prod-1',
      price: { priceCents: 2500, hidden: false },
      variants: [
        expect.objectContaining({
          id: 'var-1',
          price: { priceCents: 2600, hidden: false },
        }),
      ],
    });
    expect(result.priceContext).toEqual({
      priceListId: 'gpl-sel-1',
      name: 'Spring Catalog',
      isCatalogDefault: false,
    });
    expect(result.excludedCount).toBe(0);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(resolveDefault).not.toHaveBeenCalled();
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it('throws the generic NotFoundException when the seam returns null and never falls back to the legacy product read', async () => {
    // Legacy booby trap: a valid alternate-price projection the contextual
    // method must never reach, even though the default-list path would
    // happily resolve it.
    legacyRead.mockResolvedValue(
      makeDetail({ priceLists: [{ priceCents: 9999 }] }),
    );
    resolveDefault.mockResolvedValue('gpl-default-1');

    await expect(useCase.executeForContext(detailInput)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(seam).toHaveBeenCalledTimes(1);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it('throws the generic NotFoundException when the optional seam is absent — no optional-chain into undefined and no fallback', async () => {
    const withoutSeam = makeUseCase(false);

    await expect(withoutSeam.executeForContext(detailInput)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(legacyRead).not.toHaveBeenCalled();
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it.each([
    [
      'tenant ID mismatch',
      { id: 'tenant-2', slug: 'petshop', name: 'Petshop' },
    ],
    [
      'tenant slug mismatch',
      { id: 'tenant-1', slug: 'other', name: 'Petshop' },
    ],
  ])(
    'fails closed before any repository access on %s',
    async (_label, mismatchedTenant) => {
      await expect(
        useCase.executeForContext({ ...detailInput, tenant: mismatchedTenant }),
      ).rejects.toThrow(new NotFoundException('Not Found'));
      expect(seam).not.toHaveBeenCalled();
      expect(legacyRead).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['hidden product', { hidePriceInOnlineCatalog: true }],
    ['prescription product', { requiresPrescription: true }],
  ])(
    'redacts %s numeric prices even when the repository projection injects product and variant prices',
    async (_label, flag) => {
      seam.mockResolvedValue(priced(flag));

      const result = await useCase.executeForContext(detailInput);

      expect(result.price).toEqual({ priceCents: null, hidden: true });
      expect(result.variants[0].price).toEqual({
        priceCents: null,
        hidden: true,
      });
    },
  );

  it('keeps INHERIT and ON variants with distinct mapped values and omits the OFF variant entirely', async () => {
    const variant = (id: string, mode: string, priceCents: number) => ({
      ...makeDetail().variants[0],
      id,
      catalogPublishMode: mode,
      variantPrices: [{ priceCents }],
    });
    seam.mockResolvedValue(
      priced({
        hasVariants: true,
        variants: [
          variant('var-inherit', 'INHERIT', 2600),
          variant('var-on', 'ON', 2700),
          {
            ...variant('var-off', 'OFF', 9999),
            images: [{ url: 'https://cdn.example.com/off-image.jpg' }],
          },
        ],
      }),
    );

    const result = await useCase.executeForContext(detailInput);

    expect(result.variants.map((v) => v.id)).toEqual(['var-inherit', 'var-on']);
    expect(result.variants[0].price).toEqual({
      priceCents: 2600,
      hidden: false,
    });
    expect(result.variants[1].price).toEqual({
      priceCents: 2700,
      hidden: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('var-off');
    expect(serialized).not.toContain('off-image');
    expect(serialized).not.toContain('9999');
  });

  it('exposes exactly the three public metadata keys — no tenant ID, slug, or globalPriceListId key leak', async () => {
    seam.mockResolvedValue(makeDetail());

    const result = await useCase.executeForContext(detailInput);

    expect(Object.keys(result.priceContext)).toEqual([
      'priceListId',
      'name',
      'isCatalogDefault',
    ]);
    const serialized = JSON.stringify(result.priceContext);
    expect(serialized).not.toContain('tenant-1');
    expect(serialized).not.toContain('petshop');
    expect(serialized).not.toContain('"globalPriceListId"');
  });

  it('keeps the active execute path on the default-list resolver + findProductById with the exact legacy F1 detail key set even when both seams exist', async () => {
    resolveDefault.mockResolvedValue('gpl-default-1');
    legacyRead.mockResolvedValue(makeDetail());

    const result = await useCase.execute('prod-1', tenant);

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(legacyRead).toHaveBeenCalledTimes(1);
    expect(seam).not.toHaveBeenCalled();
    expect(resolveContext).not.toHaveBeenCalled();
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
    expect(result).not.toHaveProperty('priceContext');
    expect(result).not.toHaveProperty('excludedCount');
  });
});

/**
 * Compile-time contract probe (type-level only): the dormant seam must
 * return a FLAT extension of the existing product body — assignable to
 * `PublicCatalogProductDetail & { priceContext; excludedCount: 0 }` — and
 * must reject both a nested envelope and a broad `number` excludedCount.
 */
type FlatDetailResponse = PublicCatalogProductDetail & {
  priceContext: PublicPriceContextDto;
  excludedCount: 0;
};

type ReturnedForContext = Awaited<
  ReturnType<GetPublicProductDetailUseCase['executeForContext']>
>;

// Positive: the seam's returned type satisfies the canonical flat contract.
type ReturnedIsFlat = ReturnedForContext extends FlatDetailResponse
  ? true
  : false;
const _returnedIsFlat: ReturnedIsFlat = true;
void _returnedIsFlat;

// Negative: a nested `{ detail, ... }` envelope must not typecheck.
const _rejectsNestedEnvelope: PublicCatalogProductDetailWithContextDto = {
  // @ts-expect-error — the response must be flat, never an enveloped wrapper
  detail: null as unknown as PublicCatalogProductDetail,
  priceContext: null as unknown as PublicPriceContextDto,
  excludedCount: 0,
};
void _rejectsNestedEnvelope;

// Negative: a broad `number` excludedCount must not satisfy literal `0`.
// @ts-expect-error — excludedCount is literal 0, never a broad number
const _rejectsBroadNumber: PublicCatalogProductDetailWithContextDto['excludedCount'] = 1;
void _rejectsBroadNumber;
