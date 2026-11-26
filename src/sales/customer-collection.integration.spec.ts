/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped JSON */
/**
 * customer-collection / T2 (S2, S3, S4) — «Cobrar todo» against REAL
 * PostgreSQL through `POST /customers/:customerId/collections(/preview)` (real
 * JWT → tenant → CASL chain, production pipe + DomainExceptionFilter), the
 * real sale repository and writer, the real cash ledger bound to an OPEN
 * session, and the outbox. Contract v1 §2–§6, §8, §10; owner Q1–Q4, Q6, Q7.
 */
import type { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
} from '../delivery-zones/test-support/delivery-zone-world';
import { sortPaymentsForHash } from './sales.service';
import {
  counter,
  createCollectionTestApp,
  moneyRows,
  routes,
  seedCustomer,
  seedSale,
  type Counter,
} from './test-support/customer-collection-world';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('«Cobrar todo» customer collection (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const world = new ZoneWorld();
  let app: INestApplication;
  const api = routes(() => app);

  beforeAll(async () => {
    app = await createCollectionTestApp();
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  interface Example extends Counter {
    A: string;
    B: string;
    C: string;
  }

  /**
   * §3 example: A 300 (due 2026-11-01, overdue), B 500 (due 2026-12-10, 200
   * already paid of 700), C 400 (no due date). Noise that is never a
   * candidate: a PAID sale, a CANCELED sale with debt, another customer's
   * sale and a sale without customer.
   */
  async function example(name: string): Promise<Example> {
    const c = await counter(world, name);
    const u = c.member.userId;
    const C = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 400,
      confirmedAt: '2026-10-03T15:00:00.000Z',
    });
    const B = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 700,
      paidCents: 200,
      dueDate: '2026-12-10',
    });
    const A = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 300,
      dueDate: '2026-11-01',
      confirmedAt: '2026-10-05T15:00:00.000Z',
    });
    await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 900,
      paidCents: 900,
    });
    await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 800,
      status: 'CANCELED',
    });
    const other = await seedCustomer(c.tenantId, 'Otro', null);
    await seedSale(c.tenantId, u, other, { totalCents: 100 });
    await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 100,
      customerId: null,
    });
    return { ...c, A, B, C };
  }

  const tenders = (...pairs: Array<[string, number]>) =>
    pairs.map(([method, amountCents]) => ({ method, amountCents }));

  // ─────────────────────────────── preview ───────────────────────────────

  describe('POST …/collections/preview', () => {
    it('returns the §6 shape: every candidate in Q1 order (incl. 0), overdue before, GET /sales strings, nothing written', async () => {
      const e = await example('Preview');
      const before = await moneyRows(e.tenantId);

      const res = await api.preview(e.member, e.customerId, {
        payments: tenders(['card_debit', 600]),
      });

      expect(res.status).toBe(200);
      const saleRow = async (id: string) =>
        prisma.sale.findUniqueOrThrow({ where: { id } });
      const [a, b, c] = await Promise.all([
        saleRow(e.A),
        saleRow(e.B),
        saleRow(e.C),
      ]);
      expect(res.body).toEqual({
        customer: { id: e.customerId, name: 'Ana López' },
        debtCents: 1200,
        tenderedCents: 600,
        appliedCents: 600,
        changeDueCents: 0,
        payments: [{ method: 'card_debit', amountCents: 600, catalog: null }],
        sales: [
          {
            saleId: e.A,
            folio: a.folio,
            confirmedAt: a.confirmedAt!.toISOString(),
            dueDate: '2026-11-01T00:00:00.000Z',
            overdue: true,
            appliedCents: 300,
            paidCents: 300,
            debtCents: 0,
            paymentStatus: 'PAID',
          },
          {
            saleId: e.B,
            folio: b.folio,
            confirmedAt: b.confirmedAt!.toISOString(),
            dueDate: '2026-12-10T00:00:00.000Z',
            overdue: false,
            appliedCents: 300,
            paidCents: 500,
            debtCents: 200,
            paymentStatus: 'PARTIAL',
          },
          {
            saleId: e.C,
            folio: c.folio,
            confirmedAt: c.confirmedAt!.toISOString(),
            dueDate: null,
            overdue: false,
            appliedCents: 0,
            paidCents: 0,
            debtCents: 400,
            paymentStatus: 'CREDIT',
          },
        ],
        remainingCustomerDebtCents: 600,
      });
      expect(await moneyRows(e.tenantId)).toEqual(before);
    });

    it('accepts no tenders (shows the debt) and an explicit selection', async () => {
      const e = await example('PreviewSel');

      const empty = await api.preview(e.member, e.customerId, {});
      expect(empty.status).toBe(200);
      expect(empty.body.debtCents).toBe(1200);
      expect(empty.body.sales.map((s: any) => s.appliedCents)).toEqual([
        0, 0, 0,
      ]);

      const sel = await api.preview(e.member, e.customerId, {
        saleIds: [e.C],
        payments: tenders(['cash', 100]),
      });
      expect(sel.status).toBe(200);
      expect(
        sel.body.sales.map((s: any) => [s.saleId, s.appliedCents]),
      ).toEqual([[e.C, 100]]);
      expect(sel.body.remainingCustomerDebtCents).toBe(1100);
    });
  });

  // ──────────────────────────────── apply ────────────────────────────────

  describe('POST …/collections', () => {
    it('applies card 600 + cash 300: per-sale rows, balances, cash movements, collection row, events, idempotency', async () => {
      const e = await example('Cobro');

      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        expectedDebtCents: 1200,
        payments: tenders(['card_debit', 600], ['cash', 300]),
      });

      expect(res.status).toBe(201);
      const collectionId = res.body.collectionId as string;
      expect(res.body).toMatchObject({
        customer: { id: e.customerId, name: 'Ana López' },
        tenderedCents: 900,
        appliedCents: 900,
        changeDueCents: 0,
        payments: [
          { method: 'card_debit', amountCents: 600, catalog: null },
          { method: 'cash', amountCents: 300, catalog: null },
        ],
        remainingCustomerDebtCents: 300,
      });
      expect(
        res.body.sales.map((s: any) => [
          s.saleId,
          s.appliedCents,
          s.paidCents,
          s.debtCents,
          s.paymentStatus,
          s.overdue,
          s.paymentIds.length,
        ]),
      ).toEqual([
        [e.A, 300, 300, 0, 'PAID', true, 1],
        [e.B, 500, 700, 0, 'PAID', false, 2],
        [e.C, 100, 100, 300, 'PARTIAL', false, 1],
      ]);

      const rows = await moneyRows(e.tenantId);
      const sale = (id: string) => rows.sales.find((s) => s.id === id)!;
      expect(
        [e.A, e.B, e.C].map((id) => [
          sale(id).paidCents,
          sale(id).debtCents,
          sale(id).openDebtCents,
          sale(id).paymentStatus,
        ]),
      ).toEqual([
        [300, 0, 0, 'PAID'],
        [700, 0, 0, 'PAID'],
        [100, 300, 300, 'PARTIAL'],
      ]);

      const collected = rows.payments.filter(
        (p) => p.collectionId === collectionId,
      );
      expect(
        collected
          .map((p) => [p.saleId, p.method, p.amountCents, p.userId])
          .sort((x, y) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`)),
      ).toEqual(
        [
          [e.A, 'CARD_DEBIT', 300, e.member.userId],
          [e.B, 'CARD_DEBIT', 300, e.member.userId],
          [e.B, 'CASH', 200, e.member.userId],
          [e.C, 'CASH', 100, e.member.userId],
        ].sort((x, y) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`)),
      );
      expect(res.body.sales.flatMap((s: any) => s.paymentIds).sort()).toEqual(
        collected.map((p) => p.id).sort(),
      );

      expect(rows.collections).toEqual([
        expect.objectContaining({
          id: collectionId,
          customerId: e.customerId,
          actorUserId: e.member.userId,
          cashSessionId: e.sessionId,
          tenderedCents: 900,
          appliedCents: 900,
          changeDueCents: 0,
          tendersJson: [
            { method: 'card_debit', amountCents: 600, catalog: null },
            { method: 'cash', amountCents: 300, catalog: null },
          ],
        }),
      ]);
      expect(res.body.createdAt).toBe(
        rows.collections[0].createdAt.toISOString(),
      );

      // One SALE_PAYMENT per payment row (source = payment id), no change.
      expect(rows.movements).toHaveLength(4);
      expect(rows.movements.every((m) => m.kind === 'SALE_PAYMENT')).toBe(true);
      expect(rows.movements.map((m) => m.sourceId).sort()).toEqual(
        collected.map((p) => p.id).sort(),
      );
      expect(
        rows.movements
          .filter((m) => m.method === 'CASH')
          .reduce((sum, m) => sum + m.deltaCents, 0),
      ).toBe(300);

      const types = rows.outbox.map((o) => o.eventType);
      expect(types.filter((t) => t === 'sale.payment.received')).toHaveLength(
        4,
      );
      expect(types.filter((t) => t === 'sale.fully.paid')).toHaveLength(2);
      expect(
        types.filter((t) => t === 'customer.collection.recorded'),
      ).toHaveLength(1);
      const recorded = rows.outbox.find(
        (o) => o.eventType === 'customer.collection.recorded',
      )!;
      expect(recorded).toMatchObject({
        aggregateType: 'SaleCollection',
        aggregateId: collectionId,
      });
      expect(
        rows.outbox
          .filter((o) => o.eventType === 'sale.payment.received')
          .every((o) => (o.payload as any).collectionId === collectionId),
      ).toBe(true);

      expect(rows.idempotency).toEqual([
        expect.objectContaining({
          operation: 'customer_collection',
          status: 'SUCCEEDED',
          saleId: null,
        }),
      ]);
    });

    it('applies an explicit selection: only the selected sales, remainingCustomerDebtCents counts the rest', async () => {
      const e = await example('Seleccion');

      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        saleIds: [e.C, e.A],
        expectedDebtCents: 700,
        payments: tenders(['cash', 500]),
      });

      expect(res.status).toBe(201);
      expect(
        res.body.sales.map((s: any) => [s.saleId, s.appliedCents, s.debtCents]),
      ).toEqual([
        [e.A, 300, 0],
        [e.C, 200, 200],
      ]);
      expect(res.body.remainingCustomerDebtCents).toBe(700);
      const rows = await moneyRows(e.tenantId);
      expect(rows.sales.find((s) => s.id === e.B)!.paidCents).toBe(200);
    });

    it('Q4: collects a sale charged by ANOTHER cashier (no own-POS-sale rule)', async () => {
      const c = await counter(world, 'OtraCajera');
      const other = await world.member(c.tenantId, 'Otro cajero', [
        'Sale:update',
      ]);
      const saleId = await seedSale(c.tenantId, other.userId, c.customerId, {
        totalCents: 500,
      });

      const res = await api.collect(c.member, c.customerId, {
        cashSessionId: c.sessionId,
        payments: tenders(['transfer', 500]),
      });

      expect(res.status).toBe(201);
      expect(res.body.sales).toEqual([
        expect.objectContaining({ saleId, paymentStatus: 'PAID' }),
      ]);
    });

    it('gives change from cash: SALE_CHANGE for the collection, payment rows hold the applied amount, drawer nets the applied cash', async () => {
      const e = await example('Cambio');

      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        payments: tenders(['card_credit', 1000], ['cash', 500]),
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        tenderedCents: 1500,
        appliedCents: 1200,
        changeDueCents: 300,
        remainingCustomerDebtCents: 0,
      });
      const rows = await moneyRows(e.tenantId);
      const cashRows = rows.payments.filter(
        (p) => p.collectionId && p.method === 'CASH',
      );
      expect(cashRows.reduce((sum, p) => sum + p.amountCents, 0)).toBe(200);
      const change = rows.movements.filter((m) => m.kind === 'SALE_CHANGE');
      expect(change).toEqual([
        expect.objectContaining({
          sourceType: 'SALE',
          sourceId: res.body.collectionId,
          deltaCents: -300,
          method: 'CASH',
        }),
      ]);
      expect(
        rows.movements
          .filter((m) => m.method === 'CASH')
          .reduce((sum, m) => sum + m.deltaCents, 0),
      ).toBe(200);
      // the change lives on the collection, never on a sale
      expect(rows.collections[0].changeDueCents).toBe(300);
      expect(rows.sales.every((s) => s.changeDueCents === 0)).toBe(true);
    });

    it('replays the same key + body with 200 and the stored response, writing nothing more', async () => {
      const e = await example('Replay');
      const key = randomUUID();
      const body = {
        cashSessionId: e.sessionId,
        payments: tenders(['cash', 300]),
      };

      const first = await api.collect(e.member, e.customerId, body, key);
      expect(first.status).toBe(201);
      const afterFirst = await moneyRows(e.tenantId);

      const replay = await api.collect(e.member, e.customerId, body, key);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(await moneyRows(e.tenantId)).toEqual(afterFirst);
    });

    it('answers 409 IDEMPOTENCY_KEY_CONFLICT for the same key with another body', async () => {
      const e = await example('Conflicto');
      const key = randomUUID();
      await api
        .collect(
          e.member,
          e.customerId,
          { cashSessionId: e.sessionId, payments: tenders(['cash', 300]) },
          key,
        )
        .expect(201);

      const res = await api.collect(
        e.member,
        e.customerId,
        { cashSessionId: e.sessionId, payments: tenders(['cash', 301]) },
        key,
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('answers 409 IDEMPOTENCY_KEY_IN_FLIGHT while the same request is still in flight, writing nothing', async () => {
      const e = await example('EnVuelo');
      const key = randomUUID();
      const payments = tenders(['cash', 300]);
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            customerId: e.customerId,
            actorId: e.member.userId,
            payments: sortPaymentsForHash(payments as never),
            cashSessionId: e.sessionId,
          }),
        )
        .digest('hex');
      await prisma.saleIdempotency.create({
        data: {
          tenantId: e.tenantId,
          operation: 'customer_collection',
          key,
          requestHash,
          status: 'IN_FLIGHT',
        },
      });

      const res = await api.collect(
        e.member,
        e.customerId,
        { cashSessionId: e.sessionId, payments },
        key,
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_IN_FLIGHT' });
      const rows = await moneyRows(e.tenantId);
      expect(rows.collections).toEqual([]);
      expect(rows.payments.filter((p) => p.collectionId)).toEqual([]);
    });

    it('requires the idempotency-key header (400 IDEMPOTENCY_KEY_REQUIRED)', async () => {
      const e = await example('SinClave');
      const res = await api.collect(
        e.member,
        e.customerId,
        { cashSessionId: e.sessionId, payments: tenders(['cash', 300]) },
        null,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('answers 409 COLLECTION_DEBT_CHANGED with the current preview when expectedDebtCents differs, writing nothing', async () => {
      const e = await example('DeudaCambio');
      const before = await moneyRows(e.tenantId);

      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        expectedDebtCents: 1100,
        payments: tenders(['cash', 300]),
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'COLLECTION_DEBT_CHANGED',
        message: 'COLLECTION_DEBT_CHANGED',
        preview: {
          customer: { id: e.customerId, name: 'Ana López' },
          debtCents: 1200,
          appliedCents: 300,
          remainingCustomerDebtCents: 900,
        },
      });
      expect(res.body.preview.sales.map((s: any) => s.saleId)).toEqual([
        e.A,
        e.B,
        e.C,
      ]);
      expect(await moneyRows(e.tenantId)).toEqual(before);
    });

    it.each([
      ['an excess without cash', tenders(['transfer', 1201])],
      [
        'an excess larger than the cash tendered',
        tenders(['card_debit', 1250], ['cash', 40]),
      ],
    ])(
      'rejects %s with 422 COLLECTION_EXCEEDS_DEBT, writing nothing',
      async (_label, payments) => {
        const e = await example(`Excede${payments.length}`);
        const before = await moneyRows(e.tenantId);

        const res = await api.collect(e.member, e.customerId, {
          cashSessionId: e.sessionId,
          payments,
        });

        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ error: 'COLLECTION_EXCEEDS_DEBT' });
        expect(await moneyRows(e.tenantId)).toEqual(before);
      },
    );

    it('rejects a missing cash session with 422 CASH_SESSION_REQUIRED (no slot)', async () => {
      const e = await example('SinCaja');
      const res = await api.collect(e.member, e.customerId, {
        payments: tenders(['cash', 300]),
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        statusCode: 422,
        error: 'CASH_SESSION_REQUIRED',
        message: 'CASH_SESSION_REQUIRED',
      });
      expect((await moneyRows(e.tenantId)).idempotency).toEqual([]);
    });

    // Contract §10 lists 403; the shared DomainExceptionFilter answers every
    // cash-session violation with 422 today (same as POST /sales/:id/payments).
    it("rejects another cashier's session with CASH_SESSION_NOT_OWNED (422, as the single-sale route), rolling the slot back", async () => {
      const e = await example('CajaAjena');
      const other = await world.member(e.tenantId, 'Otra', ['Sale:update']);
      const res = await api.collect(other, e.customerId, {
        cashSessionId: e.sessionId,
        payments: tenders(['cash', 300]),
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'CASH_SESSION_NOT_OWNED' });
      expect((await moneyRows(e.tenantId)).idempotency).toEqual([]);
    });

    it('rejects a selected sale of ANOTHER tenant with 422 COLLECTION_SALE_NOT_ELIGIBLE (its id), writing nothing in either tenant', async () => {
      const e = await example('SelPropia');
      const foreign = await example('SelAjena');
      const beforeOwn = await moneyRows(e.tenantId);
      const beforeForeign = await moneyRows(foreign.tenantId);

      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        saleIds: [e.A, foreign.A],
        payments: tenders(['cash', 100]),
      });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'COLLECTION_SALE_NOT_ELIGIBLE',
        saleId: foreign.A,
      });
      expect(await moneyRows(e.tenantId)).toEqual(beforeOwn);
      expect(await moneyRows(foreign.tenantId)).toEqual(beforeForeign);
    });

    it('rejects a cash session of ANOTHER tenant with 422 CASH_SESSION_NOT_FOUND, writing nothing in either tenant', async () => {
      const e = await example('CajaPropia');
      const foreign = await example('CajaOtroTenant');
      const beforeOwn = await moneyRows(e.tenantId);
      const beforeForeign = await moneyRows(foreign.tenantId);

      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: foreign.sessionId,
        payments: tenders(['cash', 300]),
      });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'CASH_SESSION_NOT_FOUND' });
      expect(await moneyRows(e.tenantId)).toEqual(beforeOwn);
      expect(await moneyRows(foreign.tenantId)).toEqual(beforeForeign);
    });

    it('answers 404 CUSTOMER_NOT_FOUND for a customer of another tenant (preview and apply)', async () => {
      const e = await example('Propia');
      const foreign = await example('Ajena');

      const preview = await api.preview(e.member, foreign.customerId, {});
      expect(preview.status).toBe(404);
      expect(preview.body).toMatchObject({ error: 'CUSTOMER_NOT_FOUND' });

      const res = await api.collect(e.member, foreign.customerId, {
        cashSessionId: e.sessionId,
        payments: tenders(['cash', 300]),
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'CUSTOMER_NOT_FOUND' });
      expect(
        (await moneyRows(foreign.tenantId)).payments.filter(
          (p) => p.collectionId,
        ),
      ).toEqual([]);
      expect((await moneyRows(e.tenantId)).idempotency).toEqual([]);
    });

    it('answers 422 COLLECTION_NO_OPEN_DEBT for a customer that owes nothing', async () => {
      const c = await counter(world, 'SinDeuda');
      await seedSale(c.tenantId, c.member.userId, c.customerId, {
        totalCents: 500,
        paidCents: 500,
      });
      const res = await api.collect(c.member, c.customerId, {
        cashSessionId: c.sessionId,
        payments: tenders(['cash', 100]),
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'COLLECTION_NO_OPEN_DEBT' });
    });

    it('answers 422 COLLECTION_SALE_NOT_ELIGIBLE with the id of a selected sale of another customer', async () => {
      const e = await example('NoElegible');
      const other = await seedCustomer(e.tenantId, 'Otro', null);
      const foreignSale = await seedSale(e.tenantId, e.member.userId, other, {
        totalCents: 100,
      });
      const res = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        saleIds: [e.A, foreignSale],
        payments: tenders(['cash', 100]),
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'COLLECTION_SALE_NOT_ELIGIBLE',
        saleId: foreignSale,
      });
    });

    it('validates the body: more than 5 tenders or 50 sales is a 400', async () => {
      const e = await example('Validacion');
      const six = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        payments: Array.from({ length: 6 }, () => ({
          method: 'cash',
          amountCents: 1,
        })),
      });
      expect(six.status).toBe(400);
      const many = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        saleIds: Array.from({ length: 51 }, () => randomUUID()),
        payments: tenders(['cash', 1]),
      });
      expect(many.status).toBe(400);
    });
  });

  // ───────────────────────── cancellation afterwards ─────────────────────────

  describe('cancelling a collected sale afterwards (§8)', () => {
    it("refunds only that sale's payment rows method by method; the collection, its change and the other sales stay", async () => {
      const e = await example('Cancelar');
      const collected = await api.collect(e.member, e.customerId, {
        cashSessionId: e.sessionId,
        payments: tenders(['card_credit', 1000], ['cash', 500]),
      });
      expect(collected.status).toBe(201);
      const before = await moneyRows(e.tenantId);

      // C received card 200 + cash 200 from the collection (the change 300 is
      // on the collection, not on C).
      const res = await api.cancel(e.member, e.C);
      expect(res.status).toBe(200);

      const after = await moneyRows(e.tenantId);
      expect(
        after.refunds.map((r) => [r.saleId, r.method, r.amountCents]).sort(),
      ).toEqual(
        [
          [e.C, 'CARD_CREDIT', 200],
          [e.C, 'CASH', 200],
        ].sort(),
      );
      expect(after.collections).toEqual(before.collections);
      expect(after.movements).toEqual(before.movements);
      expect(after.payments).toEqual(before.payments);
      const sale = (id: string) => after.sales.find((s) => s.id === id)!;
      expect(sale(e.C).status).toBe('CANCELED');
      expect([sale(e.A).status, sale(e.B).status]).toEqual([
        'CONFIRMED',
        'CONFIRMED',
      ]);
    });
  });
});
