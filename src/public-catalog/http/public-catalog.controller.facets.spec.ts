import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { ClsService } from 'nestjs-cls';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicPriceContextsUseCase } from '../application/use-cases/list-public-price-contexts.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import {
  PUBLIC_CATALOG_REPOSITORY,
  type ResolvedPublicCatalogContext,
} from '../application/ports/public-catalog.repository';
import { AttributeFacetNotAvailableError } from '../domain/errors/attribute-facet-not-available.error';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';

// P4 S4 — `facet=<definition>:<option>` on the public list route.
describe('PublicCatalogController GET products ?facet (P4 S4)', () => {
  const TENANT = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };
  const CONTEXT: ResolvedPublicCatalogContext = {
    tenantId: 'tenant-1',
    tenantSlug: 'centro',
    globalPriceListId: 'gpl-default-1',
    name: 'Publico',
    isCatalogDefault: true,
    stockPresentationDefaults: {
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
    },
    requiresPublishedEditorial: true,
  };

  let app: INestApplication;
  let executeForContext: jest.Mock;

  beforeEach(async () => {
    executeForContext = jest.fn().mockResolvedValue({ items: [] });
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
        {
          provide: PUBLIC_CATALOG_REPOSITORY,
          useValue: {
            resolveTenantCatalogContext: jest.fn().mockResolvedValue(CONTEXT),
          },
        },
        {
          provide: ListPublicProductsUseCase,
          useValue: { executeForContext },
        },
        { provide: ListPublicBranchesUseCase, useValue: {} },
        { provide: ListPublicPriceContextsUseCase, useValue: {} },
        { provide: GetPublicProductDetailUseCase, useValue: {} },
        { provide: ValidatePublicCartUseCase, useValue: {} },
        {
          provide: PrismaService,
          useValue: {
            tenant: { findFirst: jest.fn().mockResolvedValue(TENANT) },
          },
        },
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

  afterEach(() => app.close());

  const get = (query: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0]).get(
      `/public/catalog/centro/products${query}`,
    );
  const filters = () => {
    const [[input]] = executeForContext.mock.calls as [
      [{ filters: Record<string, unknown> }],
    ];
    return input.filters;
  };

  it('groups repeated tokens per definition in input order', async () => {
    await get(
      '?facet=animal.target:ani.dom.dog&facet=food.format:food.format.pate' +
        '&facet=animal.target:ani.dom.cat',
    ).expect(200);
    expect(filters().attributeFacets).toEqual([
      { code: 'animal.target', options: ['ani.dom.dog', 'ani.dom.cat'] },
      { code: 'food.format', options: ['food.format.pate'] },
    ]);
  });

  it('accepts a single token', async () => {
    await get('?facet=animal.target:ani.dom.dog').expect(200);
    expect(filters().attributeFacets).toEqual([
      { code: 'animal.target', options: ['ani.dom.dog'] },
    ]);
  });

  it('without facet the delegated filters carry no attributeFacets key', async () => {
    await get('?q=royal').expect(200);
    expect(Object.keys(filters())).toEqual([
      'q',
      'categoryId',
      'sort',
      'page',
      'limit',
    ]);
  });

  it.each([
    ['no separator', '?facet=animal.target'],
    ['empty option', '?facet=animal.target:'],
    ['two separators', '?facet=a:b:c'],
    ['space', '?facet=animal.target:ani%20dom'],
    ['duplicate token', '?facet=a:b&facet=a:b'],
  ])('rejects a malformed selection with 400 (%s)', async (_, query) => {
    await get(query).expect(400);
    expect(executeForContext).not.toHaveBeenCalled();
  });

  it('rejects more than 50 tokens with 400', async () => {
    const query = Array.from({ length: 51 }, (_, i) => `facet=a:o${i}`).join(
      '&',
    );
    await get('?' + query).expect(400);
  });

  it('maps FACET_NOT_AVAILABLE to 400 with the domain error body', async () => {
    executeForContext.mockRejectedValue(
      new AttributeFacetNotAvailableError('nope.def'),
    );
    const res = await get('?facet=nope.def:x').expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      error: 'FACET_NOT_AVAILABLE',
      message: 'Facet is not available: nope.def',
    });
  });
});
