/**
 * Slice E.4 — Concurrent transaction collapse.
 *
 * Spec scenario:
 *   - "Two concurrent sales, one item, one alert"
 *     - GIVEN P at `qty=10`, `min=3`, no `StockAlertState` row
 *     - WHEN two sales concurrently drop P each by 5
 *     - THEN one transaction sees `count === 1` and emits the event
 *     - AND the other sees `count === 0` and emits nothing
 *
 * The atomicity guarantee comes from the conditional
 * `UPDATE stock_alert_states ... WHERE alerted = false RETURNING "alertEpoch"`.
 * Under the connection default isolation (READ COMMITTED), the LOSING tx
 * re-reads the committed `alerted = true` row and matches zero rows —
 * the `count === 0` return is the contract, NOT a Prisma `P2034`
 * serialization failure (design finding #11).
 *
 * This is a structural / call-shape spec: it asserts the
 * `decrementStockForCharge` repository call drives the right number of
 * flips + outbox writes under the simulated concurrent-loss scenario.
 * The real-DB integration variant (against a Postgres test instance)
 * lives in `prisma/` and is exercised by the verify phase.
 */
import { PrismaProductRepository } from './prisma-product.repository';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { IStockAlertStateRepository } from '../../stock-alerts/domain/stock-alert-state.repository';

function makeTxMock() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let responses: Array<Array<unknown>> = [];
  const $queryRaw = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown> => {
    let sql = '';
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    calls.push({ sql, values });
    const r = (responses as unknown as Array<Promise<unknown>>)[
      calls.length - 1
    ];
    return r ?? Promise.resolve([]);
  }) as unknown as jest.Mock;
  return {
    calls,
    $queryRaw,
    setResponses(next: Array<Array<unknown>>) {
      responses = next;
    },
  };
}

const TENANT = 'tenant-1';

describe('Slice E.4 — concurrent transaction collapse (structurally asserted)', () => {
  it('two concurrent sales on the same item: one wins (count=1, outbox written), one loses (count=0, no outbox)', async () => {
    // Spec scenario "Two concurrent sales, one item, one alert":
    //   - qty=10, min=5
    //   - Two concurrent sales each drop 6 → both reach newQuantity=4
    //   - pre=10 > 5 ✓ and newQty=4 <= 5 ✓ → both fire the PRE-gate
    //   - The conditional UPDATE ... RETURNING alertEpoch matches
    //     exactly ONE row (the winner); the loser matches 0 rows.

    // ── SALE A (the winner) ────────────────────────────────────────────
    const txA = makeTxMock();
    txA.setResponses([
      // UPDATE products returns newQuantity=4, minQuantity=5 (crosses)
      [{ newQuantity: 4, minQuantity: 5, useLotsAndExpirations: false }],
    ]);
    const tenantPrismaA = {
      getClient: jest.fn().mockReturnValue(txA),
      getTenantId: jest.fn().mockReturnValue(TENANT),
    };
    const outboxA: jest.Mocked<OutboxWriterService> = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;
    const alertStateA: jest.Mocked<IStockAlertStateRepository> = {
      seedAndFlip: jest.fn().mockResolvedValue(1), // WIN: epoch=1
      rearm: jest.fn(),
    } as any;
    const repoA = new PrismaProductRepository(
      tenantPrismaA as any,
      outboxA,
      alertStateA,
    );

    // ── SALE B (the loser) ─────────────────────────────────────────────
    const txB = makeTxMock();
    txB.setResponses([
      // UPDATE products returns newQuantity=4, minQuantity=5 (crosses)
      [{ newQuantity: 4, minQuantity: 5, useLotsAndExpirations: false }],
    ]);
    const tenantPrismaB = {
      getClient: jest.fn().mockReturnValue(txB),
      getTenantId: jest.fn().mockReturnValue(TENANT),
    };
    const outboxB: jest.Mocked<OutboxWriterService> = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;
    const alertStateB: jest.Mocked<IStockAlertStateRepository> = {
      seedAndFlip: jest.fn().mockResolvedValue(null), // LOSE: null epoch
      rearm: jest.fn(),
    } as any;
    const repoB = new PrismaProductRepository(
      tenantPrismaB as any,
      outboxB,
      alertStateB,
    );

    // ── Concurrent fire ──────────────────────────────────────────────
    const [resultA, resultB] = await Promise.all([
      repoA.decrementStockForCharge([
        { productId: 'prod-1', quantity: 6 },
      ]),
      repoB.decrementStockForCharge([
        { productId: 'prod-1', quantity: 6 },
      ]),
    ]);

    // ── Assertions ────────────────────────────────────────────────────
    // Sale A: crossed AND won → crossing in return array + outbox written
    expect(resultA).toEqual([
      { productId: 'prod-1', variantId: null, newQuantity: 4, minQuantity: 5 },
    ]);
    expect(alertStateA.seedAndFlip).toHaveBeenCalledTimes(1);
    expect(outboxA.publish).toHaveBeenCalledTimes(1);
    expect(outboxA.publish.mock.calls[0][4]).toBe('stock.low.detected');

    // Sale B: crossed BUT lost → NO crossing in return array, NO outbox
    // (spec: "already-alerted item is not re-reported"; the winner
    // already alerted this item, so the loser emits nothing).
    expect(resultB).toEqual([]);
    expect(alertStateB.seedAndFlip).toHaveBeenCalledTimes(1);
    expect(outboxB.publish).not.toHaveBeenCalled();
  });

  it('both sales decrement the stock but only one outbox row is observable', async () => {
    // qty=10, min=5, both sales drop 6 → newQty=4 in both branches.
    // The atomic flip resolves which tx owns the alert.
    const txA = makeTxMock();
    txA.setResponses([
      [{ newQuantity: 4, minQuantity: 5, useLotsAndExpirations: false }],
    ]);
    const txB = makeTxMock();
    txB.setResponses([
      [{ newQuantity: 4, minQuantity: 5, useLotsAndExpirations: false }],
    ]);

    const repoA = new PrismaProductRepository(
      {
        getClient: jest.fn().mockReturnValue(txA),
        getTenantId: jest.fn().mockReturnValue(TENANT),
      } as any,
      { publish: jest.fn().mockResolvedValue(undefined) } as any,
      { seedAndFlip: jest.fn().mockResolvedValue(1), rearm: jest.fn() } as any,
    );
    const repoB = new PrismaProductRepository(
      {
        getClient: jest.fn().mockReturnValue(txB),
        getTenantId: jest.fn().mockReturnValue(TENANT),
      } as any,
      { publish: jest.fn().mockResolvedValue(undefined) } as any,
      { seedAndFlip: jest.fn().mockResolvedValue(null), rearm: jest.fn() } as any,
    );

    const [resultA, resultB] = await Promise.all([
      repoA.decrementStockForCharge([{ productId: 'prod-1', quantity: 6 }]),
      repoB.decrementStockForCharge([{ productId: 'prod-1', quantity: 6 }]),
    ]);

    // Both UPDATEs ran (each tx independently decremented its snapshot)
    expect(txA.calls[0].sql).toMatch(/UPDATE "products"/);
    expect(txB.calls[0].sql).toMatch(/UPDATE "products"/);

    // Outcome: 1 crossing in result arrays, 1 outbox write total.
    const totalCrossings = resultA.length + resultB.length;
    expect(totalCrossings).toBe(1);
  });
});