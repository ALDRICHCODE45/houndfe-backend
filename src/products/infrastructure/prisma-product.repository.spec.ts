/**
 * PrismaProductRepository — adapter tests.
 *
 * Slice E.2 — stock crossing detection. The decrement path is rewritten
 * to use raw `$queryRaw` `UPDATE ... RETURNING` so the new post-decrement
 * quantity (and the cross-tenant guard) is available atomically; the
 * `StockCrossing[]` return type lets the sales orchestrator dispatch
 * low-stock events after commit.
 *
 * Spec coverage:
 *   - specs/sales/spec.md — "Stock Decrement Returns Threshold Crossings"
 *     + "Stock-guard failure semantics unchanged"
 *   - specs/stock-alerts/spec.md — "One-Shot Edge Trigger At Or Below Min Quantity"
 *     + "Lots/expiration products excluded" + "Boundary inclusive at minQuantity"
 *   - design.md — Decision 5 (PRE-gate), Decision 6 (strict `>` re-arm),
 *     finding #3 (raw tenant guard), finding #7 (non-stock skip),
 *     finding #8 (PRE-gate no false fire), finding #9 (variant path
 *     has no useStock/useLots columns)
 */
import { PrismaProductRepository } from './prisma-product.repository';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { IStockAlertStateRepository } from '../../stock-alerts/domain/stock-alert-state.repository';

// ── Tx-aware $queryRaw mock ────────────────────────────────────────────

type RawCall = { sql: string; values: unknown[] };

/**
 * Returns a mock transaction client that records every `$queryRaw`
 * tagged-template call AND can be programmed with per-call responses.
 *
 * The repo path uses THREE raw statements per crossing flip:
 *   1. UPDATE products/variants  ... RETURNING "newQuantity","minQuantity","useLotsAndExpirations"
 *   2. (non-stock fallback: SELECT 1 FROM products ... — only when count === 0)
 *   3. INSERT INTO stock_alert_states ... ON CONFLICT DO NOTHING
 *   4. UPDATE stock_alert_states ... RETURNING "alertEpoch" (the flip)
 *   5. (skip the flip when the PRE-gate fails)
 */
function makeTxMock() {
  const calls: RawCall[] = [];
  let responses: Array<Array<unknown>> = [];

  const $queryRaw = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown> => {
    let sql = '';
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) {
        sql += `$${i + 1}`;
      }
    }
    calls.push({ sql, values });
    const response = responses[calls.length - 1] ?? [];
    return Promise.resolve(response);
  }) as unknown as jest.Mock;

  // Tx must also expose $queryRaw (for nested tx propagation) and the
  // shape used by the repo: a top-level $queryRaw on the tenant client
  // is what actually gets called inside `runInTransaction`.
  return {
    calls,
    $queryRaw,
    setResponses(next: Array<Array<unknown>>) {
      responses = next;
    },
  };
}

/**
 * The repo calls `$queryRaw` on `tenantPrisma.getClient()`, NOT on a
 * nested `tx`. Inside `runInTransaction`, `TenantPrismaService.getClient()`
 * resolves the transaction client (it has `$queryRaw`). The factory
 * hands back a `getClient()` mock that returns the same tx mock both
 * at the top level and inside the transaction.
 */
function makeTenantPrismaForTx(tx: ReturnType<typeof makeTxMock>) {
  return {
    getClient: jest.fn().mockReturnValue(tx),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    // Ambient-tx guard (Slice E — WARNING 1 fix): the repo throws unless
    // it sees an active tx. Inside `runInTransaction`, CLS has the tx
    // client set, so this mock returns `true` for tests that drive the
    // repo as if they were inside the tx. The "outside-tx throws" test
    // below flips this to `false`.
    isInTransaction: jest.fn().mockReturnValue(true),
  };
}

