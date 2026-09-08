import {
  toPublicProductCard,
  toPublicProductDetail,
  type ProductWithIncludes,
  type ProductDetailWithIncludes,
} from '../application/mappers/public-product.mapper';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import type {
  IPublicCatalogRepository,
  PublicCartCandidate,
} from '../application/ports/public-catalog.repository';

import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ThrottlerModule } from '@nestjs/throttler';
import * as throttleConsts from '@nestjs/throttler/dist/throttler.constants';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicCatalogModule } from '../public-catalog.module';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import { PrismaPublicCatalogRepository } from '../infrastructure/prisma-public-catalog.repository';
import { Product } from '../../products/domain/product.entity';
import { ProductsService } from '../../products/products.service';
import * as cacheControl from './interceptors/cache-control.interceptor';

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

  // F2.WU7 Slice 4 — the activated contextual cart response must expose
  // ONLY whitelisted public fields (no raw stock/cost fields, no client
  // pricing), with the authoritative context and values passing through.
  it('contextual cart responses expose ONLY whitelisted public fields', async () => {
    const candidate: PublicCartCandidate = {
      id: 'prod-1',
      name: 'Royal Canin',
      type: 'PRODUCT',
      includeInOnlineCatalog: true,
      hasVariants: false,
      useStock: true,
      quantity: 50,
      minQuantity: 5,
      hidePriceInOnlineCatalog: false,
      requiresPrescription: false,
      images: [{ url: 'https://cdn.example.com/img.jpg' }],
      catalogPriceLists: [],
      priceLists: [{ priceCents: 100000 }],
      variants: [],
    };
    const useCase = new ValidatePublicCartUseCase({
      findPublicCartCandidates: () => Promise.resolve([candidate]),
    } as unknown as IPublicCatalogRepository);

    const context = {
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      globalPriceListId: 'gpl-1',
      name: 'Publico',
      isCatalogDefault: true,
      stockPresentationDefaults: {
        catalogStockPresentationDefault: 'SYSTEM_STATUS',
        catalogStockPresentationDefaultCustomQty: null,
      },
    };
    const result = await useCase.executeForContext({
      tenant: { id: 'tenant-1', slug: 'centro' },
      context,
      items: [{ productId: 'prod-1', quantity: 2 }],
    });

    expect(Object.keys(result).sort()).toEqual([
      'items',
      'priceContext',
      'totalCents',
      'valid',
      'warnings',
    ]);
    // prettier-ignore — compact key layout for the whitelisted item shape.
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'availability',
      'blockingCodes',
      'image',
      'lineTotalCents',
      'priceHidden',
      'productId',
      'productName',
      'quantity',
      'status',
      'unitPriceCents',
      'variantId',
      'variantName',
      'warnings',
    ]);
    expect(result.priceContext).toEqual({
      priceListId: context.globalPriceListId,
      name: context.name,
      isCatalogDefault: context.isCatalogDefault,
    });
    expect(result.items[0].unitPriceCents).toBe(100000);
    expect(result.items[0].lineTotalCents).toBe(200000);
  });
});

