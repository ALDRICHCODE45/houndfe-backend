/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- supertest bodies are untyped JSON; test doubles are async-shaped */
/**
 * customer-collection / T1 (S1) — counter charge change rule against REAL
 * PostgreSQL through `POST /sales/drafts/:id/charge` (real JWT → tenant → CASL chain,
 * production pipe + DomainExceptionFilter), the real `PrismaSaleRepository`,
 * the real stock journal (`SaleStockService`) and the real cash ledger
 * (`PrismaCashRegisterApplication`) bound to an OPEN cash session.
 *
 * Owner rule «Rechazar si el cambio supera el efectivo»: change (tendered −
 * total) may never exceed the cash tendered. Card 1100 + cash 100 on a 1000
 * sale answers `422 CHANGE_EXCEEDS_CASH_TENDERED` and writes nothing; the
 * valid card 800 + cash 300 control still charges with change 100.
 */
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createMongoAbility } from '@casl/ability';
import { randomUUID } from 'node:crypto';
import type { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AppAbility } from '../auth/authorization/domain/permission';
import { PrismaCashRegisterApplication } from '../cash-register/infrastructure/prisma-cash-register';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { PrismaStockAlertStateRepository } from '../stock-alerts/infrastructure/prisma-stock-alert-state.repository';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SaleStockService } from './sale-stock.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('counter charge change never exceeds cash tendered (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [SalesController],
      providers: [
        {
          provide: SalesService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) => {
            const journal = new StockJournalWriter(tenantPrisma, {
              get: (_key: string, fallback: string) => fallback,
            } as unknown as ConfigService);
            const sales = new SalesService(
              new PrismaSaleRepository(tenantPrisma),
              // SAFETY: the seeded line is CUSTOM-priced, so the charge never
              // asks the catalog for a price.
              {} as never,
              { emit: jest.fn() } as never,
              new OutboxWriterService(),
              tenantPrisma,
              { findActiveBySale: async () => [] },
              // SAFETY: the engine is replaced by the recompute stub below.
              {} as never,
              // SAFETY: built-in methods only — the resolver is never called.
              {} as never,
              { claimForSale: async () => undefined } as never,
              new PrismaCashRegisterApplication(tenantPrisma),
              new SaleStockService(
                journal,
                tenantPrisma,
                new OutboxWriterService(),
                new PrismaStockAlertStateRepository(),
              ),
            );
            Object.assign(sales, {
              recomputePricingAndPromotions: async () => ({
                promotionCapacityDemands: [],
                capacityExcludedPromotionIds: [],
              }),
            });
            return sales;
          },
        },
      ],
    });
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  interface Counter {
    tenantId: string;
    member: SeededMember;
    productId: string;
    saleId: string;
    sessionId: string;
  }

  /** Tenant, cashier, one product (stock 10), a 1000-cent DRAFT, OPEN session. */
  async function counter(): Promise<Counter> {
    const tenantId = await world.tenant('Mostrador S1');
    const member = await world.member(tenantId, 'Cajera S1', [
      'Sale:update',
    ]);
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas',
        quantity: 10,
        useStock: true,
      },
    });
    const saleId = randomUUID();
    await prisma.sale.create({
      data: { id: saleId, tenantId, userId: member.userId, status: 'DRAFT' },
    });
    await prisma.saleItem.create({
      data: {
        tenantId,
        saleId,
        productId,
        productName: 'Croquetas',
        quantity: 1,
        unitPriceCents: 1000,
        priceSource: 'CUSTOM',
        customPriceCents: 1000,
      },
    });

    // Open the session through the real cash application (tenant-scoped
    // client with its own CLS-like store, outside any HTTP request).
    const store = new Map<string, unknown>([
      ['tenantId', tenantId],
      ['isSuperAdmin', false],
    ]);
    const cls = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    } as unknown as ClsService<TenantClsStore>;
    const cash = new PrismaCashRegisterApplication(
      new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      ),
    );
    const actor = {
      userId: member.userId,
      ability: createMongoAbility<AppAbility>([
        { action: 'manage', subject: 'all' },
      ]),
    };
    const register = await cash.execute(
      actor,
      { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
      randomUUID(),
    );
    const opened = await cash.execute(
      actor,
      {
        kind: 'OPEN_SESSION',
        registerId: register.id as string,
        openingCents: 0,
        openingConfirmed: true,
      },
      randomUUID(),
    );
    const sessionId = (opened.session as { id: string }).id;
    return { tenantId, member, productId, saleId, sessionId };
  }

  const charge = (c: Counter, body: object) =>
    request(server())
      .post(`/sales/drafts/${c.saleId}/charge`)
      .set('Authorization', `Bearer ${c.member.token}`)
      .set('idempotency-key', randomUUID())
      .send(body);

  async function writes(c: Counter) {
    const [sale, product, payments, movements, stock, idempotency] =
      await Promise.all([
        prisma.sale.findUniqueOrThrow({ where: { id: c.saleId } }),
        prisma.product.findUniqueOrThrow({ where: { id: c.productId } }),
        prisma.salePayment.findMany({ where: { saleId: c.saleId } }),
        prisma.cashMovement.findMany({
          where: { tenantId: c.tenantId, sessionId: c.sessionId },
        }),
        prisma.stockMovement.count({ where: { tenantId: c.tenantId } }),
        prisma.saleIdempotency.findMany({
          where: { tenantId: c.tenantId, operation: 'sale_charge' },
        }),
      ]);
    return { sale, product, payments, movements, stock, idempotency };
  }

  it('rejects card 1100 + cash 100 on 1000 with 422 CHANGE_EXCEEDS_CASH_TENDERED and writes nothing (session-bound)', async () => {
    const c = await counter();

    const res = await charge(c, {
      cashSessionId: c.sessionId,
      payments: [
        { method: 'card_debit', amountCents: 1100 },
        { method: 'cash', amountCents: 100 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      statusCode: 422,
      error: 'CHANGE_EXCEEDS_CASH_TENDERED',
      message: 'CHANGE_EXCEEDS_CASH_TENDERED',
    });
    const after = await writes(c);
    expect(after.sale.status).toBe('DRAFT');
    expect(after.sale.folio).toBeNull();
    expect(after.sale.changeDueCents).toBe(0);
    expect(after.product.quantity).toBe(10);
    expect(after.payments).toEqual([]);
    expect(after.movements).toEqual([]);
    expect(after.stock).toBe(0);
    // The bound path rolls the freshly acquired slot back with the tx.
    expect(after.idempotency).toEqual([]);
  });

  it('rejects the same tenders without a session and writes no sale/stock/payment rows and no SUCCEEDED slot', async () => {
    const c = await counter();

    const res = await charge(c, {
      payments: [
        { method: 'card_credit', amountCents: 1100 },
        { method: 'cash', amountCents: 100 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('CHANGE_EXCEEDS_CASH_TENDERED');
    const after = await writes(c);
    expect(after.sale.status).toBe('DRAFT');
    expect(after.product.quantity).toBe(10);
    expect(after.payments).toEqual([]);
    expect(after.movements).toEqual([]);
    expect(after.stock).toBe(0);
    expect(after.idempotency.filter((r) => r.status === 'SUCCEEDED')).toEqual(
      [],
    );
  });

  it('still charges card 800 + cash 300 on 1000 with change 100 and cash-channel net 200 (session-bound)', async () => {
    const c = await counter();

    const res = await charge(c, {
      cashSessionId: c.sessionId,
      payments: [
        { method: 'card_debit', amountCents: 800 },
        { method: 'cash', amountCents: 300 },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      totalCents: 1000,
      paidCents: 1000,
      debtCents: 0,
      changeDueCents: 100,
      paymentStatus: 'PAID',
    });
    const after = await writes(c);
    expect(after.sale.status).toBe('CONFIRMED');
    expect(after.sale.changeDueCents).toBe(100);
    expect(after.product.quantity).toBe(9);
    expect(after.payments).toHaveLength(2);
    const byKind = (kind: string) =>
      after.movements
        .filter((m) => m.kind === kind)
        .reduce((sum, m) => sum + m.deltaCents, 0);
    expect(byKind('SALE_CHANGE')).toBe(-100);
    // Every tender is ledgered; the cash channel nets cash 300 − change 100.
    expect(
      after.movements
        .filter((m) => m.method === 'CASH')
        .reduce((sum, m) => sum + m.deltaCents, 0),
    ).toBe(200);
    expect(after.idempotency.map((r) => r.status)).toEqual(['SUCCEEDED']);
  });
});
