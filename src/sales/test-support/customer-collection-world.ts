/* eslint-disable @typescript-eslint/require-await -- test doubles are async-shaped */
/**
 * customer-collection / T2 — integration support for the «Cobrar todo» specs
 * (excluded from the build by `tsconfig.build.json` `**\/test-support/**`).
 *
 * Boots the real JWT → tenant → CASL chain with the production pipe/filters
 * (`createZoneTestApp`) and the REAL adapters: `PrismaSaleRepository`,
 * `PrismaCustomerCollectionRepository`, the cash ledger
 * (`PrismaCashRegisterApplication`), the stock journal and the outbox writer.
 * Routes: the collection preview/apply, the single-sale payment, the sale
 * cancellation and the customer DELETE; T3 adds `GET /collections/:id` and
 * its receipt PDF (real `PrismaCollectionReader`, real render method of
 * `PdfGenerationService` without `onModuleInit`). The collection's payment
 * method resolver is a stub that knows `CATALOG_CARD_METHOD` (T2b).
 */
import { Logger, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createMongoAbility } from '@casl/ability';
import { randomUUID } from 'node:crypto';
import type { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PrismaCashRegisterApplication } from '../../cash-register/infrastructure/prisma-cash-register';
import { CustomersController } from '../../customers/customers.controller';
import { CustomersService } from '../../customers/customers.service';
import { CUSTOMER_REPOSITORY } from '../../customers/domain/customer.repository';
import { PrismaCustomerRepository } from '../../customers/infrastructure/prisma-customer.repository';
import {
  createZoneTestApp,
  worldPrisma,
  type SeededMember,
  type ZoneWorld,
} from '../../delivery-zones/test-support/delivery-zone-world';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import { PdfGenerationService } from '../../pdf-generation/pdf-generation.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaStockAlertStateRepository } from '../../stock-alerts/infrastructure/prisma-stock-alert-state.repository';
import { CollectionReadService } from '../collection-read.service';
import { CollectionReceiptPdfController } from '../collection-receipt-pdf.controller';
import { CollectionsController } from '../collections.controller';
import { PrismaCollectionReader } from '../infrastructure/prisma-collection.reader';
import { CustomerCollectionService } from '../customer-collection.service';
import { CustomerCollectionsController } from '../customer-collections.controller';
import { PrismaCustomerCollectionRepository } from '../infrastructure/prisma-customer-collection.repository';
import { PrismaSaleRepository } from '../infrastructure/prisma-sale.repository';
import { SaleStockService } from '../sale-stock.service';
import { SalesPaymentsController } from '../sales-payments.controller';
import { SalesQueryController } from '../sales-query.controller';
import { SalesService } from '../sales.service';

/** 12:00 in Mexico City on 2026-11-25 → business today 2026-11-25. */
export const COLLECTION_NOW = new Date('2026-11-25T18:00:00.000Z');

/**
 * T2b — the one catalog payment method the collection resolver stub knows: a
 * `card_debit` «Terminal BBVA / Débito». Any other id answers the real
 * resolver's `PAYMENT_METHOD_NOT_FOUND`, a category mismatch its
 * `PAYMENT_METHOD_CATEGORY_MISMATCH`.
 */
export const CATALOG_CARD_METHOD = {
  id: '7c0f8f9e-5a4b-4c3d-9e2f-1a2b3c4d5e6f',
  category: 'card_debit',
  name: 'Terminal BBVA',
  subtitle: 'Débito',
} as const;

const catalogResolverStub = {
  resolveActive: async (input: {
    paymentMethodId: string;
    expectedCategory: string;
  }) => {
    if (input.paymentMethodId !== CATALOG_CARD_METHOD.id) {
      throw new BusinessRuleViolationError(
        'PAYMENT_METHOD_NOT_FOUND',
        'PAYMENT_METHOD_NOT_FOUND',
      );
    }
    if (input.expectedCategory !== CATALOG_CARD_METHOD.category) {
      throw new BusinessRuleViolationError(
        'PAYMENT_METHOD_CATEGORY_MISMATCH',
        'PAYMENT_METHOD_CATEGORY_MISMATCH',
      );
    }
    return {
      category: CATALOG_CARD_METHOD.category,
      name: CATALOG_CARD_METHOD.name,
      subtitle: CATALOG_CARD_METHOD.subtitle,
    };
  },
  listActive: async () => [],
};

