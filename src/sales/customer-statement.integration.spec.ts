/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest bodies are untyped JSON */
/**
 * sales-history-redesign S11 — `GET /customers/:customerId/statement/pdf`
 * against REAL PostgreSQL through the real JWT → tenant → CASL chain, the
 * production validation pipe and the real `PrismaCustomerStatementReader`.
 *
 * The statement handed to the renderer is captured so the queries are asserted
 * value by value; the renderer itself is the real `PdfGenerationService`
 * method (Yoga is mocked under Jest, so only structure/headers are checked).
 * Mexico City is UTC-6 all year (no DST since 2022): local midnight = 06:00Z.
 */
import { Logger, type INestApplication } from '@nestjs/common';
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
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { CustomerStatementService } from './customer-statement.service';
import { PrismaCustomerStatementReader } from './infrastructure/prisma-customer-statement.reader';
import { SalesCustomerStatementController } from './sales-customer-statement.controller';
import type { CustomerStatementDto } from './dto/customer-statement.dto';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

const HOUR = 3_600_000;
/** UTC instant of 00:00 local (UTC-6) on a `YYYY-MM-DD` local date. */
const mxMidnight = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 6 * HOUR);
const utcMidnight = (date: string) => new Date(`${date}T00:00:00.000Z`);
const FROM = '2026-03-01';
const TO = '2026-04-01';
// Pinned sales clock: 2026-11-25 12:00 in Mexico City.
const NOW = new Date('2026-11-25T18:00:00.000Z');

