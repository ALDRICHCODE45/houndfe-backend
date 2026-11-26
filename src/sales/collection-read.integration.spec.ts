/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped JSON */
/**
 * customer-collection / T3 (S5) — `GET /collections/:collectionId` and
 * `GET /collections/:collectionId/pdf?format=ticket|a4` against REAL
 * PostgreSQL (real JWT → tenant → CASL chain, production pipe + filters, the
 * real collection writer and `PrismaCollectionReader`). Contract v1 §1, §6,
 * §7, §8; owner Q5.
 *
 * Due dates are chosen so `overdue` is the same with the writer's pinned
 * clock (2026-11-25) and with the collection's real `createdAt` day:
 * 2026-11-01 (always past) and 2099-12-10 (always future).
 */
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
} from '../delivery-zones/test-support/delivery-zone-world';
import {
  counter,
  createCollectionTestApp,
  routes,
  seedCustomer,
  seedSale,
  type Counter,
} from './test-support/customer-collection-world';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('GET /collections/:id and its receipt PDF (PostgreSQL)', () => {
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

  interface Collected extends Counter {
    A: string;
    B: string;
    C: string;
    post: { status: number; body: any };
  }

  /**
   * A 300 (due 2026-11-01, overdue), B 700 with 200 paid (due 2099-12-10),
   * C 400 (no due date) + another customer's sale; card_debit 600 + cash 400
   * on a 1200 debt → A ← card 300; B ← card 300 + cash 200; C ← cash 100,
   * C stays with 300 (no change; cash covers part of C).
   */
  async function collected(name: string, cash = 300): Promise<Collected> {
    const c = await counter(world, name);
    const u = c.member.userId;
    const A = await seedSale(c.tenantId, u, c.customerId, {
      totalCents: 300,
      dueDate: '2026-11-01',
      confirmedAt: '2026-10-05T15:00:00.000Z',
    });
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
    await seedSale(c.tenantId, u, other, { totalCents: 100 });
    const post = await api.collect(c.member, c.customerId, {
      cashSessionId: c.sessionId,
      payments: [
        { method: 'card_debit', amountCents: 600 },
        { method: 'cash', amountCents: cash },
      ],
    });
    expect(post.status).toBe(201);
    return { ...c, A, B, C, post };
  }

  const withStatus = (body: any, status: Record<string, string> = {}) => ({
    ...body,
    sales: body.sales.map((sale: any) => ({
      ...sale,
      saleStatus: status[sale.saleId] ?? 'CONFIRMED',
    })),
  });

  // ─────────────────────────────── JSON read ───────────────────────────────

  describe('GET /collections/:collectionId', () => {
    it('answers the POST response (+ saleStatus) for a fresh collection', async () => {
      const e = await collected('Leer');

      const res = await api.read(e.member, e.post.body.collectionId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(withStatus(e.post.body));
      // Sanity of the example itself (POST order, partial last, overdue).
      expect(
        res.body.sales.map((s: any) => [
          s.saleId,
          s.appliedCents,
          s.debtCents,
          s.overdue,
          s.paymentIds.length,
        ]),
      ).toEqual([
        [e.A, 300, 0, true, 1],
        [e.B, 500, 0, false, 2],
        [e.C, 100, 300, false, 1],
      ]);
      expect(res.body.remainingCustomerDebtCents).toBe(300);
    });

    it('keeps the balances of the collection moment after a later payment', async () => {
      const e = await collected('LeerDespues');
      const later = await api.pay(e.member, e.C, {
        cashSessionId: e.sessionId,
        payments: [{ method: 'cash', amountCents: 50 }],
      });
      expect(later.status).toBe(201);

      const res = await api.read(e.member, e.post.body.collectionId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(withStatus(e.post.body));
    });

    it('a sale cancelled afterwards reads saleStatus CANCELED, balances unchanged', async () => {
      const e = await collected('LeerCancelada');
      const cancel = await api.cancel(e.member, e.B);
      expect(cancel.status).toBe(200);

      const res = await api.read(e.member, e.post.body.collectionId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        withStatus(e.post.body, { [e.B]: 'CANCELED' }),
      );
    });

    it('customer deleted afterwards → customer null, remaining debt null, the rest unchanged', async () => {
      const e = await collected('LeerBorrado');
      const deleted = await api.deleteCustomer(e.member, e.customerId);
      expect(deleted.status).toBe(204);

      const res = await api.read(e.member, e.post.body.collectionId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ...withStatus(e.post.body),
        customer: null,
        remainingCustomerDebtCents: null,
      });
    });

    it('unknown id and another tenant’s collection → 404 COLLECTION_NOT_FOUND (code-only); malformed id → 400', async () => {
      const e = await collected('LeerPropio');
      const stranger = await counter(world, 'LeerAjeno');

      const foreign = await api.read(stranger.member, e.post.body.collectionId);
      const unknown = await api.read(e.member, randomUUID());
      const malformed = await api.read(e.member, 'not-a-uuid');

      for (const res of [foreign, unknown]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          statusCode: 404,
          error: 'COLLECTION_NOT_FOUND',
          message: 'COLLECTION_NOT_FOUND',
        });
      }
      expect(malformed.status).toBe(400);
    });

    it('requires read:Sale', async () => {
      const e = await collected('LeerPermiso');
      const nobody = await world.member(e.tenantId, 'Sin permiso', [
        'Customer:read',
      ]);

      const res = await api.read(nobody, e.post.body.collectionId);

      expect(res.status).toBe(403);
    });

    it('with change: tenders as stored, change kept', async () => {
      // cash 800 → debt 1200 covered by card 600 + cash 600, change 200.
      const e = await collected('LeerCambio', 800);
      expect(e.post.body.changeDueCents).toBe(200);

      const res = await api.read(e.member, e.post.body.collectionId);

      expect(res.body).toEqual(withStatus(e.post.body));
      expect(res.body.remainingCustomerDebtCents).toBe(0);
    });
  });

  // ─────────────────────────────── receipt PDF ───────────────────────────────

  describe('GET /collections/:collectionId/pdf', () => {
    it.each([
      ['', 'default ticket'],
      ['?format=ticket', 'ticket'],
      ['?format=a4', 'a4'],
    ])('%s (%s) → 200 PDF, attachment filename, no-store', async (query) => {
      const e = await collected(`Pdf${randomUUID().slice(0, 6)}`);
      const id = e.post.body.collectionId as string;

      const res = await api.receiptPdf(e.member, id, query);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="comprobante-cobro-${id}.pdf"`,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('renders a cancelled sale and a deleted customer', async () => {
      const e = await collected('PdfCancelada');
      await api.cancel(e.member, e.A);
      await api.deleteCustomer(e.member, e.customerId);

      const res = await api.receiptPdf(
        e.member,
        e.post.body.collectionId,
        '?format=a4',
      );

      expect(res.status).toBe(200);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('invalid format → 400 INVALID_FORMAT; unknown / foreign → 404 COLLECTION_NOT_FOUND', async () => {
      const e = await collected('PdfErrores');
      const stranger = await counter(world, 'PdfAjeno');

      const badFormat = await api.receiptPdf(
        e.member,
        e.post.body.collectionId,
        '?format=receipt-a4',
      );
      const unknown = await api.receiptPdf(e.member, randomUUID());
      const foreign = await api.receiptPdf(
        stranger.member,
        e.post.body.collectionId,
      );

      expect(badFormat.status).toBe(400);
      expect(JSON.parse((badFormat.body as Buffer).toString())).toMatchObject({
        statusCode: 400,
        message: 'INVALID_FORMAT',
      });
      for (const res of [unknown, foreign]) {
        expect(res.status).toBe(404);
        expect(JSON.parse((res.body as Buffer).toString())).toEqual({
          statusCode: 404,
          error: 'COLLECTION_NOT_FOUND',
          message: 'COLLECTION_NOT_FOUND',
        });
      }
    });
  });

  it('never writes: the collection rows are untouched by reads', async () => {
    const e = await collected('SoloLectura');
    const before = await prisma.saleCollection.findMany({
      where: { tenantId: e.tenantId },
    });
    await api.read(e.member, e.post.body.collectionId);
    await api.receiptPdf(e.member, e.post.body.collectionId, '?format=a4');
    expect(
      await prisma.saleCollection.findMany({ where: { tenantId: e.tenantId } }),
    ).toEqual(before);
  });
});
