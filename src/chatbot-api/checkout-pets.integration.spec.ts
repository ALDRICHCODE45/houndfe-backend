/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * customer-pets / T3 (S7, contract §4.2) — `sale.items[i].petId` of
 * `POST /chatbot-api/checkouts` against PostgreSQL, through the REAL
 * ChatbotApiModule (repricing, sale confirmation, stock journal, folios).
 * Only the credential repository and the audit log are in-memory fixtures.
 *
 * Every test asserts status, exact error body, response members and the
 * database (nothing written on every rejection).
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
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
const PRICE = 60000;
const SCOPES = ['customers:read', 'customers:write', 'sales:create'];

d('bot checkout line pets (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const audit = { append: jest.fn(() => Promise.resolve()) };
  let app: INestApplication;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let defaultListId: string;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      defaultListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-pets-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      defaultListId = created.id;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              BOT_SHIPPING_CHARGE_MAX_CENTS: 50000,
              // Boot-time reads of unrelated modules in the real graph.
              JWT_SECRET: 'checkout-pets-test-secret',
              JWT_REFRESH_SECRET: 'checkout-pets-test-refresh',
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
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .overrideProvider(BOT_AUDIT_LOG_REPOSITORY)
      .useValue(audit)
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
    if (createdPriceListIds.length > 0) {
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: createdPriceListIds } },
      });
    }
    await disconnectWorldPrisma();
  });

  /** A sucursal: cashier, two priced products, customers and their pets. */
  async function sucursal() {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Pets', slug: `pets-${tenantId}` },
    });
    const cashierUserId = randomUUID();
    userIds.push(cashierUserId);
    await prisma.user.create({
      data: {
        id: cashierUserId,
        name: 'Bot cashier',
        email: `${cashierUserId}@pets.invalid`,
        hashedPassword: 'unused-test-fixture',
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Cashier ${cashierUserId}` },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId: cashierUserId, roleId: role.id },
    });
    const product = async (name: string) => {
      const id = randomUUID();
      await prisma.product.create({
        data: { id, tenantId, name, useStock: true, quantity: 50 },
      });
      await prisma.priceList.create({
        data: {
          tenantId,
          productId: id,
          globalPriceListId: defaultListId,
          priceCents: PRICE,
        },
      });
      return id;
    };
    const productId = await product('Croquetas');
    const secondProductId = await product('Arena');
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Ana', ...PHONE },
    });
    const otherCustomerId = randomUUID();
    await prisma.customer.create({
      data: {
        id: otherCustomerId,
        tenantId,
        firstName: 'Luis',
        phoneCountryCode: '52',
        phone: '5598765432',
      },
    });
    const pet = async (
      owner: string,
      name: string,
      species: 'DOG' | 'CAT',
      status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    ) =>
      (
        await prisma.customerPet.create({
          data: {
            tenantId,
            customerId: owner,
            name,
            nameKey: name.toLowerCase(),
            species,
            status,
            createdVia: 'CHATBOT',
          },
        })
      ).id;
    return {
      tenantId,
      cashierUserId,
      productId,
      secondProductId,
      customerId,
      otherCustomerId,
      bruno: await pet(customerId, 'Bruno', 'DOG'),
      max: await pet(customerId, 'Max', 'CAT'),
      rex: await pet(customerId, 'Rex', 'DOG', 'ARCHIVED'),
      luna: await pet(otherCustomerId, 'Luna', 'CAT'),
      token: credentials.register(tenantId, SCOPES),
    };
  }
  type Sucursal = Awaited<ReturnType<typeof sucursal>>;

  const http = () => request(app.getHttpServer());

  const line = (productId: string, petId?: string | null, quantity = 1) => ({
    productId,
    productName: 'Item',
    quantity,
    unitPriceCents: PRICE,
    ...(petId !== undefined ? { petId } : {}),
  });

  /** A store-pickup checkout of `items` (no address, no shipping charge). */
  const checkout = (
    s: Sucursal,
    key: string,
    items: object[],
    customer: object = { mode: 'existing', customerId: s.customerId },
    phone: object = PHONE,
  ) =>
    http()
      .post('/chatbot-api/checkouts')
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Idempotency-Key', key)
      .send({
        ...phone,
        customer,
        sale: {
          cashierUserId: s.cashierUserId,
          items,
          expectedTotalCents: PRICE * items.length,
          shipping: { mode: 'pickup' },
        },
      });

  const errorBody = (statusCode: number, code: string) => ({
    statusCode,
    error: code,
    message: code,
  });
  const lines = (saleId: string) =>
    prisma.saleItem.findMany({
      where: { saleId },
      select: {
        productId: true,
        quantity: true,
        petId: true,
        petNameSnapshot: true,
        petSpeciesSnapshot: true,
      },
      orderBy: { productName: 'asc' },
    });
  const counts = async (s: Sucursal) => ({
    sales: await prisma.sale.count({ where: { tenantId: s.tenantId } }),
    receipts: await prisma.saleIdempotency.count({
      where: { tenantId: s.tenantId },
    }),
    customers: await prisma.customer.count({ where: { tenantId: s.tenantId } }),
    stock: (
      await prisma.product.findUniqueOrThrow({
        where: { id: s.productId },
        select: { quantity: true },
      })
    ).quantity,
  });

  // ──────────────────────────── persistence ────────────────────────────

  describe('line with a pet', () => {
    it('persists petId + snapshot on the line; response, stock and folio are those of a checkout without pet', async () => {
      const s = await sucursal();
      const plain = await checkout(s, 'plain', [line(s.productId)]).expect(201);
      const res = await checkout(s, 'with-pet', [
        line(s.productId, s.bruno),
      ]).expect(201);

      expect(Object.keys(res.body).sort()).toEqual(
        Object.keys(plain.body).sort(),
      );
      expect(Object.keys(res.body.sale).sort()).toEqual(
        Object.keys(plain.body.sale).sort(),
      );
      expect(res.body.sale).toMatchObject({
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        totalCents: PRICE,
        debtCents: PRICE,
      });
      expect(await lines(res.body.sale.saleId)).toEqual([
        {
          productId: s.productId,
          quantity: 1,
          petId: s.bruno,
          petNameSnapshot: 'Bruno',
          petSpeciesSnapshot: 'DOG',
        },
      ]);
      // the line without pet is untouched
      expect(await lines(plain.body.sale.saleId)).toEqual([
        {
          productId: s.productId,
          quantity: 1,
          petId: null,
          petNameSnapshot: null,
          petSpeciesSnapshot: null,
        },
      ]);
      expect((await counts(s)).stock).toBe(48);
    });

    it('an UPPER-CASED petId of an existing pet is accepted and replays as the lower-cased request', async () => {
      const s = await sucursal();
      const res = await checkout(s, 'upper', [
        line(s.productId, s.bruno.toUpperCase()),
      ]).expect(201);

      expect((await lines(res.body.sale.saleId))[0]).toMatchObject({
        petId: s.bruno,
        petNameSnapshot: 'Bruno',
      });
      const replay = await checkout(s, 'upper', [
        line(s.productId, s.bruno),
      ]).expect(201);
      expect(replay.body).toEqual(res.body);
      expect((await counts(s)).sales).toBe(1);
    });

    it('petId null is the same as omitted; two products keep their own pet', async () => {
      const s = await sucursal();
      const res = await checkout(s, 'two-lines', [
        line(s.productId, s.bruno),
        line(s.secondProductId, s.max),
      ]).expect(201);

      const rows = await lines(res.body.sale.saleId);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: s.productId,
            petId: s.bruno,
            petNameSnapshot: 'Bruno',
            petSpeciesSnapshot: 'DOG',
          }),
          expect.objectContaining({
            productId: s.secondProductId,
            petId: s.max,
            petNameSnapshot: 'Max',
            petSpeciesSnapshot: 'CAT',
          }),
        ]),
      );
      const nul = await checkout(s, 'null-pet', [
        line(s.productId, null),
      ]).expect(201);
      expect((await lines(nul.body.sale.saleId))[0]).toMatchObject({
        petId: null,
        petNameSnapshot: null,
        petSpeciesSnapshot: null,
      });
    });

    it('two lines of one product for the SAME pet merge into one line that keeps the pet', async () => {
      const s = await sucursal();
      const res = await checkout(s, 'merge', [
        line(s.productId, s.bruno),
        line(s.productId, s.bruno),
      ]).expect(201);

      expect(await lines(res.body.sale.saleId)).toEqual([
        {
          productId: s.productId,
          quantity: 2,
          petId: s.bruno,
          petNameSnapshot: 'Bruno',
          petSpeciesSnapshot: 'DOG',
        },
      ]);
    });

    it('two lines of one product for DIFFERENT pets → 400 INVALID_CHECKOUT_REQUEST, nothing written', async () => {
      const s = await sucursal();
      const before = await counts(s);

      const res = await checkout(s, 'split', [
        line(s.productId, s.bruno),
        line(s.productId, s.max),
      ]).expect(400);

      expect(res.body).toEqual(errorBody(400, 'INVALID_CHECKOUT_REQUEST'));
      expect(await counts(s)).toEqual(before);
    });

    it('a pet renamed or archived after the sale does not touch the stored line', async () => {
      const s = await sucursal();
      const res = await checkout(s, 'frozen', [
        line(s.productId, s.bruno),
      ]).expect(201);

      await prisma.customerPet.update({
        where: { id: s.bruno },
        data: { name: 'Bruno II', status: 'ARCHIVED' },
      });

      expect((await lines(res.body.sale.saleId))[0]).toMatchObject({
        petId: s.bruno,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
      });
    });
  });

  // ───────────────────────────── validations ─────────────────────────────

  describe('refused pets write nothing and leave the key retryable', () => {
    it.each([
      ['unknown pet', 404, 'PET_NOT_FOUND', () => randomUUID()],
      [
        'pet of another customer',
        422,
        'PET_CUSTOMER_MISMATCH',
        (s: Sucursal) => s.luna,
      ],
      ['archived pet', 422, 'PET_ARCHIVED', (s: Sucursal) => s.rex],
    ] as const)('%s → %i %s', async (_label, statusCode, code, pickPet) => {
      const s = await sucursal();
      const before = await counts(s);
      const petId = pickPet(s);

      const res = await checkout(s, 'refused', [line(s.productId, petId)]);

      expect(res.status).toBe(statusCode);
      expect(res.body).toEqual(errorBody(statusCode, code));
      expect(await counts(s)).toEqual(before);
      // the same key goes through once the pet is dropped
      const retry = await checkout(s, 'refused', [line(s.productId)]);
      expect(retry.status).toBe(201);
    });

    it('a pet of another tenant → 404 PET_NOT_FOUND', async () => {
      const s = await sucursal();
      const other = await sucursal();
      const before = await counts(s);

      const res = await checkout(s, 'foreign', [
        line(s.productId, other.bruno),
      ]);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      expect(await counts(s)).toEqual(before);
    });

    it('a customer created by the same checkout owns no pet: 422 PET_CUSTOMER_MISMATCH and the customer is rolled back', async () => {
      const s = await sucursal();
      const before = await counts(s);

      const res = await checkout(
        s,
        'new-customer',
        [line(s.productId, s.bruno)],
        { mode: 'createIfAbsent', firstName: 'Nueva' },
        { phoneCountryCode: '52', phone: '5511112222' },
      );

      expect(res.status).toBe(422);
      expect(res.body).toEqual(errorBody(422, 'PET_CUSTOMER_MISMATCH'));
      expect(await counts(s)).toEqual(before);
    });

    it('a non-uuid petId → 400 INVALID_CHECKOUT_REQUEST', async () => {
      const s = await sucursal();
      const before = await counts(s);

      const res = await checkout(s, 'bad', [line(s.productId, 'nope')]);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(errorBody(400, 'INVALID_CHECKOUT_REQUEST'));
      expect(await counts(s)).toEqual(before);
    });
  });

  // ───────────────────────────── idempotency ─────────────────────────────

  describe('request hash', () => {
    it('replays the same request byte for byte; null and omitted petId replay a stored receipt', async () => {
      const s = await sucursal();
      const first = await checkout(s, 'replay', [line(s.productId)]).expect(
        201,
      );

      const replay = await checkout(s, 'replay', [
        line(s.productId, null),
      ]).expect(201);

      expect(replay.body).toEqual(first.body);
      expect((await counts(s)).sales).toBe(1);
    });

    it.each([
      ['adding', undefined, 'bruno'],
      ['removing', 'bruno', undefined],
      ['changing', 'bruno', 'max'],
    ] as const)(
      'a retry %s petId under the same key → 409 IDEMPOTENCY_KEY_CONFLICT, no second sale',
      async (_label, first, retry) => {
        const s = await sucursal();
        const pick = (p?: 'bruno' | 'max') => (p ? s[p] : undefined);
        const created = await checkout(s, 'conflict', [
          line(s.productId, pick(first)),
        ]).expect(201);

        const conflict = await checkout(s, 'conflict', [
          line(s.productId, pick(retry)),
        ]);

        expect(conflict.status).toBe(409);
        expect(conflict.body).toEqual(
          errorBody(409, 'IDEMPOTENCY_KEY_CONFLICT'),
        );
        expect((await counts(s)).sales).toBe(1);
        // the original still replays
        const replay = await checkout(s, 'conflict', [
          line(s.productId, pick(first)),
        ]).expect(201);
        expect(replay.body).toEqual(created.body);
      },
    );
  });

  // ─────────────────────────────── locking ───────────────────────────────

  describe('pet row lock', () => {
    it('waits for a pet erase in flight (FOR UPDATE) and then answers 404 PET_NOT_FOUND with nothing written', async () => {
      const s = await sucursal();
      const before = await counts(s);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => (locked = resolve));
      // The eraser of contract §6: pet FOR UPDATE, scrub lines, delete.
      const eraser = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_pets WHERE id = ${s.bruno} FOR UPDATE`;
        locked();
        await gate;
        await tx.saleItem.updateMany({
          where: { petId: s.bruno },
          data: {
            petId: null,
            petNameSnapshot: null,
            petSpeciesSnapshot: null,
          },
        });
        await tx.customerPet.delete({ where: { id: s.bruno } });
      });
      await lockedP;

      let settled = false;
      const pending = checkout(s, 'race', [line(s.productId, s.bruno)]).then(
        (res) => {
          settled = true;
          return res;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(settled).toBe(false); // blocked on the pet lock, not a stale read

      release();
      await eraser;
      const res = await pending;

      expect(res.status).toBe(404);
      expect(res.body).toEqual(errorBody(404, 'PET_NOT_FOUND'));
      expect(await counts(s)).toEqual(before);
    }, 30_000);

    it('two concurrent checkouts for the same pet share its lock: both succeed, no deadlock', async () => {
      const s = await sucursal();

      const [a, b] = await Promise.all([
        checkout(s, 'par-a', [line(s.productId, s.bruno)]),
        checkout(s, 'par-b', [line(s.secondProductId, s.bruno)]),
      ]);

      expect([a.status, b.status]).toEqual([201, 201]);
      const rows = await prisma.saleItem.findMany({
        where: { tenantId: s.tenantId },
        select: { petId: true, petNameSnapshot: true },
      });
      expect(rows).toEqual([
        { petId: s.bruno, petNameSnapshot: 'Bruno' },
        { petId: s.bruno, petNameSnapshot: 'Bruno' },
      ]);
    }, 30_000);
  });
});
