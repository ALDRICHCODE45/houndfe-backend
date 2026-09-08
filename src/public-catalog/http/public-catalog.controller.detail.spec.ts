import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import type { IPublicCatalogRepository } from '../application/ports/public-catalog.repository';
import type { ProductDetailWithIncludes } from '../application/mappers/public-product.mapper';
import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request, { type Response } from 'supertest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ClsService } from 'nestjs-cls';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import { CACHE_CONTROL_KEY } from './interceptors/cache-control.interceptor';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import { PUBLIC_CATALOG_REPOSITORY } from '../application/ports/public-catalog.repository';
import { PriceContextNotAvailableError } from '../domain/errors/price-context-not-available.error';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import type { ResolvedPublicCatalogContext } from '../application/ports/public-catalog.repository';
import { PublicPriceContextQueryDto } from './request-dto/public-price-context-query.dto';

function makeDetailProduct(
  overrides: Partial<ProductDetailWithIncludes> = {},
): ProductDetailWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin 13.6kg',
    description: 'Dog food',
    hasVariants: true,
    useStock: true,
    quantity: 0,
    minQuantity: 0,
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
        name: 'Grande',
        option: 'Talla',
        value: 'G',
        quantity: 10,
        minQuantity: 2,
        images: [{ url: 'https://cdn.example.com/var1.jpg' }],
        variantPrices: [{ priceCents: 130000 }],
      },
    ],
    ...overrides,
  };
}

