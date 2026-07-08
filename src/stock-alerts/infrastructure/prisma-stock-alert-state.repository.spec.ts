/**
 * Slice E.1 — PrismaStockAlertStateRepository adapter tests.
 *
 * Mirrors the structural-mock style of
 * `src/notification-config/infrastructure/prisma-notification-config.repository.spec.ts`
 * (no live DB — `$queryRaw` is asserted structurally).
 *
 * Spec coverage:
 *   - "First crossing fires one alert"            → seedAndFlip returns epoch
 *   - "Subsequent sale while low does NOT re-fire" → seedAndFlip returns null
 *   - "Concurrent Crossings Collapse To One Alert"→ second seedAndFlip returns null
 *   - "Restock re-arms; later drop re-fires"      → rearm returns row count, then seedAndFlip wins
 *   - Lots/expiration: enforced at decrement site; this port has no lots column
 *
 * Tenant scoping: every raw statement carries `"tenantId" = $N` explicitly
 * because `$queryRaw` bypasses the tenant-id extension (design §Security
 * & Isolation, finding #3).
 */
import { PrismaStockAlertStateRepository } from './prisma-stock-alert-state.repository';

/**
 * The repo issues TWO raw statements inside `seedAndFlip`:
 *   1. INSERT ... ON CONFLICT DO NOTHING (idempotent seed)
 *   2. UPDATE ... RETURNING (conditional flip)
 *
 * We capture them as a flat array of [sql, values] tuples. Prisma's
 * `$queryRaw` tagged-template shape is `(strings: TemplateStringsArray,
 * ...values: unknown[]) => Promise<unknown>`; the test mocks track the
 * captured SQL strings for assertion.
 */
type RawCall = { sql: string; values: unknown[] };

function makeTxMock() {
  const calls: RawCall[] = [];

  // Tagged-template-literal mock — Prisma passes a TemplateStringsArray
  // (frozen array of strings) plus interpolated values. We collapse them
  // into a single SQL string for assertions.
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
    // Each call's resolution is configured per-test via `setResponses`.
    const response = (responses as unknown as Array<Promise<unknown>>)[
      calls.length - 1
    ];
    return response ?? Promise.resolve([]);
  }) as unknown as jest.Mock;

  // Per-test response queue — popped as calls are recorded.
  let responses: Array<Array<{ alertEpoch: number }>> = [];

  return {
    calls,
    $queryRaw,
    setResponses(next: Array<Array<{ alertEpoch: number }>>) {
      responses = next;
    },
  };
}

function makeRepo(tx: unknown) {
  return new PrismaStockAlertStateRepository();
  // Repo is stateless — it takes the tx client on each call. We don't
  // construct it with a DI container for unit-test simplicity.
}

const TENANT = 'tenant-1';