function makeOutboxWriter(): jest.Mocked<OutboxWriterService> {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeStockAlertRepo(): jest.Mocked<IStockAlertStateRepository> {
  return {
    seedAndFlip: jest.fn(),
    rearm: jest.fn(),
  } as any;
}

const TENANT = 'tenant-1';

// ── Original contract — Stock-guard failure semantics unchanged ────────

describe('PrismaProductRepository.decrementStockForCharge (E.2)', () => {
  it('throws STOCK_INSUFFICIENT_AT_CONFIRM when the guarded UPDATE matches zero rows on a useStock product', async () => {
    const tx = makeTxMock();
    // 1) UPDATE products ... — zero rows (insufficient stock)
    // 2) SELECT fallback for useStock=false — empty (the product IS a
    //    useStock product but its stock is insufficient; throw).
    tx.setResponses([[], []]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.decrementStockForCharge([{ productId: 'prod-1', quantity: 5 }]),
    ).rejects.toThrow('STOCK_INSUFFICIENT_AT_CONFIRM');

    // SELECT issued AFTER UPDATE matched zero rows; finds NO useStock=false
    // row ⇒ throw, no flip, no outbox.
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('skips a non-stock (useStock=false) product silently without throwing or crossing', async () => {
    const tx = makeTxMock();
    tx.setResponses([
      [], // UPDATE products ... — zero rows (useStock=false excluded)
      [{ id: 'prod-service' }], // SELECT confirms non-stock row exists
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.decrementStockForCharge([
        { productId: 'prod-service', quantity: 1 },
      ]),
    ).resolves.toEqual([]);

    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });
});

// ── E.2 NEW BEHAVIOR — crossings + return type ─────────────────────────

describe('PrismaProductRepository.decrementStockForCharge — crossings (E.2)', () => {
  it('returns an empty array when the post-decrement quantity stays above minQuantity (no crossing)', async () => {
    const tx = makeTxMock();
    // Pre=10, qty=2, min=3 → new=8, pre=10 > 3 AND newQty=8 > min=3
    // → PRE-gate fails, no flip, no outbox.
    tx.setResponses([
      [{ newQuantity: 8, minQuantity: 3, useLotsAndExpirations: false }],
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-1', quantity: 2 },
    ]);

    expect(result).toEqual([]);
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('returns a StockCrossing when a downward crossing wins the flip (the happy-path edge trigger)', async () => {
    const tx = makeTxMock();
    // Pre=5, qty=2, min=3 → new=3, pre=5 > 3 AND newQty=3 <= 3
    // → PRE-gate fires, flip wins.
    tx.setResponses([
      [{ newQuantity: 3, minQuantity: 3, useLotsAndExpirations: false }],
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();
    alertState.seedAndFlip.mockResolvedValue(1); // flip won, new epoch = 1

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-1', quantity: 2 },
    ]);

    expect(result).toEqual([
      { productId: 'prod-1', variantId: null, newQuantity: 3, minQuantity: 3 },
    ]);
    expect(alertState.seedAndFlip).toHaveBeenCalledTimes(1);
    expect(alertState.seedAndFlip).toHaveBeenCalledWith({
      tx: tx as any,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: null,
    });
    // Outbox row is written IN THE SAME TRANSACTION as the decrement + flip.
    expect(outbox.publish).toHaveBeenCalledTimes(1);
    const publishArgs = outbox.publish.mock.calls[0];
    expect(publishArgs[0]).toBe(tx); // tx client
    expect(publishArgs[1]).toBe(TENANT); // tenantId
    expect(publishArgs[2]).toBe('StockAlert'); // aggregateType
    expect(publishArgs[3]).toBe('prod-1:__PRODUCT__'); // aggregateId
    expect(publishArgs[4]).toBe('stock.low.detected'); // eventType
    expect(publishArgs[5]).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        productId: 'prod-1',
        variantId: null,
        variantKey: '__PRODUCT__',
        alertEpoch: 1,
        newQuantity: 3,
        minQuantity: 3,
        occurredAt: expect.any(String),
      }),
    );
  });

  it('does NOT fire when an item is already created below min (no false-fire on PRE-gate)', async () => {
    const tx = makeTxMock();
    // Pre=2 (already low), qty=1, min=3 → new=1, pre=2 NOT > 3
    // → PRE-gate fails even though newQty=1 <= 3.
    tx.setResponses([
      [{ newQuantity: 1, minQuantity: 3, useLotsAndExpirations: false }],
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-low', quantity: 1 },
    ]);

    expect(result).toEqual([]);
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('does NOT fire on lots/expiration products even when newQty <= minQty (design Decision 5)', async () => {
    const tx = makeTxMock();
    // Pre=10, qty=7, min=3, useLotsAndExpirations=true → new=3, but lots
    // exclude → PRE-gate fails.
    tx.setResponses([
      [{ newQuantity: 3, minQuantity: 3, useLotsAndExpirations: true }],
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-lots', quantity: 7 },
    ]);

    expect(result).toEqual([]);
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('returns empty array when the flip LOSES — concurrent tx already alerted (spec: already-alerted not re-reported)', async () => {
    const tx = makeTxMock();
    tx.setResponses([
      [{ newQuantity: 3, minQuantity: 3, useLotsAndExpirations: false }],
    ]);
    // seedAndFlip returns null when the conditional UPDATE matches 0 rows
    // (another tx already flipped this item).
    const alertState = makeStockAlertRepo();
    alertState.seedAndFlip.mockResolvedValue(null);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-1', quantity: 2 },
    ]);

    // Spec "already-alerted item is not re-reported" — the loser of the
    // concurrent flip observes an alerted=true row and does NOT add a
    // crossing to its return array. The winning tx already alerted
    // and will dispatch.
    expect(result).toEqual([]);
    expect(alertState.seedAndFlip).toHaveBeenCalledTimes(1);
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('variant path: returns a StockCrossing with the variant id (no useStock/useLots columns)', async () => {
    const tx = makeTxMock();
    tx.setResponses([
      [{ newQuantity: 3, minQuantity: 3 }], // variants table has no useLotsAndExpirations
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();
    alertState.seedAndFlip.mockResolvedValue(5); // flip wins, epoch 5

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
    ]);

    expect(result).toEqual([
      {
        productId: 'prod-1',
        variantId: 'var-1',
        newQuantity: 3,
        minQuantity: 3,
      },
    ]);

    // UPDATE variants — no useStock, no useLotsAndExpirations
    const updateCall = tx.calls[0];
    expect(updateCall.sql).toMatch(/UPDATE "variants"/);
    expect(updateCall.sql).not.toMatch(/"useStock"/);
    expect(updateCall.sql).not.toMatch(/"useLotsAndExpirations"/);
    expect(updateCall.sql).toMatch(/"tenantId" = \$/);
    expect(updateCall.sql).toMatch(/"id" = \$/);
    expect(updateCall.sql).toMatch(/"productId" = \$/);

    expect(alertState.seedAndFlip).toHaveBeenCalledWith({
      tx: tx as any,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: 'var-1',
    });
    expect(outbox.publish).toHaveBeenCalledWith(
      tx,
      TENANT,
      'StockAlert',
      'prod-1:var-1',
      'stock.low.detected',
      expect.objectContaining({
        variantId: 'var-1',
        variantKey: 'var-1',
      }),
    );
  });

  it('variant path: zero rows from UPDATE throws STOCK_INSUFFICIENT_AT_CONFIRM (variants have no non-stock fallback)', async () => {
    const tx = makeTxMock();
    tx.setResponses([[]]); // UPDATE variants — zero rows

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.decrementStockForCharge([
        { productId: 'prod-1', variantId: 'var-1', quantity: 5 },
      ]),
    ).rejects.toThrow('STOCK_INSUFFICIENT_AT_CONFIRM');

    // No SELECT fallback for variants (design Decision 5, finding #9).
    expect(tx.calls).toHaveLength(1);
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('cross-tenant raw WHERE: zero rows when productId belongs to a different tenant (no useStock check, raw carries "tenantId")', async () => {
    const tx = makeTxMock();
    tx.setResponses([[]]); // raw UPDATE — zero rows for cross-tenant productId

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.decrementStockForCharge([
        { productId: 'prod-other-tenant', quantity: 1 },
      ]),
    ).rejects.toThrow('STOCK_INSUFFICIENT_AT_CONFIRM');

    const updateCall = tx.calls[0];
    expect(updateCall.sql).toMatch(/"tenantId" = \$/);
    expect(updateCall.values).toContain(TENANT);
  });

  it('processes multiple adjustments independently — returns ALL crossings (one per item that crossed)', async () => {
    const tx = makeTxMock();
    // Adjustment A: crosses (new=3, min=3, not lots) → flip wins
    // Adjustment B: stays above min (new=10, min=3) → no flip
    // Adjustment C: variant crosses (new=2, min=2) → flip wins
    tx.setResponses([
      [{ newQuantity: 3, minQuantity: 3, useLotsAndExpirations: false }],
      [{ newQuantity: 10, minQuantity: 3, useLotsAndExpirations: false }],
      [{ newQuantity: 2, minQuantity: 2 }],
    ]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();
    // Each flip returns a distinct epoch so both crossings are added.
    alertState.seedAndFlip
      .mockResolvedValueOnce(1) // prod-A
      .mockResolvedValueOnce(2); // var-C

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-A', quantity: 7 },
      { productId: 'prod-B', quantity: 1 },
      { productId: 'prod-C', variantId: 'var-C', quantity: 8 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      productId: 'prod-A',
      variantId: null,
      newQuantity: 3,
      minQuantity: 3,
    });
    expect(result[1]).toEqual({
      productId: 'prod-C',
      variantId: 'var-C',
      newQuantity: 2,
      minQuantity: 2,
    });

    expect(alertState.seedAndFlip).toHaveBeenCalledTimes(2);
    expect(outbox.publish).toHaveBeenCalledTimes(2);
  });

  it('skips adjustments with quantity <= 0 (mirrors pre-E behavior)', async () => {
    const tx = makeTxMock();
    tx.setResponses([]); // no calls expected

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    const result = await repo.decrementStockForCharge([
      { productId: 'prod-skip', quantity: 0 },
      { productId: 'prod-skip-2', quantity: -1 },
    ]);

    expect(result).toEqual([]);
    expect(tx.calls).toHaveLength(0);
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });
});

// ── E.2 NEW BEHAVIOR — incrementStockForRestock with strict > re-arm ──

describe('PrismaProductRepository.incrementStockForRestock — strict > re-arm (E.2)', () => {
  it('does NOT re-arm when newQuantity === minQuantity (strict boundary)', async () => {
    const tx = makeTxMock();
    // restock lands us exactly on min: new=3, min=3 → NOT > min → no rearm
    tx.setResponses([[{ newQuantity: 3, minQuantity: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await repo.incrementStockForRestock([{ productId: 'prod-1', quantity: 1 }]);

    expect(alertState.rearm).not.toHaveBeenCalled();
    expect(tx.calls).toHaveLength(1); // only the restock UPDATE; no flip
  });

  it('re-arms when newQuantity > minQuantity (strict > precondition met)', async () => {
    const tx = makeTxMock();
    tx.setResponses([[{ newQuantity: 5, minQuantity: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await repo.incrementStockForRestock([{ productId: 'prod-1', quantity: 3 }]);

    expect(alertState.rearm).toHaveBeenCalledWith({
      tx: tx as any,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: null,
    });
  });
});

// ── WARNING 1 — Ambient-transaction guard (Slice E reliability) ────────

describe('PrismaProductRepository — ambient-tx guard (R1 fix)', () => {
  it('decrementStockForCharge THROWS when called outside an ambient transaction (silent-fallback foot-gun)', async () => {
    // tenantPrisma.isInTransaction() === false → repo MUST throw BEFORE
    // touching the underlying client (no auto-commit, no outbox write,
    // no decrement). Without this guard, getClient() would silently
    // return a non-tx client and each statement would commit
    // independently, leaving the outbox inconsistent with the
    // products row.
    const tx = makeTxMock();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(tx),
      getTenantId: jest.fn().mockReturnValue(TENANT),
      isInTransaction: jest.fn().mockReturnValue(false),
    };
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.decrementStockForCharge([{ productId: 'prod-1', quantity: 5 }]),
    ).rejects.toThrow(
      /must be called inside TenantPrismaService\.runInTransaction/,
    );

    // NO statements ran against the client — guard fires before
    // getClient() is even consumed.
    expect(tx.calls).toHaveLength(0);
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('incrementStockForRestock THROWS when called outside an ambient transaction', async () => {
    // Mirror guard for the restock path — leaving the rearm dangling
    // would block the next alert forever.
    const tx = makeTxMock();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(tx),
      getTenantId: jest.fn().mockReturnValue(TENANT),
      isInTransaction: jest.fn().mockReturnValue(false),
    };
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.incrementStockForRestock([{ productId: 'prod-1', quantity: 3 }]),
    ).rejects.toThrow(
      /must be called inside TenantPrismaService\.runInTransaction/,
    );

    expect(tx.calls).toHaveLength(0);
    expect(alertState.rearm).not.toHaveBeenCalled();
  });
});

// ── Edit-path re-arm — rearmAlertAfterEdit (low-stock-rearm-on-edit) ────

describe('PrismaProductRepository.rearmAlertAfterEdit — ambient-tx guard', () => {
  it('throws when called outside an ambient transaction (mirror of restock guard) — Sc.7', async () => {
    // Without an ambient tx, getClient() would silently fall back to a
    // non-tx client and auto-commit the rearm UPDATE — that blocks the
    // next alert forever. The guard throws BEFORE touching the client.
    const tx = makeTxMock();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(tx),
      getTenantId: jest.fn().mockReturnValue(TENANT),
      isInTransaction: jest.fn().mockReturnValue(false),
    };
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.rearmAlertAfterEdit({ productId: 'prod-1' }),
    ).rejects.toThrow(
      /must be called inside TenantPrismaService\.runInTransaction/,
    );

    // Guard fires before any statement; getClient is never consumed.
    expect(tx.calls).toHaveLength(0);
    expect(alertState.rearm).not.toHaveBeenCalled();
  });
});

describe('PrismaProductRepository.rearmAlertAfterEdit — product path', () => {
  it('product path STRICT `>`: rearm when resulting q > m on a useStock=true product — Sc.1', async () => {
    // SELECT products.quantity,minQuantity WHERE useStock=true → 1 row
    // {q:10, m:3} → 10 > 3 → rearm({variantId:null}).
    const tx = makeTxMock();
    tx.setResponses([[{ q: 10, m: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await repo.rearmAlertAfterEdit({ productId: 'prod-1' });

    // SELECT was issued; product SELECT carries the useStock=true predicate.
    expect(tx.calls).toHaveLength(1);
    const select = tx.calls[0];
    expect(select.sql).toMatch(/SELECT/);
    expect(select.sql).toMatch(/"products"/);
    expect(select.sql).toMatch(/"useStock"\s*=\s*true/);
    expect(select.sql).toMatch(/"tenantId"\s*=\s*\$/);
    expect(select.sql).toMatch(/"id"\s*=\s*\$/);
    expect(select.values).toContain('prod-1');
    expect(select.values).toContain(TENANT);

    // rearm was called with the simple-product key (variantId: null).
    expect(alertState.rearm).toHaveBeenCalledWith({
      tx: tx as any,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: null,
    });
  });

  it('product path STRICT `==`: does NOT rearm when q == m (equality excluded) — Sc.4', async () => {
    // The repository MUST guard the boundary: 3 == 3 is not a re-arm
    // condition. seedAndFlip is also never called on this path.
    const tx = makeTxMock();
    tx.setResponses([[{ q: 3, m: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await repo.rearmAlertAfterEdit({ productId: 'prod-1' });

    expect(alertState.rearm).not.toHaveBeenCalled();
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
  });

  it('product path 0 rows: no throw, no rearm (useStock=false OR row missing) — Sc.6, Sc.8', async () => {
    // 0 rows means the row is either absent or useStock=false; either
    // way the edit MUST be a harmless no-op (no throw, no rearm, no
    // seedAndFlip). Scenario 6: no pre-existing alert-state row → the
    // rearm UPDATE would match 0 rows anyway, but here we never even
    // reach it.
    const tx = makeTxMock();
    tx.setResponses([[]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.rearmAlertAfterEdit({ productId: 'prod-1' }),
    ).resolves.toBeUndefined();

    expect(alertState.rearm).not.toHaveBeenCalled();
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
  });
});

describe('PrismaProductRepository.rearmAlertAfterEdit — variant path', () => {
  it('variant path STRICT `>`: SELECT JOINs products.useStock=true, rearm with variantId — Sc.2', async () => {
    // Variant SELECT MUST JOIN products p ON p.useStock=true AND
    // p.tenantId=v.tenantId, gating on the parent. With the join
    // satisfied, q>m ⇒ rearm({variantId:'var-1'}).
    const tx = makeTxMock();
    tx.setResponses([[{ q: 10, m: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await repo.rearmAlertAfterEdit({
      productId: 'prod-1',
      variantId: 'var-1',
    });

    expect(tx.calls).toHaveLength(1);
    const select = tx.calls[0];
    expect(select.sql).toMatch(/SELECT/);
    expect(select.sql).toMatch(/"variants"/);
    // JOIN to products is mandatory — Variant has no useStock column.
    expect(select.sql).toMatch(/JOIN\s+"products"/);
    expect(select.sql).toMatch(/p\."useStock"\s*=\s*true/);
    expect(select.sql).toMatch(/"tenantId"\s*=\s*\$/);
    expect(select.sql).toMatch(/"id"\s*=\s*\$/);
    expect(select.sql).toMatch(/"productId"\s*=\s*\$/);
    expect(select.values).toContain('var-1');
    expect(select.values).toContain('prod-1');
    expect(select.values).toContain(TENANT);

    expect(alertState.rearm).toHaveBeenCalledWith({
      tx: tx as any,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: 'var-1',
    });
  });

  it('variant path parent useStock=false: JOIN gates it out → 0 rows → no rearm — Sc.8', async () => {
    // The useStock predicate sits on the JOIN to products. When the
    // parent's useStock is false, the JOIN excludes the row ⇒ 0 rows
    // returned ⇒ early return ⇒ no rearm. (Design CRITICAL-2 trap.)
    const tx = makeTxMock();
    tx.setResponses([[]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const outbox = makeOutboxWriter();
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox,
      alertState,
    );

    await expect(
      repo.rearmAlertAfterEdit({
        productId: 'prod-1',
        variantId: 'var-1',
      }),
    ).resolves.toBeUndefined();

    expect(alertState.rearm).not.toHaveBeenCalled();
    expect(alertState.seedAndFlip).not.toHaveBeenCalled();
  });
});