describeIfDb('Customer statement PDF (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  const rendered: CustomerStatementDto[] = [];

  beforeAll(async () => {
    // Real render method without `onModuleInit` (no font CDN preflight).
    const pdf = Object.create(
      PdfGenerationService.prototype,
    ) as PdfGenerationService;
    Object.assign(pdf, { logger: new Logger('StatementSpec') });
    app = await createZoneTestApp({
      controllers: [SalesCustomerStatementController],
      providers: [
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
              return pdf.renderCustomerStatementPdf(statement);
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
    await app?.close();
    await disconnectWorldPrisma();
  });

  interface Branch {
    tenantId: string;
    member: SeededMember;
    c1: string;
    c2: string;
  }

  async function branch(name: string, grants = ['Sale:read']): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const member = await world.member(tenantId, `Cajero ${name}`, grants);
    const c1 = randomUUID();
    const c2 = randomUUID();
    await prisma.customer.create({
      data: {
        id: c1,
        tenantId,
        firstName: 'Rosa',
        lastName: 'Pérez',
        phoneCountryCode: '+52',
        phone: '5512345678',
        email: 'rosa@example.com',
        rfc: 'PERR800101AAA',
        businessName: 'Rosa SA',
      },
    });
    await prisma.customer.create({
      data: { id: c2, tenantId, firstName: 'Luis' },
    });
    return { tenantId, member, c1, c2 };
  }

  let seq = 0;
  async function sale(
    b: Branch,
    opts: {
      tenantId?: string;
      customerId?: string;
      status?: 'CONFIRMED' | 'CANCELED';
      confirmedAt: Date;
      totalCents?: number;
      debtCents?: number;
      dueDate?: Date | null;
      changeDueCents?: number;
    },
  ): Promise<{ id: string; folio: string }> {
    const id = randomUUID();
    const folio = `E-${++seq}`;
    const total = opts.totalCents ?? 1000;
    const debt = opts.debtCents ?? 0;
    await prisma.sale.create({
      data: {
        id,
        tenantId: opts.tenantId ?? b.tenantId,
        userId: b.member.userId,
        customerId: opts.customerId ?? b.c1,
        status: opts.status ?? 'CONFIRMED',
        channel: 'POS',
        folio,
        confirmedAt: opts.confirmedAt,
        canceledAt: opts.status === 'CANCELED' ? opts.confirmedAt : null,
        subtotalCents: total,
        totalCents: total,
        paidCents: total - debt,
        debtCents: debt,
        changeDueCents: opts.changeDueCents ?? 0,
        paymentStatus:
          debt === 0 ? 'PAID' : debt === total ? 'CREDIT' : 'PARTIAL',
        dueDate: opts.dueDate ?? null,
      },
    });
    return { id, folio };
  }

  async function pay(
    b: Branch,
    saleId: string,
    createdAt: Date,
    amountCents: number,
    method: 'CASH' | 'CARD_CREDIT' | 'CARD_DEBIT' | 'TRANSFER' = 'CASH',
    extra: { tenantId?: string; metadataJson?: object } = {},
  ): Promise<string> {
    const row = await prisma.salePayment.create({
      data: {
        saleId,
        tenantId: extra.tenantId ?? b.tenantId,
        method,
        amountCents,
        createdAt,
        ...(extra.metadataJson ? { metadataJson: extra.metadataJson } : {}),
      },
    });
    return row.id;
  }

  const auth = (m: SeededMember) => ({ Authorization: `Bearer ${m.token}` });
  const statementPdf = (
    b: Branch,
    customerId: string,
    query = `?from=${FROM}&to=${TO}`,
  ) =>
    request(server())
      .get(`/customers/${customerId}/statement/pdf${query}`)
      .set(auth(b.member));

  it('period sales: CONFIRMED by confirmedAt in local [from, to), other customers, tenants and CANCELED excluded', async () => {
    const b = await branch('EdoA');
    const other = await branch('EdoB');
    const first = await sale(b, { confirmedAt: mxMidnight(FROM) });
    const last = await sale(b, {
      confirmedAt: new Date(mxMidnight(TO).getTime() - 1),
      totalCents: 5000,
      debtCents: 3000,
      dueDate: utcMidnight('2026-11-24'),
    });
    await sale(b, { confirmedAt: new Date(mxMidnight(FROM).getTime() - 1) });
    await sale(b, { confirmedAt: mxMidnight(TO) });
    await sale(b, { customerId: b.c2, confirmedAt: mxMidnight('2026-03-10') });
    await sale(b, {
      status: 'CANCELED',
      confirmedAt: mxMidnight('2026-03-11'),
    });
    // Foreign tenant row pointing at this customer id: never read.
    await sale(b, {
      tenantId: other.tenantId,
      confirmedAt: mxMidnight('2026-03-12'),
    });

    await statementPdf(b, b.c1).expect(200);
    const [statement] = rendered;

    expect(statement.sales.map((s) => s.id)).toEqual([first.id, last.id]);
    expect(statement.sales.map((s) => s.localDate)).toEqual([
      '2026-03-01',
      '2026-03-31',
    ]);
    expect(statement.sales[1]).toMatchObject({
      folio: last.folio,
      totalCents: 5000,
      paidCents: 2000,
      openDebtCents: 3000,
      dueDate: '2026-11-24',
      paymentStatus: 'PARTIAL',
      paymentStatusLabel: 'Impaga',
      overdue: true,
    });
    expect(statement.periodTotals).toEqual({
      saleCount: 2,
      totalCents: 6000,
      paidCents: 3000,
      openDebtCents: 3000,
      overdueSaleCount: 1,
      overdueDebtCents: 3000,
    });
    expect(statement.customer).toEqual({
      id: b.c1,
      name: 'Rosa Pérez',
      phone: '+52 5512345678',
      email: 'rosa@example.com',
      rfc: 'PERR800101AAA',
      businessName: 'Rosa SA',
    });
    expect(statement.branchName).toBe('EdoA');
    expect(statement.today).toBe('2026-11-25');
  });

  it('current debt: every CONFIRMED open-debt sale (older too), overdue by the S3 rule; CANCELED and other customers ignored', async () => {
    const b = await branch('EdoDeuda');
    await sale(b, {
      confirmedAt: new Date('2025-01-10T18:00:00.000Z'),
      totalCents: 9000,
      debtCents: 9000,
      dueDate: utcMidnight('2025-01-25'),
    });
    // due on the local today → not overdue yet
    await sale(b, {
      confirmedAt: new Date('2026-11-10T18:00:00.000Z'),
      totalCents: 4000,
      debtCents: 1500,
      dueDate: utcMidnight('2026-11-25'),
    });
    await sale(b, {
      confirmedAt: new Date('2026-11-11T18:00:00.000Z'),
      totalCents: 700,
      debtCents: 700,
    });
    await sale(b, {
      status: 'CANCELED',
      confirmedAt: new Date('2025-02-10T18:00:00.000Z'),
      totalCents: 5000,
      debtCents: 5000,
      dueDate: utcMidnight('2025-02-25'),
    });
    await sale(b, {
      customerId: b.c2,
      confirmedAt: new Date('2025-01-10T18:00:00.000Z'),
      debtCents: 1000,
      dueDate: utcMidnight('2025-01-25'),
    });

    await statementPdf(b, b.c1).expect(200);
    const [statement] = rendered;

    expect(statement.sales).toEqual([]);
    expect(statement.currentDebt).toEqual({
      saleCount: 3,
      openDebtCents: 11_200,
      overdueSaleCount: 1,
      overdueDebtCents: 9000,
    });
  });

  it('payments: rows of the customer sales paid in local [from, to), canceled sales marked, catalog labels, cash net of change', async () => {
    const b = await branch('EdoPagos');
    const other = await branch('EdoPagosB');
    const old = await sale(b, {
      confirmedAt: new Date('2025-12-01T18:00:00.000Z'),
      totalCents: 9000,
      debtCents: 0,
    });
    const canceled = await sale(b, {
      status: 'CANCELED',
      confirmedAt: mxMidnight('2026-03-05'),
      totalCents: 2000,
    });
    const change = await sale(b, {
      confirmedAt: mxMidnight('2026-03-06'),
      totalCents: 4500,
      changeDueCents: 500,
    });
    const otherCustomer = await sale(b, {
      customerId: b.c2,
      confirmedAt: mxMidnight('2026-03-06'),
    });

    const p1 = await pay(b, old.id, mxMidnight(FROM), 3000, 'TRANSFER');
    const p2 = await pay(
      b,
      canceled.id,
      mxMidnight('2026-03-05'),
      2000,
      'CARD_DEBIT',
      {
        metadataJson: {
          catalog: { paymentMethodId: 'pm-1', name: 'Terminal BBVA' },
        },
      },
    );
    const p3 = await pay(b, change.id, mxMidnight('2026-03-06'), 5000, 'CASH');
    const p4 = await pay(
      b,
      old.id,
      new Date(mxMidnight(TO).getTime() - 1),
      1000,
      'CARD_CREDIT',
    );
    await pay(b, old.id, new Date(mxMidnight(FROM).getTime() - 1), 999);
    await pay(b, old.id, mxMidnight(TO), 999);
    await pay(b, otherCustomer.id, mxMidnight('2026-03-07'), 999);
    // Payment row of a foreign tenant on this tenant's sale id: never read.
    await pay(b, old.id, mxMidnight('2026-03-08'), 999, 'CASH', {
      tenantId: other.tenantId,
    });
    // A refund obligation of the canceled sale is not a payment row.
    await prisma.saleRefund.create({
      data: {
        tenantId: b.tenantId,
        saleId: canceled.id,
        method: 'CARD_DEBIT',
        amountCents: 2000,
        reason: 'CUSTOMER_REQUEST',
      },
    });

    await statementPdf(b, b.c1).expect(200);
    const [statement] = rendered;

    expect(
      statement.payments.map((p) => [
        p.id,
        p.localDate,
        p.methodLabel,
        p.amountCents,
        p.saleFolio,
        p.saleCanceled,
      ]),
    ).toEqual([
      [p1, '2026-03-01', 'Transferencia', 3000, old.folio, false],
      [p2, '2026-03-05', 'Terminal BBVA', 2000, canceled.folio, true],
      [p3, '2026-03-06', 'Efectivo', 4500, change.folio, false],
      [p4, '2026-03-31', 'Tarjeta de crédito', 1000, old.folio, false],
    ]);
    expect(statement.payments[2]).toMatchObject({
      tenderedCents: 5000,
      changeCents: 500,
    });
    expect(statement.paymentsTotalCents).toBe(10_500);
    // The canceled sale stays out of the sales list.
    expect(statement.sales.map((s) => s.id)).toEqual([change.id]);
  });

  it('unknown or foreign-tenant customer → 404 CUSTOMER_NOT_FOUND (code-only), nothing rendered', async () => {
    const a = await branch('EdoNoA');
    const other = await branch('EdoNoB');
    const body = {
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    };

    expect((await statementPdf(a, randomUUID()).expect(404)).body).toEqual(
      body,
    );
    expect((await statementPdf(a, other.c1).expect(404)).body).toEqual(body);
    expect(rendered).toHaveLength(0);
  });

  it('returns the PDF attachment with the fixed filename and no-store', async () => {
    const b = await branch('EdoHttp');
    await sale(b, { confirmedAt: mxMidnight('2026-03-02') });

    const res = await statementPdf(b, b.c1)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="estado-de-cuenta-${b.c1}-${FROM}-${TO}.pdf"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it.each([
    '?from=2026-03-01',
    '?from=2026-03-01&to=2026-03-01',
    '?from=2026-03-02&to=2026-03-01',
    '?from=2025-01-01&to=2026-01-03',
    '?from=2026-02-30&to=2026-03-05',
    '?from=03-01-2026&to=2026-03-05',
  ])('rejects %s with 400', async (query) => {
    const b = await branch(`EdoQ-${randomUUID().slice(0, 4)}`);
    await statementPdf(b, b.c1, query).expect(400);
    expect(rendered).toHaveLength(0);
  });

  it('a non-uuid customer id is 400; without read:Sale it is 403', async () => {
    const b = await branch('EdoPerm');
    await statementPdf(b, 'not-a-uuid').expect(400);

    const noSale = await branch('EdoSinPermiso', ['Customer:read']);
    await statementPdf(noSale, noSale.c1).expect(403);
  });
});