// F2.WU8 Slice 2 — executable guide-contract evidence. Documented shapes in
// docs/backend-responses/public-online-catalog-frontend-guide.md are bound to
// real entity/service/use-case/controller output; fixtures stage inputs only.
describe('F2.WU8 Slice 2 — documented guide contract evidence', () => {
  const guideTenant = { id: 'tenant-1', slug: 'centro', name: 'Centro' };
  const guideContext = (isCatalogDefault = true) => ({
    tenantId: guideTenant.id,
    tenantSlug: guideTenant.slug,
    globalPriceListId: 'gpl-1',
    name: 'Lista pública',
    isCatalogDefault,
    stockPresentationDefaults: {
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
    },
  });
  const priceCtx = (isCatalogDefault: boolean) => ({
    priceListId: 'gpl-1',
    name: 'Lista pública',
    isCatalogDefault,
  });
  const metaOf = (key: string | symbol, target: object): unknown =>
    Reflect.getMetadata(key, target);
  const handlerOf = (method: string): object => {
    const descriptor = Object.getOwnPropertyDescriptor(
      PublicCatalogController.prototype,
      method,
    );
    expect(descriptor?.value).toBeDefined();
    return descriptor?.value as object;
  };
  const CACHE_KEY = cacheControl.CACHE_CONTROL_KEY;
  const guideProduct = (): ProductWithIncludes => ({
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
  });
  const cartCandidate = (): PublicCartCandidate => ({
    ...guideProduct(),
    id: 'prod-1',
    name: 'Royal Canin',
    type: 'PRODUCT',
    includeInOnlineCatalog: true,
    catalogPriceLists: [],
    priceLists: [{ priceCents: 100000 }],
    variants: [],
  });
  const cartUseCase = (candidates: PublicCartCandidate[]) =>
    new ValidatePublicCartUseCase({
      findPublicCartCandidates: () => Promise.resolve(candidates),
    } as unknown as IPublicCatalogRepository);

  it('list binds priceContext, aggregate excludedCount, and the guide shape', async () => {
    const result = await new ListPublicProductsUseCase({
      listPublicProducts: () =>
        Promise.resolve({
          items: [guideProduct()],
          total: 2,
          excludedCount: 3,
          categories: [{ id: 'cat-1', name: 'Alimento', count: 2 }],
        }),
    } as unknown as IPublicCatalogRepository).executeForContext({
      tenant: guideTenant,
      context: guideContext(false),
      filters: { sort: 'newest', page: 1, limit: 20 },
    });
    expect(Object.keys(result).sort().join()).toBe(
      'excludedCount,facets,items,meta,priceContext',
    );
    expect(result.priceContext).toEqual(priceCtx(false));
    expect(result.excludedCount).toBe(3);
  });
  // F3.WU9 slice 9 — contextual list cards expose ONLY the legacy card keys
  // plus `stockPresentation` (with mirrored nullable `availability`); no
  // operational stock or persisted-override keys.
  it('contextual list cards expose stockPresentation with no operational or override leakage', async () => {
    const result = await new ListPublicProductsUseCase({
      listPublicProducts: () =>
        Promise.resolve({
          items: [
            {
              ...guideProduct(),
              onlineStockPresentation: 'CUSTOM_QUANTITY',
              onlineStockPresentationCustomQty: 3,
              stockPresentationParticipants: [],
            },
          ],
          total: 1,
          excludedCount: 0,
          categories: [],
        }),
    } as unknown as IPublicCatalogRepository).executeForContext({
      tenant: guideTenant,
      context: {
        ...guideContext(false),
        stockPresentationDefaults: {
          catalogStockPresentationDefault: 'CUSTOM_QUANTITY' as const,
          catalogStockPresentationDefaultCustomQty: null,
        },
      },
      filters: { sort: 'newest', page: 1, limit: 20 },
    });
    expect(Object.keys(result.items[0]).sort().join()).toBe(
      'availability,brand,category,description,featuredLabel,hasVariants,id,image,name,price,rating,slug,stockPresentation',
    );
    expect(result.items[0].stockPresentation).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: null,
      customQuantity: 3,
    });
    expect(result.items[0].availability).toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('"quantity"');
    expect(serialized).not.toContain('"minQuantity"');
    expect(serialized).not.toContain('stockPresentationParticipants');
    expect(serialized).not.toContain('onlineStockPresentation');
  });

  it('detail carries excludedCount, priceContext, contextual stock presentation, and no variant image fallback', async () => {
    const projection: ProductDetailWithIncludes & {
      stockPresentationParticipants: Array<{
        quantity: number;
        minQuantity: number;
      }>;
    } = {
      ...guideProduct(),
      hasVariants: true,
      images: [
        { id: 'img-1', url: 'https://cdn.example.com/main.jpg', isMain: true },
      ],
      stockPresentationParticipants: [{ quantity: 5, minQuantity: 1 }],
      variants: [
        {
          id: 'var-1',
          name: 'Grande',
          option: null,
          value: null,
          quantity: 5,
          minQuantity: 1,
          images: [],
          variantPrices: [{ priceCents: 109900 }],
        },
      ],
    };
    const result = await new GetPublicProductDetailUseCase({
      getPublicProductDetail: () => Promise.resolve(projection),
    } as unknown as IPublicCatalogRepository).executeForContext({
      productId: 'prod-snap-1',
      tenant: guideTenant,
      context: guideContext(),
    });
    expect(Object.keys(result).sort().join()).toBe(
      'availability,brand,category,description,excludedCount,featuredLabel,hasVariants,id,images,name,price,priceContext,rating,slug,stockPresentation,variants',
    );
    expect(result.excludedCount).toBe(0);
    expect(result.priceContext).toEqual(priceCtx(true));
    expect(result.images).toEqual(projection.images);
    expect(result.variants[0].image).toBeNull();
    expect(result.stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'available',
      customQuantity: null,
    });
    expect(result.variants[0].stockPresentation).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'available',
      customQuantity: null,
    });
  });
  it('cart validate maps POST (default 201) with no HttpCode override', () => {
    const cart = handlerOf('validateCartEndpoint');
    expect(metaOf(METHOD_METADATA, cart)).toBe(RequestMethod.POST);
    expect(metaOf(HTTP_CODE_METADATA, cart)).toBeUndefined();
  });

  it.each(['hidePriceInOnlineCatalog', 'requiresPrescription'] as const)(
    '%s keeps the item valid with null prices and a null total',
    async (flag) => {
      const candidate = {
        ...cartCandidate(),
        [flag]: true,
      } as PublicCartCandidate;
      const result = await cartUseCase([candidate]).executeForContext({
        tenant: guideTenant,
        context: guideContext(),
        items: [{ productId: 'prod-1', quantity: 2 }],
      });
      expect(result.valid).toBe(true);
      expect(result.totalCents).toBeNull();
      expect(result.warnings).toEqual(['PRICE_HIDDEN']);
      expect(result.items[0].priceHidden).toBe(true);
      expect(result.items[0].unitPriceCents).toBeNull();
      expect(result.items[0].lineTotalCents).toBeNull();
    },
  );

  it('cart items carry status/blockingCodes, redaction, and the queried main image', async () => {
    const findMany = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_query: unknown) =>
        Promise.resolve([
          {
            ...cartCandidate(),
            variants: [
              {
                id: 'var-1',
                name: '13.6 kg',
                catalogPublishMode: 'ON',
                quantity: 5,
                minQuantity: 1,
                variantPrices: [{ priceCents: 109900 }],
              },
            ],
          },
        ]),
    );
    const result = await new ValidatePublicCartUseCase(
      new PrismaPublicCatalogRepository(
        {} as never,
        {
          getClient: () => ({ product: { findMany } }),
          getTenantId: () => guideTenant.id,
        } as never,
      ),
    ).executeForContext({
      tenant: guideTenant,
      context: guideContext(),
      items: [
        { productId: 'prod-1', variantId: 'var-1', quantity: 1 },
        { productId: 'prod-missing', quantity: 1 },
      ],
    });
    const query = findMany.mock.calls[0][0] as {
      select: { images: unknown };
    };
    expect(query.select.images).toEqual({
      where: { isMain: true, variantId: null },
      take: 1,
      select: { url: true },
    });
    expect(result.items.map((item) => item.status)).toEqual([
      'VALID',
      'BLOCKED',
    ]);
    expect(result.items[1].blockingCodes).toEqual(['NOT_IN_CATALOG']);
    expect(result.items[1].productName).toBeNull();
    expect(result.items[1].image).toBeNull();
    expect(result.items[0].image).toEqual({
      url: 'https://cdn.example.com/snap.jpg',
    });
    expect(result.items[0].unitPriceCents).toBe(109900);
  });

  it('controller forwards explicit vs omitted priceListId via the real resolver', async () => {
    // Real resolver: omission reaches the repository as undefined.
    const resolveTenantCatalogContext = jest.fn(
      (_slug: string, requested?: string) =>
        Promise.resolve({
          tenantId: guideTenant.id,
          tenantSlug: guideTenant.slug,
          globalPriceListId: requested ?? 'gpl-default',
          name: 'Contexto',
          isCatalogDefault: !requested,
          stockPresentationDefaults: {
            catalogStockPresentationDefault: 'SYSTEM_STATUS',
            catalogStockPresentationDefaultCustomQty: null,
          },
        }),
    );
    const listProducts = { executeForContext: jest.fn() };
    const getProductDetail = { executeForContext: jest.fn() };
    const validateCart = { executeForContext: jest.fn() };
    const controller = new PublicCatalogController(
      {} as never,
      listProducts as never,
      getProductDetail as never,
      validateCart as never,
      new PublicPriceContextResolver({
        resolveTenantCatalogContext,
      } as unknown as IPublicCatalogRepository),
    );
    const contextOf = (mock: jest.Mock, call: number): string =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      mock.mock.calls[call][0].context.globalPriceListId;
    await controller.getProducts('centro', guideTenant, {
      priceListId: 'gpl-explicit',
    } as never);
    await controller.getProducts('centro', guideTenant, {} as never);
    await controller.getProduct('prod-1', 'centro', guideTenant, {} as never);
    await controller.validateCartEndpoint('centro', guideTenant, {
      items: [{ productId: 'prod-1', quantity: 1 }],
      priceListId: 'gpl-explicit',
    } as never);
    expect(resolveTenantCatalogContext.mock.calls).toEqual([
      ['centro', 'gpl-explicit'],
      ['centro', undefined],
      ['centro', undefined],
      ['centro', 'gpl-explicit'],
    ]);
    expect(contextOf(listProducts.executeForContext, 0)).toBe('gpl-explicit');
    expect(contextOf(listProducts.executeForContext, 1)).toBe('gpl-default');
    expect(contextOf(getProductDetail.executeForContext, 0)).toBe(
      'gpl-default',
    );
    expect(contextOf(validateCart.executeForContext, 0)).toBe('gpl-explicit');
  });

  it('cache-control binds per handler and is emitted by the attached interceptor', () => {
    expect(
      Reflect.getMetadata('__interceptors__', PublicCatalogController),
    ).toContain(cacheControl.CacheControlInterceptor);
    for (const [method, expected] of [
      ['getBranches', 'public, max-age=300'],
      ['getProducts', 'public, max-age=60'],
      ['getProduct', 'public, max-age=60'],
      ['validateCartEndpoint', 'no-store'],
    ] as const) {
      expect(metaOf(CACHE_KEY, handlerOf(method))).toBe(expected);
    }
    const setHeader = jest.fn();
    new cacheControl.CacheControlInterceptor({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      get: (key: string, handler: object) => Reflect.getMetadata(key, handler),
    } as never).intercept(
      {
        getHandler: () => handlerOf('getProducts'),
        switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
      } as never,
      { handle: () => undefined } as never,
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=60',
    );
  });
  it('throttle tiers bind browse 60/60_000ms and cart validate 20/60_000ms', () => {
    // Module tier registration; per-handler effects: throttler-scope.spec.
    const tiers = (
      metaOf('imports', PublicCatalogModule) as Array<{
        module?: unknown;
        providers?: Array<{ provide?: unknown; useValue?: unknown }>;
      }>
    )
      .find((entry) => entry.module === ThrottlerModule)
      ?.providers?.find(
        (provider) => provider.provide === throttleConsts.THROTTLER_OPTIONS,
      )?.useValue;
    expect(tiers).toEqual([
      { name: 'public-browse', ttl: 60_000, limit: 60 },
      { name: 'public-validate', ttl: 60_000, limit: 20 },
    ]);
  });

  it('authenticated product/variant reads carry the documented catalog fields', async () => {
    const persisted = {
      id: 'prod-admin-1',
      name: 'Admin Product',
      ivaRate: '0',
      iepsRate: '0',
      purchaseCostMode: 'NET',
      purchaseNetCostCents: 10000,
      purchaseGrossCostCents: 10000,
      useStock: true,
      hasVariants: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      includeInOnlineCatalog: true,
      hidePriceInOnlineCatalog: true,
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 4,
      supportedCatalogPriceListIds: ['00000000-0000-4000-8000-00000000000a'],
    } as unknown as Parameters<typeof Product.fromPersistence>[0];
    const product = Product.fromPersistence(persisted);
    expect(product.toResponse()).toMatchObject({
      includeInOnlineCatalog: true,
      hidePriceInOnlineCatalog: true,
      supportsAllCatalogPriceLists: false,
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 4,
    });
    // Real output: ProductsService.getVariants binds the variant tri-state.
    const variants = await new ProductsService(
      { findById: () => Promise.resolve(product) } as never,
      {} as never,
      {} as never,
      {
        getClient: () => ({
          variant: {
            findMany: () =>
              Promise.resolve([
                {
                  id: 'var-admin-1',
                  name: '13.6 kg',
                  variantPrices: [],
                  catalogPublishMode: 'ON',
                  onlineStockPresentation: 'ABSTRACT_STATUS',
                  onlineStockPresentationCustomQty: null,
                },
              ]),
          },
        }),
        getTenantId: () => guideTenant.id,
      } as never,
      {} as never,
    ).getVariants('prod-admin-1');
    expect(variants[0]).toMatchObject({
      catalogPublishMode: 'ON',
      onlineStockPresentation: 'ABSTRACT_STATUS',
      onlineStockPresentationCustomQty: null,
    });
  });
});
