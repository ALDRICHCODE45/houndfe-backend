/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
/**
 * customers-listing T2 (S5, contract §7, §7.1, §7.2, §12.3) — `GET
 * /customers/:customerId/payments` against REAL PostgreSQL: real JWT →
 * tenant → CASL chain, production pipe + filters, the real
 * `PrismaCustomerPaymentsReader`.
 *
 * Two apps share the database: the collection world app drives real «Cobrar
 * todo», reads and cancellations; the feed app serves the feed and the
 * customer statement route (its rendered statement is captured, so the feed's
 * net cash amounts are compared with the statement PDF's, value by value).
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
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { CustomerPaymentsController } from './customer-payments.controller';
import { PrismaCustomerPaymentsReader } from './customer-payments.prisma-reader';
import { CustomerPaymentsService } from './customer-payments.service';
import { CustomerStatementService } from './customer-statement.service';
import type { CustomerStatementDto } from './dto/customer-statement.dto';
import { PrismaCustomerStatementReader } from './infrastructure/prisma-customer-statement.reader';
import { SalesCustomerStatementController } from './sales-customer-statement.controller';
import {
  counter,
  createCollectionTestApp,
  routes,
  seedCustomer,
  seedSale,
  type Counter,
} from './test-support/customer-collection-world';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

const NOW = new Date('2026-11-25T18:00:00.000Z');
const at = (iso: string) => new Date(iso);

describeIfDb('GET /customers/:customerId/payments (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let collectApp: INestApplication;
  let feedApp: INestApplication;
  const api = routes(() => collectApp);
  const rendered: CustomerStatementDto[] = [];

  beforeAll(async () => {
    collectApp = await createCollectionTestApp();
    feedApp = await createZoneTestApp({
      controllers: [
        CustomerPaymentsController,
        SalesCustomerStatementController,
      ],
      providers: [
        {
          provide: CustomerPaymentsService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomerPaymentsService(
              new PrismaCustomerPaymentsReader(tenantPrisma),
            ),
        },
        {
          provide: CustomerStatementService,
          inject: [TenantPrismaService],
          useFactory: (tenantPrisma: TenantPrismaService) =>
            new CustomerStatementService(
              new PrismaCustomerStatementReader(tenantPrisma),
              () => NOW,
              {
                get: (key: string) =>
                  key === 'PROMOTIONS_BUSINESS_TIMEZONE'
                    ? 'America/Mexico_City'
                    : undefined,
              } as never,
            ),
        },
        {
          provide: PdfGenerationService,
          useValue: {
            renderCustomerStatementPdf: (statement: CustomerStatementDto) => {
              rendered.push(statement);
              return Promise.resolve(Buffer.from('%PDF-stub'));
            },
          },
        },
      ],
    });
  });

  afterEach(async () => {
    rendered.length = 0;
    await world.cleanup();
  });

  afterAll(async () => {
    await collectApp?.close();
    await feedApp?.close();
    await disconnectWorldPrisma();
  });

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const feed = (m: SeededMember, customerId: string, query = '') =>
    request(feedApp.getHttpServer() as App)
      .get(`/customers/${customerId}/payments${query}`)
      .set(auth(m));
  const statement = async (m: SeededMember, customerId: string) => {
    await request(feedApp.getHttpServer() as App)
      .get(
        `/customers/${customerId}/statement/pdf?from=2026-03-01&to=2026-04-01`,
      )
      .set(auth(m))
      .expect(200);
    return rendered[rendered.length - 1];
  };

  let seq = 0;
  async function sale(
    c: Counter,
    opts: {
      customerId?: string;
      status?: 'CONFIRMED' | 'CANCELED';
      totalCents: number;
      changeDueCents?: number;
    },
  ): Promise<{ id: string; folio: string }> {
    const id = randomUUID();
    const folio = `P-${++seq}-${id.slice(0, 4)}`;
    await prisma.sale.create({
      data: {
        id,
        tenantId: c.tenantId,
        userId: c.member.userId,
        customerId: opts.customerId ?? c.customerId,
        status: opts.status ?? 'CONFIRMED',
        channel: 'POS',
        folio,
        confirmedAt: at('2026-03-02T18:00:00.000Z'),
        canceledAt:
          opts.status === 'CANCELED' ? at('2026-03-03T18:00:00.000Z') : null,
        subtotalCents: opts.totalCents,
        totalCents: opts.totalCents,
        paidCents: opts.totalCents,
        debtCents: 0,
        changeDueCents: opts.changeDueCents ?? 0,
        paymentStatus: 'PAID',
      },
    });
    return { id, folio };
  }

  async function pay(
    c: Counter,
    saleId: string,
    createdAt: Date,
    amountCents: number,
    method: 'CASH' | 'CARD_CREDIT' | 'CARD_DEBIT' | 'TRANSFER' = 'CASH',
    extra: {
      tenantId?: string;
      metadataJson?: object;
      reference?: string;
      collectionId?: string;
      userId?: string | null;
    } = {},
  ): Promise<string> {
    const row = await prisma.salePayment.create({
      data: {
        saleId,
        tenantId: extra.tenantId ?? c.tenantId,
        method,
        amountCents,
        createdAt,
        userId: extra.userId === undefined ? c.member.userId : extra.userId,
        reference: extra.reference ?? null,
        collectionId: extra.collectionId ?? null,
        ...(extra.metadataJson ? { metadataJson: extra.metadataJson } : {}),
      },
    });
    return row.id;
  }

  it('a «Cobrar todo» is ONE event with its breakdown; the other payments are their own events; another customer’s never appear', async () => {
    const c = await counter(world, 'FeedCobro');
    const u = c.member.userId;
    const A = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 300,
      dueDate: '2026-11-01',
      confirmedAt: '2026-10-05T15:00:00.000Z',
    });
    // Seeds a 200 TRANSFER payment row (a standalone event).
    const B = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 700,
      paidCents: 200,
      dueDate: '2099-12-10',
    });
    const C = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 400,
      confirmedAt: '2026-10-03T15:00:00.000Z',
    });
    const other = await seedCustomer(c.tenantId, 'Otro', null);
    await seedSale(c.tenantId, u, other, { totalCents: 100, paidCents: 100 });
    // cash 800 → debt 1200 covered by card 600 + cash 600, change 200.
    const post = await api.collect(c.member, c.customerId, {
      cashSessionId: c.sessionId,
      payments: [
        { method: 'card_debit', amountCents: 600 },
        { method: 'cash', amountCents: 800 },
      ],
    });
    expect(post.status).toBe(201);
    const collectionId = post.body.collectionId as string;
    const read = await api.read(c.member, collectionId);
    expect(read.status).toBe(200);
    const transferRow = await prisma.salePayment.findFirstOrThrow({
      where: { saleId: B, collectionId: null },
    });
    const folios = Object.fromEntries(
      (
        await prisma.sale.findMany({
          where: { id: { in: [A, B, C] } },
          select: { id: true, folio: true },
        })
      ).map((s) => [s.id, s.folio]),
    );

    const res = await feed(c.member, c.customerId);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 2,
      totalPages: 1,
    });
    const cashier = { id: u, name: 'Cajera FeedCobro' };
    expect(res.body.data).toEqual([
      {
        kind: 'collection',
        eventId: collectionId,
        occurredAt: read.body.createdAt,
        amountCents: 1200,
        tenderedCents: 1400,
        changeDueCents: 200,
        payments: read.body.payments,
        sales: read.body.sales.map((s: any) => ({
          saleId: s.saleId,
          folio: s.folio,
          status: 'CONFIRMED',
          appliedCents: s.appliedCents,
        })),
        cashier,
        receiptPath: `/collections/${collectionId}/pdf`,
      },
      {
        kind: 'payment',
        eventId: transferRow.id,
        occurredAt: transferRow.createdAt.toISOString(),
        method: 'transfer',
        catalog: null,
        reference: null,
        amountCents: 200,
        tenderedCents: 200,
        changeCents: 0,
        sale: { id: B, folio: folios[B], status: 'CONFIRMED', totalCents: 700 },
        cashier,
        receiptPath: `/sales/${B}/pdf`,
      },
    ]);
    // Lowercase tenders, same order as GET /collections/:id.
    expect(res.body.data[0].payments).toEqual([
      { method: 'card_debit', amountCents: 600, catalog: null },
      { method: 'cash', amountCents: 800, catalog: null },
    ]);
    expect(
      res.body.data[0].sales.map((s: any) => [s.saleId, s.appliedCents]),
    ).toEqual([
      [A, 300],
      [B, 500],
      [C, 400],
    ]);

    // A sale canceled afterwards: still listed, flagged; refunds stay out.
    expect((await api.cancel(c.member, B)).status).toBe(200);
    const after = await feed(c.member, c.customerId);

    expect(after.status).toBe(200);
    expect(after.body.pagination.total).toBe(2);
    expect(
      after.body.data[0].sales.find((s: any) => s.saleId === B).status,
    ).toBe('CANCELED');
    expect(after.body.data[0].receiptPath).toBe(
      `/collections/${collectionId}/pdf`,
    );
    expect(after.body.data[1]).toMatchObject({
      eventId: transferRow.id,
      amountCents: 200,
      sale: { id: B, status: 'CANCELED' },
      receiptPath: null,
    });
  });

  it('standalone payments: lowercase methods, catalog, reference, cash net of change exactly as the statement PDF', async () => {
    const c = await counter(world, 'FeedSueltos');
    const otherTenant = await counter(world, 'FeedSueltosB');
    const change = await sale(c, { totalCents: 4500, changeDueCents: 500 });
    const split = await sale(c, { totalCents: 4500, changeDueCents: 800 });
    const card = await sale(c, { totalCents: 2000 });
    const canceled = await sale(c, { totalCents: 1500, status: 'CANCELED' });
    const foreignCustomer = await sale(c, {
      totalCents: 999,
      customerId: await seedCustomer(c.tenantId, 'Luis', null),
    });

    const pChange = await pay(
      c,
      change.id,
      at('2026-03-06T18:00:00.000Z'),
      5000,
    );
    // Change 800 > first cash row 300: spills onto the later cash row.
    const s1 = await pay(c, split.id, at('2026-03-07T18:00:00.000Z'), 300);
    const s2 = await pay(
      c,
      split.id,
      at('2026-03-07T18:00:01.000Z'),
      1000,
      'CARD_CREDIT',
    );
    const s3 = await pay(c, split.id, at('2026-03-07T18:00:02.000Z'), 4000);
    const pCard = await pay(
      c,
      card.id,
      at('2026-03-08T18:00:00.000Z'),
      2000,
      'CARD_DEBIT',
      {
        reference: 'AUT-123',
        metadataJson: {
          catalog: {
            paymentMethodId: 'pm-1',
            name: 'Terminal BBVA',
            subtitle: 'Débito',
          },
        },
        userId: null,
      },
    );
    const pCanceled = await pay(
      c,
      canceled.id,
      at('2026-03-09T18:00:00.000Z'),
      1500,
      'TRANSFER',
      {
        metadataJson: { reference: 'LEGACY-7' },
      },
    );
    await prisma.saleRefund.create({
      data: {
        tenantId: c.tenantId,
        saleId: canceled.id,
        method: 'TRANSFER',
        amountCents: 1500,
        reason: 'CUSTOMER_REQUEST',
      },
    });
    await pay(c, foreignCustomer.id, at('2026-03-10T18:00:00.000Z'), 999);
    // A foreign tenant's row on this tenant's sale id: never read.
    await pay(c, change.id, at('2026-03-11T18:00:00.000Z'), 777, 'CASH', {
      tenantId: otherTenant.tenantId,
    });

    const res = await feed(c.member, c.customerId);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(6);
    const byId = new Map<string, any>(
      res.body.data.map((e: any) => [e.eventId, e]),
    );
    expect(res.body.data.map((e: any) => e.eventId)).toEqual([
      pCanceled,
      pCard,
      s3,
      s2,
      s1,
      pChange,
    ]);
    expect(
      res.body.data.map((e: any) => [
        e.method,
        e.tenderedCents,
        e.changeCents,
        e.amountCents,
      ]),
    ).toEqual([
      ['transfer', 1500, 0, 1500],
      ['card_debit', 2000, 0, 2000],
      ['cash', 4000, 500, 3500],
      ['card_credit', 1000, 0, 1000],
      ['cash', 300, 300, 0],
      ['cash', 5000, 500, 4500],
    ]);
    expect(byId.get(pCard)).toMatchObject({
      catalog: {
        paymentMethodId: 'pm-1',
        name: 'Terminal BBVA',
        subtitle: 'Débito',
      },
      reference: 'AUT-123',
      cashier: null,
      sale: {
        id: card.id,
        folio: card.folio,
        status: 'CONFIRMED',
        totalCents: 2000,
      },
      receiptPath: `/sales/${card.id}/pdf`,
    });
    expect(byId.get(pCanceled)).toMatchObject({
      reference: 'LEGACY-7',
      catalog: null,
      sale: { id: canceled.id, status: 'CANCELED' },
      receiptPath: null,
      cashier: { id: c.member.userId, name: 'Cajera FeedSueltos' },
    });

    // The statement PDF lists the same rows with the same net amounts.
    const pdf = await statement(c.member, c.customerId);
    const pdfAmounts = new Map(
      pdf.payments.map((p) => [
        p.id,
        [p.amountCents, p.tenderedCents, p.changeCents],
      ]),
    );
    for (const event of res.body.data) {
      expect([event.eventId, pdfAmounts.get(event.eventId)]).toEqual([
        event.eventId,
        [event.amountCents, event.tenderedCents, event.changeCents],
      ]);
    }
    expect(pdf.payments).toHaveLength(6);
  });

  it('orders occurredAt desc, eventId desc across kinds; equal timestamps page stably', async () => {
    const c = await counter(world, 'FeedOrden');
    const s = await sale(c, { totalCents: 100_000 });
    const T = at('2026-03-15T18:00:00.000Z');
    const T1 = at('2026-03-15T18:00:01.000Z');
    const same = [
      await pay(c, s.id, T, 100, 'TRANSFER'),
      await pay(c, s.id, T, 100, 'TRANSFER'),
      await pay(c, s.id, T, 100, 'TRANSFER'),
      await pay(c, s.id, T, 100, 'TRANSFER'),
    ];
    const newer = [
      await pay(c, s.id, T1, 100, 'TRANSFER'),
      await pay(c, s.id, T1, 100, 'TRANSFER'),
    ];
    // A collection created at T whose rows carry a later instant: the event
    // sorts by the collection's createdAt.
    const collectionId = randomUUID();
    await prisma.saleCollection.create({
      data: {
        id: collectionId,
        tenantId: c.tenantId,
        customerId: c.customerId,
        actorUserId: c.member.userId,
        cashSessionId: c.sessionId,
        tenderedCents: 500,
        appliedCents: 500,
        changeDueCents: 0,
        tendersJson: [{ method: 'transfer', amountCents: 500, catalog: null }],
        createdAt: T,
      },
    });
    await pay(c, s.id, at('2026-03-20T18:00:00.000Z'), 300, 'TRANSFER', {
      collectionId,
    });
    await pay(c, s.id, at('2026-03-20T18:00:00.000Z'), 200, 'TRANSFER', {
      collectionId,
    });

    const desc = (ids: string[]) => [...ids].sort().reverse();
    const expected = [...desc(newer), ...desc([...same, collectionId])];
    const pages: string[][] = [];
    for (const page of [1, 2, 3]) {
      const res = await feed(c.member, c.customerId, `?page=${page}&limit=3`);
      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page,
        limit: 3,
        total: 7,
        totalPages: 3,
      });
      pages.push(res.body.data.map((e: any) => e.eventId));
    }

    expect(pages.flat()).toEqual(expected);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const collection = (await feed(c.member, c.customerId)).body.data.find(
      (e: any) => e.eventId === collectionId,
    );
    expect(collection).toMatchObject({
      kind: 'collection',
      occurredAt: T.toISOString(),
      amountCents: 500,
      sales: [
        {
          saleId: s.id,
          folio: s.folio,
          status: 'CONFIRMED',
          appliedCents: 500,
        },
      ],
    });
    const past = await feed(c.member, c.customerId, '?page=4&limit=3');
    expect(past.status).toBe(200);
    expect(past.body).toEqual({
      data: [],
      pagination: { page: 4, limit: 3, total: 7, totalPages: 3 },
    });
  });

  it('a customer without payments answers an empty page', async () => {
    const c = await counter(world, 'FeedVacio');

    const res = await feed(c.member, c.customerId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  });

  it('unknown or foreign-tenant customer → 404 CUSTOMER_NOT_FOUND (code-only); tenants never mix', async () => {
    const a = await counter(world, 'FeedA');
    const b = await counter(world, 'FeedB');
    const s = await sale(b, { totalCents: 1000 });
    await pay(b, s.id, at('2026-03-15T18:00:00.000Z'), 1000);
    const body = {
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    };

    const foreign = await feed(a.member, b.customerId);
    const unknown = await feed(a.member, randomUUID());
    const own = await feed(a.member, a.customerId);

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(body);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(body);
    expect(own.body.pagination.total).toBe(0);
    expect((await feed(b.member, b.customerId)).body.pagination.total).toBe(1);
  });

  it('validation and permission: non-UUID 400, bad page/limit or unknown param 400, without read:Sale 403', async () => {
    const c = await counter(world, 'FeedValida');
    const noSale = await world.member(c.tenantId, 'Sin ventas', [
      'Customer:read',
    ]);

    expect((await feed(c.member, 'not-a-uuid')).status).toBe(400);
    for (const query of [
      '?limit=101',
      '?limit=0',
      '?page=0',
      '?page=x',
      '?foo=1',
    ]) {
      expect([
        query,
        (await feed(c.member, c.customerId, query)).status,
      ]).toEqual([query, 400]);
    }
    expect((await feed(c.member, c.customerId, '?limit=100')).status).toBe(200);
    expect((await feed(noSale, c.customerId)).status).toBe(403);
  });
});
