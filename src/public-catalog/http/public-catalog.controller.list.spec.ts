import {
  ListPublicProductsUseCase,
  type ListProductsInput,
} from '../application/use-cases/list-public-products.use-case';
import type { IPublicCatalogRepository } from '../application/ports/public-catalog.repository';
import type { ProductWithIncludes } from '../application/mappers/public-product.mapper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request, { type Response } from 'supertest';
import { validate, type ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ClsService } from 'nestjs-cls';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import { CACHE_CONTROL_KEY } from './interceptors/cache-control.interceptor';
import { ListProductsQueryDto } from './request-dto/list-products-query.dto';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import { PUBLIC_CATALOG_REPOSITORY } from '../application/ports/public-catalog.repository';
import { PriceContextNotAvailableError } from '../domain/errors/price-context-not-available.error';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import type { ResolvedPublicCatalogContext } from '../application/ports/public-catalog.repository';

function makeProduct(
  id: string,
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id,
    name: `Product ${id}`,
    description: null,
    hasVariants: false,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento' },
    brand: { name: 'Brand' },
    images: [{ url: 'https://cdn.example.com/img.jpg' }],
    priceLists: [{ priceCents: 100000 }],
    variants: [],
    ...overrides,
  };
}

describe('ListPublicProductsUseCase', () => {
  let useCase: ListPublicProductsUseCase;
  let repo: {
    findTenantCatalogDefaultPriceListId: jest.Mock;
    findProducts: jest.Mock;
    findCategoryFacets: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      findTenantCatalogDefaultPriceListId: jest
        .fn()
        .mockResolvedValue('gpl-default-1'),
      findProducts: jest.fn(),
      findCategoryFacets: jest.fn(),
    };
    useCase = new ListPublicProductsUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  const defaultInput: ListProductsInput = {
    sort: 'newest',
    page: 1,
    limit: 20,
  };

  it('should return paginated products with meta and facets', async () => {
    repo.findProducts.mockResolvedValue({
      items: [makeProduct('p1'), makeProduct('p2')],
      total: 42,
    });
    repo.findCategoryFacets.mockResolvedValue([
      { id: 'cat-1', name: 'Alimento', count: 30 },
    ]);

    const result = await useCase.execute(defaultInput);

    expect(result.items).toHaveLength(2);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 42,
      totalPages: 3,
    });
    expect(result.facets.categories).toHaveLength(1);
  });

  it('should pass filter params to repository', async () => {
    repo.findProducts.mockResolvedValue({ items: [], total: 0 });
    repo.findCategoryFacets.mockResolvedValue([]);

    await useCase.execute({
      q: 'royal',
      categoryId: 'cat-uuid',
      sort: 'price_asc',
      page: 2,
      limit: 10,
    });

    expect(repo.findProducts).toHaveBeenCalledWith({
      q: 'royal',
      categoryId: 'cat-uuid',
      sort: 'price_asc',
      page: 2,
      limit: 10,
      globalPriceListId: 'gpl-default-1',
    });
  });

  it('should return empty items and valid meta when no matches', async () => {
    repo.findProducts.mockResolvedValue({ items: [], total: 0 });
    repo.findCategoryFacets.mockResolvedValue([]);

    const result = await useCase.execute(defaultInput);

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.totalPages).toBe(0);
  });

  it('should map products through whitelist mapper (no raw fields)', async () => {
    repo.findProducts.mockResolvedValue({
      items: [makeProduct('p1')],
      total: 1,
    });
    repo.findCategoryFacets.mockResolvedValue([]);

    const result = await useCase.execute(defaultInput);
    const item = result.items[0];

    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('price');
    expect(item).toHaveProperty('availability');
    expect(item).not.toHaveProperty('quantity');
    expect(item).not.toHaveProperty('minQuantity');
    expect(item).not.toHaveProperty('tenantId');
    expect(item.rating).toBeNull();
    expect(item.featuredLabel).toBeNull();
  });

  it('should calculate totalPages correctly for edge case', async () => {
    repo.findProducts.mockResolvedValue({ items: [], total: 21 });
    repo.findCategoryFacets.mockResolvedValue([]);

    const result = await useCase.execute({ ...defaultInput, limit: 10 });
    expect(result.meta.totalPages).toBe(3);
  });

  it('should accept rating_desc sort and fall back to relevance behavior', async () => {
    repo.findProducts.mockResolvedValue({
      items: [makeProduct('p1')],
      total: 1,
    });
    repo.findCategoryFacets.mockResolvedValue([]);

    // rating_desc is accepted (no 400) and falls back to relevance sort
    const result = await useCase.execute({
      ...defaultInput,
      sort: 'rating_desc',
    });

    expect(result.items).toHaveLength(1);
    // repo should receive 'rating_desc' — the repo maps it to relevance orderBy internally
    expect(repo.findProducts).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'rating_desc' }),
    );
  });
});

