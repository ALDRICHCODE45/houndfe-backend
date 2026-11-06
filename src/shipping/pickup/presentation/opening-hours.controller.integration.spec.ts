/**
 * shipping-zones / T7 (S10) — opening hours routes and the pickup location against
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
import { ClsModule, ClsService } from 'nestjs-cls';
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
import { OpeningHoursService } from '../application/opening-hours.service';
import { OpeningHoursController } from './opening-hours.controller';
import { PickupLocationService } from '../application/pickup-location.service';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';

const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const SECRET = 'opening-hours-it-secret';
const jwt = new JwtService({
  secret: SECRET,
  signOptions: { expiresIn: '1h' },
});

const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];
const SPLIT = [
  { open: '09:00', close: '14:00' },
  { open: '16:00', close: '20:00' },
];
const weekBody = (overrides: Record<string, unknown[]> = {}) => ({
  days: WEEKDAYS.map((day) => ({
    day,
    ranges:
      overrides[day] ?? (day === 'SATURDAY' || day === 'SUNDAY' ? [] : SPLIT),
  })),
});

describeDb('opening hours routes (PostgreSQL)', () => {
  let db: PrismaClient;
  let app: INestApplication;
  let pickup: PickupLocationService;
  let cls: ClsService<TenantClsStore>;
  // The bot checkout calls `resolve` inside its tenant-scoped request.
  const resolveAs = (tenantId: string) =>
    cls.runWith({ tenantId, userId: 'bot', isSuperAdmin: false }, () =>
      pickup.resolve(tenantId),
    );
  const tenants: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[opening-hours]');
    db = new PrismaClient();
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [OpeningHoursController],
      providers: [
        OpeningHoursService,
        PickupLocationService,
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
    pickup = moduleRef.get(PickupLocationService);
    cls = moduleRef.get<ClsService<TenantClsStore>>(ClsService);
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
        name: 'Sucursal Horario',
        slug: `hours-${tenantId}`,
        address: 'Calle libre 1',
      },
    });
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@hours.invalid`,
        name: 'Encargado',
        hashedPassword: 'not-a-login-hash',
      },
    });
    const role = await db.role.create({
      data: { tenantId, name: `Hours ${userId}` },
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
      email: `${userId}@hours.invalid`,
      tenantId,
      tenantSlug: `hours-${tenantId}`,
      isSuperAdmin: false,
    });
    return { tenantId, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = () => request(app.getHttpServer() as Server);
  const url = (tenantId: string) => `/tenants/${tenantId}/opening-hours`;

  it('is unconfigured until PUT, then stores the normalized week', async () => {
    const t = await seedTenant();
    const empty = await http().get(url(t.tenantId)).set(t.auth);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ configured: false, openingHours: null });

    const body = weekBody({
      MONDAY: [SPLIT[1], SPLIT[0]],
      SATURDAY: [{ open: '10:00', close: '14:00' }],
    });
    body.days.reverse();
    const put = await http().put(url(t.tenantId)).set(t.auth).send(body);
    expect(put.status).toBe(200);
    expect(put.headers['cache-control']).toBe('no-store');
    const stored = put.body as {
      configured: boolean;
      openingHours: {
        timeZone: string;
        days: Array<{ day: string; ranges: unknown[] }>;
      };
    };
    expect(stored.configured).toBe(true);
    expect(stored.openingHours.timeZone).toBe('America/Mexico_City');
    expect(stored.openingHours.days.map((d) => d.day)).toEqual(WEEKDAYS);
    expect(stored.openingHours.days[0].ranges).toEqual(SPLIT);

    const read = await http().get(url(t.tenantId)).set(t.auth);
    expect(read.body).toEqual(put.body);
  });

  it.each([
    [
      'overlapping ranges',
      weekBody({ FRIDAY: [SPLIT[0], { open: '13:00', close: '15:00' }] }),
    ],
    [
      'open not before close',
      weekBody({ FRIDAY: [{ open: '18:00', close: '09:00' }] }),
    ],
    ['a missing weekday', { days: weekBody().days.slice(0, 6) }],
    ['an unknown time zone', { ...weekBody(), timeZone: 'Mars/Olympus' }],
  ])('rejects %s with 400 INVALID_OPENING_HOURS', async (_label, body) => {
    const t = await seedTenant();
    const res = await http().put(url(t.tenantId)).set(t.auth).send(body);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_OPENING_HOURS');
    expect(
      await db.tenantOpeningHours.count({ where: { tenantId: t.tenantId } }),
    ).toBe(0);
  });

  it.each([
    [
      'a malformed time',
      weekBody({ MONDAY: [{ open: '9:00', close: '14:00' }] }),
    ],
    ['an unknown day', { days: [{ day: 'FUNDAY', ranges: [] }] }],
    ['an unknown field', { ...weekBody(), note: 'x' }],
  ])('rejects %s with a 400 validation error', async (_label, body) => {
    const t = await seedTenant();
    const res = await http().put(url(t.tenantId)).set(t.auth).send(body);
    expect(res.status).toBe(400);
  });

  it('isolates tenants: another tenant path is 404 and never written', async () => {
    const mine = await seedTenant();
    const other = await seedTenant();
    await http().put(url(other.tenantId)).set(other.auth).send(weekBody());
    expect((await http().get(url(other.tenantId)).set(mine.auth)).status).toBe(
      404,
    );
    const write = await http()
      .put(url(other.tenantId))
      .set(mine.auth)
      .send(weekBody({ SUNDAY: [{ open: '08:00', close: '09:00' }] }));
    expect(write.status).toBe(404);
    const row = await db.tenantOpeningHours.findUnique({
      where: { tenantId: other.tenantId },
    });
    expect(JSON.stringify(row?.days)).not.toContain('08:00');
    expect((await http().get(url(mine.tenantId)).set(mine.auth)).body).toEqual({
      configured: false,
      openingHours: null,
    });
  });

  it('requires read to GET and update to PUT', async () => {
    const reader = await seedTenant([['ShippingSettings', 'read']]);
    const stranger = await seedTenant([['Product', 'read']]);
    expect(
      (await http().get(url(reader.tenantId)).set(reader.auth)).status,
    ).toBe(200);
    expect(
      (await http().put(url(reader.tenantId)).set(reader.auth).send(weekBody()))
        .status,
    ).toBe(403);
    expect(
      (await http().get(url(stranger.tenantId)).set(stranger.auth)).status,
    ).toBe(403);
    expect((await http().get(url(reader.tenantId))).status).toBe(401);
  });

  it('pickup location reads only the given tenant (origin, hours, name)', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    await db.shippingOrigin.create({
      data: {
        tenantId: other.tenantId,
        addressLine1: 'Ajena 9',
        neighborhood: 'Otra',
        municipality: 'Otra',
        state: 'Otra',
        postalCode: '99999',
        contactPhone: '5512345678',
      },
    });
    await http().put(url(other.tenantId)).set(other.auth).send(weekBody());

    const fallback = await resolveAs(t.tenantId);
    expect(fallback).toEqual({
      name: 'Sucursal Horario',
      address: expect.objectContaining({
        formatted: 'Calle libre 1',
        postalCode: null,
      }) as unknown,
      hours: null,
    });

    await db.shippingOrigin.create({
      data: {
        tenantId: t.tenantId,
        addressLine1: 'Av. Juárez 123',
        neighborhood: 'Centro',
        municipality: 'Cuauhtémoc',
        state: 'Ciudad de México',
        postalCode: '06000',
        contactPhone: '5512345678',
      },
    });
    await http()
      .put(url(t.tenantId))
      .set(t.auth)
      .send(weekBody({ SATURDAY: [{ open: '10:00', close: '14:00' }] }));
    const location = await resolveAs(t.tenantId);
    expect(location.address?.formatted).toBe(
      'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
    );
    expect(location.hours?.summary).toBe(
      'Lunes a viernes: 09:00–14:00 y 16:00–20:00. Sábado: 10:00–14:00. Domingo: cerrado.',
    );
  });
});