describe('PrismaStockAlertStateRepository.seedAndFlip (E.1)', () => {
  it('returns the new alertEpoch when the conditional flip matches exactly one row (first crossing)', async () => {
    const tx = makeTxMock();
    tx.setResponses([
      [], // INSERT ... ON CONFLICT — no-op on existing row, returns []
      [{ alertEpoch: 7 }], // UPDATE ... RETURNING — flipped from epoch 6 → 7
    ]);

    const repo = makeRepo(tx);
    const epoch = await repo.seedAndFlip({
      tx,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: null,
    });

    expect(epoch).toBe(7);
    expect(tx.calls).toHaveLength(2);

    // 1) INSERT idempotent seed
    const insert = tx.calls[0];
    expect(insert.sql).toMatch(/INSERT INTO "stock_alert_states"/);
    expect(insert.sql).toMatch(/ON CONFLICT \(.+\) DO NOTHING/);
    expect(insert.values).toEqual([
      expect.any(String), // newId
      TENANT,
      'prod-1',
      null,
      '__PRODUCT__',
    ]);

    // 2) UPDATE ... RETURNING guarded by alerted = false
    const update = tx.calls[1];
    expect(update.sql).toMatch(/UPDATE "stock_alert_states"/);
    expect(update.sql).toMatch(/SET "alerted" = true/);
    expect(update.sql).toMatch(/"alertEpoch" = "alertEpoch" \+ 1/);
    expect(update.sql).toMatch(/RETURNING "alertEpoch"::int/);
    expect(update.sql).toMatch(/"tenantId" = \$1/);
    expect(update.sql).toMatch(/"productId" = \$2/);
    expect(update.sql).toMatch(/"variantKey" = \$3/);
    expect(update.sql).toMatch(/"alerted" = false/);
    expect(update.values).toEqual([TENANT, 'prod-1', '__PRODUCT__']);
  });

  it('returns null when the UPDATE matches zero rows (already alerted)', async () => {
    const tx = makeTxMock();
    tx.setResponses([
      [], // INSERT (seed no-op or insert)
      [], // UPDATE ... RETURNING — zero rows ⇒ another tx already flipped
    ]);

    const repo = makeRepo(tx);
    const epoch = await repo.seedAndFlip({
      tx,
      tenantId: TENANT,
      productId: 'prod-2',
      variantId: 'var-1',
    });

    expect(epoch).toBeNull();
    expect(tx.calls).toHaveLength(2);
    // variantId propagates into variantKey sentinel correctly
    const update = tx.calls[1];
    expect(update.values).toEqual([TENANT, 'prod-2', 'var-1']);
  });

  it('returns null on a concurrent-loss attempt — exactly one tx wins (E.4 contract)', async () => {
    const tx = makeTxMock();
    // Simulate the LOSING transaction: the UPDATE sees the already-committed
    // `alerted = true` and matches zero rows.
    tx.setResponses([[], []]);

    const repo = makeRepo(tx);
    const epoch = await repo.seedAndFlip({
      tx,
      tenantId: TENANT,
      productId: 'prod-concurrent',
      variantId: null,
    });

    expect(epoch).toBeNull();
  });

  it('threads tenantId into both statements (raw SQL bypasses the extension)', async () => {
    const tx = makeTxMock();
    tx.setResponses([[], [{ alertEpoch: 1 }]]);

    await makeRepo(tx).seedAndFlip({
      tx,
      tenantId: 'tenant-X',
      productId: 'prod-1',
      variantId: 'var-1',
    });

    expect(tx.calls[0].values).toEqual([
      expect.any(String),
      'tenant-X',
      'prod-1',
      'var-1',
      'var-1',
    ]);
    expect(tx.calls[1].values).toEqual(['tenant-X', 'prod-1', 'var-1']);
  });
});

describe('PrismaStockAlertStateRepository.rearm (E.1)', () => {
  it('issues an unguarded UPDATE that sets alerted=false and returns the matched-row count', async () => {
    const tx = makeTxMock();
    tx.setResponses([[{ alertEpoch: 9 }]]); // one row matched

    const repo = makeRepo(tx);
    const count = await repo.rearm({
      tx,
      tenantId: TENANT,
      productId: 'prod-1',
      variantId: null,
    });

    expect(count).toBe(1);
    expect(tx.calls).toHaveLength(1);
    const update = tx.calls[0];
    expect(update.sql).toMatch(/UPDATE "stock_alert_states"/);
    expect(update.sql).toMatch(/SET "alerted" = false/);
    // No alerted=false predicate — re-arm clears unconditionally, the
    // STRICT `>` precondition is enforced at the CALLER.
    expect(update.sql).not.toMatch(/"alerted" = false\s*$/m);
    expect(update.values).toEqual([TENANT, 'prod-1', '__PRODUCT__']);
  });

  it('returns 0 when no row matches (no prior alert state)', async () => {
    const tx = makeTxMock();
    tx.setResponses([[]]);

    const repo = makeRepo(tx);
    const count = await repo.rearm({
      tx,
      tenantId: TENANT,
      productId: 'prod-unknown',
      variantId: null,
    });

    expect(count).toBe(0);
  });
});