import type { PrismaClient } from '@prisma/client';
import { withEditorialReferenceDatabase } from './editorial-reference-experiment-runner';

const live =
  process.env.EDITORIAL_REFERENCE_SQL === '1' ? describe : describe.skip;
type Outcome = { count: number } | { code: string };
const execute = async (client: PrismaClient, sql: string): Promise<Outcome> => {
  try {
    return { count: await client.$executeRawUnsafe(sql) };
  } catch (error) {
    const code = (error as { meta?: { code?: string } }).meta?.code;
    if (!code) throw error;
    return { code };
  }
};
async function begin(client: PrismaClient) {
  await client.$executeRawUnsafe('BEGIN ISOLATION LEVEL READ COMMITTED');
  for (const setting of [
    "lock_timeout = '2000ms'",
    "statement_timeout = '2500ms'",
    "idle_in_transaction_session_timeout = '3000ms'",
  ])
    await client.$executeRawUnsafe(`SET LOCAL ${setting}`);
}
async function sources(client: PrismaClient) {
  await client.$executeRawUnsafe(
    'LOCK TABLE private_media_assets IN SHARE MODE',
  );
  await client.$executeRawUnsafe('LOCK TABLE variants IN SHARE MODE');
  const locks = await client.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname AS name FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
     WHERE l.pid = pg_backend_pid() AND l.mode = 'ShareLock' AND l.granted
       AND c.relname IN ('private_media_assets', 'variants') ORDER BY c.relname`,
  );
  expect(locks).toEqual([
    { name: 'private_media_assets' },
    { name: 'variants' },
  ]);
}
async function product(client: PrismaClient) {
  await client.$queryRawUnsafe(
    "SELECT id FROM products WHERE id = 'p' FOR UPDATE",
  );
}
async function snapshot(client: PrismaClient) {
  return client.$queryRawUnsafe(`SELECT
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM variants v) AS variants,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM private_media_assets m) AS media,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM products p) AS products,
    (SELECT jsonb_agg(to_jsonb(s)) FROM experiment_state s) AS state,
    (SELECT jsonb_agg(to_jsonb(r)) FROM experiment_receipts r) AS receipts`);
}
async function dirty(client: PrismaClient) {
  await client.$executeRawUnsafe(
    'UPDATE experiment_state SET revision = revision + 1',
  );
  await client.$executeRawUnsafe('INSERT INTO experiment_receipts VALUES (1)');
}
// Each case owns two real single-connection clients; no retired harness imports.
async function fixture(
  work: (
    a: PrismaClient,
    b: PrismaClient,
    pending: Promise<unknown>[],
  ) => Promise<void>,
) {
  await withEditorialReferenceDatabase(async ({ first: a, second: b }) => {
    const pending: Promise<unknown>[] = [];
    const peerPid = await pid(b);
    try {
      for (const sql of [
        'CREATE TABLE products (id text PRIMARY KEY, "tenantId" text NOT NULL)',
        'CREATE TABLE variants (id text PRIMARY KEY, "productId" text REFERENCES products(id) ON DELETE CASCADE, "tenantId" text NOT NULL)',
        'CREATE TABLE private_media_assets (id text PRIMARY KEY, "productId" text REFERENCES products(id) ON DELETE CASCADE, "tenantId" text NOT NULL)',
        'CREATE TABLE experiment_state (revision integer)',
        'CREATE TABLE experiment_receipts (id integer)',
        "INSERT INTO products VALUES ('p', 't'), ('foreign', 'other')",
        "INSERT INTO variants VALUES ('v', 'p', 't')",
        "INSERT INTO private_media_assets VALUES ('m', 'p', 't'), ('foreign-m', 'foreign', 'other')",
        'INSERT INTO experiment_state VALUES (1)',
      ])
        await a.$executeRawUnsafe(sql);
      await work(a, b, pending);
    } finally {
      // Bound pending SQL settles on its session timeout, even after assertion failure.
      const settled = await Promise.allSettled(pending);
      const rollback = await Promise.allSettled(
        [a, b].map((c) => c.$executeRawUnsafe('ROLLBACK')),
      );
      const failed = [...settled, ...rollback].find(
        (r) => r.status === 'rejected',
      );
      expect(failed).toBeUndefined();
      const sessions = await a.$queryRawUnsafe<{ state: string }[]>(
        'SELECT state FROM pg_stat_activity WHERE pid = $1',
        peerPid,
      );
      expect(sessions).toEqual([{ state: 'idle' }]);
    }
  });
}
async function pid(client: PrismaClient) {
  const [row] = await client.$queryRawUnsafe<{ pid: number }[]>(
    'SELECT pg_backend_pid() AS pid',
  );
  return row.pid;
}
async function waiting(
  observer: PrismaClient,
  blocked: number,
  blocker: number,
) {
  const deadline = Date.now() + 700;
  do {
    const [row] = await observer.$queryRawUnsafe<
      { edge: boolean; lock: boolean; wait: string | null }[]
    >(`SELECT ${blocker} = ANY(pg_blocking_pids(${blocked})) AS edge,
       EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${blocked} AND NOT granted) AS lock,
       (SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${blocked}) AS wait`);
    if (row.edge && row.lock && row.wait === 'Lock') return true;
  } while (Date.now() < deadline);
  return false;
}

live('isolated source-table SHARE hypothesis (not core semantic proof)', () => {
  test('unsafe baseline: Product row lock does not prevent deletion to empty', async () => {
    await fixture(async (a, b) => {
      await begin(a);
      await product(a);
      expect(await execute(b, "DELETE FROM variants WHERE id = 'v'")).toEqual({
        count: 1,
      });
      expect(await a.$queryRawUnsafe('SELECT id FROM variants')).toEqual([]);
    });
  });
  test.each([
    [
      'insert into empty',
      'DELETE FROM variants',
      "INSERT INTO variants VALUES ('new', 'p', 't')",
      0,
      1,
    ],
    ['delete to empty', '', "DELETE FROM variants WHERE id = 'v'", 1, 0],
    [
      'requalify out',
      '',
      "UPDATE variants SET \"productId\" = 'foreign', \"tenantId\" = 'other' WHERE id = 'v'",
      1,
      0,
    ],
    [
      'requalify into empty',
      'UPDATE variants SET "productId" = \'foreign\', "tenantId" = \'other\'',
      "UPDATE variants SET \"productId\" = 'p', \"tenantId\" = 't' WHERE id = 'v'",
      0,
      1,
    ],
    [
      'foreign product/tenant insert',
      '',
      "INSERT INTO variants VALUES ('foreign-v', 'foreign', 'other')",
      1,
      1,
    ],
    [
      'media insert into empty',
      "DELETE FROM private_media_assets WHERE id = 'm'",
      "INSERT INTO private_media_assets VALUES ('new', 'p', 't')",
      0,
      1,
    ],
    [
      'media delete to empty',
      '',
      "DELETE FROM private_media_assets WHERE id = 'm'",
      1,
      0,
    ],
    [
      'media requalify out',
      '',
      "UPDATE private_media_assets SET \"productId\" = 'foreign', \"tenantId\" = 'other' WHERE id = 'm'",
      1,
      0,
    ],
    [
      'media requalify into empty',
      "UPDATE private_media_assets SET \"productId\" = 'foreign', \"tenantId\" = 'other' WHERE id = 'm'",
      "UPDATE private_media_assets SET \"productId\" = 'p', \"tenantId\" = 't' WHERE id = 'm'",
      0,
      1,
    ],
    [
      'foreign media delete',
      '',
      "DELETE FROM private_media_assets WHERE id = 'foreign-m'",
      1,
      1,
    ],
  ])(
    '%s blocks then releases',
    async (_name, setup, mutation, before, after) => {
      await fixture(async (a, b, pending) => {
        if (setup) await a.$executeRawUnsafe(String(setup));
        const bPid = await pid(b);
        await begin(a);
        await sources(a);
        await product(a);
        const aPid = await pid(a);
        // Identifier chosen solely from two literal experimental source names.
        const table = String(mutation).includes('private_media_assets')
          ? 'private_media_assets'
          : 'variants';
        const count = async (c: PrismaClient) => {
          const [row] = await c.$queryRawUnsafe<{ count: number }[]>(
            `SELECT count(*)::int AS count FROM ${table} WHERE "productId" = 'p' AND "tenantId" = 't'`,
          );
          return row.count;
        };
        expect(await count(a)).toBe(before);
        const operation = execute(b, String(mutation));
        pending.push(operation);
        expect(await waiting(a, bPid, aPid)).toBe(true);
        expect(await count(a)).toBe(before);
        await a.$executeRawUnsafe('ROLLBACK');
        expect(await operation).toEqual({ count: 1 });
        expect(await count(b)).toBe(after);
        // No integrity promise after later independent mutation: operation DID commit.
      });
    },
  );

  test.each([
    ['lock timeout', "SET LOCAL lock_timeout = '100ms'", '55P03'],
    ['statement timeout', "SET LOCAL statement_timeout = '100ms'", '57014'],
  ])(
    '%s rolls back state, receipt and rejected source effects',
    async (_name, setting, code) => {
      await fixture(async (a, b, pending) => {
        const before = await snapshot(a);
        await begin(a);
        await sources(a);
        await product(a);
        await begin(b);
        await dirty(b);
        await b.$executeRawUnsafe(String(setting));
        const operation = execute(
          b,
          "UPDATE variants SET \"tenantId\" = 'other' WHERE id = 'v'",
        );
        pending.push(operation);
        expect(await operation).toEqual({ code });
        expect(await execute(b, 'SELECT 1')).toEqual({ code: '25P02' });
        await b.$executeRawUnsafe('ROLLBACK');
        await a.$executeRawUnsafe('ROLLBACK');
        expect(await snapshot(a)).toEqual(before);
      });
    },
  );

  test('source-first versus Product-first forms a real deadlock; both rollback', async () => {
    await fixture(async (a, b, pending) => {
      const before = await snapshot(a);
      await begin(a);
      await sources(a);
      await dirty(a);
      await begin(b);
      await product(b);
      const aPid = await pid(a);
      const bPid = await pid(b);
      const mutation = execute(
        b,
        "UPDATE variants SET \"tenantId\" = 'other' WHERE id = 'v'",
      );
      pending.push(mutation);
      expect(await waiting(a, bPid, aPid)).toBe(true);
      const rowLock = execute(
        a,
        "UPDATE products SET \"tenantId\" = 'changed' WHERE id = 'p'",
      );
      pending.push(rowLock);
      const results = await Promise.all([mutation, rowLock]);
      expect(results.filter((r) => 'code' in r)).toEqual([{ code: '40P01' }]);
      expect(results.filter((r) => 'count' in r)).toEqual([{ count: 1 }]);
      await a.$executeRawUnsafe('ROLLBACK');
      await b.$executeRawUnsafe('ROLLBACK');
      expect(await snapshot(a)).toEqual(before);
    });
  });
});