export async function createCollectionTestApp(): Promise<INestApplication> {
  // Real render method without `onModuleInit` (no font CDN preflight).
  const pdf = Object.create(
    PdfGenerationService.prototype,
  ) as PdfGenerationService;
  Object.assign(pdf, { logger: new Logger('CollectionReceiptSpec') });
  return createZoneTestApp({
    controllers: [
      CustomerCollectionsController,
      CollectionsController,
      CollectionReceiptPdfController,
      SalesPaymentsController,
      SalesQueryController,
      CustomersController,
    ],
    providers: [
      { provide: PdfGenerationService, useValue: pdf },
      {
        provide: CollectionReadService,
        inject: [TenantPrismaService],
        useFactory: (tenantPrisma: TenantPrismaService) =>
          new CollectionReadService(new PrismaCollectionReader(tenantPrisma)),
      },
      CustomersService,
      { provide: CUSTOMER_REPOSITORY, useClass: PrismaCustomerRepository },
      {
        provide: CustomerCollectionService,
        inject: [TenantPrismaService],
        useFactory: (tenantPrisma: TenantPrismaService) =>
          new CustomerCollectionService(
            new PrismaSaleRepository(tenantPrisma),
            new PrismaCustomerCollectionRepository(tenantPrisma),
            new OutboxWriterService(),
            tenantPrisma,
            catalogResolverStub as never,
            new PrismaCashRegisterApplication(tenantPrisma),
            () => COLLECTION_NOW,
            undefined,
          ),
      },
      {
        provide: SalesService,
        inject: [TenantPrismaService],
        useFactory: (tenantPrisma: TenantPrismaService) => {
          const journal = new StockJournalWriter(tenantPrisma, {
            get: (_key: string, fallback: string) => fallback,
          } as unknown as ConfigService);
          return new SalesService(
            new PrismaSaleRepository(tenantPrisma),
            // SAFETY: payments and cancellation never ask the catalog.
            {} as never,
            { emit: jest.fn() } as never,
            new OutboxWriterService(),
            tenantPrisma,
            { findActiveBySale: async () => [] },
            // SAFETY: no draft is recomputed on these routes.
            {} as never,
            // SAFETY: built-in methods only — the resolver is never called.
            {} as never,
            {
              claimForSale: async () => undefined,
              restoreForSale: async () => undefined,
            } as never,
            new PrismaCashRegisterApplication(tenantPrisma),
            new SaleStockService(
              journal,
              tenantPrisma,
              new OutboxWriterService(),
              new PrismaStockAlertStateRepository(),
            ),
          );
        },
      },
    ],
  });
}

export const COLLECTION_GRANTS = [
  'Sale:read',
  'Sale:update',
  'Sale:delete',
  'Customer:read',
  'Customer:delete',
];

/** Opens an OPEN cash session owned by `member` through the real cash app. */
export async function openSession(
  tenantId: string,
  member: SeededMember,
): Promise<string> {
  const prisma = worldPrisma();
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
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
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
  return (opened.session as { id: string }).id;
}

export interface SeedSale {
  /** Fixed id, so tests can control the `ORDER BY id` lock order. */
  id?: string;
  totalCents: number;
  paidCents?: number;
  dueDate?: string | null;
  confirmedAt?: string;
  status?: 'CONFIRMED' | 'CANCELED';
  customerId?: string | null;
  userId?: string;
}

export async function seedCustomer(
  tenantId: string,
  firstName = 'Ana',
  lastName: string | null = 'López',
): Promise<string> {
  const id = randomUUID();
  await worldPrisma().customer.create({
    data: { id, tenantId, firstName, lastName },
  });
  return id;
}

let folioSeq = 0;

