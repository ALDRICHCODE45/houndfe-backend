/* eslint-disable @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped */
/**
 * restock-backorder / T6 — concurrent bot sale confirmations of the SAME
 * product against REAL PostgreSQL (the normal integration database).
 *
 * Defect: `confirmBotSale` inserted the sale lines first (their foreign keys to
 * `products` / `variants` take `FOR KEY SHARE` on those rows) and charged the
 * stock afterwards (`StockJournalWriter` takes `FOR UPDATE` on the same rows).
 * Two confirmations of one product both held KEY SHARE and both waited for
 * UPDATE: PostgreSQL aborted one with 40P01 and the route answered
 * `500 CHECKOUT_CREATE_FAILED`. The fix locks the stock (journal order) BEFORE
 * the sale lines are written.
 *
 * Proves, through the production routes (`POST /chatbot-api/checkouts` and the
 * legacy `POST /chatbot-api/sales`), with a DIFFERENT customer per request (the
 * checkout's per-customer advisory lock would otherwise serialise them):
 *   - enough stock: every confirmation succeeds, no 500, stock exact;
 *   - limited stock: exactly the right number win, the rest get
 *     `409 STOCK_INSUFFICIENT_AT_CONFIRM`, never 500, never oversold;
 *   - carts with the same two products in opposite line order (lock order is
 *     by id, not by line);
 *   - the legacy route, and a mix of both routes.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { BOT_AUDIT_LOG_REPOSITORY } from '../chatbot-api/infrastructure/prisma-bot-audit-log.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { SalesService } from './sales.service';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const SCOPES = ['customers:write', 'sales:create', 'sales:write'];
const PRICE = 1000;
const ROUNDS = 4;
const phoneOf = (n: number) => ({
  phoneCountryCode: '52',
  phone: `55123499${String(n + 1).padStart(2, '0')}`,
});

d('concurrent bot sale confirmations of one product (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let app: INestApplication;
  let publicListId: string;
  /** Calls through; its results expose the errors the routes hide behind a 500. */
  let confirmSpy: jest.SpyInstance<
    ReturnType<SalesService['confirmBotSale']>,
    Parameters<SalesService['confirmBotSale']>
  >;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-confirm-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      publicListId = created.id;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              JWT_SECRET: 'sale-confirm-concurrency-test-secret',
              JWT_REFRESH_SECRET: 'sale-confirm-concurrency-test-refresh',
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
      .useValue({ append: () => Promise.resolve() })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
    // The routes answer a generic 500 / 503: keep the real cause (40P01 …).
    confirmSpy = jest.spyOn(SalesService.prototype, 'confirmBotSale');
  });

  beforeEach(() => {
    confirmSpy.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { tenantId: { in: tenantIds } },
      });
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

  interface World {
    tenantId: string;
    token: string;
    cashierUserId: string;
    productIds: string[];
    customerIds: string[];
  }

  /** One tenant, `products` products of `stock` units each, `customers` customers. */
  async function world(options: {
    stock: number;
    customers: number;
    products?: number;
  }): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Sucursal ${tenantId.slice(0, 6)}`,
        slug: `scc-${tenantId}`,
      },
    });
    const productIds: string[] = [];
    for (let n = 0; n < (options.products ?? 1); n++) {
      const id = randomUUID();
      productIds.push(id);
      await prisma.product.create({
        data: {
          id,
          tenantId,
          name: `Croquetas ${n}`,
          useStock: true,
          quantity: options.stock,
        },
      });
      await prisma.priceList.create({
        data: {
          tenantId,
          productId: id,
          globalPriceListId: publicListId,
          priceCents: PRICE,
        },
      });
    }
    const customerIds: string[] = [];
    for (let n = 0; n < options.customers; n++) {
      const id = randomUUID();
      await prisma.customer.create({
        data: {
          id,
          tenantId,
          firstName: `Cliente${n}`,
          ...phoneOf(n),
        },
      });
      customerIds.push(id);
    }
    const cashierUserId = randomUUID();
    userIds.push(cashierUserId);
    await prisma.user.create({
      data: {
        id: cashierUserId,
        email: `${cashierUserId}@confirm.invalid`,
        name: 'Ana Pérez',
        hashedPassword: 'not-a-login-hash',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Cashier ${cashierUserId}` },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId: cashierUserId, roleId: role.id },
    });
    return {
      tenantId,
      token: credentials.register(tenantId, SCOPES),
      cashierUserId,
      productIds,
      customerIds,
    };
  }

  const lines = (productIds: string[], quantity: number) =>
    productIds.map((productId) => ({
      productId,
      productName: 'Croquetas',
      quantity,
      unitPriceCents: PRICE,
    }));

  /** `POST /chatbot-api/checkouts`, pickup, for customer `n`. */
  const checkout = (w: World, n: number, productIds: string[], qty = 1) =>
    request(app.getHttpServer())
      .post('/chatbot-api/checkouts')
      .set('Authorization', `Bearer ${w.token}`)
      .set('X-Idempotency-Key', randomUUID())
      .send({
        ...phoneOf(n),
        customer: { mode: 'existing', customerId: w.customerIds[n] },
        sale: {
          cashierUserId: w.cashierUserId,
          items: lines(productIds, qty),
          expectedTotalCents: PRICE * qty * productIds.length,
          shipping: { mode: 'pickup' },
        },
      });

  /** Legacy `POST /chatbot-api/sales` for customer `n`. */
  const legacySale = (w: World, n: number, productIds: string[], qty = 1) =>
    request(app.getHttpServer())
      .post('/chatbot-api/sales')
      .set('Authorization', `Bearer ${w.token}`)
      .set('X-Idempotency-Key', randomUUID())
      .send({
        cashierUserId: w.cashierUserId,
        customerId: w.customerIds[n],
        items: lines(productIds, qty),
      });

  const quantityOf = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .quantity;
  const salesOf = (w: World) =>
    prisma.sale.count({ where: { tenantId: w.tenantId } });
  const saleMovements = async (w: World, productId: string) =>
    (
      await prisma.stockMovement.findMany({
        where: { tenantId: w.tenantId, productId, type: 'SALE' },
      })
    ).reduce((sum, row) => sum + row.delta, 0);

  const statuses = (responses: request.Response[]) =>
    responses.map((r) => r.status).sort();
  /** Responses that are neither a sale nor the 409 stock refusal, plus every deadlock. */
  const failures = async (responses: request.Response[]) => {
    const settled = await Promise.allSettled(
      confirmSpy.mock.results.map((r) => r.value as Promise<unknown>),
    );
    return [
      ...responses
        .filter((r) => ![201, 409].includes(r.status))
        .map((r) => ({ status: r.status, body: r.body as unknown })),
      ...settled.flatMap((r) =>
        r.status === 'rejected' &&
        /deadlock|40P01/i.test(String((r.reason as Error)?.message ?? r.reason))
          ? [String((r.reason as Error).message)]
          : [],
      ),
    ];
  };

  describe('POST /chatbot-api/checkouts', () => {
    it('enough stock: every concurrent checkout of the same product succeeds (no 40P01 / 500)', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const w = await world({ stock: 100, customers: 8 });
        const results = await Promise.all(
          w.customerIds.map((_, n) => checkout(w, n, w.productIds)),
        );
        expect(await failures(results)).toEqual([]);
        expect(statuses(results)).toEqual(Array(8).fill(201));
        expect(await salesOf(w)).toBe(8);
        expect(await quantityOf(w.productIds[0])).toBe(92);
        expect(await saleMovements(w, w.productIds[0])).toBe(-8);
      }
    });

    it('limited stock: exactly the stock wins, the rest get 409 STOCK_INSUFFICIENT_AT_CONFIRM, never 500', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const w = await world({ stock: 3, customers: 8 });
        const results = await Promise.all(
          w.customerIds.map((_, n) => checkout(w, n, w.productIds)),
        );
        expect(await failures(results)).toEqual([]);
        expect(statuses(results)).toEqual([
          201, 201, 201, 409, 409, 409, 409, 409,
        ]);
        for (const lost of results.filter((r) => r.status === 409)) {
          expect(lost.body).toMatchObject({
            statusCode: 409,
            error: 'STOCK_INSUFFICIENT_AT_CONFIRM',
          });
        }
        expect(await salesOf(w)).toBe(3);
        expect(await quantityOf(w.productIds[0])).toBe(0);
        expect(await saleMovements(w, w.productIds[0])).toBe(-3);
      }
    });

    it('carts with the same two products in opposite line order do not deadlock (locks are taken by id)', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const w = await world({ stock: 100, customers: 8, products: 2 });
        const forward = w.productIds;
        const backward = [...w.productIds].reverse();
        const results = await Promise.all(
          w.customerIds.map((_, n) =>
            checkout(w, n, n % 2 === 0 ? forward : backward),
          ),
        );
        expect(await failures(results)).toEqual([]);
        expect(statuses(results)).toEqual(Array(8).fill(201));
        for (const productId of w.productIds) {
          expect(await quantityOf(productId)).toBe(92);
        }
      }
    });
  });

  describe('legacy POST /chatbot-api/sales', () => {
    it('enough stock: every concurrent sale of the same product succeeds', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const w = await world({ stock: 100, customers: 8 });
        const results = await Promise.all(
          w.customerIds.map((_, n) => legacySale(w, n, w.productIds)),
        );
        expect(await failures(results)).toEqual([]);
        expect(statuses(results)).toEqual(Array(8).fill(201));
        expect(await quantityOf(w.productIds[0])).toBe(92);
      }
    });

    it('limited stock: exactly the stock wins, the rest get 409 STOCK_INSUFFICIENT_AT_CONFIRM', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const w = await world({ stock: 3, customers: 8 });
        const results = await Promise.all(
          w.customerIds.map((_, n) => legacySale(w, n, w.productIds)),
        );
        expect(await failures(results)).toEqual([]);
        expect(statuses(results)).toEqual([
          201, 201, 201, 409, 409, 409, 409, 409,
        ]);
        expect(await salesOf(w)).toBe(3);
        expect(await quantityOf(w.productIds[0])).toBe(0);
      }
    });
  });

  it('checkouts and legacy sales racing each other on one product: no 500, stock exact', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = await world({ stock: 5, customers: 8 });
      const results = await Promise.all(
        w.customerIds.map((_, n) =>
          n % 2 === 0
            ? checkout(w, n, w.productIds)
            : legacySale(w, n, w.productIds),
        ),
      );
      expect(await failures(results)).toEqual([]);
      expect(statuses(results)).toEqual([
        201, 201, 201, 201, 201, 409, 409, 409,
      ]);
      expect(await quantityOf(w.productIds[0])).toBe(0);
      expect(await salesOf(w)).toBe(5);
    }
  });
});
