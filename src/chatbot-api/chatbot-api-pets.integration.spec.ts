/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped JSON */
/**
 * customer-pets / T2 (S6 by-phone pets, S8 bot order history by pet) — the two
 * EXISTING bot routes `GET customers/by-phone` and
 * `GET customers/by-phone/:phone/orders` with their additive pet members,
 * against REAL PostgreSQL.
 *
 * Boots the real `ChatbotApiModule` + `CustomerPetsModule` (guard, controllers,
 * the real tenant Prisma extension); only the credential repository is replaced
 * by in-memory fixtures and the audit-log repository by a recorder (the
 * in-memory credentials have no `service_credentials` row for the audit FK).
 * Cleanup deletes only the tenants and users it created.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { CUSTOMER_PET_SCOPES } from '../customer-pets/domain/customer-pet-scopes';
import { CustomerPetsModule } from '../customer-pets/customer-pets.module';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { ChatbotApiModule } from './chatbot-api.module';
import { SERVICE_CREDENTIAL_REPOSITORY } from './domain/service-credential.repository';
import { BOT_AUDIT_LOG_REPOSITORY } from './infrastructure/prisma-bot-audit-log.repository';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const PHONE = { phoneCountryCode: '52', phone: '5512345678' };
const DAY = 86_400_000;

d('chatbot-api by-phone + order history with pets (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const userIds: string[] = [];
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
              JWT_SECRET: 'chatbot-api-pets-test-secret',
              JWT_REFRESH_SECRET: 'chatbot-api-pets-test-refresh',
              SPACES_BUCKET: 'unused',
              SPACES_ENDPOINT: 'https://unused.invalid',
              SPACES_REGION: 'unused',
              SPACES_ACCESS_KEY_ID: 'unused',
              SPACES_SECRET_ACCESS_KEY: 'unused',
              SPACES_PUBLIC_BASE_URL: 'https://unused.invalid',
              SPACES_UPLOAD_MAX_MB: '5',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        ChatbotApiModule,
        CustomerPetsModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .overrideProvider(BOT_AUDIT_LOG_REPOSITORY)
      .useValue({
        append: () => Promise.resolve(),
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

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await disconnectWorldPrisma();
  });

  interface World {
    tenantId: string;
    customerId: string;
    productId: string;
    userId: string;
    /** customers:read only: the pre-pets credential. */
    plain: string;
    /** customers:read + pets:read. */
    reader: string;
    /** customers:read + pets:write + pets:delete (no pets:read). */
    writer: string;
    /** pets:read + pets:write + pets:delete + customers:read. */
    full: string;
  }

  async function world(withCustomer = true): Promise<World> {
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
    if (withCustomer) {
      await prisma.customer.create({
        data: { id: customerId, tenantId, firstName: 'Rosa', ...PHONE },
      });
    }
    const productId = randomUUID();
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Croquetas', useStock: false },
    });
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@pets.invalid`,
        name: 'Cajero',
        hashedPassword: 'x',
      },
    });
    userIds.push(userId);
    const { read, write, delete: del } = CUSTOMER_PET_SCOPES;
    return {
      tenantId,
      customerId,
      productId,
      userId,
      plain: credentials.register(tenantId, ['customers:read']),
      reader: credentials.register(tenantId, ['customers:read', read]),
      writer: credentials.register(tenantId, ['customers:read', write, del]),
      full: credentials.register(tenantId, [
        'customers:read',
        read,
        write,
        del,
      ]),
    };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const byPhone = (token: string) =>
    request(app.getHttpServer())
      .get('/chatbot-api/customers/by-phone')
      .set(auth(token))
      .query(PHONE);
  const orders = (token: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/chatbot-api/customers/by-phone/${PHONE.phone}/orders`)
      .set(auth(token))
      .query({ phoneCountryCode: PHONE.phoneCountryCode, ...query });

  async function seedPet(
    w: World,
    name: string,
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

  type LinePet = {
    petId: string | null;
    name: string;
    species: 'DOG' | 'CAT' | 'OTHER';
  };

  /** A CONFIRMED sale of the customer; `lines[i].pet` fills the line's pet columns. */
  async function seedSale(
    w: World,
    ageDays: number,
    lines: Array<{ name: string; pet?: LinePet }>,
    customerId = w.customerId,
  ) {
    const sale = await prisma.sale.create({
      data: {
        tenantId: w.tenantId,
        userId: w.userId,
        customerId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        confirmedAt: new Date(Date.now() - ageDays * DAY),
        subtotalCents: 1000 * lines.length,
        totalCents: 1000 * lines.length,
        debtCents: 1000 * lines.length,
      },
    });
    for (const line of lines) {
      await prisma.saleItem.create({
        data: {
          tenantId: w.tenantId,
          saleId: sale.id,
          productId: w.productId,
          productName: line.name,
          quantity: 1,
          unitPriceCents: 1000,
          petId: line.pet?.petId ?? null,
          petNameSnapshot: line.pet?.name ?? null,
          petSpeciesSnapshot: line.pet?.species ?? null,
        },
      });
    }
    return sale.id;
  }

  const salesCount = (tenantId: string) =>
    prisma.sale.count({ where: { tenantId } });
  // The route has no `orderBy` on the lines (unchanged), so compare them by name.
  const linePets = (order: any) =>
    order.items
      .map((item: any) => [item.productName, item.pet])
      .sort((x: any[], y: any[]) => x[0].localeCompare(y[0]));
  const line = (order: any, productName: string) =>
    order.items.find((item: any) => item.productName === productName);

  describe('GET customers/by-phone', () => {
    it('without pets:read the response is exactly the previous one: no pets key, even when the customer has pets', async () => {
      const w = await world();
      await seedPet(w, 'Bruno');

      const res = await byPhone(w.plain).expect(200);

      expect(res.body).toEqual({
        found: true,
        customer: {
          customerId: w.customerId,
          firstName: 'Rosa',
          lastName: null,
          phoneCountryCode: '52',
          phone: '5512345678',
          preferredPaymentMethod: null,
          address: null,
        },
      });
      expect(res.body.customer).not.toHaveProperty('pets');
    });

    it('pets:write / pets:delete without pets:read do not add pets', async () => {
      const w = await world();
      await seedPet(w, 'Bruno');

      const res = await byPhone(w.writer).expect(200);

      expect(res.body.customer).not.toHaveProperty('pets');
      expect(res.body.customer.customerId).toBe(w.customerId);
    });

    it('with pets:read adds only the ACTIVE pets (full view, derived age), sorted by name; the rest of the response is unchanged', async () => {
      const w = await world();
      await seedPet(w, 'Zeus', { breed: 'Labrador' });
      await seedPet(w, 'Antiguo', {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedReason: 'Ya no está',
      });
      // Created through the bot route so the age comes from approxAge.
      const created = await request(app.getHttpServer())
        .post(`/chatbot-api/customers/${w.customerId}/pets`)
        .set(auth(w.full))
        .set('X-Idempotency-Key', randomUUID())
        .send({
          name: 'Bruno',
          species: 'DOG',
          breed: 'Chihuahua',
          approxAge: { months: 10 },
          allergies: 'Pollo',
        })
        .expect(201);
      const { warnings, ...bruno } = created.body;
      expect(warnings).toEqual([]);

      const res = await byPhone(w.reader).expect(200);

      expect(res.body.found).toBe(true);
      const { pets, ...profile } = res.body.customer;
      expect(profile).toEqual({
        customerId: w.customerId,
        firstName: 'Rosa',
        lastName: null,
        phoneCountryCode: '52',
        phone: '5512345678',
        preferredPaymentMethod: null,
        address: null,
      });
      expect(pets.map((p: any) => [p.name, p.status])).toEqual([
        ['Bruno', 'ACTIVE'],
        ['Zeus', 'ACTIVE'],
      ]);
      expect(pets[0]).toEqual(bruno);
      expect(pets[0]).toMatchObject({
        ageMonths: 10,
        ageLabel: '~10 meses',
        createdVia: 'CHATBOT',
      });
      expect(pets[1]).toMatchObject({
        breed: 'Labrador',
        ageMonths: null,
        ageLabel: null,
      });
    });

    it('with pets:read a customer without active pets gets pets: [] and an unknown phone stays found:false', async () => {
      const w = await world();
      await seedPet(w, 'Antiguo', {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });

      const empty = await byPhone(w.reader).expect(200);
      expect(empty.body.customer.pets).toEqual([]);

      const other = await world(false);
      const none = await byPhone(other.reader).expect(200);
      expect(none.body).toEqual({ found: false, customer: null });
    });

    it('pets:read alone (without customers:read) is 403', async () => {
      const w = await world();
      const onlyPets = credentials.register(w.tenantId, [
        CUSTOMER_PET_SCOPES.read,
      ]);

      const res = await byPhone(onlyPets).expect(403);

      expect(res.body.message).toBe('Insufficient service scope');
    });

    it("tenant isolation: a customer with the same phone in another sucursal never shows this one's pets", async () => {
      const a = await world();
      const b = await world();
      await seedPet(a, 'Bruno');

      const res = await byPhone(b.reader).expect(200);

      expect(res.body.customer.customerId).toBe(b.customerId);
      expect(res.body.customer.pets).toEqual([]);
    });
  });

  describe('GET customers/by-phone/:phone/orders', () => {
    /** Bruno (ACTIVE), Luna (ARCHIVED) and three sales, newest first: S3, S2, S1. */
    async function scenario() {
      const w = await world();
      const bruno = await seedPet(w, 'Bruno');
      const luna = await seedPet(w, 'Luna', {
        species: 'CAT',
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });
      const s1 = await seedSale(w, 3, [
        {
          name: 'Croquetas Bruno',
          pet: { petId: bruno.id, name: 'Bruno', species: 'DOG' },
        },
        { name: 'Juguete' },
      ]);
      const s2 = await seedSale(w, 2, [
        {
          name: 'Arena Luna',
          pet: { petId: luna.id, name: 'Luna', species: 'CAT' },
        },
      ]);
      // Pre-pets sale: no pet columns at all.
      const s3 = await seedSale(w, 1, [{ name: 'Collar' }]);
      return { w, bruno, luna, s1, s2, s3 };
    }

    it('adds pet per line: snapshot + current status, null without snapshot; every previous member is unchanged', async () => {
      const { w, bruno, luna, s1, s2, s3 } = await scenario();

      const res = await orders(w.plain).expect(200);

      expect(res.body.map((o: any) => o.saleId)).toEqual([s3, s2, s1]);
      expect(linePets(res.body[0])).toEqual([['Collar', null]]);
      expect(linePets(res.body[1])).toEqual([
        [
          'Arena Luna',
          { id: luna.id, name: 'Luna', species: 'CAT', status: 'ARCHIVED' },
        ],
      ]);
      expect(linePets(res.body[2])).toEqual([
        [
          'Croquetas Bruno',
          { id: bruno.id, name: 'Bruno', species: 'DOG', status: 'ACTIVE' },
        ],
        ['Juguete', null],
      ]);
      expect(Object.keys(res.body[2]).sort()).toEqual(
        [
          'saleId',
          'folio',
          'confirmedAt',
          'channel',
          'deliveryStatus',
          'paymentStatus',
          'totalCents',
          'paidCents',
          'debtCents',
          'items',
          'payments',
          'shippingAddress',
        ].sort(),
      );
      expect(Object.keys(res.body[2].items[0]).sort()).toEqual(
        [
          'productId',
          'variantId',
          'productName',
          'variantName',
          'quantity',
          'unitPriceCents',
          'pet',
        ].sort(),
      );
      expect(res.body[2]).toMatchObject({
        channel: 'ONLINE',
        totalCents: 2000,
        debtCents: 2000,
        payments: [],
        shippingAddress: null,
      });
    });

    it('the line keeps the snapshot after a pet edit, and its status follows the pet (restore → ACTIVE)', async () => {
      const { w, bruno, luna, s1, s2 } = await scenario();
      const petRoute = (id: string) =>
        `/chatbot-api/customers/${w.customerId}/pets/${id}`;
      await request(app.getHttpServer())
        .patch(petRoute(bruno.id))
        .set(auth(w.full))
        .send({ version: 1, name: 'Bruno II' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${petRoute(luna.id)}/restore`)
        .set(auth(w.full))
        .send({ version: 1 })
        .expect(200);

      const res = await orders(w.plain).expect(200);

      const byId = (id: string) => res.body.find((o: any) => o.saleId === id);
      expect(line(byId(s1), 'Croquetas Bruno').pet).toEqual({
        id: bruno.id,
        name: 'Bruno',
        species: 'DOG',
        status: 'ACTIVE',
      });
      expect(byId(s2).items[0].pet.status).toBe('ACTIVE');
    });

    it('a snapshot without pet row reads { id: null, name, species, status: null }', async () => {
      const w = await world();
      await seedSale(w, 1, [
        {
          name: 'Croquetas',
          pet: { petId: null, name: 'Michi', species: 'CAT' },
        },
      ]);

      const res = await orders(w.plain).expect(200);

      expect(linePets(res.body[0])).toEqual([
        [
          'Croquetas',
          { id: null, name: 'Michi', species: 'CAT', status: null },
        ],
      ]);
    });

    it('after the real erasure (bot DELETE) the line reads pet: null and the erased id is PET_NOT_FOUND; lines and amounts stay', async () => {
      const { w, bruno, s1 } = await scenario();
      await request(app.getHttpServer())
        .delete(`/chatbot-api/customers/${w.customerId}/pets/${bruno.id}`)
        .query({ version: 1 })
        .set(auth(w.full))
        .expect(204);

      const res = await orders(w.plain).expect(200);

      const sale = res.body.find((o: any) => o.saleId === s1);
      expect(linePets(sale)).toEqual([
        ['Croquetas Bruno', null],
        ['Juguete', null],
      ]);
      expect(sale).toMatchObject({ totalCents: 2000 });
      const gone = await orders(w.plain, { petId: bruno.id }).expect(404);
      expect(gone.body).toEqual({
        statusCode: 404,
        error: 'PET_NOT_FOUND',
        message: 'PET_NOT_FOUND',
      });
    });

    it('?petId= returns only the orders with a line of that pet, keeping ALL their lines', async () => {
      const { w, bruno, luna, s1, s2 } = await scenario();

      const forBruno = await orders(w.plain, { petId: bruno.id }).expect(200);
      expect(forBruno.body.map((o: any) => o.saleId)).toEqual([s1]);
      expect(linePets(forBruno.body[0]).map((l: any[]) => l[0])).toEqual([
        'Croquetas Bruno',
        'Juguete',
      ]);
      expect(line(forBruno.body[0], 'Juguete').pet).toBeNull();

      const forLuna = await orders(w.plain, { petId: luna.id }).expect(200);
      expect(forLuna.body.map((o: any) => o.saleId)).toEqual([s2]);
      expect(forLuna.body[0].items[0].pet.status).toBe('ARCHIVED');
    });

    it('a pet of the customer without orders is a valid empty list (not a 404)', async () => {
      const w = await world();
      const max = await seedPet(w, 'Max');

      const res = await orders(w.plain, { petId: max.id }).expect(200);

      expect(res.body).toEqual([]);
    });

    it('a pet of another customer, of another sucursal or unknown is 404 PET_NOT_FOUND, never an empty list', async () => {
      const { w } = await scenario();
      const otherCustomer = randomUUID();
      await prisma.customer.create({
        data: {
          id: otherCustomer,
          tenantId: w.tenantId,
          firstName: 'Luis',
          phoneCountryCode: '52',
          phone: '5599999999',
        },
      });
      const foreign = await seedPet(w, 'Ajeno', {}, otherCustomer);
      const b = await world();
      const otherTenantPet = await seedPet(b, 'Remoto');
      const before = await salesCount(w.tenantId);

      for (const petId of [foreign.id, otherTenantPet.id, randomUUID()]) {
        const res = await orders(w.plain, { petId }).expect(404);
        expect(res.body).toEqual({
          statusCode: 404,
          error: 'PET_NOT_FOUND',
          message: 'PET_NOT_FOUND',
        });
      }
      expect(await salesCount(w.tenantId)).toBe(before);
    });

    it('a petId with an unknown phone is 404 PET_NOT_FOUND; without petId the same phone stays []', async () => {
      const w = await world(false);
      const max = await seedPet(
        w,
        'Max',
        {},
        (
          await prisma.customer.create({
            data: {
              tenantId: w.tenantId,
              firstName: 'Otro',
              phoneCountryCode: '52',
              phone: '5500000000',
            },
          })
        ).id,
      );

      expect(
        (await orders(w.plain, { petId: max.id }).expect(404)).body.error,
      ).toBe('PET_NOT_FOUND');
      expect((await orders(w.plain).expect(200)).body).toEqual([]);
    });

    it.each(['not-a-uuid', '123', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'])(
      'an invalid petId (%s) is 400',
      async (petId) => {
        const { w } = await scenario();

        const res = await orders(w.plain, { petId }).expect(400);

        expect(res.body.statusCode).toBe(400);
        expect(res.body.error).toBe('Bad Request');
      },
    );

    it("tenant isolation: another sucursal's credential with the same phone sees none of these orders or lines", async () => {
      const { w } = await scenario();
      const b = await world();

      const res = await orders(b.plain).expect(200);

      expect(res.body).toEqual([]);
      expect((await orders(w.plain).expect(200)).body).toHaveLength(3);
    });
  });
});