/** A CONFIRMED (or CANCELED) sale with a ledger matching its paid amount. */
export async function seedSale(
  tenantId: string,
  userId: string,
  customerId: string,
  sale: SeedSale,
): Promise<string> {
  const prisma = worldPrisma();
  const id = sale.id ?? randomUUID();
  const paid = sale.paidCents ?? 0;
  const debt = sale.totalCents - paid;
  await prisma.sale.create({
    data: {
      id,
      tenantId,
      userId: sale.userId ?? userId,
      customerId: sale.customerId === undefined ? customerId : sale.customerId,
      status: sale.status ?? 'CONFIRMED',
      deliveryStatus: 'PENDING',
      totalCents: sale.totalCents,
      subtotalCents: sale.totalCents,
      paidCents: paid,
      debtCents: debt,
      paymentStatus: debt === 0 ? 'PAID' : paid === 0 ? 'CREDIT' : 'PARTIAL',
      confirmedAt: new Date(sale.confirmedAt ?? '2026-10-01T15:00:00.000Z'),
      dueDate:
        sale.dueDate === undefined || sale.dueDate === null
          ? null
          : new Date(`${sale.dueDate}T00:00:00.000Z`),
      folio: `V-${String(++folioSeq).padStart(6, '0')}-${id.slice(0, 4)}`,
    },
  });
  if (paid > 0) {
    await prisma.salePayment.create({
      data: {
        tenantId,
        saleId: id,
        method: 'TRANSFER',
        amountCents: paid,
        userId,
      },
    });
  }
  return id;
}

export interface Counter {
  tenantId: string;
  member: SeededMember;
  sessionId: string;
  customerId: string;
}

/** Tenant, cashier with an OPEN session, one customer. */
export async function counter(
  world: ZoneWorld,
  name: string,
): Promise<Counter> {
  const tenantId = await world.tenant(name);
  const member = await world.member(
    tenantId,
    `Cajera ${name}`,
    COLLECTION_GRANTS,
  );
  const sessionId = await openSession(tenantId, member);
  const customerId = await seedCustomer(tenantId);
  return { tenantId, member, sessionId, customerId };
}

export function routes(app: () => INestApplication) {
  const server = () => app().getHttpServer() as App;
  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  return {
    preview: (m: SeededMember, customerId: string, body: object) =>
      request(server())
        .post(`/customers/${customerId}/collections/preview`)
        .set(auth(m))
        .send(body),
    collect: (
      m: SeededMember,
      customerId: string,
      body: object,
      key: string | null = randomUUID(),
    ) => {
      const req = request(server())
        .post(`/customers/${customerId}/collections`)
        .set(auth(m));
      if (key !== null) req.set('idempotency-key', key);
      return req.send(body);
    },
    pay: (m: SeededMember, saleId: string, body: object) =>
      request(server())
        .post(`/sales/${saleId}/payments`)
        .set(auth(m))
        .set('idempotency-key', randomUUID())
        .send(body),
    cancel: (m: SeededMember, saleId: string) =>
      request(server())
        .post(`/sales/${saleId}/cancel`)
        .set(auth(m))
        .send({ reason: 'CUSTOMER_REQUEST' }),
    deleteCustomer: (m: SeededMember, customerId: string) =>
      request(server()).delete(`/customers/${customerId}`).set(auth(m)),
    read: (m: SeededMember, collectionId: string) =>
      request(server()).get(`/collections/${collectionId}`).set(auth(m)),
    receiptPdf: (m: SeededMember, collectionId: string, query = '') =>
      request(server())
        .get(`/collections/${collectionId}/pdf${query}`)
        .set(auth(m))
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        }),
  };
}

/** Every money row of a tenant, for "nothing written" and balance checks. */
export async function moneyRows(tenantId: string) {
  const prisma = worldPrisma();
  const [
    sales,
    payments,
    collections,
    movements,
    idempotency,
    outbox,
    refunds,
  ] = await Promise.all([
    prisma.sale.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    prisma.salePayment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.saleCollection.findMany({ where: { tenantId } }),
    prisma.cashMovement.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.saleIdempotency.findMany({ where: { tenantId } }),
    prisma.outboxEvent.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.saleRefund.findMany({ where: { tenantId } }),
  ]);
  return {
    sales,
    payments,
    collections,
    movements,
    idempotency,
    outbox,
    refunds,
  };
}
