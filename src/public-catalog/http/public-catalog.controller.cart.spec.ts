import { NotFoundException } from '@nestjs/common';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import type {
  IPublicCatalogRepository,
  PublicCartCandidate,
  ResolvedPublicCatalogContext,
} from '../application/ports/public-catalog.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { Server } from 'http';
import { ThrottlerModule } from '@nestjs/throttler';
import { ClsService } from 'nestjs-cls';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import { PUBLIC_CATALOG_REPOSITORY } from '../application/ports/public-catalog.repository';
import { PriceContextNotAvailableError } from '../domain/errors/price-context-not-available.error';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';

// F2.WU7 slice 2 — dormant seam: basic happy path + blocked paths.
describe('executeForContext (F2.WU7 slice 2 — dormant seam)', () => {
  const context: ResolvedPublicCatalogContext = {
    tenantId: 'tenant-1',
    tenantSlug: 'petshop',
    globalPriceListId: 'gpl-sel-1',
    name: 'Spring Catalog',
    isCatalogDefault: false,
  };
  const tenant = { id: 'tenant-1', slug: 'petshop' };

  const makeCandidate = (
    overrides: Partial<PublicCartCandidate> = {},
  ): PublicCartCandidate => ({
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
    ...overrides,
  });

  let seam: jest.Mock;
  let useCase: ValidatePublicCartUseCase;

  beforeEach(() => {
    seam = jest.fn().mockResolvedValue([]);
    const repo = { findPublicCartCandidates: seam };
    useCase = new ValidatePublicCartUseCase(
      {} as unknown as TenantPrismaService,
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('happy path: dedup load, order, prices, exact context', async () => {
    seam.mockResolvedValue([
      makeCandidate({ id: 'prod-1', priceLists: [{ priceCents: 100000 }] }),
    ]);

    const result = await useCase.executeForContext({
      tenant,
      context,
      items: [
        // Client-supplied prices are structurally ignored (never read)
        { productId: 'prod-1', quantity: 2, clientPriceCents: 1 } as never,
        { productId: 'prod-1', quantity: 1 },
      ],
    });

    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      context,
      productIds: ['prod-1'],
      variantIds: [],
    });
    expect(result.items.map((i) => i.productId)).toEqual(['prod-1', 'prod-1']);
    expect(result.items[0].unitPriceCents).toBe(100000);
    expect(result.items[0].lineTotalCents).toBe(200000);
    expect(result.valid).toBe(true);
    expect(result.totalCents).toBe(300000);
    expect(result.priceContext).toEqual({
      priceListId: 'gpl-sel-1',
      name: 'Spring Catalog',
      isCatalogDefault: false,
    });
    // PRICE_CHANGED stays dormant: client prices are never accepted
    expect(result.warnings).not.toContain('PRICE_CHANGED');
  });

  it('blocked paths: uniform redaction and variant distinction', async () => {
    seam.mockResolvedValue([
      makeCandidate({ id: 'prod-1', type: 'SERVICE' }),
      makeCandidate({ id: 'prod-2', hasVariants: true }),
    ]);

    const result = await useCase.executeForContext({
      tenant,
      context,
      items: [
        { productId: 'prod-missing', quantity: 1 },
        { productId: 'prod-1', quantity: 2 },
        { productId: 'prod-2', variantId: 'var-elsewhere', quantity: 1 },
      ],
    });

    expect(result.items.map((i) => i.blockingCodes)).toEqual([
      ['NOT_IN_CATALOG'],
      ['NOT_IN_CATALOG'],
      ['VARIANT_NOT_FOUND'],
    ]);
    for (const item of result.items) {
      expect(item.status).toBe('BLOCKED');
      expect(item.warnings).toEqual(item.blockingCodes);
      expect(item.productName).toBeNull();
      expect(item.variantName).toBeNull();
      expect(item.image).toBeNull();
      expect(item.unitPriceCents).toBeNull();
      expect(item.lineTotalCents).toBeNull();
    }
    expect(result.valid).toBe(false);
    expect(result.totalCents).toBe(0);
  });

  // R3-PositivePriceCheck: strictly positive exact-context prices, allowlist exactness, no fallback, independent stock.
  it('accepts only strictly positive exact-context prices, with allowlist exactness, no fallback, and independent stock', async () => {
    const priced = (
      id: string,
      quantity: number,
      priceCents: number,
      extra: Partial<PublicCartCandidate> = {},
    ) =>
      makeCandidate({ id, quantity, ...extra, priceLists: [{ priceCents }] });
    seam.mockResolvedValue([
      makeCandidate({ id: 'p-zero', priceLists: [{ priceCents: 0 }] }),
      makeCandidate({ id: 'p-neg', priceLists: [{ priceCents: -100 }] }),
      makeCandidate({
        id: 'p-mismatch',
        catalogPriceLists: [{ globalPriceListId: 'gpl-other' }],
        priceLists: [{ priceCents: 100000 }],
      }),
      makeCandidate({
        id: 'p-ok',
        catalogPriceLists: [{ globalPriceListId: 'gpl-sel-1' }],
        priceLists: [{ priceCents: 500 }],
      }),
      priced('p-oos', 0, 1000),
      priced('p-low', 5, 2000),
      priced('p-nostock', 0, 3000, { useStock: false }),
    ]);

    const result = await useCase.executeForContext({
      tenant,
      context,
      items: [
        { productId: 'p-zero', quantity: 2 },
        { productId: 'p-neg', quantity: 1 },
        { productId: 'p-mismatch', quantity: 1 },
        { productId: 'p-ok', quantity: 3 },
        { productId: 'p-oos', quantity: 2 },
        { productId: 'p-low', quantity: 1 },
        { productId: 'p-nostock', quantity: 1 },
      ],
    });

    expect(
      result.items.map((i) => [i.blockingCodes, i.status, i.availability]),
    ).toEqual([
      [['PRICE_NOT_AVAILABLE_IN_CONTEXT'], 'BLOCKED', 'available'],
      [['PRICE_NOT_AVAILABLE_IN_CONTEXT'], 'BLOCKED', 'available'],
      [['PRICE_NOT_AVAILABLE_IN_CONTEXT'], 'BLOCKED', 'available'],
      [[], 'VALID', 'available'],
      [['OUT_OF_STOCK'], 'BLOCKED', 'out_of_stock'],
      [[], 'VALID', 'low_stock'],
      [[], 'VALID', 'available'],
    ]);
    // No default/alternate rescue; blocked rows disclose no prices while the visible OOS row keeps its line total.
    expect(result.items.map((i) => i.lineTotalCents)).toEqual([
      null,
      null,
      null,
      1500,
      2000,
      2000,
      3000,
    ]);
    // Aggregate excludes OOS but includes low-stock and non-stock.
    expect(result.totalCents).toBe(6500);
    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual([
      'PRICE_NOT_AVAILABLE_IN_CONTEXT',
      'OUT_OF_STOCK',
      'LOW_STOCK',
    ]);
  });

  it('hidden/prescription precedence bypasses allowlist and price checks, nulls numerics and the aggregate', async () => {
    seam.mockResolvedValue([
      makeCandidate({
        id: 'p-hidden',
        hidePriceInOnlineCatalog: true,
        catalogPriceLists: [{ globalPriceListId: 'gpl-other' }],
      }),
      makeCandidate({ id: 'p-rx', requiresPrescription: true }),
    ]);

    const result = await useCase.executeForContext({
      tenant,
      context,
      items: [
        { productId: 'p-hidden', quantity: 1 },
        { productId: 'p-rx', quantity: 2 },
      ],
    });

    for (const item of result.items) {
      expect(item).toMatchObject({
        status: 'VALID',
        blockingCodes: [],
        warnings: ['PRICE_HIDDEN'],
        priceHidden: true,
        unitPriceCents: null,
        lineTotalCents: null,
      });
    }
    expect(result.totalCents).toBeNull();
    expect(result.valid).toBe(true);
  });

  it('fails closed with a generic miss before any repository access on tenant/context mismatch or absent seam', async () => {
    const items = [{ productId: 'prod-1', quantity: 1 }];
    const miss = (t: { id: string; slug: string }) =>
      useCase.executeForContext({ tenant: t, context, items });
    await expect(miss({ id: 'tenant-2', slug: 'petshop' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(miss({ id: 'tenant-1', slug: 'other-shop' })).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    await expect(
      new ValidatePublicCartUseCase(
        {} as unknown as TenantPrismaService,
        {} as unknown as IPublicCatalogRepository,
      ).executeForContext({ tenant, context, items }),
    ).rejects.toThrow(NotFoundException);
    expect(seam).not.toHaveBeenCalled();
  });

  it('preserves order and duplicates, de-duplicates repository inputs, and omits unrequested variant ids', async () => {
    seam.mockResolvedValue([
      makeCandidate({
        id: 'p-a',
        hasVariants: true,
        priceLists: [{ priceCents: 1000 }],
        variants: [
          {
            id: 'v-a1',
            name: 'A1',
            catalogPublishMode: 'ON',
            quantity: 10,
            minQuantity: 5,
            variantPrices: [{ priceCents: 1100 }],
          },
        ],
      }),
      makeCandidate({ id: 'p-b', priceLists: [{ priceCents: 2000 }] }),
    ]);

    const result = await useCase.executeForContext({
      tenant,
      context,
      items: [
        { productId: 'p-b', quantity: 1 },
        { productId: 'p-a', variantId: 'v-a1', quantity: 2 },
        { productId: 'p-a', quantity: 1 }, // omitted-variant compatibility
        { productId: 'p-b', quantity: 4 }, // duplicate product
      ],
    });

    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      context,
      productIds: ['p-b', 'p-a'], // de-duplicated, first-request order
      variantIds: ['v-a1'],
    });
    expect(result.items.map((i) => [i.productId, i.unitPriceCents])).toEqual([
      ['p-b', 2000],
      ['p-a', 1100],
      ['p-a', 1000],
      ['p-b', 2000],
    ]);
    expect(result.totalCents).toBe(13200);
    expect(result.valid).toBe(true);
  });
});

describe('POST /public/catalog/:tenantSlug/cart/validate (F2.WU7 Slice 4)', () => {
  const TENANT = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
  const GPL_ID = '0e2b7c1a-9f3d-4a5b-8c6e-7d1f2a3b4c5d';
  const PROD_ID = '3f1a2b4c-5d6e-4f70-8a9b-1c2d3e4f5a6b';
  const URL = '/public/catalog/centro/cart/validate';
  const ITEMS = [
    { productId: PROD_ID, quantity: 2 },
    { productId: PROD_ID, quantity: 1 },
  ];
  const DEFAULT_CONTEXT: ResolvedPublicCatalogContext = {
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    globalPriceListId: 'gpl-default-1',
    name: 'Publico',
    isCatalogDefault: true,
  };
  const EXPLICIT_CONTEXT: ResolvedPublicCatalogContext = {
    ...DEFAULT_CONTEXT,
    globalPriceListId: GPL_ID,
    name: 'Mayoreo',
    isCatalogDefault: false,
  };

  const markerFor = (context: ResolvedPublicCatalogContext) => ({
    valid: true,
    priceContext: {
      priceListId: context.globalPriceListId,
      name: context.name,
      isCatalogDefault: context.isCatalogDefault,
    },
    items: ITEMS.map((item, index) => ({
      productId: item.productId,
      quantity: item.quantity,
      status: 'VALID',
      blockingCodes: index === 0 ? ['STOCK_LOW'] : [],
      unitPriceCents: 100000 - index,
      lineTotalCents: item.quantity * (100000 - index),
    })),
    warnings: [],
    totalCents: 300000,
  });

  const bodyOf = (res: Response): Record<string, unknown> =>
    res.body as Record<string, unknown>;

  let app: INestApplication;
  let validateCart: { execute: jest.Mock; executeForContext: jest.Mock };
  let repo: { resolveTenantCatalogContext: jest.Mock };

  const postCart = (body: Record<string, unknown>) =>
    request(app.getHttpServer() as Server)
      .post(URL)
      .send(body);

  beforeEach(async () => {
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue(TENANT) },
    };
    repo = {
      resolveTenantCatalogContext: jest.fn(
        (slug: string, requestedId?: string) =>
          Promise.resolve(requestedId ? EXPLICIT_CONTEXT : DEFAULT_CONTEXT),
      ),
    };
    validateCart = {
      execute: jest.fn(),
      executeForContext: jest.fn(
        (input: { context: ResolvedPublicCatalogContext }) =>
          markerFor(input.context),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'public-validate', ttl: 60_000, limit: 20 },
        ]),
      ],
      controllers: [PublicCatalogController],
      providers: [
        PublicPriceContextResolver,
        PublicTenantGuard,
        { provide: PUBLIC_CATALOG_REPOSITORY, useValue: repo },
        { provide: ListPublicBranchesUseCase, useValue: {} },
        { provide: ListPublicProductsUseCase, useValue: {} },
        { provide: GetPublicProductDetailUseCase, useValue: {} },
        { provide: ValidatePublicCartUseCase, useValue: validateCart },
        { provide: PrismaService, useValue: prisma },
        { provide: ClsService, useValue: { set: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
  });

  it.each([
    ['an explicit priceListId', { priceListId: GPL_ID }, EXPLICIT_CONTEXT],
    ['the tenant default (omitted)', {}, DEFAULT_CONTEXT],
  ] as const)(
    'resolves once and delegates once for %s with exact passthrough',
    async (
      _name: string,
      priceList: { priceListId?: string },
      context: ResolvedPublicCatalogContext,
    ) => {
      const res = await postCart({ ...priceList, items: ITEMS }).expect(201);

      expect(repo.resolveTenantCatalogContext).toHaveBeenCalledTimes(1);
      expect(repo.resolveTenantCatalogContext).toHaveBeenCalledWith(
        'centro',
        priceList.priceListId,
      );
      expect(validateCart.executeForContext).toHaveBeenCalledTimes(1);
      expect(validateCart.executeForContext).toHaveBeenCalledWith({
        tenant: TENANT,
        context,
        items: ITEMS,
      });
      expect(validateCart.execute).not.toHaveBeenCalled();
      expect(bodyOf(res)).toEqual(markerFor(context));
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it.each([
    ['an unavailable explicit priceListId', { priceListId: GPL_ID }, null],
    ['an unavailable tenant default', {}, null],
    [
      'a thrown PriceContextNotAvailableError',
      {},
      new PriceContextNotAvailableError(),
    ],
  ] as const)(
    'maps %s to the single generic 404',
    async (
      _name: string,
      priceList: { priceListId?: string },
      outcome: null | PriceContextNotAvailableError,
    ) => {
      repo.resolveTenantCatalogContext.mockImplementation(() =>
        outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome),
      );

      const res = await postCart({ ...priceList, items: ITEMS }).expect(404);

      expect(bodyOf(res).statusCode).toBe(404);
      expect(bodyOf(res).error).toBe('PRICE_CONTEXT_NOT_AVAILABLE');
      expect(validateCart.executeForContext).not.toHaveBeenCalled();
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it.each([
    [
      'the old nested customer contract',
      { items: ITEMS, customer: { globalPriceListId: GPL_ID } },
    ],
    [
      'client pricing fields on an item',
      { items: [{ productId: PROD_ID, quantity: 1, clientPriceCents: 100 }] },
    ],
    ['a non-UUID priceListId', { items: ITEMS, priceListId: 'not-a-uuid' }],
  ] as const)(
    'rejects %s with 400 and zero cart calls',
    async (_name: string, payload: Record<string, unknown>) => {
      await postCart(payload).expect(400);

      expect(validateCart.executeForContext).not.toHaveBeenCalled();
    },
  );
});
