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
});
