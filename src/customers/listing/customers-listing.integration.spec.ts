/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped JSON */
/**
 * customers-listing / T1 (S1) — `GET /customers/listing` against REAL
 * PostgreSQL through the real JWT → tenant → CASL chain and the production
 * validation pipe (contract §2, §2.1, §2.2, §3, §4.6, §10.1, §13):
 *
 * - metrics count CONFIRMED sales only and match `GET /sales` `summary` for
 *   the same customer, on both sides of the local-midnight overdue boundary
 *   (both services share one pinned clock);
 * - customers without sales read 0 / null; primary address = oldest;
 * - metric sorts with LIMIT, nulls last, stable `id` tie-break;
 * - `filterSummary` totals every matching customer, not just the page;
 * - without `read:Sale`: 200, no `metrics` key, `{count}`, 400 on metric sorts;
 * - tenant isolation (even a foreign-tenant sale pointing at our customer);
 * - `search` matches exactly what `GET /customers?search=` matches;
 * - `GET /customers` keeps its shape.
 *
 * Mexico City is UTC-6 all year, so local midnight is 06:00Z.
 */
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../../delivery-zones/test-support/delivery-zone-world';
import { PrismaSaleRepository } from '../../sales/infrastructure/prisma-sale.repository';
import { SalesQueryController } from '../../sales/sales-query.controller';
import { SalesService } from '../../sales/sales.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { CustomersController } from '../customers.controller';
import { CustomersService } from '../customers.service';
import { CUSTOMER_REPOSITORY } from '../domain/customer.repository';
import { PrismaCustomerRepository } from '../infrastructure/prisma-customer.repository';
import { CustomersListingController } from './customers-listing.controller';
import { CustomersListingService } from './customers-listing.service';
import { PrismaCustomersListingReader } from './prisma-customers-listing.reader';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

/** Stored form of a user-picked due date: 00:00Z of that calendar day. */
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
/** 23:59 local on 26/11 → local today 26/11, cut-off 2026-11-26T00:00Z. */
const LATE_26 = new Date('2026-11-27T05:59:00.000Z');
/** 00:00 local on 27/11 → local today 27/11. */
const MIDNIGHT_27 = new Date('2026-11-27T06:00:00.000Z');

const ROW_KEYS = [
  'id',
  'firstName',
  'lastName',
  'businessName',
  'phoneCountryCode',
  'phone',
  'email',
  'globalPriceList',
  'rfc',
  'fiscalRegime',
  'preferredPaymentMethod',
  'isTrusted',
  'createdAt',
  'primaryAddress',
  'activePetsCount',
  'petSpecies',
  'matchedPetName',
  'metrics',
];

const METRIC_KEYS = [
  'openDebtCents',
  'overdueDebtCents',
  'overdueCount',
  'oldestOverdueDueDate',
  'salesCount',
  'totalSoldCents',
  'averageTicketCents',
  'lastPurchaseAt',
];

