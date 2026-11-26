/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped JSON */
/**
 * customer-collection / T2 (S3) — lock order of «Cobrar todo» against REAL
 * PostgreSQL: cash session → customer `FOR KEY SHARE` → the sales the tender
 * reaches `FOR UPDATE ORDER BY id` (T2b: a sale that receives 0 is never
 * locked; a reached sale that changed under the lock answers 409
 * COLLECTION_DEBT_CHANGED), versus
 *   - the single-sale payment (`POST /sales/:id/payments`: session → one sale),
 *   - customer DELETE (customer `FOR UPDATE` → its sales `ORDER BY id`),
 *   - another collection of the same customer.
 *
 * Deterministic handshake, no sleeps (customer-delete-pets-lock pattern): a
 * helper transaction holds ONE sale row lock, the first request starts and is
 * seen blocked by the helper (`pg_blocking_pids`), the second starts and is
 * seen blocked by the helper or the first, then the helper releases. Both
 * complete (never 40P01 / 500), no sale is overpaid and the balances are the
 * ones of the start order. Two cashiers with their own OPEN sessions, so the
 * session lock never serializes the pair by itself.
 */
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import {
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../delivery-zones/test-support/delivery-zone-world';
import {
  COLLECTION_GRANTS,
  createCollectionTestApp,
  moneyRows,
  openSession,
  routes,
  seedCustomer,
  seedSale,
} from './test-support/customer-collection-world';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

describeIfDb('«Cobrar todo» lock order (PostgreSQL)', () => {
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

  // ─────────────────────────────── fixtures ───────────────────────────────

  interface Branch {
    tenantId: string;
    collector: SeededMember;
    collectorSession: string;
    cashier: SeededMember;
    cashierSession: string;
    customerId: string;
    /** Due 2026-11-01, debt 300, the HIGHER id (locked last). */
    A: string;
    /** Due 2026-12-10, debt 500, the LOWER id (locked first). */
    B: string;
  }

  /**
   * Both sales were charged by `cashier` (so the single-sale route may collect
   * them); `collector` collects them through «Cobrar todo» (Q4).
   */
  async function branch(name: string): Promise<Branch> {
    const tenantId = await world.tenant(name);
    const collector = await world.member(
      tenantId,
      `Cobra ${name}`,
      COLLECTION_GRANTS,
    );
    const cashier = await world.member(
      tenantId,
      `Caja ${name}`,
      COLLECTION_GRANTS,
    );
    const collectorSession = await openSession(tenantId, collector);
    const cashierSession = await openSession(tenantId, cashier);
    const customerId = await seedCustomer(tenantId);
    const [low, high] = [randomUUID(), randomUUID()].sort();
    const A = await seedSale(tenantId, cashier.userId, customerId, {
      id: high,
      totalCents: 300,
      dueDate: '2026-11-01',
    });
    const B = await seedSale(tenantId, cashier.userId, customerId, {
      id: low,
      totalCents: 500,
      dueDate: '2026-12-10',
    });
    return {
      tenantId,
      collector,
      collectorSession,
      cashier,
      cashierSession,
      customerId,
      A,
      B,
    };
  }

  const collect = (
    b: Branch,
    who: 'collector' | 'cashier',
    cents: number,
    expectedDebtCents?: number,
  ) =>
    api.collect(b[who], b.customerId, {
      cashSessionId:
        who === 'collector' ? b.collectorSession : b.cashierSession,
      payments: [{ method: 'cash', amountCents: cents }],
      ...(expectedDebtCents === undefined ? {} : { expectedDebtCents }),
    });
  const payA = (b: Branch, cents: number) =>
    api.pay(b.cashier, b.A, {
      cashSessionId: b.cashierSession,
      payments: [{ method: 'cash', amountCents: cents }],
    });

  // ───────────────────────────── handshake tools ─────────────────────────────

  function holdLock(lock: (tx: typeof prisma) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: (pid: number) => void;
    const heldP = new Promise<number>((resolve) => (held = resolve));
    const done = prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid`;
        await lock(tx as unknown as typeof prisma);
        held(pid);
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    return { acquired: heldP, release, done };
  }

  async function waitBlockedBy(chain: number[]): Promise<number> {
    for (let i = 0; i < 400; i++) {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE pid <> ALL(${chain}::int[])
          AND pg_blocking_pids(pid) && ${chain}::int[]`;
      if (rows.length > 0) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no backend blocked by ${chain.join(',')} after 10 s`);
  }

  async function race(
    helperLock: (tx: typeof prisma) => Promise<unknown>,
    first: () => Promise<request.Response>,
    second: () => Promise<request.Response>,
  ) {
    const helper = holdLock(helperLock);
    const helperPid = await helper.acquired;
    const a = first().then((res) => res);
    const firstPid = await waitBlockedBy([helperPid]);
    const b = second().then((res) => res);
    await waitBlockedBy([helperPid, firstPid]);
    helper.release();
    await helper.done;
    return [await a, await b] as const;
  }

  const lockSale = (id: string) => (tx: typeof prisma) =>
    tx.$queryRaw`SELECT id FROM sales WHERE id = ${id} FOR UPDATE`;

  async function balances(b: Branch) {
    const rows = await moneyRows(b.tenantId);
    const sale = (id: string) => rows.sales.find((s) => s.id === id)!;
    const paidFromLedger = (id: string) =>
      rows.payments
        .filter((p) => p.saleId === id)
        .reduce((sum, p) => sum + p.amountCents, 0);
    for (const id of [b.A, b.B]) {
      // never overpaid, and the stored paid amount is the ledger sum
      expect(paidFromLedger(id)).toBeLessThanOrEqual(sale(id).totalCents);
      expect(sale(id).paidCents).toBe(paidFromLedger(id));
      // a cancelled CREDIT sale stores debt 0 (cancellation rule)
      if (sale(id).status !== 'CANCELED') {
        expect(sale(id).debtCents).toBe(
          sale(id).totalCents - sale(id).paidCents,
        );
      }
    }
    return {
      A: [sale(b.A).paidCents, sale(b.A).paymentStatus],
      B: [sale(b.B).paidCents, sale(b.B).paymentStatus],
      collections: rows.collections,
      rows,
    };
  }

  // ─────────────── collection vs single-sale payment on one of its sales ───────────────

  describe('collection vs POST /sales/:id/payments on one of its sales', () => {
    it('collection first (blocked on A), payment second: the collection pays both, the payment finds no debt', async () => {
      const b = await branch('CobroPrimero');

      const [collected, paid] = await race(
        lockSale(b.A),
        () => collect(b, 'collector', 800, 800),
        () => payA(b, 100),
      );

      expect(collected.status).toBe(201);
      expect(paid.status).toBe(422);
      expect(paid.body.error).toBe('NO_OUTSTANDING_DEBT');
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [300, 'PAID'],
        [500, 'PAID'],
      ]);
    }, 60_000);

    it('payment first (blocked on A), collection second: the payment lands, the collection answers 409 COLLECTION_DEBT_CHANGED and writes nothing', async () => {
      const b = await branch('PagoPrimero');

      const [paid, collected] = await race(
        lockSale(b.A),
        () => payA(b, 100),
        () => collect(b, 'collector', 800, 800),
      );

      expect(paid.status).toBe(201);
      expect(collected.status).toBe(409);
      expect(collected.body).toMatchObject({
        error: 'COLLECTION_DEBT_CHANGED',
        preview: { debtCents: 700 },
      });
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [100, 'PARTIAL'],
        [0, 'CREDIT'],
      ]);
      expect(after.collections).toEqual([]);
    }, 60_000);
  });

  // ─────────────────────────── collection vs customer DELETE ───────────────────────────

  describe('collection vs DELETE /customers/:id', () => {
    it('collection first (blocked on A), DELETE second (blocked on the customer): both complete, the money history stays', async () => {
      const b = await branch('CobroBorrar');

      const [collected, deleted] = await race(
        lockSale(b.A),
        () => collect(b, 'collector', 800, 800),
        () => api.deleteCustomer(b.collector, b.customerId),
      );

      expect([collected.status, deleted.status]).toEqual([201, 204]);
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [300, 'PAID'],
        [500, 'PAID'],
      ]);
      expect(await prisma.customer.count({ where: { id: b.customerId } })).toBe(
        0,
      );
      expect(after.rows.sales.every((s) => s.customerId === null)).toBe(true);
      expect(after.collections).toEqual([
        expect.objectContaining({ customerId: null, appliedCents: 800 }),
      ]);
      expect(after.rows.payments.filter((p) => p.collectionId)).toHaveLength(2);
    }, 60_000);

    it('DELETE first (blocked on A), collection second (blocked on the customer): the customer goes, the collection answers 404 and writes nothing', async () => {
      const b = await branch('BorrarCobro');

      const [deleted, collected] = await race(
        lockSale(b.A),
        () => api.deleteCustomer(b.collector, b.customerId),
        () => collect(b, 'collector', 800, 800),
      );

      expect(deleted.status).toBe(204);
      expect(collected.status).toBe(404);
      expect(collected.body.error).toBe('CUSTOMER_NOT_FOUND');
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [0, 'CREDIT'],
        [0, 'CREDIT'],
      ]);
      expect(after.collections).toEqual([]);
      expect(after.rows.idempotency).toEqual([]);
      expect(after.rows.movements).toEqual([]);
    }, 60_000);
  });

  // ─────────────────────── collection vs collection, same customer ───────────────────────

  describe('collection vs POST /sales/:id/cancel of one of its sales (§12)', () => {
    const cancelA = (b: Branch) => api.cancel(b.collector, b.A);
    /**
     * The cancellation inserts its idempotency slot (with `saleId`, FK → KEY
     * SHARE on the sale row) in autocommit BEFORE its transaction. A helper
     * `FOR UPDATE` would park it there, outside the sale-lock queue, and the
     * collection would always win. `FOR NO KEY UPDATE` lets that KEY SHARE
     * through while still blocking both `FOR UPDATE`s, so the start order is
     * the order in which they take the sale row.
     */
    const holdA = (b: Branch) => (tx: typeof prisma) =>
      tx.$queryRaw`SELECT id FROM sales WHERE id = ${b.A} FOR NO KEY UPDATE`;

    it('cancel first (blocked on A), collection second without expectedDebtCents: the reached A is no longer eligible under the lock, 409 COLLECTION_DEBT_CHANGED with B only, nothing collected', async () => {
      const b = await branch('CancelarCobrar');

      const [canceled, collected] = await race(
        holdA(b),
        () => cancelA(b),
        () => collect(b, 'collector', 600),
      );

      expect(canceled.status).toBe(200);
      expect(collected.status).toBe(409);
      expect(collected.body).toMatchObject({
        error: 'COLLECTION_DEBT_CHANGED',
        preview: {
          debtCents: 500,
          tenderedCents: 600,
          appliedCents: 500,
          changeDueCents: 100,
          remainingCustomerDebtCents: 0,
        },
      });
      expect(collected.body.preview.sales.map((s: any) => s.saleId)).toEqual([
        b.B,
      ]);
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [0, 'CREDIT'],
        [0, 'CREDIT'],
      ]);
      const sale = (id: string) => after.rows.sales.find((s) => s.id === id)!;
      expect(sale(b.A).status).toBe('CANCELED');
      expect(after.rows.payments).toEqual([]);
      expect(after.collections).toEqual([]);
      expect(after.rows.movements).toEqual([]);
      // A was unpaid when cancelled: nothing to refund
      expect(after.rows.refunds).toEqual([]);
    }, 60_000);

    it('cancel first (blocked on A), collection second WITH expectedDebtCents: 409 COLLECTION_DEBT_CHANGED with the debt without A, nothing collected', async () => {
      const b = await branch('CancelarEsperado');

      const [canceled, collected] = await race(
        holdA(b),
        () => cancelA(b),
        () => collect(b, 'collector', 800, 800),
      );

      expect(canceled.status).toBe(200);
      expect(collected.status).toBe(409);
      expect(collected.body).toMatchObject({
        error: 'COLLECTION_DEBT_CHANGED',
        preview: { debtCents: 500 },
      });
      expect(collected.body.preview.sales.map((s: any) => s.saleId)).toEqual([
        b.B,
      ]);
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [0, 'CREDIT'],
        [0, 'CREDIT'],
      ]);
      expect(after.collections).toEqual([]);
      expect(after.rows.movements).toEqual([]);
    }, 60_000);

    it("collection first (blocked on A), cancel second: the cancel refunds exactly A's collection payments as PENDING refunds; the change is never refunded", async () => {
      const b = await branch('CobrarCancelar');

      const [collected, canceled] = await race(
        holdA(b),
        () =>
          api.collect(b.collector, b.customerId, {
            cashSessionId: b.collectorSession,
            expectedDebtCents: 800,
            payments: [
              { method: 'card_debit', amountCents: 600 },
              { method: 'cash', amountCents: 300 },
            ],
          }),
        () => cancelA(b),
      );

      expect(collected.status).toBe(201);
      expect(collected.body.changeDueCents).toBe(100);
      expect(canceled.status).toBe(200);

      const after = await balances(b);
      const sale = (id: string) => after.rows.sales.find((s) => s.id === id)!;
      expect(sale(b.A).status).toBe('CANCELED');
      expect(sale(b.B)).toMatchObject({
        status: 'CONFIRMED',
        paidCents: 500,
        paymentStatus: 'PAID',
      });
      // card 600 → A 300 + B 300; cash 300 → B 200, change 100
      const aPayments = after.rows.payments.filter((p) => p.saleId === b.A);
      expect(aPayments.map((p) => [p.method, p.amountCents])).toEqual([
        ['CARD_DEBIT', 300],
      ]);
      expect(
        after.rows.refunds.map((r) => [
          r.saleId,
          r.salePaymentId,
          r.method,
          r.amountCents,
          r.status,
        ]),
      ).toEqual([[b.A, aPayments[0].id, 'CARD_DEBIT', 300, 'PENDING']]);
      // the collection and its change stay untouched
      expect(after.collections).toEqual([
        expect.objectContaining({ appliedCents: 800, changeDueCents: 100 }),
      ]);
      expect(
        after.rows.movements
          .filter((m) => m.kind === 'SALE_CHANGE')
          .map((m) => m.deltaCents),
      ).toEqual([-100]);
    }, 60_000);
  });

  describe('collection vs collection of the same customer', () => {
    it('with expectedDebtCents: the first pays A, the second sees the new debt and answers 409 with it', async () => {
      const b = await branch('DobleEsperado');

      const [first, second] = await race(
        lockSale(b.A),
        () => collect(b, 'collector', 300, 800),
        () => collect(b, 'cashier', 300, 800),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        error: 'COLLECTION_DEBT_CHANGED',
        preview: { debtCents: 500 },
      });
      expect(second.body.preview.sales.map((s: any) => s.saleId)).toEqual([
        b.B,
      ]);
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [300, 'PAID'],
        [0, 'CREDIT'],
      ]);
    }, 60_000);

    it('without expectedDebtCents: they serialize on A; the second finds A paid (its tender would now reach B, which it did not lock) and answers 409 with B, nothing overpaid', async () => {
      const b = await branch('DobleLibre');

      const [first, second] = await race(
        lockSale(b.A),
        () => collect(b, 'collector', 300),
        () => collect(b, 'cashier', 300),
      );

      expect([first.status, second.status]).toEqual([201, 409]);
      expect(first.body.sales.map((s: any) => s.saleId)).toEqual([b.A]);
      expect(second.body).toMatchObject({
        error: 'COLLECTION_DEBT_CHANGED',
        preview: { debtCents: 500, appliedCents: 300 },
      });
      expect(
        second.body.preview.sales.map((s: any) => [s.saleId, s.appliedCents]),
      ).toEqual([[b.B, 300]]);
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [300, 'PAID'],
        [0, 'CREDIT'],
      ]);
      expect(after.collections).toHaveLength(1);
    }, 60_000);
  });

  // ─────────────── R4: a sale that receives nothing is never locked ───────────────

  describe('lock set without saleIds', () => {
    it('a sale that receives 0 is NOT locked: a single-sale payment on it completes while the collection waits on the reached sale', async () => {
      const b = await branch('SinBloqueoCero');
      // cash 300 reaches only A (due first); B (the LOWER id, which a lock of
      // every candidate would take first) receives 0.
      const helper = holdLock(lockSale(b.A));
      const helperPid = await helper.acquired;
      try {
        // `.then` sends the (lazy) supertest request now
        const collected = collect(b, 'collector', 300, 800).then((res) => res);
        const collectionPid = await waitBlockedBy([helperPid]);

        let settled = false;
        const paid = api
          .pay(b.cashier, b.B, {
            cashSessionId: b.cashierSession,
            payments: [{ method: 'cash', amountCents: 100 }],
          })
          .then((res) => res)
          .finally(() => (settled = true));
        // Handshake: until the payment answers, no backend ever waits on the
        // collection, and the collection is still parked on A.
        while (!settled) {
          const waiters = await prisma.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE pg_blocking_pids(pid) && ARRAY[${collectionPid}]::int[]`;
          expect(waiters).toEqual([]);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect((await paid).status).toBe(201);
        const stillParked = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE pid = ${collectionPid}
            AND pg_blocking_pids(pid) && ARRAY[${helperPid}]::int[]`;
        expect(stillParked).toHaveLength(1);

        helper.release();
        await helper.done;
        const res = await collected;
        expect(res.status).toBe(201);
        expect(res.body.sales.map((s: any) => s.saleId)).toEqual([b.A]);
        // B was read (unlocked) before its payment, and expectedDebtCents
        // is compared with the debt read in this request (A 300 locked + B
        // 500 unlocked = 800); the remaining debt reflects that same read.
        expect(res.body.remainingCustomerDebtCents).toBe(500);
      } finally {
        helper.release();
        await helper.done.catch(() => undefined);
      }
      const after = await balances(b);
      expect([after.A, after.B]).toEqual([
        [300, 'PAID'],
        [100, 'PARTIAL'],
      ]);
    }, 60_000);
  });
});
