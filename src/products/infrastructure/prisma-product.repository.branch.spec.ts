/**
 * Slice E.4 — Branch coverage for `decrementStockForCharge` flip-loser path.
 *
 * What this spec actually tests (re-framed after the R1/R3 review):
 *   The branch `if (alertEpoch === null) return false` inside
 *   `flipAndOutbox`. When the seeded-flip loses to a concurrent tx (mocked
 *   here as `seedAndFlip → null`), the repo MUST omit the crossing from
 *   the returned `StockCrossing[]` AND MUST NOT call `outbox.publish`.
 *
 * What this spec does NOT prove:
 *   This is a structural / unit-level test that wires the right code path
 *   under simulated concurrent loss. Two PRISMA mocks with hard-coded
 *   "win → 1, lose → null" responses do NOT exercise Postgres MVCC or
 *   `UPDATE ... WHERE alerted=false RETURNING` race resolution. That
 *   real-DB concurrent proof lives in
 *   `prisma/e4-concurrent-stock-alert.spec.ts` (driven through
 *   `PrismaProductRepository.decrementStockForCharge` against the live
 *   dev DB under `Promise.all`).
 *
 * Reviewer R1 call-out (FAIL → fix): the previous wording implied this
 * file exercised true concurrent transaction collapse and that "the
 * atomic flip resolves which tx owns the alert". Both claims were false.
 * With this rename and header, the test's actual coverage is the branch
 * alone — anything stronger must come from `prisma/e4-concurrent-*.spec.ts`.
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

describe('PrismaProductRepository.decrementStockForCharge — flip-loser branch (E.4)', () => {
  it('when seedAndFlip returns null (lost the conditional flip), the crossing is omitted AND outbox is NOT called', async () => {
    // qty=10, min=5, drop=6 → new=4 → crosses PRE-gate
    //   (pre=10 > 5 AND new=4 <= 5 AND !useLotsAndExpirations).
    // seedAndFlip → null simulates the E.4 LOSING branch: another
    // transaction already flipped the same key, so our conditional
    // UPDATE ... RETURNING matched 0 rows.
    //
    // Branch under test:
    //   flipAndOutbox returns false → decrementStockForCharge pushes
    //   NOTHING into the crossings array.
    const tx = makeTxMock();
    tx.setResponses([
      [{ newQuantity: 4, minQuantity: 5, useLotsAndExpirations: false }],
    ]);

    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(tx),
      getTenantId: jest.fn().mockReturnValue(TENANT),
      isInTransaction: jest.fn().mockReturnValue(true),
    };
    const outbox: jest.Mocked<OutboxWriterService> = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;
    const alertState: jest.Mocked<IStockAlertStateRepository> = {
      seedAndFlip: jest.fn().mockResolvedValue(null), // loser branch
      rearm: jest.fn(),
    } as any;

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-1', quantity: 6 },
    ]);

    // The branch contract — both halves:
    expect(result).toEqual([]); // NO crossing for the loser
    expect(alertState.seedAndFlip).toHaveBeenCalledTimes(1);
    expect(outbox.publish).not.toHaveBeenCalled(); // NO outbox row from the loser
  });

  it('when seedAndFlip returns a number (won the conditional flip), the crossing is returned AND outbox is called once', async () => {
    // Companion branch — proves the WIN path is wired symmetrically so
    // the loser branch above is not just "everything returns empty".
    const tx = makeTxMock();
    tx.setResponses([
      [{ newQuantity: 4, minQuantity: 5, useLotsAndExpirations: false }],
    ]);

    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(tx),
      getTenantId: jest.fn().mockReturnValue(TENANT),
      isInTransaction: jest.fn().mockReturnValue(true),
    };
    const outbox: jest.Mocked<OutboxWriterService> = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;
    const alertState: jest.Mocked<IStockAlertStateRepository> = {
      seedAndFlip: jest.fn().mockResolvedValue(1), // winner branch
      rearm: jest.fn(),
    } as any;

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-1', quantity: 6 },
    ]);

    expect(result).toEqual([
      { productId: 'prod-1', variantId: null, newQuantity: 4, minQuantity: 5 },
    ]);
    expect(alertState.seedAndFlip).toHaveBeenCalledTimes(1);
    expect(outbox.publish).toHaveBeenCalledTimes(1);
    expect(outbox.publish.mock.calls[0][4]).toBe('stock.low.detected');
  });
});