describeIfDb('GET /customers/listing (PostgreSQL)', () => {
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
  };

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [
        CustomersListingController,
        CustomersController,
        SalesQueryController,
      ],
      providers: [
        CustomersService,
        { provide: CUSTOMER_REPOSITORY, useClass: PrismaCustomerRepository },
        {
          provide: CustomersListingService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomersListingService(
              new PrismaCustomersListingReader(tenantPrisma),
              config as unknown as ConfigService,
              () => clockNow,
            ),
        },
        {
          provide: SalesService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) => {
            // SAFETY: `listSales` only uses these ports (same seam as the
            // sales-history-redesign integration spec).
            const sales = Object.create(SalesService.prototype) as SalesService;
            Object.assign(sales, {
              tenantPrisma,
              saleRepo: new PrismaSaleRepository(tenantPrisma),
              clock: () => clockNow,
              config,
            });
            return sales;
          },
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

  // ─────────────────────────────── fixtures ───────────────────────────────

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

  let seq = 0;
  async function customer(
    b: Branch,
    firstName: string,
    over: Partial<Prisma.CustomerUncheckedCreateInput> = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.customer.create({
      data: {
        id,
        tenantId: b.tenantId,
        firstName,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)),
        ...over,
      },
    });
    return id;
  }

  async function sale(
    b: Branch,
    customerId: string | null,
    opts: {
      status?: 'CONFIRMED' | 'CANCELED' | 'DRAFT';
      totalCents?: number;
      debtCents?: number;
      dueDate?: Date | null;
      confirmedAt?: Date | null;
      tenantId?: string;
      userId?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const total = opts.totalCents ?? 1000;
    const debt = opts.debtCents ?? 0;
    const status = opts.status ?? 'CONFIRMED';
    await prisma.sale.create({
      data: {
        id,
        tenantId: opts.tenantId ?? b.tenantId,
        userId: opts.userId ?? b.member.userId,
        customerId,
        status,
        channel: 'POS',
        folio: `L-${++seq}-${id.slice(0, 6)}`,
        confirmedAt:
          opts.confirmedAt !== undefined
            ? opts.confirmedAt
            : status === 'DRAFT'
              ? null
              : new Date(Date.UTC(2026, 9, 1, 0, 0, ++seq)),
        subtotalCents: total,
        totalCents: total,
        paidCents: total - debt,
        debtCents: debt,
        paymentStatus: debt > 0 ? 'CREDIT' : 'PAID',
        deliveryStatus: 'DELIVERED',
        dueDate: opts.dueDate ?? null,
      },
    });
    return id;
  }

  async function address(
    b: Branch,
    customerId: string,
    neighborhood: string,
    createdAt: Date,
    id: string = randomUUID(),
  ) {
    await prisma.customerAddress.create({
      data: {
        id,
        tenantId: b.tenantId,
        customerId,
        street: 'Calle 1',
        neighborhood,
        municipality: 'Benito Juárez',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        zipCode: '03100',
        createdAt,
      },
    });
    return id;
  }

  async function pet(
    b: Branch,
    customerId: string,
    name: string,
    over: Partial<Prisma.CustomerPetUncheckedCreateInput> = {},
  ) {
    await prisma.customerPet.create({
      data: {
        tenantId: b.tenantId,
        customerId,
        name,
        nameKey: name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
        species: 'DOG',
        createdVia: 'POS',
        ...over,
      },
    });
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const listing = (m: SeededMember, query: Record<string, string> = {}) =>
    request(server()).get('/customers/listing').query(query).set(auth(m));
  const names = (res: request.Response) =>
    (res.body.data as Array<{ firstName: string }>).map((r) => r.firstName);
  const rowOf = (res: request.Response, id: string) =>
    (res.body.data as Array<{ id: string }>).find((r) => r.id === id) as any;

  // ─────────────────────────────── metrics ───────────────────────────────

  describe('metrics (§2.1)', () => {
    it('CONFIRMED sales only, overdue boundary at local midnight, identical to GET /sales summary', async () => {
      const b = await branch('Metricas');
      const c = await customer(b, 'Rosa');
      await sale(b, c, {
        totalCents: 10000,
        debtCents: 4000,
        dueDate: day('2026-11-20'),
        confirmedAt: new Date('2026-11-10T15:00:00.000Z'),
      });
      await sale(b, c, {
        totalCents: 5000,
        debtCents: 1000,
        dueDate: day('2026-11-26'), // due today: overdue only from local midnight
        confirmedAt: new Date('2026-11-20T19:31:02.000Z'),
      });
      await sale(b, c, {
        totalCents: 3001,
        confirmedAt: new Date('2026-11-01T10:00:00.000Z'),
      });
      // Never counted: canceled, draft, and a sale without a customer.
      await sale(b, c, {
        status: 'CANCELED',
        totalCents: 99999,
        debtCents: 99999,
        dueDate: day('2026-01-01'),
        confirmedAt: new Date('2026-11-25T10:00:00.000Z'),
      });
      await sale(b, c, {
        status: 'DRAFT',
        totalCents: 77777,
        debtCents: 77777,
      });
      await sale(b, null, { totalCents: 55555, debtCents: 55555 });

      const check = async (expected: Record<string, unknown>) => {
        const res = await listing(b.member).expect(200);
        const metrics = rowOf(res, c).metrics;
        expect(Object.keys(metrics)).toEqual(METRIC_KEYS);
        expect(metrics).toEqual(expected);

        const sales = await request(server())
          .get('/sales')
          .query({ customerId: c, limit: '100' })
          .set(auth(b.member))
          .expect(200);
        const s = sales.body.summary;
        expect(metrics.salesCount).toBe(s.salesCount);
        expect(metrics.totalSoldCents).toBe(s.totalSoldCents);
        expect(metrics.openDebtCents).toBe(s.outstandingDebtCents);
        expect(metrics.averageTicketCents).toBe(s.averageTicketCents);
        expect(metrics.overdueCount).toBe(sales.body.counts.overdue);
        expect(metrics.overdueDebtCents).toBe(s.overdueDebtCents);
        expect(metrics.oldestOverdueDueDate).toBe(s.oldestOverdueDueDate);
      };

      clockNow = LATE_26;
      await check({
        openDebtCents: 5000,
        overdueDebtCents: 4000,
        overdueCount: 1,
        oldestOverdueDueDate: '2026-11-20',
        salesCount: 3,
        totalSoldCents: 18001,
        averageTicketCents: 6000, // round(6000.33)
        lastPurchaseAt: '2026-11-20T19:31:02.000Z',
      });

      clockNow = MIDNIGHT_27;
      await check({
        openDebtCents: 5000,
        overdueDebtCents: 5000,
        overdueCount: 2,
        oldestOverdueDueDate: '2026-11-20',
        salesCount: 3,
        totalSoldCents: 18001,
        averageTicketCents: 6000,
        lastPurchaseAt: '2026-11-20T19:31:02.000Z',
      });
    });

    it('averageTicketCents rounds half up', async () => {
      const b = await branch('Redondeo');
      const c = await customer(b, 'Rosa');
      await sale(b, c, { totalCents: 1 });
      await sale(b, c, { totalCents: 2 });
      const res = await listing(b.member).expect(200);
      expect(rowOf(res, c).metrics.averageTicketCents).toBe(2); // 1.5 → 2
    });

    it('a customer without sales reads 0 counts/sums and null dates/average', async () => {
      const b = await branch('SinVentas');
      const c = await customer(b, 'Nueva');
      await sale(b, c, { status: 'CANCELED', totalCents: 500 });
      const res = await listing(b.member).expect(200);
      expect(rowOf(res, c).metrics).toEqual({
        openDebtCents: 0,
        overdueDebtCents: 0,
        overdueCount: 0,
        oldestOverdueDueDate: null,
        salesCount: 0,
        totalSoldCents: 0,
        averageTicketCents: null,
        lastPurchaseAt: null,
      });
    });
  });

  // ─────────────────────────────── row shape ───────────────────────────────

  describe('row (§2, §2.2)', () => {
    it('exact keys, oldest address as primaryAddress, ACTIVE pets only, price list, isTrusted', async () => {
      const b = await branch('Fila');
      const list = await prisma.globalPriceList.create({
        data: { name: `Mayoreo ${randomUUID()}` },
      });
      try {
        const c = await customer(b, 'Ana', {
          lastName: 'López',
          phoneCountryCode: '52',
          phone: '5512345678',
          email: 'ana@example.com',
          rfc: 'LOAA800101XXX',
          fiscalRegime: '612',
          preferredPaymentMethod: 'transferencia',
          isTrusted: true,
          globalPriceListId: list.id,
          comments: 'no sale en la fila',
        });
        const t = new Date('2026-03-01T00:00:00.000Z');
        // Same createdAt: the lower id wins (a digit vs a letter first, so
        // every collation agrees on the order).
        const ids = [`1${randomUUID().slice(1)}`, `e${randomUUID().slice(1)}`];
        await address(b, c, 'Narvarte', new Date(t.getTime() + 1000));
        await address(b, c, 'Del Valle', t, ids[0]);
        await address(b, c, 'Roma', t, ids[1]);
        await pet(b, c, 'Michi', { species: 'CAT' });
        await pet(b, c, 'Bruno', { species: 'DOG' });
        await pet(b, c, 'Max', { species: 'DOG' });
        await pet(b, c, 'Viejo', {
          species: 'OTHER',
          speciesOther: 'Hurón',
          status: 'ARCHIVED',
          archivedAt: new Date(),
        });
        const bare = await customer(b, 'Sola');

        const res = await listing(b.member).expect(200);
        const row = rowOf(res, c);
        expect(Object.keys(row)).toEqual(ROW_KEYS);
        expect(row).toMatchObject({
          firstName: 'Ana',
          lastName: 'López',
          businessName: null,
          phoneCountryCode: '52',
          phone: '5512345678',
          email: 'ana@example.com',
          globalPriceList: { id: list.id, name: list.name },
          rfc: 'LOAA800101XXX',
          fiscalRegime: '612',
          preferredPaymentMethod: 'transferencia',
          isTrusted: true,
          createdAt: expect.stringMatching(/^2026-01-01T/) as string,
          primaryAddress: {
            id: ids[0],
            neighborhood: 'Del Valle',
            municipality: 'Benito Juárez',
            city: 'Ciudad de México',
            state: 'Ciudad de México',
            zipCode: '03100',
          },
          activePetsCount: 3,
          petSpecies: ['DOG', 'CAT'],
          matchedPetName: null,
        });
        expect(Object.keys(row.primaryAddress)).toEqual([
          'id',
          'neighborhood',
          'municipality',
          'city',
          'state',
          'zipCode',
        ]);
        expect(rowOf(res, bare)).toMatchObject({
          isTrusted: false,
          primaryAddress: null,
          activePetsCount: 0,
          petSpecies: [],
          globalPriceList: null,
        });
      } finally {
        await world.cleanup();
        await prisma.globalPriceList.delete({ where: { id: list.id } });
      }
    });
  });

  // ─────────────────────────── pagination & sorting ───────────────────────────

  describe('pagination, filterSummary and sorting (§3)', () => {
    async function seedThree(b: Branch) {
      const big = await customer(b, 'Beto');
      const mid = await customer(b, 'ana');
      const none = await customer(b, 'Carla');
      await sale(b, big, {
        totalCents: 9000,
        debtCents: 2000,
        dueDate: day('2026-11-01'),
        confirmedAt: new Date('2026-11-05T00:00:00.000Z'),
      });
      await sale(b, big, { totalCents: 1000 });
      await sale(b, mid, {
        totalCents: 3000,
        debtCents: 3000,
        dueDate: day('2026-10-01'),
        confirmedAt: new Date('2026-11-10T00:00:00.000Z'),
      });
      return { big, mid, none };
    }

    it('default: createdAt desc, limit 50; filterSummary totals every match; page past the end keeps totals', async () => {
      const b = await branch('Paginas');
      await seedThree(b);

      const all = await listing(b.member).expect(200);
      expect(names(all)).toEqual(['Carla', 'ana', 'Beto']);
      expect(all.body.pagination).toEqual({
        page: 1,
        limit: 50,
        total: 3,
        totalPages: 1,
      });
      expect(all.body.filterSummary).toEqual({
        count: 3,
        openDebtCents: 5000,
        overdueDebtCents: 5000,
      });

      const page2 = await listing(b.member, { limit: '2', page: '2' }).expect(
        200,
      );
      expect(names(page2)).toEqual(['Beto']);
      expect(page2.body.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(page2.body.filterSummary).toEqual(all.body.filterSummary);

      const past = await listing(b.member, { limit: '2', page: '9' }).expect(
        200,
      );
      expect(past.body.data).toEqual([]);
      expect(past.body.pagination.total).toBe(3);
      expect(past.body.filterSummary).toEqual(all.body.filterSummary);
    });

    it('metric sort with LIMIT computes over every customer before paging; nulls last both ways', async () => {
      const b = await branch('OrdenMetrica');
      await seedThree(b);

      const top = await listing(b.member, {
        sortBy: 'totalSold',
        sortOrder: 'desc',
        limit: '1',
      }).expect(200);
      expect(names(top)).toEqual(['Beto']);
      const next = await listing(b.member, {
        sortBy: 'totalSold',
        sortOrder: 'desc',
        limit: '1',
        page: '2',
      }).expect(200);
      expect(names(next)).toEqual(['ana']);

      const cases: Array<[string, string, string[]]> = [
        ['openDebt', 'desc', ['ana', 'Beto', 'Carla']],
        ['openDebt', 'asc', ['Carla', 'Beto', 'ana']],
        ['oldestOverdue', 'asc', ['ana', 'Beto', 'Carla']],
        ['oldestOverdue', 'desc', ['Beto', 'ana', 'Carla']],
        ['lastPurchaseAt', 'desc', ['ana', 'Beto', 'Carla']],
        ['lastPurchaseAt', 'asc', ['Beto', 'ana', 'Carla']],
        ['salesCount', 'desc', ['Beto', 'ana', 'Carla']],
        ['averageTicket', 'desc', ['Beto', 'ana', 'Carla']],
        ['averageTicket', 'asc', ['ana', 'Beto', 'Carla']],
        ['totalSold', 'asc', ['Carla', 'ana', 'Beto']],
        ['name', 'asc', ['ana', 'Beto', 'Carla']],
        ['name', 'desc', ['Carla', 'Beto', 'ana']],
        ['createdAt', 'asc', ['Beto', 'ana', 'Carla']],
      ];
      for (const [sortBy, sortOrder, expected] of cases) {
        const res = await listing(b.member, { sortBy, sortOrder }).expect(200);
        expect([sortBy, sortOrder, names(res)]).toEqual([
          sortBy,
          sortOrder,
          expected,
        ]);
      }
    });

    it('ties break on id, so pages never repeat or skip a row', async () => {
      const b = await branch('Empates');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await customer(b, 'Igual'));
      for (const sortBy of ['salesCount', 'name']) {
        const seenBy: Record<string, string[]> = {};
        for (const sortOrder of ['asc', 'desc']) {
          const seen: string[] = [];
          for (const page of ['1', '2', '3']) {
            const res = await listing(b.member, {
              sortBy,
              sortOrder,
              limit: '2',
              page,
            }).expect(200);
            seen.push(
              ...(res.body.data as Array<{ id: string }>).map((r) => r.id),
            );
          }
          // Every row exactly once across the pages.
          expect([...seen].sort()).toEqual([...ids].sort());
          seenBy[sortOrder] = seen;
        }
        // The id tie-break follows sortOrder.
        expect(seenBy.desc).toEqual([...seenBy.asc].reverse());
      }
    });

    it('validation: limit 101, page 0, unknown sortBy and unknown params → 400', async () => {
      const b = await branch('Validacion');
      for (const query of [
        { limit: '101' },
        { page: '0' },
        { sortBy: 'debt' },
        { preferredPaymentMethod: 'cash' },
      ] as Array<Record<string, string>>) {
        await listing(b.member, query).expect(400);
      }
    });
  });

  // ─────────────────────────────── permissions ───────────────────────────────

  describe('permissions (§10, §10.1)', () => {
    it('without read:Sale: 200, no metrics key, filterSummary {count}; name/createdAt sorts still work', async () => {
      const b = await branch('SinVenta');
      const c = await customer(b, 'Rosa');
      await customer(b, 'Ana');
      await sale(b, c, { totalCents: 5000, debtCents: 5000 });

      const res = await listing(b.noSale, {
        sortBy: 'name',
        sortOrder: 'asc',
      }).expect(200);
      expect(names(res)).toEqual(['Ana', 'Rosa']);
      for (const row of res.body.data) {
        expect(row).not.toHaveProperty('metrics');
        expect(Object.keys(row)).toEqual(
          ROW_KEYS.filter((k) => k !== 'metrics'),
        );
      }
      expect(res.body.filterSummary).toEqual({ count: 2 });
      expect(res.body.pagination.total).toBe(2);
    });

    it('without read:Sale, a metric sort → 400 LISTING_PARAM_REQUIRES_PERMISSION', async () => {
      const b = await branch('SinVentaOrden');
      const res = await listing(b.noSale, { sortBy: 'openDebt' }).expect(400);
      expect(res.body).toEqual({
        statusCode: 400,
        code: 'LISTING_PARAM_REQUIRES_PERMISSION',
        message: 'sortBy requires read:Sale',
        field: 'sortBy',
        details: { required: 'read:Sale' },
      });
    });

    it('a malformed value gets its validation error first', async () => {
      const b = await branch('SinVentaValida');
      const res = await listing(b.noSale, {
        sortBy: 'openDebt',
        limit: '500',
      }).expect(400);
      expect(res.body.code).not.toBe('LISTING_PARAM_REQUIRES_PERMISSION');
    });

    it('without read:Customer → 403', async () => {
      const b = await branch('SinCliente');
      const saleOnly = await world.member(b.tenantId, 'Solo ventas', [
        'Sale:read',
      ]);
      await listing(saleOnly).expect(403);
    });
  });

  // ─────────────────────────────── isolation ───────────────────────────────

  describe('tenant isolation (§12.2)', () => {
    it("another tenant's customers and sales are never listed or counted", async () => {
      const b = await branch('Aislada');
      const other = await branch('Aislada B');
      const mine = await customer(b, 'Mia');
      const foreign = await customer(other, 'Ajena');
      await sale(other, foreign, { totalCents: 7000, debtCents: 7000 });
      // A foreign-tenant sale pointing at OUR customer (the FK is not
      // tenant-composite): the explicit tenant predicate keeps it out.
      await sale(other, mine, {
        totalCents: 8000,
        debtCents: 8000,
        dueDate: day('2026-01-01'),
      });
      await sale(b, mine, { totalCents: 1000 });

      const res = await listing(b.member).expect(200);
      expect((res.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual(
        [mine],
      );
      expect(rowOf(res, mine).metrics).toMatchObject({
        salesCount: 1,
        totalSoldCents: 1000,
        openDebtCents: 0,
        overdueCount: 0,
      });
      expect(res.body.filterSummary).toEqual({
        count: 1,
        openDebtCents: 0,
        overdueDebtCents: 0,
      });
    });
  });

  // ─────────────────────────────── search ───────────────────────────────

  describe('search (§4.6) — same matches as GET /customers', () => {
    it('own fields (every word), ACTIVE pet names, matchedPetName, LIKE escaping, 6-word cap', async () => {
      const b = await branch('Buscar');
      const other = await branch('Buscar B');
      const rosa = await customer(b, 'Rosa', {
        lastName: 'Pérez',
        phone: '5585876245',
        email: 'rosa@mail.test',
      });
      await customer(b, 'Pedro', {
        lastName: 'López',
        businessName: 'Pet 100%',
      });
      const bruno = await customer(b, 'Bruno', { lastName: 'Díaz' });
      await pet(b, bruno, 'Bruno');
      await pet(b, rosa, 'Brunó Jr');
      await pet(b, rosa, 'Brunó');
      const archivedOwner = await customer(b, 'Lola');
      await pet(b, archivedOwner, 'Fantasma', {
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });
      const foreign = await customer(other, 'Rosa');
      await pet(other, foreign, 'Bruno');

      const terms = [
        'rosa',
        'ROSA pérez',
        'mail.test',
        '58587',
        'lópez rosa',
        'BRUNO',
        'bruno díaz',
        'fantasma',
        '%',
        '_runo',
        '100%',
        '  pedro  ',
        'a b c d e f rosa', // only the first 6 words count
        '',
        'zzz',
      ];
      for (const term of terms) {
        const legacy = await request(server())
          .get('/customers')
          .query({ search: term })
          .set(auth(b.member))
          .expect(200);
        const res = await listing(b.member, { search: term }).expect(200);
        const pick = (
          rows: Array<{ id: string; matchedPetName: string | null }>,
        ) => rows.map((r) => [r.id, r.matchedPetName]);
        expect([term, pick(res.body.data)]).toEqual([term, pick(legacy.body)]);
        expect(res.body.pagination.total).toBe(
          (legacy.body as unknown[]).length,
        );
      }
      const viaPet = await listing(b.member, { search: 'bruno' }).expect(200);
      expect(rowOf(viaPet, rosa).matchedPetName).toBe('Brunó');
      expect(rowOf(viaPet, bruno).matchedPetName).toBeNull();
    });
  });

  // ─────────────────────────────── GET /customers ───────────────────────────────

  describe('GET /customers stays unchanged', () => {
    it('flat array, newest first, same keys (no isTrusted, no metrics)', async () => {
      const b = await branch('Legacy');
      const c = await customer(b, 'Rosa', { isTrusted: true });
      await address(b, c, 'Del Valle', new Date('2026-01-01T00:00:00.000Z'));
      await customer(b, 'Reciente');
      await sale(b, c, { totalCents: 1000 });

      const res = await request(server())
        .get('/customers')
        .set(auth(b.member))
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map((r: { firstName: string }) => r.firstName)).toEqual([
        'Reciente',
        'Rosa',
      ]);
      expect(Object.keys(res.body[1])).toEqual([
        'id',
        'firstName',
        'lastName',
        'phoneCountryCode',
        'phone',
        'email',
        'globalPriceListId',
        'comments',
        'preferredPaymentMethod',
        'businessName',
        'fiscalZipCode',
        'rfc',
        'fiscalRegime',
        'billingStreet',
        'billingExteriorNumber',
        'billingInteriorNumber',
        'billingZipCode',
        'billingNeighborhood',
        'billingMunicipality',
        'billingCity',
        'billingState',
        'createdAt',
        'updatedAt',
        'globalPriceList',
        'addresses',
        'matchedPetName',
      ]);
      expect(res.body[1].addresses).toHaveLength(1);
    });
  });

  // ═════════════════════════ T3 / S2: filters (§4.1–§4.5) ═════════════════════════

  async function addr(
    b: Branch,
    customerId: string,
    over: Partial<Prisma.CustomerAddressUncheckedCreateInput> & {
      createdAt: Date;
    },
  ): Promise<string> {
    const id = over.id ?? randomUUID();
    await prisma.customerAddress.create({
      data: {
        tenantId: b.tenantId,
        customerId,
        street: 'Calle 1',
        ...over,
        id,
      },
    });
    return id;
  }

  async function zone(
    tenantId: string,
    zipCode: string,
    type: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED',
    isActive = true,
  ) {
    await prisma.deliveryZone.create({
      data: {
        tenantId,
        zipCode,
        type,
        isActive,
        // `delivery_zones_type_shape`: FREE/SURCHARGE need an ETA, SURCHARGE
        // a surcharge.
        etaDays: type === 'FREE' || type === 'SURCHARGE' ? 1 : null,
        surchargeCents: type === 'SURCHARGE' ? 5000 : null,
        approvedById: randomUUID(),
        approvedByDisplayName: 'Gerente',
        approvedAt: new Date(),
      },
    });
  }

  let folio = 0;
  async function chatbotRequest(
    tenantId: string,
    customerId: string | null,
    status: 'NEW' | 'RESOLVED' = 'NEW',
  ) {
    const closed = status === 'RESOLVED' ? new Date() : null;
    await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: ++folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        status,
        summary: 'Pregunta',
        customerId,
        customerKey: `unknown:${randomUUID()}`,
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        resolvedAt: closed,
        closedAt: closed,
      },
    });
  }

  const ids = (res: request.Response) =>
    (res.body.data as Array<{ id: string }>).map((r) => r.id).sort();
  const sorted = (...values: string[]) => [...values].sort();

  /** Every case: [query, expected ids]; checks data AND pagination.total. */
  async function expectMatches(
    m: SeededMember,
    cases: Array<[Record<string, string>, string[]]>,
  ) {
    for (const [query, expected] of cases) {
      const res = await listing(m, query).expect(200);
      expect([query, ids(res)]).toEqual([query, sorted(...expected)]);
      expect([query, res.body.pagination.total]).toEqual([
        query,
        expected.length,
      ]);
      expect(res.body.filterSummary.count).toBe(expected.length);
    }
  }

  describe('§4.1 Deuda', () => {
    it('hasDebt, open debt range, hasOverdue, strict overdueMoreThanDays (day 30 vs 31), oldestOverdue range; filterSummary under filters', async () => {
      const b = await branch('Deuda');
      // Local today = 26/11 (LATE_26).
      const d31 = await customer(b, 'Dia31');
      await sale(b, d31, { debtCents: 1000, dueDate: day('2026-10-26') });
      const d30 = await customer(b, 'Dia30');
      await sale(b, d30, { debtCents: 2000, dueDate: day('2026-10-27') });
      const noDue = await customer(b, 'SinVencer');
      await sale(b, noDue, { debtCents: 500, dueDate: null });
      const paid = await customer(b, 'Pagado');
      await sale(b, paid, { totalCents: 4000 });
      const never = await customer(b, 'Nunca');
      // A canceled overdue sale never counts.
      await sale(b, never, {
        status: 'CANCELED',
        debtCents: 900,
        dueDate: day('2026-01-01'),
      });

      await expectMatches(b.member, [
        [{ hasDebt: 'true' }, [d31, d30, noDue]],
        [{ hasDebt: 'false' }, [paid, never]],
        [{ openDebtMin: '1000', openDebtMax: '2000' }, [d31, d30]],
        [{ openDebtMax: '0' }, [paid, never]],
        [{ hasOverdue: 'true' }, [d31, d30]],
        [{ hasOverdue: 'false' }, [noDue, paid, never]],
        [{ overdueMoreThanDays: '30' }, [d31]],
        [{ overdueMoreThanDays: '29' }, [d31, d30]],
        [{ overdueMoreThanDays: '31' }, []],
        [
          {
            oldestOverdueFrom: '2026-10-27T00:00:00.000Z',
            oldestOverdueTo: '2026-10-27T00:00:00.000Z',
          },
          [d30],
        ],
        [{ oldestOverdueTo: '2026-10-26T23:59:59.999Z' }, [d31]],
        // Contradictory filters are not errors: they match nothing.
        [{ hasDebt: 'false', openDebtMin: '100' }, []],
      ]);

      const summary = await listing(b.member, {
        hasDebt: 'true',
        limit: '1',
        sortBy: 'name',
        sortOrder: 'asc',
      }).expect(200);
      expect(names(summary)).toEqual(['Dia30']);
      expect(summary.body.pagination).toEqual({
        page: 1,
        limit: 1,
        total: 3,
        totalPages: 3,
      });
      expect(summary.body.filterSummary).toEqual({
        count: 3,
        openDebtCents: 3500,
        overdueDebtCents: 3000,
      });
      const overdue = await listing(b.member, {
        overdueMoreThanDays: '30',
      }).expect(200);
      expect(overdue.body.filterSummary).toEqual({
        count: 1,
        openDebtCents: 1000,
        overdueDebtCents: 1000,
      });

      // At local midnight the 27/10 sale is 31 days overdue too.
      clockNow = MIDNIGHT_27;
      await expectMatches(b.member, [
        [{ overdueMoreThanDays: '30' }, [d31, d30]],
      ]);
    });
  });

  describe('§4.2 Compras', () => {
    it('totalSold / salesCount / averageTicket / lastPurchase ranges; noPurchaseMoreThanDays includes never-bought, local-day boundary; createdFrom/To', async () => {
      const b = await branch('Compras');
      // N = 30 on local 26/11 → bound = local 27/10 00:00 = 2026-10-27T06:00Z.
      const before = await customer(b, 'Antes', {
        createdAt: new Date('2025-06-01T00:00:00.000Z'),
      });
      await sale(b, before, {
        totalCents: 1000,
        confirmedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      await sale(b, before, {
        totalCents: 3000,
        confirmedAt: new Date('2026-10-27T05:59:00.000Z'), // local 26/10 23:59
      });
      const onBound = await customer(b, 'EnBorde', {
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      await sale(b, onBound, {
        totalCents: 9000,
        confirmedAt: new Date('2026-10-27T06:00:00.000Z'), // local 27/10 00:00
      });
      const never = await customer(b, 'Nunca', {
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      const canceledOnly = await customer(b, 'Cancelado', {
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
      });
      await sale(b, canceledOnly, {
        status: 'CANCELED',
        totalCents: 7000,
        confirmedAt: new Date('2026-11-20T00:00:00.000Z'),
      });

      await expectMatches(b.member, [
        [{ noPurchaseMoreThanDays: '30' }, [before, never, canceledOnly]],
        [
          { noPurchaseMoreThanDays: '29' },
          [before, onBound, never, canceledOnly],
        ],
        [{ noPurchaseMoreThanDays: '3650' }, [never, canceledOnly]],
        [{ totalSoldMin: '4000', totalSoldMax: '4000' }, [before]],
        [{ totalSoldMax: '0' }, [never, canceledOnly]],
        [{ salesCountMin: '2' }, [before]],
        [{ salesCountMin: '1', salesCountMax: '1' }, [onBound]],
        [{ averageTicketMin: '2000', averageTicketMax: '2000' }, [before]],
        // Without sales the average is null: never inside a range.
        [{ averageTicketMin: '0' }, [before, onBound]],
        [
          {
            lastPurchaseFrom: '2026-10-27T06:00:00.000Z',
            lastPurchaseTo: '2026-10-27T06:00:00.000Z',
          },
          [onBound],
        ],
        [{ lastPurchaseTo: '2026-10-27T05:59:59.999Z' }, [before]],
        [
          {
            createdFrom: '2026-02-01T00:00:00.000Z',
            createdTo: '2026-03-01T00:00:00.000Z',
          },
          [onBound, never],
        ],
        [{ createdTo: '2025-12-31T00:00:00.000Z' }, [before]],
      ]);
    });
  });

  describe('§4.3 Mascotas (ACTIVE pets)', () => {
    it('species + size on the SAME active pet; species/size alone; archived pets never count; activePets range; hasPets', async () => {
      const b = await branch('Mascotas');
      const bigDog = await customer(b, 'PerroGrande');
      await pet(b, bigDog, 'Rex', { species: 'DOG', size: 'LARGE' });
      const split = await customer(b, 'Separados');
      await pet(b, split, 'Chico', { species: 'DOG', size: 'SMALL' });
      await pet(b, split, 'Gata', { species: 'CAT', size: 'LARGE' });
      const archived = await customer(b, 'Archivado');
      await pet(b, archived, 'Viejo', {
        species: 'DOG',
        size: 'LARGE',
        status: 'ARCHIVED',
        archivedAt: new Date(),
      });
      const noSize = await customer(b, 'SinTalla');
      await pet(b, noSize, 'Firulais', { species: 'DOG', size: null });
      const none = await customer(b, 'SinMascota');

      await expectMatches(b.member, [
        [{ petSpecies: 'DOG', petSize: 'LARGE' }, [bigDog]],
        [{ petSpecies: 'DOG' }, [bigDog, split, noSize]],
        [{ petSize: 'LARGE' }, [bigDog, split]],
        [{ petSpecies: 'CAT,OTHER', petSize: 'LARGE,GIANT' }, [split]],
        [{ petSize: 'SMALL,MEDIUM,LARGE,GIANT' }, [bigDog, split]],
        [{ activePetsMin: '2' }, [split]],
        [{ activePetsMin: '1', activePetsMax: '1' }, [bigDog, noSize]],
        [{ activePetsMax: '0' }, [archived, none]],
        [{ hasPets: 'true' }, [bigDog, split, noSize]],
        [{ hasPets: 'false' }, [archived, none]],
      ]);
    });
  });

  describe('§4.4 Ubicación (any address)', () => {
    it('trimmed case-insensitive match on ANY address, multi-value, matchedAddressId = oldest matching address; key only with a location filter', async () => {
      const b = await branch('Ubicacion');
      const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
      const two = await customer(b, 'DosDirecciones');
      const primary = await addr(b, two, {
        createdAt: t(1),
        neighborhood: 'Narvarte',
        municipality: 'Benito Juárez',
        city: 'Ciudad de México',
        zipCode: '03020',
      });
      const second = await addr(b, two, {
        createdAt: t(2),
        neighborhood: '  del VALLE ',
        municipality: 'Benito Juárez',
        city: 'Ciudad de México',
        zipCode: ' 03100 ',
      });
      const third = await addr(b, two, {
        createdAt: t(3),
        neighborhood: 'Del Valle',
        city: 'Ciudad de México',
        zipCode: '03100',
      });
      const roma = await customer(b, 'Roma');
      const romaAddr = await addr(b, roma, {
        createdAt: t(4),
        neighborhood: 'Roma Norte',
        municipality: 'Cuauhtémoc',
        city: 'Ciudad de México',
        zipCode: '06700',
      });
      const homeless = await customer(b, 'SinDireccion');

      await expectMatches(b.member, [
        [{ neighborhood: 'Del Valle' }, [two]],
        [{ neighborhood: 'del valle, ROMA NORTE' }, [two, roma]],
        [{ neighborhood: 'Valle' }, []], // exact, not contains
        [{ municipality: 'benito juárez' }, [two]],
        [{ city: 'Ciudad de México' }, [two, roma]],
        [{ zipCode: '03100' }, [two]],
        [{ zipCode: '06700,03020' }, [two, roma]],
        // Every location filter holds on the SAME address.
        [{ neighborhood: 'Narvarte', zipCode: '03100' }, []],
        [{ neighborhood: 'Narvarte', zipCode: '03020' }, [two]],
      ]);

      const res = await listing(b.member, { neighborhood: 'Del Valle' }).expect(
        200,
      );
      const row = rowOf(res, two);
      expect(row.primaryAddress.id).toBe(primary);
      expect(row.matchedAddressId).toBe(second);
      expect(Object.keys(row)).toEqual([
        ...ROW_KEYS.slice(0, ROW_KEYS.indexOf('metrics')),
        'matchedAddressId',
        'metrics',
      ]);
      const byCity = await listing(b.member, {
        city: 'Ciudad de México',
      }).expect(200);
      expect(rowOf(byCity, two).matchedAddressId).toBe(primary);
      expect(rowOf(byCity, roma).matchedAddressId).toBe(romaAddr);
      expect(third).toBeDefined();

      // Without a location filter the key is absent.
      const plain = await listing(b.member).expect(200);
      expect(rowOf(plain, two)).not.toHaveProperty('matchedAddressId');
      expect(rowOf(plain, homeless)).not.toHaveProperty('matchedAddressId');

      // Without read:Sale the location filters work too, without metrics.
      const noSale = await listing(b.noSale, { zipCode: '03100' }).expect(200);
      expect(ids(noSale)).toEqual([two]);
      expect(rowOf(noSale, two).matchedAddressId).toBe(second);
      expect(rowOf(noSale, two)).not.toHaveProperty('metrics');
      expect(noSale.body.filterSummary).toEqual({ count: 1 });
    });

    it('deliveryZoneType by ACTIVE zone type of the address ZIP (trimmed); deliveryZoneNone = non-empty ZIP without active zone; tenant zones only', async () => {
      const b = await branch('Zonas');
      const other = await branch('Zonas B');
      await zone(b.tenantId, '03100', 'FREE');
      await zone(b.tenantId, '03020', 'DENIED');
      await zone(b.tenantId, '06700', 'SURCHARGE', false); // inactive
      await zone(other.tenantId, '06700', 'FREE'); // another tenant's
      await zone(other.tenantId, '11000', 'CARRIER_ONLY');
      const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

      const free = await customer(b, 'Gratis');
      const freeAddr = await addr(b, free, {
        createdAt: t(1),
        zipCode: '03100',
      });
      const freeTrim = await customer(b, 'GratisEspacios');
      await addr(b, freeTrim, { createdAt: t(2), zipCode: ' 03100 ' });
      const denied = await customer(b, 'Denegada');
      await addr(b, denied, { createdAt: t(3), zipCode: '03020' });
      const inactive = await customer(b, 'ZonaInactiva');
      const inactiveAddr = await addr(b, inactive, {
        createdAt: t(4),
        zipCode: '06700',
      });
      const foreignZip = await customer(b, 'ZonaAjena');
      await addr(b, foreignZip, { createdAt: t(5), zipCode: '11000' });
      const noZip = await customer(b, 'SinCP');
      await addr(b, noZip, { createdAt: t(6), zipCode: null });
      await addr(b, noZip, { createdAt: t(7), zipCode: '   ' });
      const mixed = await customer(b, 'Mixto');
      await addr(b, mixed, { createdAt: t(8), zipCode: '99999' });
      const mixedFree = await addr(b, mixed, {
        createdAt: t(9),
        zipCode: '03100',
      });
      const homeless = await customer(b, 'SinDireccion');

      await expectMatches(b.member, [
        [{ deliveryZoneType: 'FREE' }, [free, freeTrim, mixed]],
        [{ deliveryZoneType: 'DENIED' }, [denied]],
        [{ deliveryZoneType: 'SURCHARGE' }, []],
        [{ deliveryZoneType: 'CARRIER_ONLY' }, []],
        [{ deliveryZoneNone: 'true' }, [inactive, foreignZip, mixed]],
        // `false` is no filter.
        [
          { deliveryZoneNone: 'false' },
          [
            free,
            freeTrim,
            denied,
            inactive,
            foreignZip,
            noZip,
            mixed,
            homeless,
          ],
        ],
        [
          { deliveryZoneType: 'DENIED', deliveryZoneNone: 'true' },
          [denied, inactive, foreignZip, mixed],
        ],
        [{ deliveryZoneType: 'FREE', zipCode: '99999' }, []],
      ]);

      const res = await listing(b.member, { deliveryZoneType: 'FREE' }).expect(
        200,
      );
      expect(rowOf(res, free).matchedAddressId).toBe(freeAddr);
      expect(rowOf(res, mixed).matchedAddressId).toBe(mixedFree);
      const none = await listing(b.member, { deliveryZoneNone: 'true' }).expect(
        200,
      );
      expect(rowOf(none, inactive).matchedAddressId).toBe(inactiveAddr);
    });
  });

  describe('§4.5 Comercial y contacto', () => {
    it('priceListId (+ includeNull), isTrusted, hasRfc, fiscalRegime, hasEmail, hasPhone, hasChatbotRequests (any status, tenant only)', async () => {
      const b = await branch('Comercial');
      const other = await branch('Comercial B');
      const [l1, l2] = await Promise.all([
        prisma.globalPriceList.create({ data: { name: `L1 ${randomUUID()}` } }),
        prisma.globalPriceList.create({ data: { name: `L2 ${randomUUID()}` } }),
      ]);
      try {
        const full = await customer(b, 'Completo', {
          globalPriceListId: l1.id,
          isTrusted: true,
          rfc: 'LOAA800101XXX',
          fiscalRegime: '612',
          email: 'a@b.test',
          phone: '5512345678',
          phoneCountryCode: '52',
        });
        const mayoreo = await customer(b, 'Mayoreo', {
          globalPriceListId: l2.id,
          rfc: '  ',
          fiscalRegime: '601',
          email: '',
        });
        const bare = await customer(b, 'Vacio');
        const resolvedOnly = await customer(b, 'Resuelta');
        await chatbotRequest(b.tenantId, full, 'NEW');
        await chatbotRequest(b.tenantId, resolvedOnly, 'RESOLVED');
        await chatbotRequest(b.tenantId, null);
        // Another tenant's request pointing at our customer never counts.
        await chatbotRequest(other.tenantId, bare);

        await expectMatches(b.member, [
          [{ priceListId: l1.id }, [full]],
          [{ priceListId: `${l1.id},${l2.id}` }, [full, mayoreo]],
          [
            { priceListId: l2.id, priceListIncludeNull: 'true' },
            [mayoreo, bare, resolvedOnly],
          ],
          [{ priceListIncludeNull: 'true' }, [bare, resolvedOnly]],
          [{ isTrusted: 'true' }, [full]],
          [{ isTrusted: 'false' }, [mayoreo, bare, resolvedOnly]],
          [{ hasRfc: 'true' }, [full]],
          [{ hasRfc: 'false' }, [mayoreo, bare, resolvedOnly]],
          [{ fiscalRegime: '612' }, [full]],
          [{ fiscalRegime: '601,612' }, [full, mayoreo]],
          [{ hasEmail: 'false' }, [mayoreo, bare, resolvedOnly]],
          [{ hasPhone: 'true' }, [full]],
          [{ hasChatbotRequests: 'true' }, [full, resolvedOnly]],
          [{ hasChatbotRequests: 'false' }, [mayoreo, bare]],
          // AND between groups.
          [{ isTrusted: 'true', hasChatbotRequests: 'false' }, []],
          [{ hasChatbotRequests: 'true', search: 'resu' }, [resolvedOnly]],
        ]);
      } finally {
        await world.cleanup();
        await prisma.globalPriceList.deleteMany({
          where: { id: { in: [l1.id, l2.id] } },
        });
      }
    });
  });

  describe('§10.1 / §11 for the new params (HTTP)', () => {
    it('without read:Sale: metric filters → 400 with the field; customer filters → 200 {count}', async () => {
      const b = await branch('PermisosFiltros');
      await customer(b, 'Rosa');
      for (const [key, value] of [
        ['hasDebt', 'false'],
        ['overdueMoreThanDays', '30'],
        ['averageTicketMin', '0'],
        ['noPurchaseMoreThanDays', '90'],
      ]) {
        const res = await listing(b.noSale, { [key]: value }).expect(400);
        expect(res.body).toEqual({
          statusCode: 400,
          code: 'LISTING_PARAM_REQUIRES_PERMISSION',
          message: `${key} requires read:Sale`,
          field: key,
          details: { required: 'read:Sale' },
        });
      }
      // A malformed metric param gets its validation error first.
      const bad = await listing(b.noSale, { openDebtMin: '-1' }).expect(400);
      expect(bad.body).toMatchObject({
        code: 'LISTING_INVALID_NUMBER',
        field: 'openDebtMin',
      });
      const ok = await listing(b.noSale, {
        hasPets: 'false',
        isTrusted: 'false',
        createdFrom: '2026-01-01T00:00:00.000Z',
      }).expect(200);
      expect(ok.body.filterSummary).toEqual({ count: 1 });
    });

    it('error codes of §11 through the production pipe', async () => {
      const b = await branch('ErroresFiltros');
      const cases: Array<[Record<string, string>, string | null, string]> = [
        [{ openDebtMin: 'abc' }, 'LISTING_INVALID_NUMBER', 'openDebtMin'],
        [{ totalSoldMax: '-5' }, 'LISTING_INVALID_NUMBER', 'totalSoldMax'],
        [{ salesCountMin: '1.5' }, 'LISTING_INVALID_NUMBER', 'salesCountMin'],
        [
          { averageTicketMin: '9', averageTicketMax: '1' },
          'LISTING_INVERTED_RANGE',
          'averageTicket',
        ],
        [
          { lastPurchaseFrom: 'nope' },
          'LISTING_INVALID_DATE',
          'lastPurchaseFrom',
        ],
        [
          { createdFrom: '2026-02-01', createdTo: '2026-01-01' },
          'LISTING_INVERTED_RANGE',
          'created',
        ],
        [{ petSize: 'XL' }, 'LISTING_INVALID_ENUM_VALUE', 'petSize'],
        [{ fiscalRegime: '000' }, 'LISTING_INVALID_ENUM_VALUE', 'fiscalRegime'],
        [
          { deliveryZoneType: 'ZONA_A' },
          'LISTING_INVALID_ENUM_VALUE',
          'deliveryZoneType',
        ],
        [{ priceListId: '123' }, 'LISTING_INVALID_UUID', 'priceListId'],
        [
          { city: Array.from({ length: 201 }, (_, i) => `c${i}`).join(',') },
          'LISTING_TOO_MANY_VALUES',
          'city',
        ],
        [{ overdueMoreThanDays: '0' }, null, 'overdueMoreThanDays'],
        [{ noPurchaseMoreThanDays: '3651' }, null, 'noPurchaseMoreThanDays'],
        [{ hasRfc: 'yes' }, null, 'hasRfc'],
        [
          { preferredPaymentMethod: 'efectivo' },
          null,
          'preferredPaymentMethod',
        ],
      ];
      for (const [query, code, field] of cases) {
        const res = await listing(b.member, query).expect(400);
        if (code) {
          expect([query, res.body.code, res.body.field]).toEqual([
            query,
            code,
            field,
          ]);
        } else {
          expect([query, res.body.code]).toEqual([query, undefined]);
          expect(JSON.stringify(res.body)).toContain(field);
        }
      }
    });
  });

  // ═════════════════════════ T3 / S2: options (§5) ═════════════════════════

  describe('GET /customers/listing/options (§5)', () => {
    const options = (m: SeededMember, query: Record<string, string>) =>
      request(server())
        .get('/customers/listing/options')
        .query(query)
        .set(auth(m));

    it('distinct trimmed case-insensitive groups, most frequent spelling, distinct customers, count desc then value, q, limit, blanks skipped, tenant only', async () => {
      const b = await branch('Opciones');
      const other = await branch('Opciones B');
      const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
      const c1 = await customer(b, 'Uno');
      const c2 = await customer(b, 'Dos');
      const c3 = await customer(b, 'Tres');
      const c4 = await customer(b, 'Cuatro');
      await addr(b, c1, {
        createdAt: t(1),
        neighborhood: 'Del Valle',
        zipCode: '03100',
        city: 'CDMX',
      });
      // Two addresses of one customer in the same colonia count once.
      await addr(b, c1, {
        createdAt: t(2),
        neighborhood: ' del valle ',
        zipCode: '03100',
      });
      await addr(b, c2, {
        createdAt: t(3),
        neighborhood: 'Del Valle',
        zipCode: '03100',
      });
      await addr(b, c3, {
        createdAt: t(4),
        neighborhood: 'DEL VALLE',
        zipCode: '03020',
      });
      await addr(b, c4, {
        createdAt: t(5),
        neighborhood: 'Roma Norte',
        zipCode: '06700',
      });
      await addr(b, c4, {
        createdAt: t(6),
        neighborhood: 'Álamos',
        zipCode: '   ',
      });
      await addr(b, c4, { createdAt: t(7), neighborhood: '  ', zipCode: null });
      const foreign = await customer(other, 'Ajena');
      await addr(other, foreign, {
        createdAt: t(8),
        neighborhood: 'Del Valle',
      });
      await addr(other, foreign, { createdAt: t(9), neighborhood: 'Polanco' });

      const res = await options(b.member, { field: 'neighborhood' }).expect(
        200,
      );
      expect(res.body.field).toBe('neighborhood');
      expect(res.body.data[0]).toEqual({
        value: 'Del Valle',
        customersCount: 3,
      });
      // The 1-customer tie sorts by value in the database collation, which
      // may place «Á» either side of «R»: assert the group, not its order.
      expect(
        (res.body.data as Array<{ value: string }>)
          .slice(1)
          .map((o) => o.value)
          .sort(),
      ).toEqual(['Roma Norte', 'Álamos'].sort());
      expect(res.body.data).toHaveLength(3);

      const q = await options(b.member, {
        field: 'neighborhood',
        q: 'VALL',
      }).expect(200);
      expect(q.body.data).toEqual([{ value: 'Del Valle', customersCount: 3 }]);
      const limited = await options(b.member, {
        field: 'neighborhood',
        limit: '1',
      }).expect(200);
      expect(limited.body.data).toEqual([
        { value: 'Del Valle', customersCount: 3 },
      ]);

      const zips = await options(b.member, { field: 'zipCode' }).expect(200);
      expect(zips.body.data).toEqual([
        { value: '03100', customersCount: 2 },
        { value: '03020', customersCount: 1 },
        { value: '06700', customersCount: 1 },
      ]);
      const cities = await options(b.member, { field: 'city' }).expect(200);
      expect(cities.body).toEqual({
        field: 'city',
        data: [{ value: 'CDMX', customersCount: 1 }],
      });
      const municipalities = await options(b.member, {
        field: 'municipality',
      }).expect(200);
      expect(municipalities.body).toEqual({ field: 'municipality', data: [] });

      // Selecting an option matches the whole group through the §4.4 filter.
      const filtered = await listing(b.member, {
        neighborhood: 'Del Valle',
      }).expect(200);
      expect(filtered.body.pagination.total).toBe(3);

      // Tenant isolation: the other tenant sees only its own values.
      const theirs = await options(other.member, {
        field: 'neighborhood',
      }).expect(200);
      expect(theirs.body.data).toEqual([
        { value: 'Del Valle', customersCount: 1 },
        { value: 'Polanco', customersCount: 1 },
      ]);
    });

    it('fiscalRegime: only the SAT codes in use, with counts', async () => {
      const b = await branch('OpcionesRegimen');
      await customer(b, 'A', { fiscalRegime: '612' });
      await customer(b, 'B', { fiscalRegime: '612' });
      await customer(b, 'C', { fiscalRegime: '601' });
      await customer(b, 'D', { fiscalRegime: 'XYZ' }); // not a SAT code
      await customer(b, 'E', { fiscalRegime: null });
      const res = await options(b.member, { field: 'fiscalRegime' }).expect(
        200,
      );
      expect(res.body).toEqual({
        field: 'fiscalRegime',
        data: [
          { value: '612', customersCount: 2 },
          { value: '601', customersCount: 1 },
        ],
      });
    });

    it('permissions and validation: read:Customer is enough; without it 403; unknown field / limit → 400', async () => {
      const b = await branch('OpcionesPermisos');
      await options(b.noSale, { field: 'city' }).expect(200);
      const saleOnly = await world.member(b.tenantId, 'Solo ventas', [
        'Sale:read',
      ]);
      await options(saleOnly, { field: 'city' }).expect(403);
      for (const query of [
        {},
        { field: 'preferredPaymentMethod' },
        { field: 'deliveryZoneType' },
        { field: 'city', limit: '201' },
        { field: 'city', limit: '0' },
        { field: 'city', page: '1' },
      ] as Array<Record<string, string>>) {
        await options(b.member, query).expect(400);
      }
    });
  });
});
