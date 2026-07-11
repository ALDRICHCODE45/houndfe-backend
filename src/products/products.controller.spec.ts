/**
 * ProductsController — Sub-resource RBAC Integration Tests
 *
 * Tests that all 14 sub-resource routes (variants, variant-prices, lots,
 * product-price-lists) enforce @RequirePermissions correctly.
 *
 * Pattern mirrors brands.controller.spec.ts (proven in Slice 1).
 */
import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

const UUID = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
const UUID2 = 'c6f3c9fe-cefe-482a-c798-fd451e689996';

function makeMockProductsService() {
  return {
    create: jest.fn().mockResolvedValue({ id: UUID }),
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: UUID }),
    update: jest.fn().mockResolvedValue({ id: UUID }),
    remove: jest.fn().mockResolvedValue(undefined),
    addVariant: jest.fn().mockResolvedValue({ id: 'v-1' }),
    getVariants: jest.fn().mockResolvedValue([]),
    updateVariant: jest.fn().mockResolvedValue({ id: 'v-1' }),
    removeVariant: jest.fn().mockResolvedValue(undefined),
    getVariantPrices: jest.fn().mockResolvedValue([]),
    upsertVariantPrice: jest.fn().mockResolvedValue({ id: 'vp-1' }),
    removeVariantPrice: jest.fn().mockResolvedValue(undefined),
    bulkUpsertVariantPrices: jest.fn().mockResolvedValue([]),
    addLot: jest.fn().mockResolvedValue({ id: 'lot-1' }),
    getLots: jest.fn().mockResolvedValue([]),
    updateLot: jest.fn().mockResolvedValue({ id: 'lot-1' }),
    removeLot: jest.fn().mockResolvedValue(undefined),
    getPriceLists: jest.fn().mockResolvedValue([]),
    updatePriceList: jest.fn().mockResolvedValue({ id: 'pl-1' }),
    uploadProductImage: jest.fn().mockResolvedValue({ id: 'img-1' }),
    uploadVariantImage: jest.fn().mockResolvedValue({ id: 'img-2' }),
    addImage: jest.fn().mockResolvedValue({ id: 'img-3' }),
    getImages: jest.fn().mockResolvedValue([]),
    setMainImage: jest.fn().mockResolvedValue(undefined),
    removeImage: jest.fn().mockResolvedValue(undefined),
  } as any;
}

/**
 * Test guard tokens:
 * - 'super-admin'          → manage:all (super admin)
 * - 'product-full-crud'    → Product:create/read/update/delete
 * - 'product-read-only'    → Product:read only
 * - 'no-product-perms'     → authenticated but no Product permissions
 * - (no header)            → unauthenticated → 401
 */

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth = req.headers.authorization as string | undefined;
    if (!auth) throw new UnauthorizedException('Unauthorized');

    const token = auth.replace('Bearer ', '');

    if (token === 'super-admin') {
      req.user = {
        userId: 'user-sa',
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
        permissions: ['manage:all'],
      };
      return true;
    }

    if (token === 'product-full-crud') {
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [
          'create:Product',
          'read:Product',
          'update:Product',
          'delete:Product',
        ],
      };
      return true;
    }

    if (token === 'product-read-only') {
      req.user = {
        userId: 'user-cashier',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:Product'],
      };
      return true;
    }

    if (token === 'no-product-perms') {
      req.user = {
        userId: 'user-empty',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [],
      };
      return true;
    }

    throw new UnauthorizedException('Unauthorized');
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const permissions = (req.user?.permissions ?? []) as string[];

    // Super admin bypass
    if (permissions.includes('manage:all')) return true;

    // Extract required permissions from metadata
    const handler = context.getHandler();
    const classRef = context.getClass();
    const requiredPerms =
      Reflect.getMetadata('required_permissions', handler) ??
      Reflect.getMetadata('required_permissions', classRef) ??
      [];

    for (const [action, subject] of requiredPerms) {
      const key = `${action}:${subject}`;
      if (!permissions.includes(key)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }

    return true;
  }
}

class TestTenantContextGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

