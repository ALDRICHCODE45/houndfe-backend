/**
 * PrismaProductRepository — adapter tests.
 *
 * Legacy restock fallback (`incrementStockForRestock`) and the edit-path
 * re-arm (`rearmAlertAfterEdit`). Charging moved to the stock journal (O1).
 *
 * Spec coverage:
 *   - specs/stock-alerts/spec.md — "One-Shot Edge Trigger At Or Below Min Quantity"
 *   - design.md — Decision 6 (strict `>` re-arm)
 */
import { PrismaProductRepository } from './prisma-product.repository';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
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
  let responseIndex = 0;

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
    // Parent locks have no stock result; retain the existing UPDATE/fallback fixtures.
    if (/FOR (UPDATE|KEY SHARE)/.test(sql)) return Promise.resolve([]);
    const response = responses[responseIndex++] ?? [];
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

function makeStockAlertRepo(): jest.Mocked<IStockAlertStateRepository> {
  return {
    seedAndFlip: jest.fn(),
    rearm: jest.fn(),
  } as any;
}

const TENANT = 'tenant-1';

// ── E.2 NEW BEHAVIOR — incrementStockForRestock with strict > re-arm ──

describe('PrismaProductRepository.incrementStockForRestock — strict > re-arm (E.2)', () => {
  it.each([false, true])(
    'rejects converted parent (%s)',
    async (hasEarlierItem) => {
      const tx = makeTxMock();
      tx.setResponses([
        ...(hasEarlierItem ? [[{ newQuantity: 5, minQuantity: 0 }]] : []),
        [],
        [{ name: 'Converted product', hasVariants: true, useStock: true }],
      ]);
      const alerts = makeStockAlertRepo();
      const repo = new PrismaProductRepository(
        makeTenantPrismaForTx(tx) as unknown as ConstructorParameters<
          typeof PrismaProductRepository
        >[0],
        alerts,
      );
      const result = repo.incrementStockForRestock([
        ...(hasEarlierItem ? [{ productId: 'a', quantity: 1 }] : []),
        { productId: 'b', quantity: 1 },
        { productId: 'c', variantId: 'v', quantity: 1 },
      ]);
      await expect(result).rejects.toBeInstanceOf(BusinessRuleViolationError);
      await expect(result).rejects.toMatchObject({
        code: 'RESTOCK_TARGET_HAS_VARIANTS',
        details: { productId: 'b' },
      });
      await expect(result).rejects.toThrow('Converted product');
      const updates = tx.calls.filter((call) => /UPDATE "/.test(call.sql));
      expect(updates).toHaveLength(hasEarlierItem ? 2 : 1);
      expect(updates.at(-1)?.sql).toContain('AND "hasVariants" = false');
      expect(updates.at(-1)?.values).toEqual([1, 'b', TENANT]);
      expect(tx.calls.at(-1)?.sql).toMatch(
        /SELECT.*"name"[\s\S]*FROM "products"/,
      );
      expect(tx.calls.at(-1)?.values).toEqual(['b', TENANT]);
      expect(alerts.rearm.mock.calls.map(([call]) => call.productId)).toEqual(
        hasEarlierItem ? ['a'] : [],
      );
      expect(alerts.seedAndFlip.mock.calls).toEqual([]);
    },
  );

  it('silently skips a non-stock Product even when it now has Variants', async () => {
    const tx = makeTxMock();
    tx.setResponses([
      [],
      [{ name: 'Non-stock product', useStock: false, hasVariants: true }],
      [{ newQuantity: 5, minQuantity: 0 }],
    ]);
    const alerts = makeStockAlertRepo();
    const repo = new PrismaProductRepository(
      makeTenantPrismaForTx(tx) as unknown as ConstructorParameters<
        typeof PrismaProductRepository
      >[0],
      alerts,
    );
    await expect(
      repo.incrementStockForRestock([
        { productId: 'a', quantity: 1 },
        { productId: 'b', variantId: 'v', quantity: 1 },
      ]),
    ).resolves.toBeUndefined();
    expect(tx.calls).toHaveLength(5);
    expect(tx.calls[3].values).toEqual(['a', TENANT]);
    expect(tx.calls[4].sql).toContain('UPDATE "variants"');
    expect(alerts.rearm.mock.calls).toEqual([
      [{ tx, tenantId: TENANT, productId: 'b', variantId: 'v' }],
    ]);
    expect(alerts.seedAndFlip.mock.calls).toEqual([]);
  });
  it('locks mixed parents once in global id order and restocks/rearms in row order', async () => {
    const tx = makeTxMock();
    tx.setResponses(
      Array.from({ length: 5 }, () => [{ newQuantity: 5, minQuantity: 0 }]),
    );
    const alerts = makeStockAlertRepo();
    // SAFETY: the fixture supplies the exact tenant/transaction port used here.
    const repo = new PrismaProductRepository(
      makeTenantPrismaForTx(tx) as unknown as ConstructorParameters<
        typeof PrismaProductRepository
      >[0],
      alerts,
    );
    await expect(
      repo.incrementStockForRestock([
        { productId: 'z', quantity: 1 },
        { productId: 'm', variantId: 'v2', quantity: 1 },
        { productId: 'a', variantId: 'v1', quantity: 1 },
        { productId: 'm', quantity: 1 },
        { productId: 'm', variantId: 'v1', quantity: 1 },
      ]),
    ).resolves.toBeUndefined();
    const locks = tx.calls.slice(0, 3);
    expect(locks.map((c) => c.values)).toEqual([
      ['a', TENANT],
      ['m', TENANT],
      ['z', TENANT],
    ]);
    expect(
      locks.map((c) => c.sql.match(/FOR (UPDATE|KEY SHARE)/)?.[1]),
    ).toEqual(['KEY SHARE', 'UPDATE', 'UPDATE']);
    for (const lock of locks) {
      expect(lock.sql).toMatch(/FROM "products"/);
      expect(lock.sql).toMatch(/"id" = \$1 AND "tenantId" = \$2/);
    }
    expect(tx.calls.slice(3).map((c) => c.values.slice(0, 3))).toEqual([
      [1, 'v1', 'a'],
      [1, 'm', TENANT],
      [1, 'v1', 'm'],
      [1, 'v2', 'm'],
      [1, 'z', TENANT],
    ]);
    expect(
      alerts.rearm.mock.calls.map(([c]) => [c.productId, c.variantId]),
    ).toEqual([
      ['a', 'v1'],
      ['m', null],
      ['m', 'v1'],
      ['m', 'v2'],
      ['z', null],
    ]);
    expect(alerts.seedAndFlip.mock.calls).toEqual([]);
  });

  it('skips nonpositive entries and preserves no-match/useStock and Variant rearm boundaries', async () => {
    const tx = makeTxMock();
    tx.setResponses([[], [], [], [{ newQuantity: 2, minQuantity: 3 }]]);
    const alerts = makeStockAlertRepo();
    // SAFETY: the fixture supplies the exact tenant/transaction port used here.
    const repo = new PrismaProductRepository(
      makeTenantPrismaForTx(tx) as unknown as ConstructorParameters<
        typeof PrismaProductRepository
      >[0],
      alerts,
    );
    await expect(
      repo.incrementStockForRestock([
        { productId: 'a', quantity: 1 },
        { productId: 'b', variantId: 'missing', quantity: 1 },
        { productId: 'b', variantId: 'v', quantity: 1 },
        { productId: 'zero', quantity: 0 },
        { productId: 'negative', variantId: 'v', quantity: -1 },
      ]),
    ).resolves.toBeUndefined();
    expect(tx.calls).toHaveLength(6); // two parents, three updates, qualified fallback
    expect(tx.calls.slice(0, 2).map((c) => c.values)).toEqual([
      ['a', TENANT],
      ['b', TENANT],
    ]);
    expect(tx.calls[2].sql).toMatch(/AND "useStock" = true/);
    expect(alerts.rearm.mock.calls).toEqual([]);
    expect(alerts.seedAndFlip.mock.calls).toEqual([]);
  });

  it('does NOT re-arm when newQuantity === minQuantity (strict boundary)', async () => {
    const tx = makeTxMock();
    // restock lands us exactly on min: new=3, min=3 → NOT > min → no rearm
    tx.setResponses([[{ newQuantity: 3, minQuantity: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

    await repo.incrementStockForRestock([{ productId: 'prod-1', quantity: 1 }]);

    expect(alertState.rearm).not.toHaveBeenCalled();
    expect(tx.calls).toHaveLength(2); // qualified parent lock + restock UPDATE; no flip
  });

  it('re-arms when newQuantity > minQuantity (strict > precondition met)', async () => {
    const tx = makeTxMock();
    tx.setResponses([[{ newQuantity: 5, minQuantity: 3 }]]);

    const tenantPrisma = makeTenantPrismaForTx(tx);
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
  it('incrementStockForRestock THROWS when called outside an ambient transaction', async () => {
    // Mirror guard for the restock path — leaving the rearm dangling
    // would block the next alert forever.
    const tx = makeTxMock();
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(tx),
      getTenantId: jest.fn().mockReturnValue(TENANT),
      isInTransaction: jest.fn().mockReturnValue(false),
    };
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
    const alertState = makeStockAlertRepo();

    const repo = new PrismaProductRepository(tenantPrisma as any, alertState);

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
