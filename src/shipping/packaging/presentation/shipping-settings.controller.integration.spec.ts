/**
 * shipping-zones / T2 (S5) — standard boxes and shipping origin routes against
 * REAL PostgreSQL through the real JWT → TenantContext → Permissions chain
 * (CASL reading RolePermission rows). Fixtures live under random tenants
 * removed afterwards.
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
import { ShippingSettingsService } from '../application/shipping-settings.service';
import { ShippingSettingsController } from './shipping-settings.controller';

const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const SECRET = 'shipping-settings-it-secret';
const jwt = new JwtService({
  secret: SECRET,
  signOptions: { expiresIn: '1h' },
});

const BOX = {
  name: 'Caja chica',
  innerLengthCm: 20,
  innerWidthCm: 15.5,
  innerHeightCm: 10,
  weightG: 120,
  maxContentWeightG: 5000,
};
const ORIGIN = {
  addressLine1: 'Av. Juárez 123',
  addressLine2: 'Local 4',
  neighborhood: 'Centro',
  municipality: 'Cuauhtémoc',
  state: 'Ciudad de México',
  postalCode: '06000',
  contactPhone: '5512345678',
};

describeDb('shipping settings routes (PostgreSQL)', () => {
  let db: PrismaClient;
  let app: INestApplication;
  let service: ShippingSettingsService;
  const tenants: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[shipping-settings]');
    db = new PrismaClient();
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [ShippingSettingsController],
      providers: [
        ShippingSettingsService,
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
    service = moduleRef.get(ShippingSettingsService);
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

  async function seedTenant(
    grants: [string, string][] = [
      ['ShippingSettings', 'read'],
      ['ShippingSettings', 'update'],
    ],
  ) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenants.push(tenantId);
    users.push(userId);
    await db.tenant.create({
      data: {
        id: tenantId,
        name: 'Shipping IT',
        slug: `ship-${tenantId}`,
        address: 'texto libre',
      },
    });
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@shipping.invalid`,
        name: 'Shipper',
        hashedPassword: 'not-a-login-hash',
      },
    });
    const role = await db.role.create({
      data: { tenantId, name: `Shipping ${userId}` },
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
    const token = jwt.sign({
      sub: userId,
      email: `${userId}@shipping.invalid`,
      tenantId,
      tenantSlug: `ship-${tenantId}`,
      isSuperAdmin: false,
    });
    return { tenantId, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = () => request(app.getHttpServer() as Server);
  const boxesUrl = (tenantId: string) => `/tenants/${tenantId}/shipping-boxes`;
  const originUrl = (tenantId: string) =>
    `/tenants/${tenantId}/shipping-origin`;

  describe('standard boxes', () => {
    it('creates, lists, updates, deactivates and deletes a box', async () => {
      const t = await seedTenant();
      const created = await http()
        .post(boxesUrl(t.tenantId))
        .set(t.auth)
        .send(BOX);
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.any(String) as unknown,
        ...BOX,
        isActive: true,
        createdAt: expect.any(String) as unknown,
        updatedAt: expect.any(String) as unknown,
      });
      const id = (created.body as { id: string }).id;

      const listed = await http().get(boxesUrl(t.tenantId)).set(t.auth);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({ data: [created.body] });

      const patched = await http()
        .patch(`${boxesUrl(t.tenantId)}/${id}`)
        .set(t.auth)
        .send({ isActive: false, innerHeightCm: 12.5 });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        isActive: false,
        innerHeightCm: 12.5,
        name: BOX.name,
      });

      const removed = await http()
        .delete(`${boxesUrl(t.tenantId)}/${id}`)
        .set(t.auth);
      expect(removed.status).toBe(204);
      expect(await db.shippingBox.count({ where: { id } })).toBe(0);
    });

    it('rejects a duplicate name in the same tenant with 409, allows it in another', async () => {
      const t = await seedTenant();
      const other = await seedTenant();
      await http().post(boxesUrl(t.tenantId)).set(t.auth).send(BOX);
      const dup = await http().post(boxesUrl(t.tenantId)).set(t.auth).send(BOX);
      expect(dup.status).toBe(409);
      expect((dup.body as { error: string }).error).toBe(
        'ENTITY_ALREADY_EXISTS',
      );
      const elsewhere = await http()
        .post(boxesUrl(other.tenantId))
        .set(other.auth)
        .send(BOX);
      expect(elsewhere.status).toBe(201);
    });

    it('isolates tenants: foreign path is 404 and a foreign box id is 404', async () => {
      const mine = await seedTenant();
      const other = await seedTenant();
      const foreign = await http()
        .post(boxesUrl(other.tenantId))
        .set(other.auth)
        .send(BOX);
      const foreignId = (foreign.body as { id: string }).id;

      const listForeign = await http()
        .get(boxesUrl(other.tenantId))
        .set(mine.auth);
      expect(listForeign.status).toBe(404);
      const createForeign = await http()
        .post(boxesUrl(other.tenantId))
        .set(mine.auth)
        .send({ ...BOX, name: 'intrusa' });
      expect(createForeign.status).toBe(404);

      const patchViaOwnPath = await http()
        .patch(`${boxesUrl(mine.tenantId)}/${foreignId}`)
        .set(mine.auth)
        .send({ isActive: false });
      expect(patchViaOwnPath.status).toBe(404);
      const deleteViaOwnPath = await http()
        .delete(`${boxesUrl(mine.tenantId)}/${foreignId}`)
        .set(mine.auth);
      expect(deleteViaOwnPath.status).toBe(404);

      const row = await db.shippingBox.findUnique({ where: { id: foreignId } });
      expect(row?.isActive).toBe(true);
      expect(
        await db.shippingBox.count({ where: { tenantId: other.tenantId } }),
      ).toBe(1);
      const ownList = await http().get(boxesUrl(mine.tenantId)).set(mine.auth);
      expect(ownList.body).toEqual({ data: [] });
    });

    it('requires read:ShippingSettings to list and update:ShippingSettings to write', async () => {
      const reader = await seedTenant([['ShippingSettings', 'read']]);
      const productEditor = await seedTenant([
        ['Product', 'read'],
        ['Product', 'update'],
      ]);
      expect(
        (await http().get(boxesUrl(reader.tenantId)).set(reader.auth)).status,
      ).toBe(200);
      expect(
        (
          await http()
            .post(boxesUrl(reader.tenantId))
            .set(reader.auth)
            .send(BOX)
        ).status,
      ).toBe(403);
      expect(
        (
          await http()
            .get(boxesUrl(productEditor.tenantId))
            .set(productEditor.auth)
        ).status,
      ).toBe(403);
      expect((await http().get(boxesUrl(reader.tenantId))).status).toBe(401);
    });

    it.each([
      ['blank name', { ...BOX, name: '   ' }],
      ['zero own weight', { ...BOX, weightG: 0 }],
      ['fractional max weight', { ...BOX, maxContentWeightG: 10.5 }],
      ['max weight above 70 kg', { ...BOX, maxContentWeightG: 70_001 }],
      ['two decimals', { ...BOX, innerLengthCm: 20.25 }],
      ['side above 300 cm', { ...BOX, innerWidthCm: 301 }],
      ['missing dimension', { ...BOX, innerHeightCm: undefined }],
      ['unknown field', { ...BOX, color: 'café' }],
    ])('rejects %s with 400 on create', async (_label, body) => {
      const t = await seedTenant();
      const res = await http()
        .post(boxesUrl(t.tenantId))
        .set(t.auth)
        .send(body);
      expect(res.status).toBe(400);
      expect(
        await db.shippingBox.count({ where: { tenantId: t.tenantId } }),
      ).toBe(0);
    });

    it('rejects an invalid partial update with 400', async () => {
      const t = await seedTenant();
      const created = await http()
        .post(boxesUrl(t.tenantId))
        .set(t.auth)
        .send(BOX);
      const res = await http()
        .patch(`${boxesUrl(t.tenantId)}/${(created.body as { id: string }).id}`)
        .set(t.auth)
        .send({ weightG: -5 });
      expect(res.status).toBe(400);
    });
  });

  it('listActiveBoxes returns only active boxes of the given tenant, outside a request', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    await http().post(boxesUrl(t.tenantId)).set(t.auth).send(BOX);
    await http()
      .post(boxesUrl(t.tenantId))
      .set(t.auth)
      .send({ ...BOX, name: 'Retirada', isActive: false });
    await http()
      .post(boxesUrl(other.tenantId))
      .set(other.auth)
      .send({ ...BOX, name: 'Ajena' });

    const boxes = await service.listActiveBoxes(t.tenantId);
    expect(boxes).toEqual([
      {
        id: expect.any(String) as unknown,
        name: BOX.name,
        innerLengthCm: 20,
        innerWidthCm: 15.5,
        innerHeightCm: 10,
        weightG: 120,
        maxContentWeightG: 5000,
      },
    ]);
  });

  describe('shipping origin', () => {
    it('is unconfigured until PUT, then returns the stored origin', async () => {
      const t = await seedTenant();
      const empty = await http().get(originUrl(t.tenantId)).set(t.auth);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ configured: false, origin: null });

      const put = await http()
        .put(originUrl(t.tenantId))
        .set(t.auth)
        .send(ORIGIN);
      expect(put.status).toBe(200);
      expect(put.body).toEqual({
        configured: true,
        origin: { ...ORIGIN, updatedAt: expect.any(String) as unknown },
      });

      const replaced = await http()
        .put(originUrl(t.tenantId))
        .set(t.auth)
        .send({ ...ORIGIN, addressLine2: undefined, postalCode: '44100' });
      expect(replaced.body).toMatchObject({
        origin: { addressLine2: null, postalCode: '44100' },
      });

      // Tenant.address keeps its own free-text meaning.
      const tenant = await db.tenant.findUnique({ where: { id: t.tenantId } });
      expect(tenant?.address).toBe('texto libre');
    });

    it('isolates tenants: another tenant path is 404 and never written', async () => {
      const mine = await seedTenant();
      const other = await seedTenant();
      const read = await http().get(originUrl(other.tenantId)).set(mine.auth);
      expect(read.status).toBe(404);
      const write = await http()
        .put(originUrl(other.tenantId))
        .set(mine.auth)
        .send(ORIGIN);
      expect(write.status).toBe(404);
      expect(
        await db.shippingOrigin.count({ where: { tenantId: other.tenantId } }),
      ).toBe(0);
    });

    it('requires update:ShippingSettings to write', async () => {
      const reader = await seedTenant([['ShippingSettings', 'read']]);
      const res = await http()
        .put(originUrl(reader.tenantId))
        .set(reader.auth)
        .send(ORIGIN);
      expect(res.status).toBe(403);
    });

    it.each([
      ['4-digit postal code', { ...ORIGIN, postalCode: '6000' }],
      ['letters in postal code', { ...ORIGIN, postalCode: '06A00' }],
      ['short phone', { ...ORIGIN, contactPhone: '12345' }],
      ['blank neighborhood', { ...ORIGIN, neighborhood: ' ' }],
      ['missing state', { ...ORIGIN, state: undefined }],
      ['unknown field', { ...ORIGIN, country: 'MX' }],
    ])('rejects %s with 400', async (_label, body) => {
      const t = await seedTenant();
      const res = await http()
        .put(originUrl(t.tenantId))
        .set(t.auth)
        .send(body);
      expect(res.status).toBe(400);
    });
  });
});