describe('GetPublicProductDetailUseCase', () => {
  let useCase: GetPublicProductDetailUseCase;
  let repo: {
    findProductById: jest.Mock;
    findTenantCatalogDefaultPriceListId: jest.Mock;
  };
  const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };

  beforeEach(() => {
    repo = {
      findProductById: jest.fn(),
      findTenantCatalogDefaultPriceListId: jest
        .fn()
        .mockResolvedValue('gpl-default-1'),
    };
    useCase = new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('should return product detail with variants', async () => {
    repo.findProductById.mockResolvedValue(makeDetailProduct());

    const result = await useCase.execute('prod-1', tenant);

    expect(result.id).toBe('prod-1');
    expect(result.name).toBe('Royal Canin 13.6kg');
    expect(result.variants).toHaveLength(1);
    expect(result.rating).toBeNull();
    expect(result.featuredLabel).toBeNull();
  });

  it('should map single-entry availabilityByBranch with isSelected=true', async () => {
    repo.findProductById.mockResolvedValue(makeDetailProduct());

    const result = await useCase.execute('prod-1', tenant);

    expect(result.variants[0].availabilityByBranch).toHaveLength(1);
    expect(result.variants[0].availabilityByBranch[0]).toEqual({
      branchId: 'tenant-1',
      branchName: 'Sucursal Centro',
      branchSlug: 'centro',
      availability: 'available',
      isSelected: true,
    });
  });

  it('should throw 404 when product is not found', async () => {
    repo.findProductById.mockResolvedValue(null);

    await expect(useCase.execute('non-existent', tenant)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should not include raw quantity or cost fields in output', async () => {
    repo.findProductById.mockResolvedValue(makeDetailProduct());

    const result = await useCase.execute('prod-1', tenant);
    const keys = Object.keys(result);

    expect(keys).not.toContain('quantity');
    expect(keys).not.toContain('minQuantity');
    expect(keys).not.toContain('tenantId');
    expect(keys).not.toContain('purchaseNetCostCents');
  });

  it('should hide prices when product is prescription-required', async () => {
    repo.findProductById.mockResolvedValue(
      makeDetailProduct({ requiresPrescription: true }),
    );

    const result = await useCase.execute('prod-1', tenant);

    expect(result.price.hidden).toBe(true);
    expect(result.price.priceCents).toBeNull();
    expect(result.variants[0].price.hidden).toBe(true);
    expect(result.variants[0].price.priceCents).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F2.WU6 Slice 5c — detail HTTP activation. Additive only; every legacy
// case above is preserved unchanged.
// ─────────────────────────────────────────────────────────────────────────

describe('PublicPriceContextQueryDto (F2.WU6 Slice 5c mutation lock)', () => {
  const GPL_ID = '0e2b7c1a-9f3d-4a5b-8c6e-7d1f2a3b4c5d';

  it.each([
    ['accepts a valid optional priceListId UUID', { priceListId: GPL_ID }, 0],
    ['keeps priceListId optional (omitted passes)', {}, 0],
    ['rejects a non-UUID priceListId', { priceListId: 'not-a-uuid' }, 1],
  ])('%s', async (_name, query, expected) => {
    const errors = await validate(
      plainToInstance(PublicPriceContextQueryDto, query),
    );
    expect(errors.filter((e) => e.property === 'priceListId')).toHaveLength(
      expected,
    );
  });
});

describe(
  'PublicCatalogController GET /public/catalog/:tenantSlug/products/:productId ' +
    '(F2.WU6 Slice 5c HTTP activation)',
  () => {
    const TENANT = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
    const PRODUCT_ID = '3f1a2b4c-5d6e-4f70-8a9b-1c2d3e4f5a6b';
    const GPL_EXPLICIT_ID = '0e2b7c1a-9f3d-4a5b-8c6e-7d1f2a3b4c5d';
    const URL = `/public/catalog/centro/products/${PRODUCT_ID}`;
    const DEFAULT_CONTEXT: ResolvedPublicCatalogContext = {
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      globalPriceListId: 'gpl-default-1',
      name: 'Publico',
      isCatalogDefault: true,
      stockPresentationDefaults: {
        catalogStockPresentationDefault: 'SYSTEM_STATUS',
        catalogStockPresentationDefaultCustomQty: null,
      },
    };
    const EXPLICIT_CONTEXT: ResolvedPublicCatalogContext = {
      ...DEFAULT_CONTEXT,
      globalPriceListId: GPL_EXPLICIT_ID,
      name: 'Mayoreo',
      isCatalogDefault: false,
    };
    const HIDDEN_PRICE = { priceCents: null, hidden: true };

    const makeDetailResponse = (
      context: ResolvedPublicCatalogContext,
      overrides: Record<string, unknown> = {},
      hiddenPrices = false,
    ) => ({
      id: PRODUCT_ID,
      name: 'Royal Canin 13.6kg',
      slug: 'royal-canin-13-6kg',
      description: 'Dog food',
      category: { id: 'cat-1', name: 'Alimento Seco' },
      brand: { name: 'Royal Canin' },
      images: [
        { id: 'img-1', url: 'https://cdn.example.com/img1.jpg', isMain: true },
      ],
      price: hiddenPrices
        ? HIDDEN_PRICE
        : { priceCents: 125000, hidden: false },
      availability: 'available',
      hasVariants: true,
      variants: [
        {
          id: 'var-1',
          name: 'Grande',
          option: 'Talla',
          value: 'G',
          image: { url: 'https://cdn.example.com/var1.jpg' },
          price: hiddenPrices
            ? HIDDEN_PRICE
            : { priceCents: 130000, hidden: false },
          availabilityByBranch: [
            {
              branchId: 'tenant-1',
              branchName: 'Sucursal Centro',
              branchSlug: 'centro',
              availability: 'available',
              isSelected: true,
            },
          ],
        },
      ],
      rating: null,
      featuredLabel: null,
      priceContext: {
        priceListId: context.globalPriceListId,
        name: context.name,
        isCatalogDefault: context.isCatalogDefault,
      },
      excludedCount: 0 as const,
      ...overrides,
    });

    /** Typed access to the supertest JSON body (guards no-unsafe rules). */
    const bodyOf = (res: Response): Record<string, unknown> =>
      res.body as Record<string, unknown>;

    let app: INestApplication;
    let getProductDetail: { execute: jest.Mock; executeForContext: jest.Mock };
    let repo: { resolveTenantCatalogContext: jest.Mock };
    let prisma: { tenant: { findFirst: jest.Mock } };

    beforeEach(async () => {
      prisma = { tenant: { findFirst: jest.fn().mockResolvedValue(TENANT) } };
      repo = {
        resolveTenantCatalogContext: jest.fn(
          (slug: string, requestedId?: string) =>
            Promise.resolve(requestedId ? EXPLICIT_CONTEXT : DEFAULT_CONTEXT),
        ),
      };
      getProductDetail = {
        execute: jest.fn(() =>
          makeDetailResponse(DEFAULT_CONTEXT, { id: 'legacy' }),
        ),
        executeForContext: jest.fn(
          (input: { context: ResolvedPublicCatalogContext }) =>
            makeDetailResponse(input.context),
        ),
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          ThrottlerModule.forRoot([
            { name: 'public-browse', ttl: 60_000, limit: 60 },
            { name: 'public-validate', ttl: 60_000, limit: 20 },
          ]),
        ],
        controllers: [PublicCatalogController],
        providers: [
          PublicPriceContextResolver,
          PublicTenantGuard,
          { provide: PUBLIC_CATALOG_REPOSITORY, useValue: repo },
          {
            provide: GetPublicProductDetailUseCase,
            useValue: getProductDetail,
          },
          { provide: ListPublicBranchesUseCase, useValue: {} },
          { provide: ListPublicProductsUseCase, useValue: {} },
          { provide: ValidatePublicCartUseCase, useValue: {} },
          { provide: PrismaService, useValue: prisma },
          { provide: ClsService, useValue: { set: jest.fn() } },
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      // Production-equivalent global pipes/filters (main.ts contract).
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          exceptionFactory: createListingValidationExceptionFactory(),
        }),
      );
      app.useGlobalFilters(new DomainExceptionFilter());
      await app.init();
    });

    afterEach(async () => {
      await app.close();
      jest.restoreAllMocks();
    });

    it('resolves the explicit context once and delegates once with exact passthrough', async () => {
      const resolveSpy = jest.spyOn(
        PublicPriceContextResolver.prototype,
        'resolve',
      );

      const res = await request(app.getHttpServer())
        .get(URL)
        .query({ priceListId: GPL_EXPLICIT_ID })
        .expect(200);

      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith('centro', GPL_EXPLICIT_ID);
      expect(repo.resolveTenantCatalogContext).toHaveBeenCalledTimes(1);
      expect(getProductDetail.executeForContext).toHaveBeenCalledTimes(1);
      expect(getProductDetail.executeForContext).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        tenant: TENANT,
        context: EXPLICIT_CONTEXT,
      });
      expect(getProductDetail.execute).not.toHaveBeenCalled();
      expect(bodyOf(res)).toEqual(makeDetailResponse(EXPLICIT_CONTEXT));
      // priceContext equality is proven by the exact whole-body passthrough.
      expect(bodyOf(res).excludedCount).toBe(0);
    });

    it('resolves the tenant catalog default when priceListId is omitted', async () => {
      const resolveSpy = jest.spyOn(
        PublicPriceContextResolver.prototype,
        'resolve',
      );

      const res = await request(app.getHttpServer()).get(URL).expect(200);

      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith('centro', undefined);
      expect(getProductDetail.executeForContext).toHaveBeenCalledTimes(1);
      expect(getProductDetail.executeForContext).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        tenant: TENANT,
        context: DEFAULT_CONTEXT,
      });
      expect(getProductDetail.execute).not.toHaveBeenCalled();
      expect(bodyOf(res)).toEqual(makeDetailResponse(DEFAULT_CONTEXT));
    });

    it('rejects an invalid priceListId with 400 and zero resolver/detail calls', async () => {
      await request(app.getHttpServer())
        .get(URL)
        .query({ priceListId: 'not-a-uuid' })
        .expect(400);

      expect(repo.resolveTenantCatalogContext).not.toHaveBeenCalled();
      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
    });

    it('rejects a repeated priceListId query value with 400', async () => {
      await request(app.getHttpServer())
        .get(URL)
        .query('priceListId=a&priceListId=b')
        .expect(400);

      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
    });

    it('rejects unknown query parameters with 400 and zero detail calls', async () => {
      await request(app.getHttpServer())
        .get(URL)
        .query({ unknown: 'x' })
        .expect(400);

      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
    });

    it('rejects an invalid product UUID with 400 and zero resolver/detail calls', async () => {
      // Guards run before parameter pipes: the tenant lookup is permitted,
      // but neither the resolver nor the detail use case may fire.
      await request(app.getHttpServer())
        .get('/public/catalog/centro/products/not-a-uuid')
        .expect(400);

      expect(prisma.tenant.findFirst).toHaveBeenCalledTimes(1);
      expect(repo.resolveTenantCatalogContext).not.toHaveBeenCalled();
      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
      expect(getProductDetail.execute).not.toHaveBeenCalled();
    });

    it('keeps generic tenant-guard 404 semantics before any price-context resolution', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer()).get(URL).expect(404);

      expect(repo.resolveTenantCatalogContext).not.toHaveBeenCalled();
      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
      expect(getProductDetail.execute).not.toHaveBeenCalled();
    });

    it('returns the generic 404 miss with zero detail calls when the context is unavailable', async () => {
      repo.resolveTenantCatalogContext.mockResolvedValue(null);

      const res = await request(app.getHttpServer()).get(URL).expect(404);

      expect(bodyOf(res).statusCode).toBe(404);
      expect(bodyOf(res).error).toBe('PRICE_CONTEXT_NOT_AVAILABLE');
      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
      expect(getProductDetail.execute).not.toHaveBeenCalled();
    });

    it('maps PriceContextNotAvailableError to the same generic 404 shape with zero detail calls', async () => {
      repo.resolveTenantCatalogContext.mockRejectedValue(
        new PriceContextNotAvailableError(),
      );

      const res = await request(app.getHttpServer()).get(URL).expect(404);

      expect(bodyOf(res).statusCode).toBe(404);
      expect(bodyOf(res).error).toBe('PRICE_CONTEXT_NOT_AVAILABLE');
      expect(getProductDetail.executeForContext).not.toHaveBeenCalled();
      expect(getProductDetail.execute).not.toHaveBeenCalled();
    });

    it('passes the generic detail 404 through with no legacy fallback', async () => {
      getProductDetail.executeForContext.mockRejectedValue(
        new NotFoundException('Not Found'),
      );

      const res = await request(app.getHttpServer()).get(URL).expect(404);

      expect(bodyOf(res).statusCode).toBe(404);
      expect(getProductDetail.executeForContext).toHaveBeenCalledTimes(1);
      expect(getProductDetail.execute).not.toHaveBeenCalled();
    });

    it('never reconstructs the response: hidden prices pass through as exact nulls', async () => {
      getProductDetail.executeForContext.mockImplementationOnce(
        (input: { context: ResolvedPublicCatalogContext }) =>
          makeDetailResponse(input.context, {}, true),
      );

      const res = await request(app.getHttpServer())
        .get(URL)
        .query({ priceListId: GPL_EXPLICIT_ID })
        .expect(200);

      expect(bodyOf(res).price).toEqual(HIDDEN_PRICE);
      expect(
        (bodyOf(res).variants as Record<string, unknown>[])[0].price,
      ).toEqual(HIDDEN_PRICE);
    });

    it('serves Cache-Control public, max-age=60 on the detail route', async () => {
      const res = await request(app.getHttpServer()).get(URL).expect(200);

      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('keeps PublicTenantGuard/ThrottlerGuard and cache metadata on the route', () => {
      const guards = (Reflect.getMetadata(
        '__guards__',
        PublicCatalogController,
      ) ?? []) as unknown[];

      expect(guards).toContain(PublicTenantGuard);
      expect(guards).toContain(ThrottlerGuard);
      const detailHandler = Reflect.getOwnPropertyDescriptor(
        PublicCatalogController.prototype,
        'getProduct',
      )?.value as unknown as (...args: unknown[]) => unknown;
      expect(Reflect.getMetadata(CACHE_CONTROL_KEY, detailHandler)).toBe(
        'public, max-age=60',
      );
    });
  },
);
