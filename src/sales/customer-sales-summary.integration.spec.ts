/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped JSON */
/**
 * customers-listing T4 (S4, contract §6.2, §2.1, §10, §11, §13) —
 * `GET /customers/:customerId/sales-summary` against REAL PostgreSQL through
 * the real JWT → tenant → CASL chain and the production validation pipe:
 *
 * - `metrics` equal the `GET /customers/listing` row metrics for the same
 *   customer, on both sides of the local-midnight overdue boundary (one
 *   pinned clock for both services);
 * - CONFIRMED sales only; a customer without sales reads 0 / null;
 * - tenant isolation: a foreign-tenant sale pointing at our customer never
 *   counts; a foreign or unknown customer → code-only `404 CUSTOMER_NOT_FOUND`;
 * - non-UUID → 400; without `read:Sale` → 403.
 *
 * Mexico City is UTC-6 all year, so local midnight is 06:00Z.
 */
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CustomersListingController } from '../customers/listing/customers-listing.controller';
import { CustomersListingService } from '../customers/listing/customers-listing.service';
import { PrismaCustomersListingReader } from '../customers/listing/prisma-customers-listing.reader';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { CustomerSalesSummaryController } from './customer-sales-summary.controller';
import { PrismaCustomerSalesSummaryReader } from './customer-sales-summary.prisma-reader';
import { CustomerSalesSummaryService } from './customer-sales-summary.service';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

/** Stored form of a user-picked due date: 00:00Z of that calendar day. */
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
/** 23:59 local on 26/11 → local today 26/11, cut-off 2026-11-26T00:00Z. */
const LATE_26 = new Date('2026-11-27T05:59:00.000Z');
/** 00:00 local on 27/11 → local today 27/11. */
const MIDNIGHT_27 = new Date('2026-11-27T06:00:00.000Z');

const NOT_FOUND = {
  statusCode: 404,
  error: 'CUSTOMER_NOT_FOUND',
  message: 'CUSTOMER_NOT_FOUND',
};

