import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { Server } from 'node:http';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import { ListPublicPriceContextsUseCase } from '../application/use-cases/list-public-price-contexts.use-case';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';

const tenant = { id: 'tenant-1', slug: 'centro', name: 'Centro' };
const contexts = [
  { priceListId: 'default-id', name: 'General', isCatalogDefault: true },
  { priceListId: 'other-id', name: 'Mayorista', isCatalogDefault: false },
];

describe('GET /public/catalog/:tenantSlug/price-contexts', () => {
  let app: INestApplication;
  let findFirst: jest.Mock;
  let execute: jest.Mock;
  let resolve: jest.Mock;

  beforeEach(async () => {
    findFirst = jest.fn().mockResolvedValue(tenant);
    execute = jest.fn().mockResolvedValue(contexts);
    resolve = jest.fn();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'public-browse', ttl: 60_000, limit: 60 },
          { name: 'public-validate', ttl: 60_000, limit: 20 },
        ]),
      ],
      controllers: [PublicCatalogController],
      providers: [
        PublicTenantGuard,
        { provide: PrismaService, useValue: { tenant: { findFirst } } },
        { provide: ClsService, useValue: { set: jest.fn() } },
        { provide: ListPublicPriceContextsUseCase, useValue: { execute } },
        { provide: ListPublicBranchesUseCase, useValue: {} },
        { provide: ListPublicProductsUseCase, useValue: {} },
        { provide: GetPublicProductDetailUseCase, useValue: {} },
        { provide: ValidatePublicCartUseCase, useValue: {} },
        { provide: PublicPriceContextResolver, useValue: { resolve } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a bare three-field array with the browse cache header, without selecting a product context', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/public/catalog/centro/price-contexts')
      .expect(200);
    expect(res.body).toEqual(contexts);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(findFirst).toHaveBeenCalledWith({
      where: { slug: 'centro', isActive: true, catalogPublished: true },
    });
    expect(execute).toHaveBeenCalledWith(tenant);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns an empty array without inventing a default', async () => {
    execute.mockResolvedValue([]);
    const res = await request(app.getHttpServer() as Server)
      .get('/public/catalog/centro/price-contexts')
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it.each(['missing', 'unpublished', 'inactive'])(
    'does not expose contexts of a %s tenant',
    async () => {
      findFirst.mockResolvedValue(null);
      const res = await request(app.getHttpServer() as Server)
        .get('/public/catalog/centro/price-contexts')
        .expect(404);
      expect((res.body as { message: string }).message).toBe('Not Found');
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
