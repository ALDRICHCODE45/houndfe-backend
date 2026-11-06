/**
 * shipping-zones / T2 (S4) — product/variant packaging routes against REAL
 * PostgreSQL through the real JWT → TenantContext → Permissions (CASL reading
 * RolePermission rows) chain, real nestjs-cls and the real tenant-scoped
 * Prisma client. Fixtures live under random tenants removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { normalizeTestDatabaseUrl } from '../../../../test/integration/setup/test-database-url';
import { CaslAbilityFactory } from '../../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../../auth/infrastructure/strategies/jwt.strategy';
import { DomainExceptionFilter } from '../../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../../../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../../../shared/prisma/prisma.module';
import { TenantContextGuard } from '../../../shared/tenant/tenant-context.guard';
import { ProductPackagingService } from '../application/product-packaging.service';
import { ProductPackagingController } from './product-packaging.controller';

const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const SECRET = 'shipping-packaging-it-secret';
const jwt = new JwtService({
  secret: SECRET,
  signOptions: { expiresIn: '1h' },
});

const PACKAGING = { weightG: 450, lengthCm: 20.5, widthCm: 12, heightCm: 8.3 };

describeDb('product packaging routes (PostgreSQL)', () => {
  let db: PrismaClient;
  let app: INestApplication;
  let service: ProductPackagingService;
  const tenants: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[shipping-packaging]');
    db = new PrismaClient();
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [ProductPackagingController],
      providers: [
        ProductPackagingService,
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        CaslAbilityFactory,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => SECRET, get: () => SECRET },
        },
      ],
    }).compile();
    service = moduleRef.get(ProductPackagingService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db.tenant.deleteMany({ where: { id: { in: tenants } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  async function seedTenant(grants: [string, string][]) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenants.push(tenantId);
    users.push(userId);
    await db.tenant.create({
      data: { id: tenantId, name: 'Packaging IT', slug: `pkg-${tenantId}` },
    });
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@packaging.invalid`,
        name: 'Packer',
        hashedPassword: 'not-a-login-hash',
      },
    });
    const role = await db.role.create({
      data: { tenantId, name: `Packaging ${userId}` },
    });
    for (const [subject, action] of grants) {
      const permission = await db.permission.upsert({
        where: { subject_action: { subject, action } },
        create: { subject, action },
        update: {},
      });
      await db.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await db.tenantMembership.create({
      data: { tenantId, userId, roleId: role.id },
    });
    const product = await db.product.create({
      data: { tenantId, name: 'Té verde', hasVariants: true },
    });
    const variant = await db.variant.create({
      data: { tenantId, productId: product.id, name: '500 g' },
    });
    const token = jwt.sign({
      sub: userId,
      email: `${userId}@packaging.invalid`,
      tenantId,
      tenantSlug: `pkg-${tenantId}`,
      isSuperAdmin: false,
    });
    return { tenantId, token, product, variant };
  }

  const editor = () =>
    seedTenant([
      ['Product', 'read'],
      ['Product', 'update'],
    ]);
  const http = () => request(app.getHttpServer() as Server);

  it('GET returns null packaging until it is set, then PUT stores it', async () => {
    const t = await editor();
    const url = `/products/${t.product.id}/packaging`;

    const empty = await http()
      .get(url)
      .set('Authorization', `Bearer ${t.token}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ productId: t.product.id, packaging: null });

    const put = await http()
      .put(url)
      .set('Authorization', `Bearer ${t.token}`)
      .send(PACKAGING);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      productId: t.product.id,
      packaging: { ...PACKAGING, updatedAt: expect.any(String) as unknown },
    });

    const row = await db.productPackaging.findUnique({
      where: { productId: t.product.id },
    });
    expect(row?.tenantId).toBe(t.tenantId);
    expect(Number(row?.lengthCm)).toBe(20.5);

    const replaced = await http()
      .put(url)
      .set('Authorization', `Bearer ${t.token}`)
      .send({ ...PACKAGING, weightG: 900 });
    expect(
      (replaced.body as { packaging: { weightG: number } }).packaging.weightG,
    ).toBe(900);
  });

  it('variant inherits the product record until a whole-record override exists', async () => {
    const t = await editor();
    const auth = { Authorization: `Bearer ${t.token}` };
    const variantUrl = `/products/${t.product.id}/variants/${t.variant.id}/packaging`;

    await http()
      .put(`/products/${t.product.id}/packaging`)
      .set(auth)
      .send(PACKAGING);
    const inherited = await http().get(variantUrl).set(auth);
    expect(inherited.status).toBe(200);
    expect(inherited.body).toMatchObject({
      productId: t.product.id,
      variantId: t.variant.id,
      override: null,
      source: 'PRODUCT',
      effective: PACKAGING,
    });

    const override = { weightG: 1200, lengthCm: 30, widthCm: 20, heightCm: 10 };
    const put = await http().put(variantUrl).set(auth).send(override);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      source: 'VARIANT',
      override,
      effective: override,
      productPackaging: PACKAGING,
    });

    const removed = await http().delete(variantUrl).set(auth);
    expect(removed.status).toBe(204);
    const after = await http().get(variantUrl).set(auth);
    expect(after.body).toMatchObject({ source: 'PRODUCT', override: null });
  });

  it('reports source null when neither the variant nor the product has packaging', async () => {
    const t = await editor();
    const res = await http()
      .get(`/products/${t.product.id}/variants/${t.variant.id}/packaging`)
      .set('Authorization', `Bearer ${t.token}`);
    expect(res.body).toMatchObject({ source: null, effective: null });
  });

  it('isolates tenants: a foreign product or variant is 404 and never written', async () => {
    const mine = await editor();
    const other = await editor();
    const auth = { Authorization: `Bearer ${mine.token}` };

    const foreignProduct = await http()
      .put(`/products/${other.product.id}/packaging`)
      .set(auth)
      .send(PACKAGING);
    expect(foreignProduct.status).toBe(404);
    expect((foreignProduct.body as { error: string }).error).toBe(
      'ENTITY_NOT_FOUND',
    );

    const foreignRead = await http()
      .get(`/products/${other.product.id}/packaging`)
      .set(auth);
    expect(foreignRead.status).toBe(404);

    const crossedVariant = await http()
      .put(
        `/products/${mine.product.id}/variants/${other.variant.id}/packaging`,
      )
      .set(auth)
      .send(PACKAGING);
    expect(crossedVariant.status).toBe(404);

    expect(
      await db.productPackaging.count({ where: { tenantId: other.tenantId } }),
    ).toBe(0);
    expect(
      await db.variantPackaging.count({
        where: { variantId: other.variant.id },
      }),
    ).toBe(0);
  });

  it('requires read:Product to read and update:Product to write', async () => {
    const reader = await seedTenant([['Product', 'read']]);
    const nobody = await seedTenant([]);
    const url = (t: { product: { id: string } }) =>
      `/products/${t.product.id}/packaging`;

    const readOk = await http()
      .get(url(reader))
      .set('Authorization', `Bearer ${reader.token}`);
    expect(readOk.status).toBe(200);

    const writeDenied = await http()
      .put(url(reader))
      .set('Authorization', `Bearer ${reader.token}`)
      .send(PACKAGING);
    expect(writeDenied.status).toBe(403);

    const readDenied = await http()
      .get(url(nobody))
      .set('Authorization', `Bearer ${nobody.token}`);
    expect(readDenied.status).toBe(403);

    const anonymous = await http().get(url(nobody));
    expect(anonymous.status).toBe(401);
  });

  it.each([
    ['zero weight', { ...PACKAGING, weightG: 0 }],
    ['fractional grams', { ...PACKAGING, weightG: 10.5 }],
    ['too heavy', { ...PACKAGING, weightG: 70_001 }],
    ['two decimals', { ...PACKAGING, lengthCm: 10.25 }],
    ['negative side', { ...PACKAGING, widthCm: -1 }],
    ['too long', { ...PACKAGING, heightCm: 300.1 }],
    ['missing field', { weightG: 1, lengthCm: 1, widthCm: 1 }],
    ['unknown field', { ...PACKAGING, netWeightG: 3 }],
  ])('rejects %s with 400', async (_label, body) => {
    const t = await editor();
    const res = await http()
      .put(`/products/${t.product.id}/packaging`)
      .set('Authorization', `Bearer ${t.token}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(
      await db.productPackaging.count({ where: { productId: t.product.id } }),
    ).toBe(0);
  });

  it('resolvePackageItems returns effective packaging per line, scoped to the tenant', async () => {
    const t = await editor();
    const other = await editor();
    const plain = await db.product.create({
      data: { tenantId: t.tenantId, name: 'Sin empaque' },
    });
    await db.productPackaging.create({
      data: { productId: t.product.id, tenantId: t.tenantId, ...PACKAGING },
    });
    await db.variantPackaging.create({
      data: {
        variantId: t.variant.id,
        tenantId: t.tenantId,
        weightG: 999,
        lengthCm: 1,
        widthCm: 2,
        heightCm: 3,
      },
    });
    await db.productPackaging.create({
      data: {
        productId: other.product.id,
        tenantId: other.tenantId,
        ...PACKAGING,
      },
    });

    const items = await service.resolvePackageItems(t.tenantId, [
      { productId: t.product.id, variantId: null, quantity: 2 },
      { productId: t.product.id, variantId: t.variant.id, quantity: 1 },
      { productId: plain.id, variantId: null, quantity: 1 },
      { productId: other.product.id, variantId: null, quantity: 1 },
      // A variant of another product never lends its override.
      { productId: plain.id, variantId: t.variant.id, quantity: 1 },
    ]);

    expect(items).toEqual([
      {
        productId: t.product.id,
        variantId: null,
        quantity: 2,
        packageWeightG: 450,
        dims: { lengthCm: 20.5, widthCm: 12, heightCm: 8.3 },
      },
      {
        productId: t.product.id,
        variantId: t.variant.id,
        quantity: 1,
        packageWeightG: 999,
        dims: { lengthCm: 1, widthCm: 2, heightCm: 3 },
      },
      {
        productId: plain.id,
        variantId: null,
        quantity: 1,
        packageWeightG: null,
        dims: null,
      },
      {
        productId: other.product.id,
        variantId: null,
        quantity: 1,
        packageWeightG: null,
        dims: null,
      },
      {
        productId: plain.id,
        variantId: t.variant.id,
        quantity: 1,
        packageWeightG: null,
        dims: null,
      },
    ]);
  });
});