describe('ListProductsQueryDto validation (CRITICAL-02 regression)', () => {
  // Test at DTO validation layer — rating_desc must be accepted, not 400
  it('should accept rating_desc as a valid sort value', async () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const {
      ListProductsQueryDto,
    } = require('./request-dto/list-products-query.dto');

    const dto = plainToInstance(ListProductsQueryDto, { sort: 'rating_desc' });
    const errors = await validate(dto);
    const sortErrors = errors.filter((e: any) => e.property === 'sort');

    expect(sortErrors).toHaveLength(0);
  });

  it('should still reject invalid sort values', async () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const {
      ListProductsQueryDto,
    } = require('./request-dto/list-products-query.dto');

    const dto = plainToInstance(ListProductsQueryDto, { sort: 'invalid_sort' });
    const errors = await validate(dto);
    const sortErrors = errors.filter((e: any) => e.property === 'sort');

    expect(sortErrors).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F2.WU6 Slice 5b — list HTTP activation. The DTO mutation lock and the
// Nest/Supertest controller evidence below are additive; every legacy case
// above is preserved unchanged.
// ─────────────────────────────────────────────────────────────────────────

describe('ListProductsQueryDto priceListId (F2.WU6 Slice 5b mutation lock)', () => {
  const GPL_ID = '0e2b7c1a-9f3d-4a5b-8c6e-7d1f2a3b4c5d';

  const validateDto = (
    query: Record<string, unknown>,
  ): Promise<ValidationError[]> =>
    validate(plainToInstance(ListProductsQueryDto, query));

  const priceListErrors = (errors: ValidationError[]) =>
    errors.filter((e) => e.property === 'priceListId');

  it('accepts a valid optional priceListId UUID', async () => {
    const errors = await validateDto({ priceListId: GPL_ID });
    expect(priceListErrors(errors)).toHaveLength(0);
  });

  it('keeps priceListId optional (omitted passes)', async () => {
    const errors = await validateDto({});
    expect(priceListErrors(errors)).toHaveLength(0);
  });

  it('rejects a non-UUID priceListId', async () => {
    const errors = await validateDto({ priceListId: 'not-a-uuid' });
    expect(priceListErrors(errors)).toHaveLength(1);
  });
});

describe(
  'PublicCatalogController GET /public/catalog/:tenantSlug/products ' +
    '(F2.WU6 Slice 5b HTTP activation)',
  () => {
    const TENANT = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
    const GPL_EXPLICIT_ID = '0e2b7c1a-9f3d-4a5b-8c6e-7d1f2a3b4c5d';
    const DEFAULT_CONTEXT: ResolvedPublicCatalogContext = {
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      globalPriceListId: 'gpl-default-1',
      name: 'Publico',
      isCatalogDefault: true,
    };
    const EXPLICIT_CONTEXT: ResolvedPublicCatalogContext = {
      ...DEFAULT_CONTEXT,
      globalPriceListId: GPL_EXPLICIT_ID,
      name: 'Mayoreo',
      isCatalogDefault: false,
    };

    const makeListResponse = (context: ResolvedPublicCatalogContext) => ({
      items: [],
      meta: { page: 1, limit: 20, total: 2, totalPages: 1 },
      facets: { categories: [{ id: 'cat-1', name: 'Alimento', count: 2 }] },
      excludedCount: 3,
      priceContext: {
        priceListId: context.globalPriceListId,
        name: context.name,
        isCatalogDefault: context.isCatalogDefault,
      },
    });

    /** Typed access to the supertest JSON body (guards no-unsafe rules). */
    const bodyOf = (res: Response): Record<string, unknown> =>
      res.body as Record<string, unknown>;

    let app: INestApplication;
    let listProducts: { execute: jest.Mock; executeForContext: jest.Mock };
    let repo: { resolveTenantCatalogContext: jest.Mock };
    let prisma: { tenant: { findFirst: jest.Mock } };

    beforeEach(async () => {
      prisma = { tenant: { findFirst: jest.fn().mockResolvedValue(TENANT) } };
      repo = {
        resolveTenantCatalogContext: jest
          .fn()
          .mockImplementation(
            (
              slug: string,
              requestedId?: string,
            ): Promise<ResolvedPublicCatalogContext> =>
              requestedId
                ? Promise.resolve(EXPLICIT_CONTEXT)
                : Promise.resolve(DEFAULT_CONTEXT),
          ),
      };
      listProducts = {
        execute: jest.fn(),
        executeForContext: jest.fn(
          (input: { context: ResolvedPublicCatalogContext }) =>
            makeListResponse(input.context),
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
          { provide: ListPublicProductsUseCase, useValue: listProducts },
          { provide: ListPublicBranchesUseCase, useValue: {} },
          { provide: GetPublicProductDetailUseCase, useValue: {} },
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

    it('resolves the explicit context once from the combined filter request and delegates once with exact response passthrough', async () => {
      const resolveSpy = jest.spyOn(
        PublicPriceContextResolver.prototype,
        'resolve',
      );

      const res = await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .query({
          priceListId: GPL_EXPLICIT_ID,
          q: 'royal canina',
          categoryId: 'c1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          sort: 'price_asc',
          page: '3',
          limit: '5',
          branchId: 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        })
        .expect(200);

      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith('centro', GPL_EXPLICIT_ID);
      expect(repo.resolveTenantCatalogContext).toHaveBeenCalledTimes(1);
      expect(repo.resolveTenantCatalogContext).toHaveBeenCalledWith(
        'centro',
        GPL_EXPLICIT_ID,
      );
      expect(listProducts.executeForContext).toHaveBeenCalledTimes(1);
      expect(listProducts.executeForContext).toHaveBeenCalledWith({
        tenant: TENANT,
        context: EXPLICIT_CONTEXT,
        filters: {
          q: 'royal canina',
          categoryId: 'c1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          sort: 'price_asc',
          page: 3,
          limit: 5,
        },
      });
      expect(listProducts.execute).not.toHaveBeenCalled();
      expect(bodyOf(res)).toEqual(makeListResponse(EXPLICIT_CONTEXT));
    });

    it('resolves the tenant catalog default when priceListId is omitted', async () => {
      const resolveSpy = jest.spyOn(
        PublicPriceContextResolver.prototype,
        'resolve',
      );

      const res = await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .expect(200);

      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith('centro', undefined);
      expect(bodyOf(res).priceContext).toEqual({
        priceListId: 'gpl-default-1',
        name: 'Publico',
        isCatalogDefault: true,
      });
    });

    it('returns the generic 404 miss with zero use-case calls on PriceContextNotAvailableError', async () => {
      repo.resolveTenantCatalogContext.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .expect(404);

      expect(bodyOf(res).statusCode).toBe(404);
      expect(bodyOf(res).error).toBe('PRICE_CONTEXT_NOT_AVAILABLE');
      expect(listProducts.executeForContext).not.toHaveBeenCalled();
      expect(listProducts.execute).not.toHaveBeenCalled();
    });

    it('never throws the miss error shape beyond the generic filter mapping', async () => {
      repo.resolveTenantCatalogContext.mockRejectedValue(
        new PriceContextNotAvailableError(),
      );

      const res = await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .expect(404);

      expect(bodyOf(res).error).toBe('PRICE_CONTEXT_NOT_AVAILABLE');
      expect(listProducts.executeForContext).not.toHaveBeenCalled();
      expect(listProducts.execute).not.toHaveBeenCalled();
    });

    it('applies production defaults to the delegated filters', async () => {
      await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .query({ q: 'royal' })
        .expect(200);

      expect(listProducts.executeForContext).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: {
            q: 'royal',
            categoryId: undefined,
            sort: 'newest',
            page: 1,
            limit: 20,
          },
        }),
      );
    });

    it('accepts a valid branchId as a compatibility no-op and never passes it downstream', async () => {
      await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .query({ branchId: 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' })
        .expect(200);

      expect(listProducts.executeForContext).toHaveBeenCalledTimes(1);
      expect(listProducts.executeForContext).toHaveBeenCalledWith({
        tenant: TENANT,
        context: DEFAULT_CONTEXT,
        filters: {
          q: undefined,
          categoryId: undefined,
          sort: 'newest',
          page: 1,
          limit: 20,
        },
      });
    });

    it('rejects unknown query parameters with 400 (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .query({ unknown: 'x' })
        .expect(400);

      expect(listProducts.executeForContext).not.toHaveBeenCalled();
    });

    it('serves Cache-Control public, max-age=60 on the list route', async () => {
      const res = await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .expect(200);

      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('keeps PublicTenantGuard/ThrottlerGuard and cache metadata on the route', () => {
      const guards = (Reflect.getMetadata(
        '__guards__',
        PublicCatalogController,
      ) ?? []) as unknown[];

      expect(guards).toContain(PublicTenantGuard);
      expect(guards).toContain(ThrottlerGuard);
      const listHandler = Reflect.getOwnPropertyDescriptor(
        PublicCatalogController.prototype,
        'getProducts',
      )?.value as unknown as (...args: unknown[]) => unknown;
      expect(Reflect.getMetadata(CACHE_CONTROL_KEY, listHandler)).toBe(
        'public, max-age=60',
      );
    });

    it('keeps generic tenant-guard 404 semantics before any price-context resolution', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/public/catalog/centro/products')
        .expect(404);

      expect(repo.resolveTenantCatalogContext).not.toHaveBeenCalled();
      expect(listProducts.executeForContext).not.toHaveBeenCalled();
      expect(listProducts.execute).not.toHaveBeenCalled();
    });
  },
);