describe('ProductsController sub-resource auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockProductsService>;

  beforeEach(async () => {
    service = makeMockProductsService();

    const moduleRef = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [{ provide: ProductsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard as Type<CanActivate>)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantContextGuard as Type<CanActivate>)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard as Type<CanActivate>)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ==================== Variants ====================

  // POST /products/:id/variants → ['update', 'Product']
  it('POST /products/:id/variants returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post(`/products/${UUID}/variants`)
      .send({ name: 'Red', sku: 'RED-001' })
      .expect(401);
  });

  it('POST /products/:id/variants returns 403 without Product:update', async () => {
    await request(app.getHttpServer())
      .post(`/products/${UUID}/variants`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ name: 'Red', sku: 'RED-001' })
      .expect(403);
  });

  it('POST /products/:id/variants returns 201 with Product:update', async () => {
    await request(app.getHttpServer())
      .post(`/products/${UUID}/variants`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ name: 'Red', sku: 'RED-001' })
      .expect(201);
  });

  // GET /products/:id/variants → ['read', 'Product']
  it('GET /products/:id/variants returns 403 without Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/variants`)
      .set('Authorization', 'Bearer no-product-perms')
      .expect(403);
  });

  it('GET /products/:id/variants returns 200 with Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/variants`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);
  });

  // PATCH /products/:id/variants/:variantId → ['update', 'Product']
  it('PATCH /products/:id/variants/:variantId returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .patch(`/products/${UUID}/variants/${UUID2}`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ name: 'Blue' })
      .expect(403);
  });

  it('PATCH /products/:id/variants/:variantId returns 200 with Product:update', async () => {
    await request(app.getHttpServer())
      .patch(`/products/${UUID}/variants/${UUID2}`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ name: 'Blue' })
      .expect(200);
  });

  // DELETE /products/:id/variants/:variantId → ['delete', 'Product']
  it('DELETE /products/:id/variants/:variantId returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/variants/${UUID2}`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(403);
  });

  it('DELETE /products/:id/variants/:variantId returns 204 with Product:delete', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/variants/${UUID2}`)
      .set('Authorization', 'Bearer product-full-crud')
      .expect(204);
  });

  // ==================== Variant Prices ====================

  // GET /products/:productId/variants/:variantId/prices → ['read', 'Product']
  it('GET variant prices returns 403 without Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/variants/${UUID2}/prices`)
      .set('Authorization', 'Bearer no-product-perms')
      .expect(403);
  });

  it('GET variant prices returns 200 with Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/variants/${UUID2}/prices`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);
  });

  // PUT /products/:productId/variants/:variantId/prices/:priceListId → ['update', 'Product']
  it('PUT single variant price returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .put(`/products/${UUID}/variants/${UUID2}/prices/${UUID}`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ priceCents: 1000 })
      .expect(403);
  });

  it('PUT single variant price returns 200 with Product:update', async () => {
    await request(app.getHttpServer())
      .put(`/products/${UUID}/variants/${UUID2}/prices/${UUID}`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ priceCents: 1000 })
      .expect(200);
  });

  // DELETE /products/:productId/variants/:variantId/prices/:priceListId → ['update', 'Product']
  it('DELETE variant price returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/variants/${UUID2}/prices/${UUID}`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(403);
  });

  it('DELETE variant price returns 204 with Product:update (aggregate boundary)', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/variants/${UUID2}/prices/${UUID}`)
      .set('Authorization', 'Bearer product-full-crud')
      .expect(204);
  });

  // PUT /products/:productId/variants/:variantId/prices (bulk) → ['update', 'Product']
  it('PUT bulk variant prices returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .put(`/products/${UUID}/variants/${UUID2}/prices`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ prices: [{ priceListId: UUID, priceCents: 500 }] })
      .expect(403);
  });

  it('PUT bulk variant prices returns 200 with Product:update', async () => {
    await request(app.getHttpServer())
      .put(`/products/${UUID}/variants/${UUID2}/prices`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ prices: [{ priceListId: UUID, priceCents: 500 }] })
      .expect(200);
  });

  // ==================== Lots ====================

  // POST /products/:id/lots → ['update', 'Product']
  it('POST /products/:id/lots returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .post(`/products/${UUID}/lots`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ lotNumber: 'L001', expirationDate: '2027-12-31' })
      .expect(403);
  });

  it('POST /products/:id/lots returns 201 with Product:update', async () => {
    await request(app.getHttpServer())
      .post(`/products/${UUID}/lots`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ lotNumber: 'L001', expirationDate: '2027-12-31' })
      .expect(201);
  });

  // GET /products/:id/lots → ['read', 'Product']
  it('GET /products/:id/lots returns 403 without Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/lots`)
      .set('Authorization', 'Bearer no-product-perms')
      .expect(403);
  });

  it('GET /products/:id/lots returns 200 with Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/lots`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);
  });

  // PATCH /products/:id/lots/:lotId → ['update', 'Product']
  it('PATCH /products/:id/lots/:lotId returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .patch(`/products/${UUID}/lots/${UUID2}`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ quantity: 10 })
      .expect(403);
  });

  it('PATCH /products/:id/lots/:lotId returns 200 with Product:update', async () => {
    await request(app.getHttpServer())
      .patch(`/products/${UUID}/lots/${UUID2}`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ quantity: 10 })
      .expect(200);
  });

  // DELETE /products/:id/lots/:lotId → ['update', 'Product']
  it('DELETE /products/:id/lots/:lotId returns 403 for read-only user (aggregate boundary)', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/lots/${UUID2}`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(403);
  });

  it('DELETE /products/:id/lots/:lotId returns 204 with Product:update', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/lots/${UUID2}`)
      .set('Authorization', 'Bearer product-full-crud')
      .expect(204);
  });

  // ==================== Product Price Lists ====================

  // GET /products/:id/price-lists → ['read', 'Product']
  it('GET /products/:id/price-lists returns 403 without Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/price-lists`)
      .set('Authorization', 'Bearer no-product-perms')
      .expect(403);
  });

  it('GET /products/:id/price-lists returns 200 with Product:read', async () => {
    await request(app.getHttpServer())
      .get(`/products/${UUID}/price-lists`)
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);
  });

  // PATCH /products/:id/price-lists/:priceListId → ['update', 'Product']
  it('PATCH /products/:id/price-lists/:priceListId returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .patch(`/products/${UUID}/price-lists/${UUID2}`)
      .set('Authorization', 'Bearer product-read-only')
      .send({ priceCents: 1500 })
      .expect(403);
  });

  it('PATCH /products/:id/price-lists/:priceListId returns 200 with Product:update', async () => {
    await request(app.getHttpServer())
      .patch(`/products/${UUID}/price-lists/${UUID2}`)
      .set('Authorization', 'Bearer product-full-crud')
      .send({ priceCents: 1500 })
      .expect(200);
  });

  // ==================== Super admin bypass ====================

  it('POST /products/:id/variants returns 201 for super-admin', async () => {
    await request(app.getHttpServer())
      .post(`/products/${UUID}/variants`)
      .set('Authorization', 'Bearer super-admin')
      .send({ name: 'Red', sku: 'RED-001' })
      .expect(201);
  });

  it('DELETE /products/:id/lots/:lotId returns 204 for super-admin', async () => {
    await request(app.getHttpServer())
      .delete(`/products/${UUID}/lots/${UUID2}`)
      .set('Authorization', 'Bearer super-admin')
      .expect(204);
  });

  // ==================== GET /products — query alias regression ====================
  //
  // Regression: commit c61bbb8 introduced ListProductsQueryDto on
  // GET /products. With the global ValidationPipe's
  // `whitelist + forbidNonWhitelisted` policy (replicated below), any
  // unknown query param now returns 400. The frontend POS screen sends
  // `?q=` (legacy alias) in addition to `?search=`, so the product list
  // was rejected and rendered empty.
  //
  // These tests exercise the FULL pipe (whitelist + forbidNonWhitelisted +
  // transform) so the fix is proven end-to-end, not just at the DTO unit
  // level.
  //
  // Trade-off: the chosen fix (Approach A in the design discussion) adds
  // `q` as an explicit, documented alias on the DTO. We CANNOT apply a
  // handler-scoped @UsePipes with forbidNonWhitelisted:false because the
  // global ValidationPipe runs FIRST in NestJS' pipe chain
  // (global → controller → method → parameter) and throws before the
  // handler pipe runs. Relaxing the global pipe itself would weaken
  // mutation endpoints. Therefore unknown legacy params other than `q`
  // will still 400 — that is intentional and documented.

  it('GET /products?q=ibup returns 200 (q accepted as legacy alias of search)', async () => {
    const res = await request(app.getHttpServer())
      .get('/products?q=ibup')
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);

    // The service is called with the DTO instance. `q` must be preserved
    // on the DTO (so the service can resolve the alias).
    expect(service.findAll).toHaveBeenCalledTimes(1);
    const passedQuery = service.findAll.mock.calls[0][0];
    expect(passedQuery.q).toBe('ibup');
  });

  it('GET /products?search=ibup returns 200 (canonical search still works)', async () => {
    await request(app.getHttpServer())
      .get('/products?search=ibup')
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);

    const passedQuery = service.findAll.mock.calls[0][0];
    expect(passedQuery.search).toBe('ibup');
  });

  it('GET /products?search=para&q=ibup returns 200 (both params present, no 400)', async () => {
    await request(app.getHttpServer())
      .get('/products?search=para&q=ibup')
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);

    const passedQuery = service.findAll.mock.calls[0][0];
    expect(passedQuery.search).toBe('para');
    expect(passedQuery.q).toBe('ibup');
  });

  it('GET /products with NO params returns 200 (flat array, unchanged)', async () => {
    await request(app.getHttpServer())
      .get('/products')
      .set('Authorization', 'Bearer product-read-only')
      .expect(200);

    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  // Defense-in-depth: the global pipe is still strict on this endpoint.
  // An unknown param (anything other than the documented DTO fields)
  // MUST still 400, proving we did NOT weaken the global policy.
  it('GET /products?someUnknownParam=1 returns 400 (global pipe still rejects unknown query props)', async () => {
    await request(app.getHttpServer())
      .get('/products?someUnknownParam=1')
      .set('Authorization', 'Bearer product-read-only')
      .expect(400);
  });
});