describeIfDb('GET /customers/:customerId/sales-summary (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  let clockNow: Date = LATE_26;
  const config = {
    get: (key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE'
        ? 'America/Mexico_City'
        : undefined,
  } as unknown as ConfigService;

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [CustomersListingController, CustomerSalesSummaryController],
      providers: [
        {
          provide: CustomersListingService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomersListingService(
              new PrismaCustomersListingReader(tenantPrisma),
              config,
              () => clockNow,
            ),
        },
        {
          provide: CustomerSalesSummaryService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomerSalesSummaryService(
              new PrismaCustomerSalesSummaryReader(tenantPrisma),
              config,
              () => clockNow,
            ),
        },
      ],
    });
  });

  afterEach(async () => {
    clockNow = LATE_26;
    await world.cleanup();
  });

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  interface Branch {
    tenantId: string;
    member: SeededMember;
    noSale: SeededMember;
  }

  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Gerente ${name}`, [
      'Customer:read',
      'Sale:read',
    ]);
    const noSale = await world.member(tenantId, `Vendedor ${name}`, [
      'Customer:read',
    ]);
    return { tenantId, member, noSale };
  }

  async function customer(b: Branch, firstName: string): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: { id, tenantId: b.tenantId, firstName },
    });
    return id;
  }

  let seq = 0;
  async function sale(
    b: Branch,
    customerId: string,
    opts: {
      status?: 'CONFIRMED' | 'CANCELED' | 'DRAFT';
      totalCents?: number;
      debtCents?: number;
      dueDate?: Date | null;
      confirmedAt?: Date;
      tenantId?: string;
    } = {},
  ): Promise<void> {
    const id = randomUUID();
    const total = opts.totalCents ?? 1000;
    const debt = opts.debtCents ?? 0;
    const status = opts.status ?? 'CONFIRMED';
    await prisma.sale.create({
      data: {
        id,
        tenantId: opts.tenantId ?? b.tenantId,
        userId: b.member.userId,
        customerId,
        status,
        channel: 'POS',
        folio: `K-${++seq}-${id.slice(0, 6)}`,
        confirmedAt:
          status === 'DRAFT'
            ? null
            : (opts.confirmedAt ?? new Date(Date.UTC(2026, 9, 1, 0, 0, ++seq))),
        subtotalCents: total,
        totalCents: total,
        paidCents: total - debt,
        debtCents: debt,
        paymentStatus: debt > 0 ? 'CREDIT' : 'PAID',
        deliveryStatus: 'DELIVERED',
        dueDate: opts.dueDate ?? null,
      },
    });
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const summary = (m: SeededMember, id: string) =>
    request(server()).get(`/customers/${id}/sales-summary`).set(auth(m));
  const listingMetrics = async (m: SeededMember, id: string) => {
    const res = await request(server())
      .get('/customers/listing')
      .query({ limit: 100 })
      .set(auth(m))
      .expect(200);
    return (
      res.body.data as Array<{ id: string; metrics: Record<string, unknown> }>
    ).find((r) => r.id === id)?.metrics;
  };

  it('metrics equal the listing row metrics, across the local-midnight overdue boundary', async () => {
    const b = await branch('KPI');
    const other = await branch('KPI B');
    const rosa = await customer(b, 'Rosa');
    // Overdue since 01/11, partially paid.
    await sale(b, rosa, {
      totalCents: 5000,
      debtCents: 3000,
      dueDate: day('2026-11-01'),
    });
    // Due today (26/11): overdue only from local midnight 27/11.
    await sale(b, rosa, {
      totalCents: 2001,
      debtCents: 2001,
      dueDate: day('2026-11-26'),
    });
    // Paid; the latest purchase.
    await sale(b, rosa, {
      totalCents: 3000,
      confirmedAt: new Date('2026-11-20T19:31:02.000Z'),
    });
    // Never counted: canceled, draft, and a foreign-tenant sale on our id.
    await sale(b, rosa, { status: 'CANCELED', totalCents: 99999 });
    await sale(b, rosa, { status: 'DRAFT', totalCents: 88888 });
    await sale(b, rosa, {
      totalCents: 77777,
      debtCents: 77777,
      dueDate: day('2026-10-01'),
      tenantId: other.tenantId,
    });

    const late = await summary(b.member, rosa).expect(200);
    expect(late.body).toEqual({
      customerId: rosa,
      metrics: {
        openDebtCents: 5001,
        overdueDebtCents: 3000,
        overdueCount: 1,
        oldestOverdueDueDate: '2026-11-01',
        salesCount: 3,
        totalSoldCents: 10001,
        averageTicketCents: 3334,
        lastPurchaseAt: '2026-11-20T19:31:02.000Z',
      },
    });
    expect(late.body.metrics).toEqual(await listingMetrics(b.member, rosa));

    clockNow = MIDNIGHT_27;
    const midnight = await summary(b.member, rosa).expect(200);
    expect(midnight.body.metrics).toMatchObject({
      overdueCount: 2,
      overdueDebtCents: 5001,
      oldestOverdueDueDate: '2026-11-01',
    });
    expect(midnight.body.metrics).toEqual(await listingMetrics(b.member, rosa));
  });

  it('a customer without sales reads 0 / null, the same as its listing row', async () => {
    const b = await branch('Nuevo');
    const nuevo = await customer(b, 'Nuevo');

    const res = await summary(b.member, nuevo).expect(200);

    expect(res.body).toEqual({
      customerId: nuevo,
      metrics: {
        openDebtCents: 0,
        overdueDebtCents: 0,
        overdueCount: 0,
        oldestOverdueDueDate: null,
        salesCount: 0,
        totalSoldCents: 0,
        averageTicketCents: null,
        lastPurchaseAt: null,
      },
    });
    expect(res.body.metrics).toEqual(await listingMetrics(b.member, nuevo));
  });

  it('foreign-tenant or unknown customer → code-only 404 CUSTOMER_NOT_FOUND; tenants never mix', async () => {
    const a = await branch('A');
    const b = await branch('B');
    const foreign = await customer(b, 'Ajena');
    await sale(b, foreign, { totalCents: 1000 });

    for (const id of [foreign, randomUUID()]) {
      const res = await summary(a.member, id).expect(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    const own = await summary(b.member, foreign).expect(200);
    expect(own.body.metrics.salesCount).toBe(1);
  });

  it('non-UUID → 400; without read:Sale → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const b = await branch('Errores');
    const c = await customer(b, 'Rosa');

    const bad = await summary(b.member, 'not-a-uuid').expect(400);
    expect(bad.body.message).toBe('Validation failed (uuid is expected)');
    const denied = await summary(b.noSale, c).expect(403);
    expect(denied.body.error).toBe('INSUFFICIENT_PERMISSIONS');
  });
});
