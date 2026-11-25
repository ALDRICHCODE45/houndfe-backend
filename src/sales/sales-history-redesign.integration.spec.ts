/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * sales-history-redesign / T1 (contract §1, §3, §5.2, §7) against REAL
 * PostgreSQL through the real JWT → tenant → CASL chain, the production
 * validation pipe and the real `PrismaSaleRepository`:
 *
 * - S1 `GET /sales` rows carry `itemsPreview` (≤ 3 lines, `createdAt`, `id`)
 *   and `itemsCount`, tenant-scoped.
 * - S2/S3 `summary.averageTicketCents`, `counts.overdue`,
 *   `summary.overdueDebtCents`, `summary.oldestOverdueDueDate` and the
 *   `overdue=true` page filter (due day = UTC date of `dueDate`, before
 *   today's local date in Mexico City).
 * - S4 `GET /customers/:customerId/sales-monthly`.
 *
 * Dates are derived from the real clock (one test pins the injected sales
 * clock to a late-local-day instant): Mexico City is UTC-6 all year
 * (no DST since 2022), so local midnight is 06:00Z. The expectations are
 * computed here independently of the production helpers.
 */
import type { INestApplication } from '@nestjs/common';
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
} from '../delivery-zones/test-support/delivery-zone-world';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SalesCustomerMonthlyController } from './sales-customer-monthly.controller';
import { SalesQueryController } from './sales-query.controller';
import { SalesService } from './sales.service';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local (UTC-6) calendar date of an instant, `YYYY-MM-DD`. */
const mxDate = (at: Date) =>
  new Date(at.getTime() - 6 * HOUR).toISOString().slice(0, 10);
/** UTC instant of 00:00 local on a `YYYY-MM-DD` local date. */
const mxMidnight = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 6 * HOUR);
/** Stored form of a user-picked due date: 00:00Z of that calendar day. */
const utcMidnight = (date: string) => new Date(`${date}T00:00:00.000Z`);
/** `YYYY-MM-DD` shifted by `delta` days. */
const shiftDay = (date: string, delta: number) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + delta * DAY)
    .toISOString()
    .slice(0, 10);
/** `YYYY-MM` shifted by `delta` months. */
const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

const ROW_KEYS = [
  'id',
  'folio',
  'status',
  'channel',
  'cancelReason',
  'paymentStatus',
  'deliveryStatus',
  'totalCents',
  'debtCents',
  'confirmedAt',
  'dueDate',
  'customer',
  'cashier',
  'seller',
  'paymentMethods',
  'shippingAddress',
  'hold',
  'itemsPreview',
  'itemsCount',
].sort();

