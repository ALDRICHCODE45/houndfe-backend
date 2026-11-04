/**
 * PrismaProductRepository — adapter tests.
 *
 * Edit-path re-arm (`rearmAlertAfterEdit`). Charging and restocking live in
 * the stock journal (O1).
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
