/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- supertest bodies are untyped JSON */
/**
 * customer-pets / T2 (S6) — the bot routes under
 * `/chatbot-api/customers/:customerId/pets` against REAL PostgreSQL.
 *
 * Boots the REAL `CustomerPetsModule` (guard, controller, create service, the
 * real tenant Prisma extension) with only the credential repository replaced by
 * in-memory fixtures and the audit-log repository by a recorder (the in-memory
 * credentials have no `service_credentials` row for the audit FK). Cleanup
 * deletes only the tenants it created.
 *
 * Every test asserts the status, the exact error body and the database state
 * (unchanged on every rejection).
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BOT_AUDIT_LOG_REPOSITORY,
  type BotAuditLogEntry,
} from '../chatbot-api/infrastructure/prisma-bot-audit-log.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { CustomerPetsModule } from './customer-pets.module';
import { CUSTOMER_PET_SCOPES } from './domain/customer-pet-scopes';
import {
  CUSTOMER_PET_CREATE_RECEIPT_KIND,
  petCreateLockKey,
} from './presentation/bot/customer-pet-bot-create.service';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const ALL_SCOPES = [
  CUSTOMER_PET_SCOPES.read,
  CUSTOMER_PET_SCOPES.write,
  CUSTOMER_PET_SCOPES.delete,
];

d('customer pets — bot routes (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const audit: BotAuditLogEntry[] = [];
  const tenantIds: string[] = [];
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              // Boot-time reads of unrelated modules in the real graph.
              JWT_SECRET: 'customer-pets-bot-test-secret',
              JWT_REFRESH_SECRET: 'customer-pets-bot-test-refresh',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        CustomerPetsModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .overrideProvider(BOT_AUDIT_LOG_REPOSITORY)
      .useValue({
        append: (entry: BotAuditLogEntry) => {
          audit.push(entry);
          return Promise.resolve();
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    audit.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await disconnectWorldPrisma();
  });

  interface World {
    tenantId: string;
    customerId: string;
    token: string;
  }

  async function world(scopes: string[] = ALL_SCOPES): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Pets ${tenantId.slice(0, 6)}`,
        slug: tenantId,
      },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Rosa' },
    });
    return {
      tenantId,
      customerId,
      token: credentials.register(tenantId, scopes),
    };
  }

  const base = (customerId: string) =>
    `/chatbot-api/customers/${customerId}/pets`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  const list = (token: string, customerId: string, status = '') =>
    http()
      .get(`${base(customerId)}${status}`)
      .set(auth(token));
  const create = (
    token: string,
    customerId: string,
    body: object,
    key: string | null = randomUUID(),
  ) => {
    const req = http().post(base(customerId)).set(auth(token));
    return (key === null ? req : req.set('X-Idempotency-Key', key)).send(body);
  };
  const patch = (
    token: string,
    customerId: string,
    petId: string,
    body: object,
  ) =>
    http()
      .patch(`${base(customerId)}/${petId}`)
      .set(auth(token))
      .send(body);
  const archive = (
    token: string,
    customerId: string,
    petId: string,
    body: object,
  ) =>
    http()
      .post(`${base(customerId)}/${petId}/archive`)
      .set(auth(token))
      .send(body);
  const restore = (
    token: string,
    customerId: string,
    petId: string,
    body: object,
  ) =>
    http()
      .post(`${base(customerId)}/${petId}/restore`)
      .set(auth(token))
      .send(body);
  const erase = (
    token: string,
    customerId: string,
    petId: string,
    query = '',
  ) =>
    http()
      .delete(`${base(customerId)}/${petId}${query}`)
      .set(auth(token));

  const bruno = {
    name: 'Bruno',
    species: 'DOG',
    breed: 'Chihuahua',
    approxAge: { months: 10 },
    allergies: 'Pollo',
  };

  async function seedPet(
    w: World,
    name = 'Max',
    over: Record<string, unknown> = {},
    customerId = w.customerId,
  ) {
    return prisma.customerPet.create({
      data: {
        tenantId: w.tenantId,
        customerId,
        name,
        nameKey: name.toLowerCase(),
        species: 'DOG',
        createdVia: 'POS',
        ...over,
      },
    });
  }

  const petRows = (customerId: string) =>
    prisma.customerPet.findMany({
      where: { customerId },
      orderBy: { id: 'asc' },
    });
  const receipts = (tenantId: string) =>
    prisma.chatbotBotReceipt.findMany({
      where: { tenantId, kind: CUSTOMER_PET_CREATE_RECEIPT_KIND },
    });

  describe('scopes', () => {
    it('401 without a credential and 403 with customers:read only (nothing is written)', async () => {
      const w = await world();
      const pet = await seedPet(w);
      const unrelated = credentials.register(w.tenantId, ['customers:read']);

      const anonymous = await http().get(base(w.customerId)).expect(401);
      expect(anonymous.body.message).toBe('Service authorization required');
      const forbidden = await create(unrelated, w.customerId, bruno).expect(
        403,
      );
      expect(forbidden.body).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Insufficient service scope',
      });
      await list(unrelated, w.customerId).expect(403);
      await erase(unrelated, w.customerId, pet.id, '?version=1').expect(403);

      expect(await petRows(w.customerId)).toHaveLength(1);
      expect(await receipts(w.tenantId)).toHaveLength(0);
    });

    it.each([
      [
        'pets:read',
        ['GET list'],
        ['POST create', 'PATCH', 'archive', 'restore', 'DELETE'],
      ],
      [
        'pets:write',
        ['POST create', 'PATCH', 'archive', 'restore'],
        ['GET list', 'DELETE'],
      ],
      [
        'pets:delete',
        ['DELETE'],
        ['GET list', 'POST create', 'PATCH', 'archive', 'restore'],
      ],
    ])('%s opens only its own routes', async (scope, allowed, denied) => {
      const w = await world();
      const active = await seedPet(w, 'Activo');
      const archived = await seedPet(w, 'Archivado', {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });
      const token = credentials.register(w.tenantId, [scope]);
      const calls: Record<string, () => request.Test> = {
        'GET list': () => list(token, w.customerId),
        'POST create': () => create(token, w.customerId, bruno),
        PATCH: () =>
          patch(token, w.customerId, active.id, { version: 1, notes: 'x' }),
        archive: () => archive(token, w.customerId, active.id, { version: 1 }),
        restore: () =>
          restore(token, w.customerId, archived.id, { version: 1 }),
        DELETE: () => erase(token, w.customerId, archived.id, '?version=1'),
      };

      for (const name of denied) {
        const res = await calls[name]().expect(403);
        expect(res.body.message).toBe('Insufficient service scope');
      }
      // Nothing the denied calls could have done happened.
      const rows = await petRows(w.customerId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => [r.name, r.status, r.version]).sort()).toEqual([
        ['Activo', 'ACTIVE', 1],
        ['Archivado', 'ARCHIVED', 1],
      ]);
      expect(await receipts(w.tenantId)).toHaveLength(0);

      for (const name of allowed) {
        expect((await calls[name]()).status).not.toBe(403);
      }
    });
  });

  describe('create (idempotent)', () => {
    it('201 with the complete pet, createdVia CHATBOT, warnings [], and the receipt in the same commit', async () => {
      const w = await world();
      const key = randomUUID();

      const res = await create(w.token, w.customerId, bruno, key).expect(201);

      expect(res.body).toMatchObject({
        customerId: w.customerId,
        name: 'Bruno',
        species: 'DOG',
        breed: 'Chihuahua',
        birthDatePrecision: 'MONTH',
        ageMonths: 10,
        ageLabel: '~10 meses',
        allergies: 'Pollo',
        status: 'ACTIVE',
        createdVia: 'CHATBOT',
        version: 1,
        warnings: [],
      });
      const rows = await petRows(w.customerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: res.body.id,
        createdVia: 'CHATBOT',
        tenantId: w.tenantId,
      });
      const stored = await receipts(w.tenantId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        idempotencyKey: key,
        kind: 'CUSTOMER_PET_CREATE',
      });
      expect(stored[0].commandHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored[0].responseSnapshot).toEqual(res.body);
    });

    it('same key + same body replays the first response with 200: no second pet, no second receipt', async () => {
      const w = await world();
      const key = randomUUID();
      const first = await create(w.token, w.customerId, bruno, key).expect(201);
      // The pet changes after the first answer: the replay is the FIRST response.
      await patch(w.token, w.customerId, first.body.id, {
        version: 1,
        notes: 'cambio',
      }).expect(200);

      const replay = await create(w.token, w.customerId, bruno, key).expect(
        200,
      );

      expect(replay.body).toEqual(first.body);
      const rows = await petRows(w.customerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ notes: 'cambio', version: 2 });
      expect(await receipts(w.tenantId)).toHaveLength(1);
    });

    it('a retry that spells absence as null still replays (200)', async () => {
      const w = await world();
      const key = randomUUID();
      const first = await create(
        w.token,
        w.customerId,
        { name: 'Luna', species: 'CAT' },
        key,
      ).expect(201);

      const replay = await create(
        w.token,
        w.customerId,
        { name: 'Luna', species: 'CAT', breed: null, notes: null },
        key,
      ).expect(200);

      expect(replay.body).toEqual(first.body);
      expect(await petRows(w.customerId)).toHaveLength(1);
    });

    it('same key + different body is 409 IDEMPOTENCY_KEY_CONFLICT and changes nothing', async () => {
      const w = await world();
      const key = randomUUID();
      await create(w.token, w.customerId, bruno, key).expect(201);
      const before = await receipts(w.tenantId);

      const res = await create(
        w.token,
        w.customerId,
        { ...bruno, name: 'Max' },
        key,
      ).expect(409);

      expect(res.body).toEqual({
        statusCode: 409,
        error: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'IDEMPOTENCY_KEY_CONFLICT',
      });
      expect((await petRows(w.customerId)).map((r) => r.name)).toEqual([
        'Bruno',
      ]);
      expect(await receipts(w.tenantId)).toEqual(before);
    });

    it('the same key and body for ANOTHER customer is a conflict, not a replay', async () => {
      const w = await world();
      const other = randomUUID();
      await prisma.customer.create({
        data: { id: other, tenantId: w.tenantId, firstName: 'Luis' },
      });
      const key = randomUUID();
      await create(w.token, w.customerId, bruno, key).expect(201);

      const res = await create(w.token, other, bruno, key).expect(409);

      expect(res.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(await petRows(other)).toHaveLength(0);
    });

    it.each([
      ['missing', null],
      ['blank', '   '],
      ['over 200 characters', 'k'.repeat(201)],
    ])(
      '%s key is 400 INVALID_IDEMPOTENCY_KEY before any write',
      async (_label, key) => {
        const w = await world();

        const res = await create(w.token, w.customerId, bruno, key).expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          error: 'INVALID_IDEMPOTENCY_KEY',
          message: 'INVALID_IDEMPOTENCY_KEY',
        });
        expect(await petRows(w.customerId)).toHaveLength(0);
        expect(await receipts(w.tenantId)).toHaveLength(0);
      },
    );

    it('a key in flight (held by another transaction) is 409 IDEMPOTENCY_KEY_IN_FLIGHT; the key works after release', async () => {
      const w = await world();
      const key = randomUUID();
      const lock = petCreateLockKey(w.tenantId, key);
      let inFlight: request.Response | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
        inFlight = await create(w.token, w.customerId, bruno, key);
        expect(await petRows(w.customerId)).toHaveLength(0);
      });

      expect(inFlight?.status).toBe(409);
      expect(inFlight?.body).toEqual({
        statusCode: 409,
        error: 'IDEMPOTENCY_KEY_IN_FLIGHT',
        message: 'IDEMPOTENCY_KEY_IN_FLIGHT',
      });
      expect(await receipts(w.tenantId)).toHaveLength(0);
      await create(w.token, w.customerId, bruno, key).expect(201);
      expect(await petRows(w.customerId)).toHaveLength(1);
    });

    it('concurrent identical creates produce exactly one pet and one receipt', async () => {
      const w = await world();
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          create(w.token, w.customerId, bruno, key),
        ),
      );

      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body.error).toBe('IDEMPOTENCY_KEY_IN_FLIGHT');
      }
      expect(await petRows(w.customerId)).toHaveLength(1);
      expect(await receipts(w.tenantId)).toHaveLength(1);
    });

    it('the pet and the receipt are atomic: a failing receipt write leaves no pet; the retry then creates it', async () => {
      const w = await world();
      const key = randomUUID();
      const realGetClient = TenantPrismaService.prototype.getClient;
      jest
        .spyOn(TenantPrismaService.prototype, 'getClient')
        .mockImplementation(function (this: TenantPrismaService) {
          const client = realGetClient.call(this);
          return new Proxy(client, {
            get: (target, prop, receiver) =>
              prop === 'chatbotBotReceipt'
                ? {
                    findFirst: (args: never) =>
                      target.chatbotBotReceipt.findFirst(args),
                    create: () =>
                      Promise.reject(new Error('receipt write failed')),
                  }
                : Reflect.get(target, prop, receiver),
          });
        });

      const failed = await create(w.token, w.customerId, bruno, key).expect(
        500,
      );

      expect(failed.body).toEqual({
        statusCode: 500,
        error: 'CUSTOMER_PET_REQUEST_FAILED',
        message: 'CUSTOMER_PET_REQUEST_FAILED',
      });
      expect(await petRows(w.customerId)).toHaveLength(0);
      expect(await receipts(w.tenantId)).toHaveLength(0);

      jest.restoreAllMocks();
      await create(w.token, w.customerId, bruno, key).expect(201);
      expect(await petRows(w.customerId)).toHaveLength(1);
      expect(await receipts(w.tenantId)).toHaveLength(1);
    });

    it('a rejected create (limit reached) stores no receipt, so the same key works once a slot frees up', async () => {
      const w = await world();
      const seeded = [];
      for (let i = 0; i < 20; i += 1) seeded.push(await seedPet(w, `Pet${i}`));
      const key = randomUUID();

      const res = await create(w.token, w.customerId, bruno, key).expect(422);

      expect(res.body).toEqual({
        statusCode: 422,
        error: 'PET_LIMIT_REACHED',
        message: 'PET_LIMIT_REACHED',
      });
      expect(await petRows(w.customerId)).toHaveLength(20);
      expect(await receipts(w.tenantId)).toHaveLength(0);

      await archive(w.token, w.customerId, seeded[0].id, { version: 1 }).expect(
        200,
      );
      await create(w.token, w.customerId, bruno, key).expect(201);
      expect(await receipts(w.tenantId)).toHaveLength(1);
    });

    it('400 per-field validation and 404 CUSTOMER_NOT_FOUND write nothing', async () => {
      const w = await world();

      const invalid = await create(w.token, w.customerId, {
        name: '',
        species: 'FISH',
      }).expect(400);
      expect(invalid.body.message).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'name' }),
          expect.objectContaining({ property: 'species' }),
        ]),
      );
      const missing = await create(w.token, randomUUID(), bruno).expect(404);
      expect(missing.body).toEqual({
        statusCode: 404,
        error: 'CUSTOMER_NOT_FOUND',
        message: 'CUSTOMER_NOT_FOUND',
      });
      await create(w.token, 'not-a-uuid', bruno).expect(400);

      expect(await petRows(w.customerId)).toHaveLength(0);
      expect(await receipts(w.tenantId)).toHaveLength(0);
    });

    it('PET_NAME_DUPLICATE is a warning, not an error', async () => {
      const w = await world();
      await seedPet(w, 'bruno');

      const res = await create(w.token, w.customerId, bruno).expect(201);

      expect(res.body.warnings).toEqual(['PET_NAME_DUPLICATE']);
      expect(await petRows(w.customerId)).toHaveLength(2);
    });
  });

  describe('list, patch, archive, restore, delete', () => {
    it('lists by ?status and rejects an unknown status with 400', async () => {
      const w = await world();
      await seedPet(w, 'Activo');
      await seedPet(w, 'Archivado', {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });

      expect(
        (await list(w.token, w.customerId).expect(200)).body.map(
          (p: any) => p.name,
        ),
      ).toEqual(['Activo']);
      expect(
        (
          await list(w.token, w.customerId, '?status=ARCHIVED').expect(200)
        ).body.map((p: any) => p.name),
      ).toEqual(['Archivado']);
      expect(
        (await list(w.token, w.customerId, '?status=ALL').expect(200)).body,
      ).toHaveLength(2);
      await list(w.token, w.customerId, '?status=BOGUS').expect(400);
      const missing = await list(w.token, randomUUID()).expect(404);
      expect(missing.body.error).toBe('CUSTOMER_NOT_FOUND');
    });

    it('PATCH is partial, bumps the version; a stale version is 409 with currentVersion and changes nothing', async () => {
      const w = await world();
      const pet = await seedPet(w, 'Bruno', {
        allergies: 'Pollo',
        breed: 'Mestizo',
      });

      const ok = await patch(w.token, w.customerId, pet.id, {
        version: 1,
        breed: null,
      }).expect(200);
      expect(ok.body).toMatchObject({
        id: pet.id,
        version: 2,
        breed: null,
        allergies: 'Pollo',
        warnings: [],
      });

      const stale = await patch(w.token, w.customerId, pet.id, {
        version: 1,
        name: 'Otro',
      }).expect(409);
      expect(stale.body).toEqual({
        statusCode: 409,
        error: 'PET_VERSION_CONFLICT',
        message: 'PET_VERSION_CONFLICT',
        currentVersion: 2,
      });
      expect(
        await prisma.customerPet.findUnique({ where: { id: pet.id } }),
      ).toMatchObject({
        name: 'Bruno',
        breed: null,
        version: 2,
      });
      await patch(w.token, w.customerId, pet.id, {
        name: 'Sin version',
      }).expect(400);
    });

    it('archive → PET_ARCHIVED on edit/archive → restore → PET_NOT_ARCHIVED, versions advancing', async () => {
      const w = await world();
      const pet = await seedPet(w, 'Bruno');

      const archived = await archive(w.token, w.customerId, pet.id, {
        version: 1,
        reason: 'Ya no está',
      }).expect(200);
      expect(archived.body).toMatchObject({
        status: 'ARCHIVED',
        archivedReason: 'Ya no está',
        version: 2,
      });
      expect(
        (
          await patch(w.token, w.customerId, pet.id, {
            version: 2,
            notes: 'x',
          }).expect(422)
        ).body.error,
      ).toBe('PET_ARCHIVED');
      expect(
        (
          await archive(w.token, w.customerId, pet.id, { version: 2 }).expect(
            422,
          )
        ).body.error,
      ).toBe('PET_ARCHIVED');
      expect(
        await prisma.customerPet.findUnique({ where: { id: pet.id } }),
      ).toMatchObject({ status: 'ARCHIVED', version: 2, notes: null });

      const restored = await restore(w.token, w.customerId, pet.id, {
        version: 2,
      }).expect(200);
      expect(restored.body).toMatchObject({
        status: 'ACTIVE',
        archivedAt: null,
        archivedReason: null,
        version: 3,
        warnings: [],
      });
      const again = await restore(w.token, w.customerId, pet.id, {
        version: 3,
      }).expect(422);
      expect(again.body.error).toBe('PET_NOT_ARCHIVED');
      expect((await petRows(w.customerId))[0]).toMatchObject({
        status: 'ACTIVE',
        version: 3,
      });
    });

    it('DELETE ?version=N is 204 and erases; again → 404 PET_NOT_FOUND; stale 409; missing/non-integer version 400', async () => {
      const w = await world();
      const pet = await seedPet(w, 'Bruno');

      await erase(w.token, w.customerId, pet.id).expect(400);
      await erase(w.token, w.customerId, pet.id, '?version=abc').expect(400);
      const stale = await erase(
        w.token,
        w.customerId,
        pet.id,
        '?version=9',
      ).expect(409);
      expect(stale.body).toEqual({
        statusCode: 409,
        error: 'PET_VERSION_CONFLICT',
        message: 'PET_VERSION_CONFLICT',
        currentVersion: 1,
      });
      expect(await petRows(w.customerId)).toHaveLength(1);

      const done = await erase(
        w.token,
        w.customerId,
        pet.id,
        '?version=1',
      ).expect(204);
      expect(done.text).toBe('');
      expect(await petRows(w.customerId)).toHaveLength(0);
      const gone = await erase(
        w.token,
        w.customerId,
        pet.id,
        '?version=1',
      ).expect(404);
      expect(gone.body).toEqual({
        statusCode: 404,
        error: 'PET_NOT_FOUND',
        message: 'PET_NOT_FOUND',
      });
    });
  });

  describe('tenant isolation', () => {
    it("another sucursal's credential cannot read or touch the pets (404, nothing changes, no receipt)", async () => {
      const a = await world();
      const b = await world();
      const pet = await seedPet(a, 'Bruno');
      const before = await petRows(a.customerId);

      const listed = await list(b.token, a.customerId).expect(404);
      expect(listed.body.error).toBe('CUSTOMER_NOT_FOUND');
      await create(b.token, a.customerId, bruno).expect(404);
      await patch(b.token, a.customerId, pet.id, {
        version: 1,
        name: 'X',
      }).expect(404);
      await archive(b.token, a.customerId, pet.id, { version: 1 }).expect(404);
      await restore(b.token, a.customerId, pet.id, { version: 1 }).expect(404);
      const erased = await erase(
        b.token,
        a.customerId,
        pet.id,
        '?version=1',
      ).expect(404);
      expect(erased.body.error).toBe('CUSTOMER_NOT_FOUND');

      expect(await petRows(a.customerId)).toEqual(before);
      expect(await receipts(a.tenantId)).toHaveLength(0);
      expect(await receipts(b.tenantId)).toHaveLength(0);
    });

    it('a pet of ANOTHER customer of the same tenant is PET_NOT_FOUND on every pet route', async () => {
      const w = await world();
      const other = randomUUID();
      await prisma.customer.create({
        data: { id: other, tenantId: w.tenantId, firstName: 'Luis' },
      });
      const pet = await seedPet(w, 'Bruno', {}, other);

      for (const res of [
        await patch(w.token, w.customerId, pet.id, {
          version: 1,
          notes: 'x',
        }).expect(404),
        await archive(w.token, w.customerId, pet.id, { version: 1 }).expect(
          404,
        ),
        await restore(w.token, w.customerId, pet.id, { version: 1 }).expect(
          404,
        ),
        await erase(w.token, w.customerId, pet.id, '?version=1').expect(404),
      ]) {
        expect(res.body.error).toBe('PET_NOT_FOUND');
      }
      expect(await petRows(other)).toHaveLength(1);
      expect((await petRows(other))[0]).toMatchObject({
        version: 1,
        status: 'ACTIVE',
        notes: null,
      });
    });

    it('the same idempotency key in two sucursales is two independent receipts', async () => {
      const a = await world();
      const b = await world();
      const key = randomUUID();

      await create(a.token, a.customerId, bruno, key).expect(201);
      await create(b.token, b.customerId, bruno, key).expect(201);

      expect(await receipts(a.tenantId)).toHaveLength(1);
      expect(await receipts(b.tenantId)).toHaveLength(1);
      expect(await petRows(a.customerId)).toHaveLength(1);
      expect(await petRows(b.customerId)).toHaveLength(1);
    });
  });

  describe('audit', () => {
    it('every route lands on the allowlist with its action and resource id', async () => {
      const w = await world();
      const pet = await seedPet(w, 'Bruno');

      await list(w.token, w.customerId).expect(200);
      await create(w.token, w.customerId, bruno).expect(201);
      await patch(w.token, w.customerId, pet.id, {
        version: 1,
        notes: 'x',
      }).expect(200);
      await archive(w.token, w.customerId, pet.id, { version: 2 }).expect(200);
      await restore(w.token, w.customerId, pet.id, { version: 3 }).expect(200);
      await erase(w.token, w.customerId, pet.id, '?version=4').expect(204);

      expect(
        audit.map((e) => [e.action, e.resourceType, e.resourceId, e.tenantId]),
      ).toEqual([
        ['customer_pets.list', 'customer', w.customerId, w.tenantId],
        ['customer_pets.create', 'customer', w.customerId, w.tenantId],
        ['customer_pets.update', 'customer_pet', pet.id, w.tenantId],
        ['customer_pets.archive', 'customer_pet', pet.id, w.tenantId],
        ['customer_pets.restore', 'customer_pet', pet.id, w.tenantId],
        ['customer_pets.delete', 'customer_pet', pet.id, w.tenantId],
      ]);
    });
  });
});