describeIfDb('Sales history redesign — GET /sales + customer monthly (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  // Injected sales clock (SALES_CLOCK seam); real time unless a test pins it.
  let clockNow: () => Date = () => new Date();

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [SalesQueryController, SalesCustomerMonthlyController],
      providers: [
        {
          provide: SalesService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) => {
            // SAFETY: the read methods under test only use these ports.
            const sales = Object.create(SalesService.prototype) as SalesService;
            Object.assign(sales, {
              tenantPrisma,
              saleRepo: new PrismaSaleRepository(tenantPrisma),
              clock: () => clockNow(),
              config: {
                get: (key: string) =>
                  key === 'PROMOTIONS_BUSINESS_TIMEZONE'
                    ? 'America/Mexico_City'
                    : undefined,
              },
            });
            return sales;
          },
        },
      ],
    });
  });

  afterEach(async () => {
    clockNow = () => new Date();
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
    productId: string;
    c1: string;
    c2: string;
    pet: string; // of c1
  }

  async function branch(name: string, grants = ['Sale:read']): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Cajero ${name}`, grants);
    const productId = randomUUID();
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Croquetas', quantity: 50 },
    });
    const c1 = randomUUID();
    const c2 = randomUUID();
    await prisma.customer.create({
      data: { id: c1, tenantId, firstName: 'Rosa' },
    });
    await prisma.customer.create({
      data: { id: c2, tenantId, firstName: 'Luis' },
    });
    const pet = await prisma.customerPet.create({
      data: {
        tenantId,
        customerId: c1,
        name: 'Bruno',
        nameKey: 'bruno',
        species: 'DOG',
        status: 'ACTIVE',
        createdVia: 'POS',
      },
    });
    return { tenantId, member, productId, c1, c2, pet: pet.id };
  }

  interface Line {
    id?: string;
    name: string;
    variant?: string | null;
    quantity?: number;
    createdAt?: Date;
    petId?: string;
    tenantId?: string;
  }

  let folioSeq = 0;
  async function sale(
    b: Branch,
    opts: {
      customerId?: string | null;
      status?: 'CONFIRMED' | 'CANCELED';
      totalCents?: number;
      debtCents?: number;
      paymentStatus?: 'PAID' | 'PARTIAL' | 'CREDIT';
      deliveryStatus?: 'DELIVERED' | 'PENDING';
      dueDate?: Date | null;
      confirmedAt?: Date;
      lines?: Line[];
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const total = opts.totalCents ?? 1000;
    const debt = opts.debtCents ?? 0;
    await prisma.sale.create({
      data: {
        id,
        tenantId: b.tenantId,
        userId: b.member.userId,
        customerId: opts.customerId === undefined ? b.c1 : opts.customerId,
        status: opts.status ?? 'CONFIRMED',
        channel: 'POS',
        folio: `H-${++folioSeq}-${id.slice(0, 6)}`,
        confirmedAt:
          opts.confirmedAt ?? new Date(Date.now() - DAY - folioSeq * 1000),
        subtotalCents: total,
        totalCents: total,
        paidCents: total - debt,
        debtCents: debt,
        paymentStatus: opts.paymentStatus ?? (debt > 0 ? 'CREDIT' : 'PAID'),
        deliveryStatus: opts.deliveryStatus ?? 'DELIVERED',
        dueDate: opts.dueDate ?? null,
      },
    });
    await addLines(b, id, opts.lines ?? []);
    return id;
  }

  async function addLines(b: Branch, saleId: string, lines: Line[]) {
    for (const line of lines) {
      await prisma.saleItem.create({
        data: {
          id: line.id,
          saleId,
          tenantId: line.tenantId ?? b.tenantId,
          productId: b.productId,
          productName: line.name,
          variantName: line.variant ?? null,
          quantity: line.quantity ?? 1,
          unitPriceCents: 100,
          petId: line.petId ?? null,
          ...(line.createdAt ? { createdAt: line.createdAt } : {}),
        },
      });
    }
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const list = (b: Branch, query = '') =>
    request(server()).get(`/sales?limit=100&${query}`).set(auth(b.member));
  const monthly = (b: Branch, customerId: string, query = '') =>
    request(server())
      .get(`/customers/${customerId}/sales-monthly${query}`)
      .set(auth(b.member));
  const ids = (res: request.Response) =>
    (res.body.data as Array<{ id: string }>).map((r) => r.id).sort();

  // ───────────────────────────── S1 preview ─────────────────────────────

  describe('S1 — itemsPreview / itemsCount on every row', () => {
    it('first 3 lines by createdAt then id, line count, snapshots; no lines → [] / 0', async () => {
      const b = await branch('Preview');
      const t0 = new Date('2026-11-01T10:00:00.000Z');
      const at = (s: number) => new Date(t0.getTime() + s * 1000);
      const four = await sale(b, {
        lines: [
          // Inserted out of order; two lines share createdAt (id breaks the tie).
          { name: 'Arena', quantity: 4, createdAt: at(3) },
          {
            id: 'ffffffff-0000-4000-8000-000000000002',
            name: 'Collar',
            variant: 'Rojo',
            createdAt: at(1),
          },
          { name: 'Croquetas', variant: '2 kg', quantity: 2, createdAt: at(0) },
          {
            id: 'ffffffff-0000-4000-8000-000000000001',
            name: 'Correa',
            quantity: 3,
            createdAt: at(1),
          },
        ],
      });
      const one = await sale(b, {
        customerId: null,
        lines: [{ name: 'Hueso', quantity: 5 }],
      });
      const none = await sale(b, { customerId: b.c2 });

      // A line of another tenant pointing at this sale never leaks.
      const foreign = await branch('PreviewForeign');
      await prisma.saleItem.create({
        data: {
          saleId: one,
          tenantId: foreign.tenantId,
          productId: foreign.productId,
          productName: 'Ajeno',
          quantity: 9,
          unitPriceCents: 1,
          createdAt: new Date('2000-01-01T00:00:00.000Z'),
        },
      });

      const res = await list(b).expect(200);
      const byId = new Map(
        (res.body.data as Array<Record<string, unknown>>).map((r) => [
          r.id as string,
          r,
        ]),
      );

      expect(byId.get(four)).toMatchObject({
        itemsCount: 4,
        itemsPreview: [
          { productName: 'Croquetas', variantName: '2 kg', quantity: 2 },
          { productName: 'Correa', variantName: null, quantity: 3 },
          { productName: 'Collar', variantName: 'Rojo', quantity: 1 },
        ],
      });
      expect(byId.get(one)).toMatchObject({
        itemsCount: 1,
        itemsPreview: [{ productName: 'Hueso', variantName: null, quantity: 5 }],
      });
      expect(byId.get(none)).toMatchObject({ itemsCount: 0, itemsPreview: [] });
      for (const row of byId.values()) {
        expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
        for (const preview of row.itemsPreview as object[]) {
          expect(Object.keys(preview).sort()).toEqual([
            'productName',
            'quantity',
            'variantName',
          ]);
        }
      }

      // Same preview when the history is scoped to one customer.
      const scoped = await list(b, `customerId=${b.c1}`).expect(200);
      expect(scoped.body.data).toEqual([byId.get(four)]);
    });
  });

  // ─────────────────────────── S2 / S3 overdue ───────────────────────────

  describe('S2/S3 — average ticket and overdue', () => {
    // The due day of a sale is the UTC calendar date of `dueDate` (what the
    // POS shows: user-picked dates are stored at 00:00Z of the picked day);
    // overdue = that day is before today's LOCAL date in Mexico City.
    async function overdueWorld(b: Branch, now = new Date()) {
      const today = mxDate(now);
      const yesterday = shiftDay(today, -1);
      const threeAgo = shiftDay(today, -3);
      const s = {
        // Overdue: picked due date three local days ago (stored 00:00Z).
        old: await sale(b, {
          totalCents: 3000,
          debtCents: 1000,
          dueDate: utcMidnight(threeAgo),
          lines: [{ name: 'Croquetas', petId: b.pet }],
        }),
        // Overdue: picked due date yesterday (stored 00:00Z).
        yesterdayPicked: await sale(b, {
          totalCents: 2000,
          debtCents: 500,
          paymentStatus: 'PARTIAL',
          dueDate: utcMidnight(yesterday),
        }),
        // Overdue: default-style due date with a time of day, UTC date yesterday.
        yesterdayLate: await sale(b, {
          totalCents: 800,
          debtCents: 200,
          paymentStatus: 'PARTIAL',
          dueDate: new Date(`${yesterday}T23:30:00.000Z`),
        }),
        // NOT overdue: due today (picked, stored 00:00Z).
        dueToday: await sale(b, {
          totalCents: 700,
          debtCents: 700,
          dueDate: utcMidnight(today),
        }),
        // NOT overdue: default-style due date today at 05:00Z (before local
        // midnight in UTC terms, but its UTC date is today).
        todayEarly: await sale(b, {
          totalCents: 600,
          debtCents: 600,
          dueDate: new Date(`${today}T05:00:00.000Z`),
        }),
        noDueDate: await sale(b, { totalCents: 300, debtCents: 300 }),
        paid: await sale(b, {
          totalCents: 1000,
          dueDate: utcMidnight(shiftDay(today, -10)),
        }),
        canceled: await sale(b, {
          status: 'CANCELED',
          totalCents: 900,
          debtCents: 900,
          dueDate: utcMidnight(yesterday),
        }),
        otherCustomer: await sale(b, {
          customerId: b.c2,
          totalCents: 400,
          debtCents: 400,
          deliveryStatus: 'PENDING',
          dueDate: utcMidnight(yesterday),
        }),
      };
      return { s, oldest: threeAgo };
    }

    it('counts.overdue / overdueDebtCents / oldestOverdueDueDate over the base filters; averageTicketCents half up', async () => {
      const b = await branch('Vencidas');
      const { oldest } = await overdueWorld(b);
      // Another tenant's overdue sale never counts.
      const foreign = await branch('VencidasForeign');
      await sale(foreign, {
        debtCents: 1000,
        dueDate: new Date(Date.now() - 5 * DAY),
      });

      const one = await list(b, `customerId=${b.c1}`).expect(200);
      // c1 CONFIRMED: old, yesterdayPicked, yesterdayLate, dueToday,
      // todayEarly, noDueDate, paid = 7 sales, 8400.
      expect(one.body.counts).toEqual({
        all: 7,
        pendingPayments: 6,
        notDelivered: 0,
        overdue: 3,
      });
      expect(one.body.summary).toEqual({
        salesCount: 7,
        totalSoldCents: 8400,
        outstandingDebtCents: 3300,
        averageTicketCents: 1200,
        overdueDebtCents: 1700,
        // The exact stored calendar date, as the row renders it.
        oldestOverdueDueDate: oldest,
      });

      const all = await list(b).expect(200);
      // + otherCustomer (400): 8 sales, 8800 → 1100.
      expect(all.body.counts.overdue).toBe(4);
      expect(all.body.summary).toMatchObject({
        salesCount: 8,
        totalSoldCents: 8800,
        averageTicketCents: 1100,
        overdueDebtCents: 2100,
        oldestOverdueDueDate: oldest,
      });
      expect(all.body.summary.salesCount).toBe(all.body.counts.all);

      // No overdue sale → zeroes and null.
      const none = await list(
        b,
        `customerId=${b.c1}&confirmedTo=2000-01-01T00:00:00.000Z`,
      ).expect(200);
      expect(none.body.counts.overdue).toBe(0);
      expect(none.body.summary).toMatchObject({
        salesCount: 0,
        averageTicketCents: 0,
        overdueDebtCents: 0,
        oldestOverdueDueDate: null,
      });
    });

    it('a yesterday-picked due date is the oldest overdue date, string for string', async () => {
      const b = await branch('VencidaAyer');
      const yesterday = shiftDay(mxDate(new Date()), -1);
      await sale(b, { debtCents: 500, dueDate: utcMidnight(yesterday) });

      const res = await list(b).expect(200);

      expect(res.body.counts.overdue).toBe(1);
      expect(res.body.summary.oldestOverdueDueDate).toBe(yesterday);
      expect(res.body.data[0].dueDate).toBe(`${yesterday}T00:00:00.000Z`);
    });

    it('late in the local day (23:30 Mexico = 05:30Z next UTC day) a sale due on the local today is not overdue', async () => {
      // Local today is 2026-11-24 although the UTC date is already the 25th.
      clockNow = () => new Date('2026-11-25T05:30:00.000Z');
      const b = await branch('VencidaMedianoche');
      const dueLocalToday = await sale(b, {
        debtCents: 700,
        dueDate: utcMidnight('2026-11-24'),
      });
      const dueUtcToday = await sale(b, {
        debtCents: 300,
        dueDate: utcMidnight('2026-11-25'),
      });
      const dueYesterday = await sale(b, {
        debtCents: 500,
        dueDate: utcMidnight('2026-11-23'),
      });

      const base = await list(b).expect(200);
      expect(base.body.counts.overdue).toBe(1);
      expect(base.body.summary).toMatchObject({
        overdueDebtCents: 500,
        oldestOverdueDueDate: '2026-11-23',
      });

      const filtered = await list(b, 'overdue=true').expect(200);
      expect(ids(filtered)).toEqual([dueYesterday]);
      expect(ids(filtered)).not.toContain(dueLocalToday);
      expect(ids(filtered)).not.toContain(dueUtcToday);
      expect(filtered.body.filterSummary).toEqual({
        count: 1,
        totalCents: 1000,
        debtCents: 500,
      });
    });

    it('overdue=true narrows data/pagination/filterSummary and never moves summary/counts', async () => {
      const b = await branch('FiltroVencidas');
      const { s } = await overdueWorld(b);

      const base = await list(b, `customerId=${b.c1}`).expect(200);
      const res = await list(b, `customerId=${b.c1}&overdue=true`).expect(200);

      expect(ids(res)).toEqual(
        [s.old, s.yesterdayPicked, s.yesterdayLate].sort(),
      );
      expect(ids(res)).not.toContain(s.dueToday);
      expect(ids(res)).not.toContain(s.todayEarly);
      expect(res.body.pagination).toMatchObject({ total: 3, totalPages: 1 });
      expect(res.body.filterSummary).toEqual({
        count: 3,
        totalCents: 5800,
        debtCents: 1700,
      });
      expect(res.body.summary).toEqual(base.body.summary);
      expect(res.body.counts).toEqual(base.body.counts);

      // false / absent = no filter.
      const off = await list(b, `customerId=${b.c1}&overdue=false`).expect(200);
      expect(ids(off)).toEqual(ids(base));
      expect(off.body.pagination).toEqual(base.body.pagination);
    });

    it.each<
      [string, (b: Branch) => string, (s: Record<string, string>) => string[]]
    >([
      [
        'customerId + paymentStatus',
        (b) => `customerId=${b.c1}&paymentStatus=PARTIAL`,
        (s) => [s.yesterdayPicked, s.yesterdayLate],
      ],
      [
        'customerId + petId',
        (b) => `customerId=${b.c1}&petId=${b.pet}`,
        (s) => [s.old],
      ],
      [
        'deliveryStatus',
        () => 'deliveryStatus=PENDING',
        (s) => [s.otherCustomer],
      ],
      [
        'no other filter',
        () => '',
        (s) => [s.old, s.yesterdayPicked, s.yesterdayLate, s.otherCustomer],
      ],
      [
        'status=CANCELED (overdue is CONFIRMED only)',
        () => 'status=CANCELED',
        () => [],
      ],
    ])('overdue=true combines (AND) with %s', async (_label, query, expected) => {
      const b = await branch(`Combo-${randomUUID().slice(0, 4)}`);
      const { s } = await overdueWorld(b);

      const res = await list(b, `overdue=true&${query(b)}`).expect(200);

      expect(ids(res)).toEqual(expected(s).sort());
      expect(res.body.pagination.total).toBe(expected(s).length);
      expect(res.body.filterSummary.count).toBe(expected(s).length);
    });

    it('rejects a non-boolean overdue with 400', async () => {
      const b = await branch('VencidasMal');
      const res = await list(b, 'overdue=yes').expect(400);
      expect(JSON.stringify(res.body)).toContain('overdue');
    });
  });

  // ─────────────────────────── S4 monthly ───────────────────────────

  describe('S4 — GET /customers/:customerId/sales-monthly', () => {
    it('one entry per month ending with the current local month, zero months, CONFIRMED by confirmedAt in local months', async () => {
      const b = await branch('Mensual');
      const now = new Date();
      const thisMonth = mxDate(now).slice(0, 7);
      const monthStart = mxMidnight(`${thisMonth}-01`);
      // 00:30 local on day 1 → this month.
      await sale(b, { totalCents: 1000, confirmedAt: new Date(monthStart.getTime() + 30 * 60_000) });
      // 23:30 local on the last day of the previous month is 05:30Z on day 1
      // of this month in UTC → previous month locally.
      await sale(b, { totalCents: 2000, confirmedAt: new Date(monthStart.getTime() - 30 * 60_000) });
      await sale(b, { totalCents: 2500, confirmedAt: new Date(monthStart.getTime() - 2 * HOUR) });
      // 3 months back.
      const threeBack = mxMidnight(`${shiftMonth(thisMonth, -3)}-15`);
      await sale(b, { totalCents: 500, confirmedAt: threeBack });
      // Excluded: canceled, other customer, older than the window.
      await sale(b, { status: 'CANCELED', totalCents: 9999, confirmedAt: new Date(monthStart.getTime() + HOUR) });
      await sale(b, { customerId: b.c2, totalCents: 7777, confirmedAt: new Date(monthStart.getTime() + HOUR) });
      await sale(b, { totalCents: 4444, confirmedAt: mxMidnight(`${shiftMonth(thisMonth, -12)}-28`) });
      // Another tenant's sales never count.
      const foreign = await branch('MensualForeign');
      await sale(foreign, { totalCents: 8888, confirmedAt: new Date(monthStart.getTime() + HOUR) });

      const res = await monthly(b, b.c1).expect(200);

      const expected = Array.from({ length: 12 }, (_, i) => ({
        month: shiftMonth(thisMonth, i - 11),
        saleCount: 0,
        totalCents: 0,
      }));
      expected[11] = { month: thisMonth, saleCount: 1, totalCents: 1000 };
      expected[10] = { month: shiftMonth(thisMonth, -1), saleCount: 2, totalCents: 4500 };
      expected[8] = { month: shiftMonth(thisMonth, -3), saleCount: 1, totalCents: 500 };
      expect(res.body).toEqual({
        customerId: b.c1,
        timeZone: 'America/Mexico_City',
        months: expected,
      });

      const two = await monthly(b, b.c1, '?months=2').expect(200);
      expect(two.body.months).toEqual(expected.slice(10));

      const max = await monthly(b, b.c1, '?months=24').expect(200);
      expect(max.body.months).toHaveLength(24);
      expect(max.body.months[0].month).toBe(shiftMonth(thisMonth, -23));
      expect(max.body.months[11]).toEqual({
        month: shiftMonth(thisMonth, -12),
        saleCount: 1,
        totalCents: 4444,
      });

      // `months=1` → only the current local month (c2's one sale).
      const single = await monthly(b, b.c2, '?months=1').expect(200);
      expect(single.body.months).toEqual([
        { month: thisMonth, saleCount: 1, totalCents: 7777 },
      ]);
    });

    it('unknown or foreign-tenant customer → 404 CUSTOMER_NOT_FOUND (code-only)', async () => {
      const a = await branch('MensualA');
      const other = await branch('MensualB');
      await sale(other, { totalCents: 1000 });
      const body = {
        statusCode: 404,
        error: 'CUSTOMER_NOT_FOUND',
        message: 'CUSTOMER_NOT_FOUND',
      };

      expect((await monthly(a, randomUUID()).expect(404)).body).toEqual(body);
      expect((await monthly(a, other.c1).expect(404)).body).toEqual(body);
    });

    it.each(['?months=0', '?months=25', '?months=abc', '?months=1.5'])(
      'rejects %s with 400',
      async (query) => {
        const b = await branch(`MensualQ-${randomUUID().slice(0, 4)}`);
        await monthly(b, b.c1, query).expect(400);
      },
    );

    it('a non-uuid customer id is 400; without read:Sale it is 403', async () => {
      const b = await branch('MensualPerm');
      await monthly(b, 'not-a-uuid').expect(400);

      const noSale = await branch('MensualSinPermiso', ['Customer:read']);
      await monthly(noSale, noSale.c1).expect(403);
    });
  });
});
