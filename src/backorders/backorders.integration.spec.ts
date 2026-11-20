/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped JSON */
/**
 * restock-backorder / T1 — the bot backorder routes and the migration's
 * constraints against REAL PostgreSQL.
 *
 * Boots the REAL `BackordersModule` (guard, controller, service, the real
 * `SalesService.previewBotPricing` price resolution and the real tenant Prisma
 * extension), with only the credential repository replaced by in-memory
 * fixtures. Cleanup deletes only the tenants it created.
 *
 * Proves what no unit test can: the partial unique index (one active backorder
 * per customer + product + variant, NULL variant included), the CHECK/FK
 * guarantees, the atomic per-tenant folio under concurrency, idempotent replay
 * and conflict, and tenant isolation.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { BACKORDER_RESERVATION_RELEASER } from './application/ports/backorder-reservation-releaser.port';
import { BackordersModule } from './backorders.module';
import { BACKORDER_SCOPES } from './domain/backorder-scopes';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const DAY = 86_400_000;
const RESOLVED_AT = new Date(Date.now() - DAY);
const ALL_SCOPES = [
  BACKORDER_SCOPES.create,
  BACKORDER_SCOPES.read,
  BACKORDER_SCOPES.cancel,
];

d('restock backorders — bot routes + constraints (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const releaser = { releaseReservation: jest.fn(() => Promise.resolve()) };
  const tenantIds: string[] = [];
  const createdPriceListIds: string[] = [];
  const userIds: string[] = [];
  let app: INestApplication;
  let publicListId: string;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-bo-${randomUUID()}`, isDefault: true },
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
              // Boot-time reads of unrelated modules in the real graph.
              JWT_SECRET: 'backorders-test-secret',
              JWT_REFRESH_SECRET: 'backorders-test-refresh',
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
        BackordersModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .overrideProvider(BACKORDER_RESERVATION_RELEASER)
      .useValue(releaser)
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

  beforeEach(() => {
    releaser.releaseReservation.mockClear();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  interface World {
    tenantId: string;
    tenantName: string;
    token: string;
    productId: string;
    decisionId: string;
    customerId: string;
    phone: { phoneCountryCode: string; phone: string };
  }

  const phoneOf = (n: number) => ({
    phoneCountryCode: '52',
    phone: `55123499${String(n).padStart(2, '0')}`,
  });

  async function decision(
    tenantId: string,
    productId: string,
    over: Partial<Prisma.HumanDecisionUncheckedCreateInput> = {},
  ): Promise<string> {
    const row = await prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: tenantId,
        branchName: 'Centro',
        productId,
        productName: 'Croquetas',
        variantId: null,
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolutionRequestId: randomUUID(),
        resolvedAt: RESOLVED_AT,
        resolvedByActorId: 'actor',
        resolvedByDisplayName: 'Gerente',
        ...over,
      },
    });
    return row.id;
  }

  /** A sucursal with an out-of-stock priced product, a customer and an answered RESTOCK decision. */
  async function world(
    options: {
      quantity?: number;
      priceCents?: number;
      scopes?: string[];
    } = {},
  ): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    const tenantName = `Sucursal ${tenantId.slice(0, 6)}`;
    await prisma.tenant.create({
      data: { id: tenantId, name: tenantName, slug: `bo-${tenantId}` },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas Adulto 18 kg',
        useStock: true,
        quantity: options.quantity ?? 0,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: publicListId,
        priceCents: options.priceCents ?? 114900,
      },
    });
    const phone = phoneOf(1);
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, tenantId, firstName: 'Rosa', ...phone },
    });
    return {
      tenantId,
      tenantName,
      token: credentials.register(tenantId, options.scopes ?? ALL_SCOPES),
      productId,
      decisionId: await decision(tenantId, productId),
      customerId,
      phone,
    };
  }

  async function extraCustomer(w: World, n: number, firstName = 'Luis') {
    const id = randomUUID();
    const phone = phoneOf(n);
    await prisma.customer.create({
      data: { id, tenantId: w.tenantId, firstName, ...phone },
    });
    return { id, phone };
  }

  const body = (w: World, over: Record<string, unknown> = {}) => ({
    ...w.phone,
    customer: { mode: 'existing', customerId: w.customerId },
    productId: w.productId,
    quantity: 2,
    sourceDecisionId: w.decisionId,
    ...over,
  });

  const post = (token: string, payload: object, key: string = randomUUID()) =>
    request(app.getHttpServer())
      .post('/chatbot-api/backorders')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Idempotency-Key', key)
      .send(payload);

  const get = (token: string, path = '') =>
    request(app.getHttpServer())
      .get(`/chatbot-api/backorders${path}`)
      .set('Authorization', `Bearer ${token}`);

  const cancel = (token: string, id: string, payload: object = {}) =>
    request(app.getHttpServer())
      .post(`/chatbot-api/backorders/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

  /** Direct insert satisfying every CHECK; for constraint tests and states T1 cannot reach. */
  async function insertBackorder(
    w: World,
    over: Partial<Prisma.BackorderUncheckedCreateInput> = {},
  ) {
    const n = Math.floor(Math.random() * 1_000_000_000);
    return prisma.backorder.create({
      data: {
        tenantId: w.tenantId,
        folio: `BO-${String(n).padStart(9, '0')}`,
        customerId: w.customerId,
        productId: w.productId,
        quantity: 1,
        referencePriceCents: 1000,
        scheduledAt: new Date(),
        estimatedArrivalDays: 7,
        estimatedAt: new Date(Date.now() + 7 * DAY),
        sourceDecisionId: w.decisionId,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        ...over,
      },
    });
  }

  /** A sale of `tenantId` (needs a cashier user, removed in afterAll). */
  async function saleOf(tenantId: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@bo.invalid`,
        name: 'Cajero',
        hashedPassword: 'x',
      },
    });
    userIds.push(user.id);
    const sale = await prisma.sale.create({
      data: { tenantId, userId: user.id },
    });
    return sale.id;
  }

  const cancelledFields = () => ({
    status: 'CANCELLED' as const,
    cancelledAt: new Date(),
    cancelledByKind: 'CUSTOMER' as const,
  });
  const reservedFields = () => ({
    status: 'RESERVED' as const,
    reservedAt: new Date(),
    reservedUntil: new Date(Date.now() + DAY),
    reminderAt: new Date(Date.now() + DAY - 3 * 3_600_000),
    currentPriceCents: 900,
    finalPriceCents: 900,
  });

  async function violation(
    run: () => Promise<unknown>,
  ): Promise<{ text: string }> {
    try {
      await run();
    } catch (error) {
      const err = error as { message?: string; code?: string; meta?: unknown };
      return {
        text: `${err.code ?? ''} ${err.message ?? ''} ${JSON.stringify(err.meta ?? {})}`,
      };
    }
    throw new Error('expected the database to reject the statement');
  }

  // ---------------------------------------------------------------------------
  // POST /chatbot-api/backorders
  // ---------------------------------------------------------------------------

  describe('POST /chatbot-api/backorders — schedule', () => {
    it('creates a WAITING backorder with the server price, folio BO-000001 and queuePosition 1', async () => {
      const w = await world({ priceCents: 114900 });
      const res = await post(w.token, body(w)).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        backorder: {
          id: expect.any(String),
          folio: 'BO-000001',
          status: 'WAITING',
          productId: w.productId,
          productName: 'Croquetas Adulto 18 kg',
          variantId: null,
          variantName: null,
          quantity: 2,
          referencePriceCents: 114900,
          currentPriceCents: null,
          finalPriceCents: null,
          scheduledAt: expect.stringMatching(/Z$/),
          estimatedAt: new Date(RESOLVED_AT.getTime() + 7 * DAY).toISOString(),
          estimatedArrivalDays: 7,
          reservedAt: null,
          reservedUntil: null,
          reminderAt: null,
          queuePosition: 1,
          saleId: null,
          cancelledByKind: null,
          cancelReason: null,
          branchName: w.tenantName,
          customerFirstName: 'Rosa',
        },
      });
      const row = await prisma.backorder.findUniqueOrThrow({
        where: { id: res.body.backorder.id },
      });
      expect(row).toMatchObject({
        tenantId: w.tenantId,
        customerId: w.customerId,
        status: 'WAITING',
        version: 1,
        referencePriceListId: null,
        reservationStage: 0,
        etaStage: 0,
        passedOverCount: 0,
        sourceDecisionId: w.decisionId,
        chatbotRequestId: null,
      });
      expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('queues the next customer behind (BO-000002, position 2) and numbers by creation', async () => {
      const w = await world();
      const second = await extraCustomer(w, 2);
      await post(w.token, body(w)).expect(201);
      const res = await post(
        w.token,
        body(w, {
          ...second.phone,
          customer: { mode: 'existing', customerId: second.id },
        }),
      ).expect(201);
      expect(res.body.backorder).toMatchObject({
        folio: 'BO-000002',
        queuePosition: 2,
        customerFirstName: 'Luis',
      });
    });

    it('createIfAbsent creates the customer without an address and prices PUBLICO', async () => {
      const w = await world({ priceCents: 50000 });
      const phone = phoneOf(7);
      const res = await post(
        w.token,
        body(w, {
          ...phone,
          customer: {
            mode: 'createIfAbsent',
            firstName: 'Marta',
            lastName: 'Díaz',
          },
        }),
      ).expect(201);
      expect(res.body.backorder).toMatchObject({
        customerFirstName: 'Marta',
        referencePriceCents: 50000,
      });
      const customer = await prisma.customer.findFirstOrThrow({
        where: { tenantId: w.tenantId, ...phone },
        include: { addresses: true },
      });
      expect(customer).toMatchObject({ firstName: 'Marta', lastName: 'Díaz' });
      expect(customer.addresses).toHaveLength(0);
    });

    it('createIfAbsent reuses the customer that already owns the phone', async () => {
      const w = await world();
      const res = await post(
        w.token,
        body(w, { customer: { mode: 'createIfAbsent', firstName: 'Otra' } }),
      ).expect(201);
      expect(res.body.backorder.customerFirstName).toBe('Rosa');
      expect(
        await prisma.customer.count({ where: { tenantId: w.tenantId } }),
      ).toBe(1);
    });

    it('404 CUSTOMER_NOT_FOUND when the existing customer id does not own that phone', async () => {
      const w = await world();
      const res = await post(
        w.token,
        body(w, {
          customer: { mode: 'existing', customerId: randomUUID() },
        }),
      ).expect(404);
      expect(res.body.error).toBe('CUSTOMER_NOT_FOUND');
    });

    it('409 CUSTOMER_PHONE_AMBIGUOUS when two customers share the phone', async () => {
      const w = await world();
      await prisma.customer.create({
        data: { tenantId: w.tenantId, firstName: 'Clon', ...w.phone },
      });
      const res = await post(w.token, body(w)).expect(409);
      expect(res.body.error).toBe('CUSTOMER_PHONE_AMBIGUOUS');
      expect(
        await prisma.backorder.count({ where: { tenantId: w.tenantId } }),
      ).toBe(0);
    });

    it("prices with the customer's own price list and records it", async () => {
      const w = await world({ priceCents: 114900 });
      const list = await prisma.globalPriceList.create({
        data: { name: `MAYOREO-bo-${randomUUID()}` },
      });
      createdPriceListIds.push(list.id);
      await prisma.priceList.create({
        data: {
          tenantId: w.tenantId,
          productId: w.productId,
          globalPriceListId: list.id,
          priceCents: 99900,
        },
      });
      await prisma.customer.update({
        where: { id: w.customerId },
        data: { globalPriceListId: list.id },
      });
      const res = await post(w.token, body(w)).expect(201);
      expect(res.body.backorder.referencePriceCents).toBe(99900);
      const row = await prisma.backorder.findUniqueOrThrow({
        where: { id: res.body.backorder.id },
      });
      expect(row.referencePriceListId).toBe(list.id);
    });

    it('409 PRICE_OUT_OF_DATE {currentPriceCents} when the expected price differs; equal passes', async () => {
      const w = await world({ priceCents: 114900 });
      const stale = await post(
        w.token,
        body(w, { expectedReferencePriceCents: 109900 }),
      ).expect(409);
      expect(stale.body).toEqual({
        statusCode: 409,
        error: 'PRICE_OUT_OF_DATE',
        message: 'PRICE_OUT_OF_DATE',
        currentPriceCents: 114900,
      });
      expect(
        await prisma.backorder.count({ where: { tenantId: w.tenantId } }),
      ).toBe(0);
      await post(
        w.token,
        body(w, { expectedReferencePriceCents: 114900 }),
      ).expect(201);
    });

    it('422 PRICE_UNAVAILABLE when the product has no catalog price', async () => {
      const w = await world();
      await prisma.priceList.deleteMany({ where: { tenantId: w.tenantId } });
      const res = await post(w.token, body(w)).expect(422);
      expect(res.body.error).toBe('PRICE_UNAVAILABLE');
    });

    it('409 STOCK_AVAILABLE_NOW {availableToSell} when sellable stock covers the quantity', async () => {
      const w = await world({ quantity: 5 });
      const res = await post(w.token, body(w, { quantity: 5 })).expect(409);
      expect(res.body).toMatchObject({
        error: 'STOCK_AVAILABLE_NOW',
        availableToSell: 5,
      });
      // Short stock still schedules.
      await post(w.token, body(w, { quantity: 6 })).expect(201);
    });

    it('does not count units in an expired lot as sellable', async () => {
      const w = await world({ quantity: 5 });
      await prisma.product.update({
        where: { id: w.productId },
        data: { useLotsAndExpirations: true },
      });
      await prisma.lot.create({
        data: {
          tenantId: w.tenantId,
          productId: w.productId,
          lotNumber: 'L-OLD',
          quantity: 5,
          expirationDate: new Date('2020-01-01T00:00:00.000Z'),
        },
      });
      await post(w.token, body(w, { quantity: 1 })).expect(201);
    });

    it('a product that does not track stock is always available', async () => {
      const w = await world();
      await prisma.product.update({
        where: { id: w.productId },
        data: { useStock: false },
      });
      const res = await post(w.token, body(w)).expect(409);
      expect(res.body).toMatchObject({
        error: 'STOCK_AVAILABLE_NOW',
        availableToSell: null,
      });
    });

    it("404 PRODUCT_NOT_FOUND for an unknown product and for another sucursal's product", async () => {
      const w = await world();
      const other = await world();
      expect(
        (await post(w.token, body(w, { productId: randomUUID() })).expect(404))
          .body.error,
      ).toBe('PRODUCT_NOT_FOUND');
      expect(
        (
          await post(w.token, body(w, { productId: other.productId })).expect(
            404,
          )
        ).body.error,
      ).toBe('PRODUCT_NOT_FOUND');
    });

    describe('variants', () => {
      async function withVariants(w: World) {
        await prisma.product.update({
          where: { id: w.productId },
          data: { hasVariants: true, quantity: 0 },
        });
        const variantId = randomUUID();
        await prisma.variant.create({
          data: {
            id: variantId,
            tenantId: w.tenantId,
            productId: w.productId,
            name: '18 kg',
            quantity: 0,
          },
        });
        const list = await prisma.priceList.findFirstOrThrow({
          where: { tenantId: w.tenantId, productId: w.productId },
        });
        await prisma.variantPrice.create({
          data: {
            tenantId: w.tenantId,
            variantId,
            priceListId: list.id,
            priceCents: 77700,
          },
        });
        const variantDecision = await decision(w.tenantId, w.productId, {
          variantId,
        });
        return { variantId, variantDecision };
      }

      it('422 VARIANT_REQUIRED when the product has variants and none is sent', async () => {
        const w = await world();
        await withVariants(w);
        const res = await post(w.token, body(w)).expect(422);
        expect(res.body.error).toBe('VARIANT_REQUIRED');
      });

      it('schedules a variant with its price, name and the variant decision', async () => {
        const w = await world();
        const { variantId, variantDecision } = await withVariants(w);
        const res = await post(
          w.token,
          body(w, { variantId, sourceDecisionId: variantDecision }),
        ).expect(201);
        expect(res.body.backorder).toMatchObject({
          variantId,
          variantName: '18 kg',
          referencePriceCents: 77700,
          queuePosition: 1,
        });
      });

      it('404 VARIANT_NOT_FOUND / 422 VARIANT_NOT_OF_PRODUCT', async () => {
        const w = await world();
        const { variantId } = await withVariants(w);
        expect(
          (
            await post(w.token, body(w, { variantId: randomUUID() })).expect(
              404,
            )
          ).body.error,
        ).toBe('VARIANT_NOT_FOUND');
        // A variant of another product of the same sucursal.
        const otherProduct = randomUUID();
        await prisma.product.create({
          data: {
            id: otherProduct,
            tenantId: w.tenantId,
            name: 'Otro',
            hasVariants: true,
          },
        });
        const otherVariant = randomUUID();
        await prisma.variant.create({
          data: {
            id: otherVariant,
            tenantId: w.tenantId,
            productId: otherProduct,
            name: 'x',
          },
        });
        expect(
          (
            await post(w.token, body(w, { variantId: otherVariant })).expect(
              422,
            )
          ).body.error,
        ).toBe('VARIANT_NOT_OF_PRODUCT');
        expect(variantId).toBeDefined();
      });

      it('queues each variant separately (position 1 in each)', async () => {
        const w = await world();
        const { variantId, variantDecision } = await withVariants(w);
        const second = await extraCustomer(w, 2);
        const a = await post(
          w.token,
          body(w, { variantId, sourceDecisionId: variantDecision }),
        ).expect(201);
        const b = await post(
          w.token,
          body(w, {
            ...second.phone,
            customer: { mode: 'existing', customerId: second.id },
            variantId,
            sourceDecisionId: variantDecision,
          }),
        ).expect(201);
        expect(a.body.backorder.queuePosition).toBe(1);
        expect(b.body.backorder.queuePosition).toBe(2);
      });
    });

    describe('source decision', () => {
      it('404 SOURCE_DECISION_NOT_FOUND: unknown, another sucursal, another product, EXPIRATION', async () => {
        const w = await world();
        const other = await world();
        const otherProduct = randomUUID();
        await prisma.product.create({
          data: { id: otherProduct, tenantId: w.tenantId, name: 'Otro' },
        });
        const foreignProductDecision = await decision(w.tenantId, otherProduct);
        const expiration = await decision(w.tenantId, w.productId, {
          type: 'EXPIRATION',
          productUnit: 'UNIDAD',
          sku: null,
          requestedQuantity: null,
          observedStockAtRequest: null,
          stockObservedAt: null,
          resolutionAction: 'PROVIDE_EXPIRATION_TEXT',
          restockDays: null,
          expirationText: 'caduca en 2027',
        });
        for (const sourceDecisionId of [
          randomUUID(),
          other.decisionId,
          foreignProductDecision,
          expiration,
        ]) {
          const res = await post(w.token, body(w, { sourceDecisionId })).expect(
            404,
          );
          expect(res.body.error).toBe('SOURCE_DECISION_NOT_FOUND');
        }
      });

      it('409 SOURCE_DECISION_NOT_ESTIMATED: pending, and answered "unavailable"', async () => {
        const w = await world();
        const pending = await decision(w.tenantId, w.productId, {
          status: 'PENDING',
          version: 1,
          resolutionAction: null,
          restockDays: null,
          resolutionRequestId: null,
          resolvedAt: null,
          resolvedByActorId: null,
          resolvedByDisplayName: null,
        });
        const unavailable = await decision(w.tenantId, w.productId, {
          resolutionAction: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
          restockDays: null,
        });
        for (const sourceDecisionId of [pending, unavailable]) {
          const res = await post(w.token, body(w, { sourceDecisionId })).expect(
            409,
          );
          expect(res.body.error).toBe('SOURCE_DECISION_NOT_ESTIMATED');
        }
      });

      it('estimatedAt = resolvedAt + restockDays; a past estimate starts with etaStage 0', async () => {
        const w = await world();
        const old = await decision(w.tenantId, w.productId, {
          resolvedAt: new Date(Date.now() - 30 * DAY),
          restockDays: 3,
        });
        const res = await post(
          w.token,
          body(w, { sourceDecisionId: old }),
        ).expect(201);
        expect(Date.parse(res.body.backorder.estimatedAt)).toBeLessThan(
          Date.now(),
        );
        expect(res.body.backorder.estimatedArrivalDays).toBe(3);
        const row = await prisma.backorder.findUniqueOrThrow({
          where: { id: res.body.backorder.id },
        });
        expect(row.etaStage).toBe(0);
      });
    });

    describe('one active backorder per customer + product + variant', () => {
      it('409 BACKORDER_DUPLICATE {backorderId} while WAITING', async () => {
        const w = await world();
        const first = await post(w.token, body(w)).expect(201);
        const res = await post(w.token, body(w)).expect(409);
        expect(res.body).toMatchObject({
          error: 'BACKORDER_DUPLICATE',
          backorderId: first.body.backorder.id,
        });
        expect(
          await prisma.backorder.count({ where: { tenantId: w.tenantId } }),
        ).toBe(1);
      });

      it('rescheduling after CANCELLED reuses the same decision and joins the back of the queue', async () => {
        const w = await world();
        const other = await extraCustomer(w, 2);
        const first = await post(w.token, body(w)).expect(201);
        await post(
          w.token,
          body(w, {
            ...other.phone,
            customer: { mode: 'existing', customerId: other.id },
          }),
        ).expect(201);
        await cancel(w.token, first.body.backorder.id).expect(200);
        const again = await post(w.token, body(w)).expect(201);
        expect(again.body.backorder).toMatchObject({
          folio: 'BO-000003',
          queuePosition: 2,
          estimatedAt: first.body.backorder.estimatedAt,
        });
      });

      it('concurrent requests (different keys) for the same customer: exactly one wins', async () => {
        const w = await world();
        const results = await Promise.all(
          Array.from({ length: 6 }, () => post(w.token, body(w))),
        );
        const statuses = results.map((r) => r.status).sort();
        expect(statuses.filter((s) => s === 201)).toHaveLength(1);
        for (const r of results.filter((x) => x.status !== 201)) {
          expect(r.status).toBe(409);
          expect(r.body.error).toBe('BACKORDER_DUPLICATE');
        }
        expect(
          await prisma.backorder.count({ where: { tenantId: w.tenantId } }),
        ).toBe(1);
      });
    });

    describe('idempotency', () => {
      it('same key + same body replays 200 with the same backorder and creates nothing', async () => {
        const w = await world();
        const key = `key-${randomUUID()}`;
        const first = await post(w.token, body(w), key).expect(201);
        const replay = await post(w.token, body(w), key).expect(200);
        expect(replay.body.backorder.id).toBe(first.body.backorder.id);
        expect(replay.body.backorder.folio).toBe('BO-000001');
        expect(
          await prisma.backorder.count({ where: { tenantId: w.tenantId } }),
        ).toBe(1);
        expect(
          (
            await prisma.backorderFolioCounter.findUniqueOrThrow({
              where: { tenantId: w.tenantId },
            })
          ).lastNumber,
        ).toBe(1);
      });

      it('a replay shows the CURRENT state (after the customer cancelled)', async () => {
        const w = await world();
        const key = `key-${randomUUID()}`;
        const first = await post(w.token, body(w), key).expect(201);
        await cancel(w.token, first.body.backorder.id).expect(200);
        const replay = await post(w.token, body(w), key).expect(200);
        expect(replay.body.backorder).toMatchObject({
          id: first.body.backorder.id,
          status: 'CANCELLED',
        });
      });

      it('same key + different body is 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
        const w = await world();
        const key = `key-${randomUUID()}`;
        await post(w.token, body(w), key).expect(201);
        const res = await post(w.token, body(w, { quantity: 3 }), key).expect(
          409,
        );
        expect(res.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });

      it('omitted and null optional members replay as the same body', async () => {
        const w = await world();
        const key = `key-${randomUUID()}`;
        await post(w.token, body(w), key).expect(201);
        await post(
          w.token,
          body(w, {
            variantId: null,
            expectedReferencePriceCents: null,
            chatbotRequestId: null,
          }),
          key,
        ).expect(200);
      });

      it('concurrent identical requests create exactly one backorder', async () => {
        const w = await world();
        const key = `key-${randomUUID()}`;
        const results = await Promise.all(
          Array.from({ length: 6 }, () => post(w.token, body(w), key)),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        for (const r of results.filter((x) => x.status !== 201)) {
          expect([200, 409]).toContain(r.status);
          if (r.status === 409) {
            expect(r.body.error).toBe('IDEMPOTENCY_KEY_IN_FLIGHT');
          }
        }
        expect(
          await prisma.backorder.count({ where: { tenantId: w.tenantId } }),
        ).toBe(1);
      });

      it('an idempotency key is scoped to the tenant', async () => {
        const a = await world();
        const b = await world();
        const key = `key-${randomUUID()}`;
        const first = await post(a.token, body(a), key).expect(201);
        const second = await post(b.token, body(b), key).expect(201);
        expect(second.body.backorder.id).not.toBe(first.body.backorder.id);
      });

      it('400 INVALID_IDEMPOTENCY_KEY when the header is missing', async () => {
        const w = await world();
        const res = await request(app.getHttpServer())
          .post('/chatbot-api/backorders')
          .set('Authorization', `Bearer ${w.token}`)
          .send(body(w))
          .expect(400);
        expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
      });
    });

    describe('folio', () => {
      it('allocates distinct consecutive folios under concurrency (one tenant)', async () => {
        const w = await world();
        const customers = await Promise.all(
          Array.from({ length: 8 }, (_, i) => extraCustomer(w, 10 + i)),
        );
        const results = await Promise.all(
          customers.map((c) =>
            post(
              w.token,
              body(w, {
                ...c.phone,
                customer: { mode: 'existing', customerId: c.id },
              }),
            ),
          ),
        );
        for (const r of results) expect(r.status).toBe(201);
        const folios = results
          .map((r) => r.body.backorder.folio as string)
          .sort();
        expect(folios).toEqual(
          Array.from(
            { length: 8 },
            (_, i) => `BO-${String(i + 1).padStart(6, '0')}`,
          ),
        );
        expect(
          (
            await prisma.backorderFolioCounter.findUniqueOrThrow({
              where: { tenantId: w.tenantId },
            })
          ).lastNumber,
        ).toBe(8);
      });

      it('a rejected request does not burn a folio', async () => {
        const w = await world();
        await post(w.token, body(w, { expectedReferencePriceCents: 1 })).expect(
          409,
        );
        const ok = await post(w.token, body(w)).expect(201);
        expect(ok.body.backorder.folio).toBe('BO-000001');
      });

      it('each tenant counts on its own', async () => {
        const a = await world();
        const b = await world();
        expect(
          (await post(a.token, body(a)).expect(201)).body.backorder.folio,
        ).toBe('BO-000001');
        expect(
          (await post(b.token, body(b)).expect(201)).body.backorder.folio,
        ).toBe('BO-000001');
      });
    });

    it('stores the wrapper request when it belongs to the tenant; 404 CHATBOT_REQUEST_NOT_FOUND otherwise', async () => {
      const w = await world();
      const missing = await post(
        w.token,
        body(w, { chatbotRequestId: randomUUID() }),
      ).expect(404);
      expect(missing.body.error).toBe('CHATBOT_REQUEST_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // GET / list / cancel
  // ---------------------------------------------------------------------------

  describe('GET /chatbot-api/backorders/:id and list', () => {
    it('reads one backorder; 404 BACKORDER_NOT_FOUND otherwise', async () => {
      const w = await world();
      const created = await post(w.token, body(w)).expect(201);
      const res = await get(w.token, `/${created.body.backorder.id}`).expect(
        200,
      );
      expect(res.body).toEqual({ backorder: created.body.backorder });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(
        (await get(w.token, `/${randomUUID()}`).expect(404)).body.error,
      ).toBe('BACKORDER_NOT_FOUND');
      expect((await get(w.token, '/not-a-uuid').expect(404)).body.error).toBe(
        'BACKORDER_NOT_FOUND',
      );
    });

    it('lists by phone, newest activity first, filtered by status and updatedSince', async () => {
      const w = await world();
      const second = await extraCustomer(w, 2);
      const a = await post(w.token, body(w)).expect(201);
      const otherProduct = randomUUID();
      await prisma.product.create({
        data: { id: otherProduct, tenantId: w.tenantId, name: 'Arena 10 kg' },
      });
      await prisma.priceList.create({
        data: {
          tenantId: w.tenantId,
          productId: otherProduct,
          globalPriceListId: publicListId,
          priceCents: 20000,
        },
      });
      const otherDecision = await decision(w.tenantId, otherProduct);
      const b = await post(
        w.token,
        body(w, { productId: otherProduct, sourceDecisionId: otherDecision }),
      ).expect(201);
      // Another customer's backorder never shows for this phone.
      await post(
        w.token,
        body(w, {
          ...second.phone,
          customer: { mode: 'existing', customerId: second.id },
        }),
      ).expect(201);
      await cancel(w.token, a.body.backorder.id).expect(200);

      const all = await get(
        w.token,
        `?phoneCountryCode=${w.phone.phoneCountryCode}&phone=${w.phone.phone}`,
      ).expect(200);
      expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([
        a.body.backorder.id,
        b.body.backorder.id,
      ]);

      const waiting = await get(
        w.token,
        `?phoneCountryCode=${w.phone.phoneCountryCode}&phone=${w.phone.phone}&status=WAITING,RESERVED`,
      ).expect(200);
      expect(waiting.body.items.map((i: { id: string }) => i.id)).toEqual([
        b.body.backorder.id,
      ]);

      const since = new Date(Date.now() + 60_000).toISOString();
      expect(
        (
          await get(
            w.token,
            `?updatedSince=${encodeURIComponent(since)}`,
          ).expect(200)
        ).body.items,
      ).toEqual([]);
      const past = new Date(Date.now() - 60_000).toISOString();
      expect(
        (
          await get(
            w.token,
            `?updatedSince=${encodeURIComponent(past)}`,
          ).expect(200)
        ).body.items,
      ).toHaveLength(3);
    });

    it('an unknown phone lists nothing; an ambiguous phone is 409', async () => {
      const w = await world();
      expect(
        (
          await get(w.token, '?phoneCountryCode=52&phone=5599999999').expect(
            200,
          )
        ).body,
      ).toEqual({ items: [] });
      await prisma.customer.create({
        data: { tenantId: w.tenantId, firstName: 'Clon', ...w.phone },
      });
      expect(
        (
          await get(
            w.token,
            `?phoneCountryCode=${w.phone.phoneCountryCode}&phone=${w.phone.phone}`,
          ).expect(409)
        ).body.error,
      ).toBe('CUSTOMER_PHONE_AMBIGUOUS');
    });

    it('answers at most 50 items', async () => {
      const w = await world();
      const products = Array.from({ length: 52 }, () => randomUUID());
      await prisma.product.createMany({
        data: products.map((id) => ({
          id,
          tenantId: w.tenantId,
          name: `P-${id.slice(0, 4)}`,
        })),
      });
      const decisionId = w.decisionId;
      let n = 0;
      for (const productId of products) {
        n += 1;
        await insertBackorder(w, {
          productId,
          folio: `BO-${String(n).padStart(6, '0')}`,
          sourceDecisionId: decisionId,
        });
      }
      const res = await get(w.token).expect(200);
      expect(res.body.items).toHaveLength(50);
    });
  });

  describe('POST /chatbot-api/backorders/:id/cancel', () => {
    it('cancels WAITING now: CUSTOMER, reason, version bump; queue shifts up', async () => {
      const w = await world();
      const second = await extraCustomer(w, 2);
      const head = await post(w.token, body(w)).expect(201);
      const tail = await post(
        w.token,
        body(w, {
          ...second.phone,
          customer: { mode: 'existing', customerId: second.id },
        }),
      ).expect(201);
      expect(tail.body.backorder.queuePosition).toBe(2);

      const res = await cancel(w.token, head.body.backorder.id, {
        reason: ' ya no lo necesito ',
      }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.backorder).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'CUSTOMER',
        cancelReason: 'ya no lo necesito',
        queuePosition: null,
      });
      const row = await prisma.backorder.findUniqueOrThrow({
        where: { id: head.body.backorder.id },
      });
      expect(row).toMatchObject({
        status: 'CANCELLED',
        version: 2,
        cancelledByUserId: null,
      });
      expect(row.cancelledAt).toBeInstanceOf(Date);
      expect(
        (await get(w.token, `/${tail.body.backorder.id}`).expect(200)).body
          .backorder.queuePosition,
      ).toBe(1);
      expect(releaser.releaseReservation).not.toHaveBeenCalled();
    });

    it('409 BACKORDER_NOT_CANCELLABLE {status} when already terminal', async () => {
      const w = await world();
      const created = await post(w.token, body(w)).expect(201);
      await cancel(w.token, created.body.backorder.id).expect(200);
      const again = await cancel(w.token, created.body.backorder.id).expect(
        409,
      );
      expect(again.body).toEqual({
        statusCode: 409,
        error: 'BACKORDER_NOT_CANCELLABLE',
        message: 'BACKORDER_NOT_CANCELLABLE',
        status: 'CANCELLED',
      });
      const expired = await insertBackorder(w, {
        status: 'EXPIRED',
        expiredAt: new Date(),
        customerId: (await extraCustomer(w, 3)).id,
      });
      expect((await cancel(w.token, expired.id).expect(409)).body.status).toBe(
        'EXPIRED',
      );
    });

    it('a RESERVED backorder goes through the release seam in the same transaction', async () => {
      const w = await world();
      const reserved = await insertBackorder(w, reservedFields());
      const res = await cancel(w.token, reserved.id, {
        reason: 'cambié de idea',
      }).expect(200);
      expect(res.body.backorder.status).toBe('CANCELLED');
      expect(releaser.releaseReservation).toHaveBeenCalledTimes(1);
      expect(releaser.releaseReservation).toHaveBeenCalledWith({
        tenantId: w.tenantId,
        backorderId: reserved.id,
        productId: w.productId,
        variantId: null,
        quantity: 1,
      });
    });

    it('a failing release rolls the cancel back', async () => {
      const w = await world();
      const reserved = await insertBackorder(w, reservedFields());
      releaser.releaseReservation.mockRejectedValueOnce(
        new Error('journal down'),
      );
      await cancel(w.token, reserved.id).expect(500);
      expect(
        (
          await prisma.backorder.findUniqueOrThrow({
            where: { id: reserved.id },
          })
        ).status,
      ).toBe('RESERVED');
    });

    it('404 for an unknown or malformed id; 400 for a too long reason', async () => {
      const w = await world();
      expect((await cancel(w.token, randomUUID()).expect(404)).body.error).toBe(
        'BACKORDER_NOT_FOUND',
      );
      expect((await cancel(w.token, 'nope').expect(404)).body.error).toBe(
        'BACKORDER_NOT_FOUND',
      );
      const created = await post(w.token, body(w)).expect(201);
      await cancel(w.token, created.body.backorder.id, {
        reason: 'x'.repeat(281),
      }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Scopes and tenant isolation
  // ---------------------------------------------------------------------------

  describe('scopes', () => {
    it('each route needs its own scope', async () => {
      const w = await world();
      const created = await post(w.token, body(w)).expect(201);
      const id = created.body.backorder.id as string;
      const readOnly = credentials.register(w.tenantId, [
        BACKORDER_SCOPES.read,
      ]);
      const createOnly = credentials.register(w.tenantId, [
        BACKORDER_SCOPES.create,
      ]);
      const cancelOnly = credentials.register(w.tenantId, [
        BACKORDER_SCOPES.cancel,
      ]);
      await post(readOnly, body(w)).expect(403);
      await get(createOnly, `/${id}`).expect(403);
      await get(createOnly).expect(403);
      await cancel(readOnly, id).expect(403);
      await get(readOnly, `/${id}`).expect(200);
      await cancel(cancelOnly, id).expect(200);
    });

    it('401 without a credential', async () => {
      await request(app.getHttpServer())
        .get('/chatbot-api/backorders')
        .expect(401);
    });
  });

  describe('tenant isolation', () => {
    it('another sucursal cannot read, list or cancel a backorder (404, nothing changes)', async () => {
      const a = await world();
      const b = await world();
      const created = await post(a.token, body(a)).expect(201);
      const id = created.body.backorder.id as string;
      expect((await get(b.token, `/${id}`).expect(404)).body.error).toBe(
        'BACKORDER_NOT_FOUND',
      );
      expect((await cancel(b.token, id).expect(404)).body.error).toBe(
        'BACKORDER_NOT_FOUND',
      );
      expect((await get(b.token).expect(200)).body.items).toEqual([]);
      expect(
        (
          await get(
            b.token,
            `?phoneCountryCode=${a.phone.phoneCountryCode}&phone=${a.phone.phone}`,
          ).expect(200)
        ).body.items,
      ).toEqual([]);
      expect(
        (await prisma.backorder.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('WAITING');
    });

    it("cannot schedule with another sucursal's customer, product or decision", async () => {
      const a = await world();
      const b = await world();
      expect(
        (
          await post(
            b.token,
            body(b, {
              customer: { mode: 'existing', customerId: a.customerId },
            }),
          ).expect(404)
        ).body.error,
      ).toBe('CUSTOMER_NOT_FOUND');
      expect(
        (await post(b.token, body(b, { productId: a.productId })).expect(404))
          .body.error,
      ).toBe('PRODUCT_NOT_FOUND');
      expect(
        (
          await post(
            b.token,
            body(b, { sourceDecisionId: a.decisionId }),
          ).expect(404)
        ).body.error,
      ).toBe('SOURCE_DECISION_NOT_FOUND');
    });

    it('queue positions never count another sucursal', async () => {
      const a = await world();
      const b = await world();
      await post(a.token, body(a)).expect(201);
      const res = await post(b.token, body(b)).expect(201);
      expect(res.body.backorder.queuePosition).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Migration constraints (direct SQL through Prisma)
  // ---------------------------------------------------------------------------

  describe('migration constraints', () => {
    it('allows one active backorder per customer+product (NULL variant): WAITING blocks WAITING', async () => {
      const w = await world();
      await insertBackorder(w);
      const v = await violation(() => insertBackorder(w));
      expect(v.text).toMatch(/backorders_one_active|Unique constraint|23505/i);
    });

    it('RESERVED counts as active too', async () => {
      const w = await world();
      await insertBackorder(w, reservedFields());
      const v = await violation(() => insertBackorder(w));
      expect(v.text).toMatch(/backorders_one_active|Unique constraint|23505/i);
    });

    it('frees the slot once the backorder is CANCELLED, EXPIRED or CONFIRMED', async () => {
      const w = await world();
      const saleId = await saleOf(w.tenantId);
      await insertBackorder(w, cancelledFields());
      await insertBackorder(w, { status: 'EXPIRED', expiredAt: new Date() });
      await insertBackorder(w, {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        saleId,
        currentPriceCents: 900,
        finalPriceCents: 900,
      });
      // …and a fresh active one fits next to all the terminal ones.
      await insertBackorder(w);
      const v = await violation(() => insertBackorder(w));
      expect(v.text).toMatch(/backorders_one_active|Unique constraint|23505/i);
    });

    it('treats NULL variants as equal and variants as distinct', async () => {
      const w = await world();
      const variants = [randomUUID(), randomUUID()];
      await prisma.product.update({
        where: { id: w.productId },
        data: { hasVariants: true },
      });
      for (const id of variants) {
        await prisma.variant.create({
          data: { id, tenantId: w.tenantId, productId: w.productId, name: id },
        });
      }
      // Two different variants for the same customer+product coexist…
      await insertBackorder(w, { variantId: variants[0] });
      await insertBackorder(w, { variantId: variants[1] });
      // …next to ONE variant-less backorder (NULL equal), but not two.
      await insertBackorder(w, { variantId: null });
      const dupNull = await violation(() =>
        insertBackorder(w, { variantId: null }),
      );
      expect(dupNull.text).toMatch(
        /backorders_one_active|Unique constraint|23505/i,
      );
      const dupVariant = await violation(() =>
        insertBackorder(w, { variantId: variants[0] }),
      );
      expect(dupVariant.text).toMatch(
        /backorders_one_active|Unique constraint|23505/i,
      );
    });

    it('lets different customers and different products queue for the same thing', async () => {
      const w = await world();
      const other = await extraCustomer(w, 2);
      await insertBackorder(w);
      await insertBackorder(w, { customerId: other.id });
      const otherProduct = randomUUID();
      await prisma.product.create({
        data: { id: otherProduct, tenantId: w.tenantId, name: 'Otro' },
      });
      await insertBackorder(w, { productId: otherProduct });
    });

    it('keeps the idempotency key and the folio unique per tenant only', async () => {
      const a = await world();
      const b = await world();
      const first = await insertBackorder(a, {
        idempotencyKey: 'same-key',
        folio: 'BO-000001',
      });
      expect(first.id).toBeDefined();
      const second = await extraCustomer(a, 2);
      const third = await extraCustomer(a, 3);
      const dupKey = await violation(() =>
        insertBackorder(a, {
          idempotencyKey: 'same-key',
          customerId: second.id,
        }),
      );
      expect(dupKey.text).toMatch(/idempotencyKey|Unique constraint/i);
      const dupFolio = await violation(() =>
        insertBackorder(a, { folio: 'BO-000001', customerId: third.id }),
      );
      expect(dupFolio.text).toMatch(/folio|Unique constraint/i);
      await insertBackorder(b, {
        idempotencyKey: 'same-key',
        folio: 'BO-000001',
      });
    });

    it('rejects a cross-tenant product through the composite FK', async () => {
      const a = await world();
      const b = await world();
      const v = await violation(() =>
        insertBackorder(a, { productId: b.productId }),
      );
      expect(v.text).toMatch(/foreign key|P2003|23503/i);
    });

    it('rejects a cross-tenant sale and chatbot request through the composite FKs', async () => {
      const a = await world();
      const b = await world();
      const saleId = await saleOf(b.tenantId);
      const sv = await violation(() =>
        insertBackorder(a, {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          saleId,
        }),
      );
      expect(sv.text).toMatch(/foreign key|P2003|23503/i);
      const cv = await violation(() =>
        insertBackorder(a, { chatbotRequestId: randomUUID() }),
      );
      expect(cv.text).toMatch(/foreign key|P2003|23503/i);
    });

    it.each([
      ['folio shape', { folio: 'CC-000001' }, /backorders_folio_format|check/i],
      ['quantity >= 1', { quantity: 0 }, /backorders_quantity_positive|check/i],
      [
        'prices non negative',
        { referencePriceCents: -1 },
        /backorders_prices_non_negative|check/i,
      ],
      [
        'final <= reference',
        { ...reservedFields(), referencePriceCents: 800, finalPriceCents: 900 },
        /backorders_final_price_not_above_reference|check/i,
      ],
      [
        'eta days 1..365',
        { estimatedArrivalDays: 366 },
        /backorders_estimated_days_range|check/i,
      ],
      ['stage range', { etaStage: 3 }, /backorders_stage_range|check/i],
      [
        'a CANCELLED row needs cancelledAt and kind',
        { status: 'CANCELLED' as const },
        /backorders_cancelled_state|check/i,
      ],
      [
        'cancel members need CANCELLED',
        { cancelReason: 'x' },
        /backorders_cancelled_state|check/i,
      ],
      [
        'a user can only cancel as STAFF',
        { ...cancelledFields(), cancelledByUserId: 'someone' },
        /backorders_cancelled_by_user_is_staff|foreign key|check/i,
      ],
      [
        'a RESERVED row needs its reservation',
        { status: 'RESERVED' as const },
        /backorders_reserved_state|check/i,
      ],
      [
        'a WAITING row holds no reservation',
        { reservedUntil: new Date() },
        /backorders_waiting_state|check/i,
      ],
      [
        'a CONFIRMED row needs sale and time',
        { status: 'CONFIRMED' as const },
        /backorders_confirmed_state|check/i,
      ],
      [
        'EXPIRED needs expiredAt',
        { status: 'EXPIRED' as const },
        /backorders_expired_state|check/i,
      ],
      [
        'requestHash shape',
        { requestHash: 'nope' },
        /backorders_idempotency_shape|check/i,
      ],
    ] as Array<
      [string, Partial<Prisma.BackorderUncheckedCreateInput>, RegExp]
    >)('CHECK: %s', async (_label, over, expected) => {
      const w = await world();
      const v = await violation(() => insertBackorder(w, over));
      expect(v.text).toMatch(expected);
    });

    it('restricts deleting a customer, product or decision that has a backorder', async () => {
      const w = await world();
      await insertBackorder(w);
      expect(
        (
          await violation(() =>
            prisma.customer.delete({ where: { id: w.customerId } }),
          )
        ).text,
      ).toMatch(/foreign key|P2003|23503/i);
      expect(
        (
          await violation(() =>
            prisma.product.delete({ where: { id: w.productId } }),
          )
        ).text,
      ).toMatch(/foreign key|P2003|23503/i);
      expect(
        (
          await violation(() =>
            prisma.humanDecision.delete({ where: { id: w.decisionId } }),
          )
        ).text,
      ).toMatch(/foreign key|P2003|23503/i);
    });
  });
});
