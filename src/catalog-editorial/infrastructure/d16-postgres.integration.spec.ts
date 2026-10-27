import { d16Postgres, D16Database } from './d16-postgres-runner';

let db: D16Database;
beforeAll(async () => {
  db = await d16Postgres();
});
afterAll(async () => {
  await db?.close();
});

it('admits two independent connections to exactly one synthetic schema', async () => {
  const first = await db.first.$queryRaw<
    { database: string; schema: string; pid: number }[]
  >`SELECT current_database() AS database, current_schema() AS schema, pg_backend_pid() AS pid`;
  const second = await db.second.$queryRaw<
    typeof first
  >`SELECT current_database() AS database, current_schema() AS schema, pg_backend_pid() AS pid`;
  expect(first[0].database).toBe('catalog_d16_isolated');
  expect(first[0].schema).toMatch(/^ce_d16_[a-f0-9]{32}$/);
  expect(second[0].database).toBe(first[0].database);
  expect(second[0].schema).toBe(first[0].schema);
  expect(second[0].pid).not.toBe(first[0].pid);
});
it('shares committed synthetic prerequisites and keeps rolled-back changes absent', async () => {
  await db.first
    .$executeRaw`INSERT INTO products (id, "tenantId", name) VALUES ('p', 't', 'Synthetic')`;
  expect(
    await db.second.$queryRaw`SELECT id, "tenantId", name FROM products`,
  ).toEqual([{ id: 'p', tenantId: 't', name: 'Synthetic' }]);
  const abort = new Error('rollback');
  await expect(
    db.first.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO editorial_families VALUES ('f', 'synthetic')`;
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await db.second.$queryRaw`SELECT * FROM editorial_families`).toEqual(
    [],
  );
});
it('installs both core receipts and definitions artifacts, without records', async () => {
  expect(
    await db.second.$queryRaw`SELECT
    (SELECT count(*)::int FROM catalog_editorial_states) AS states,
    (SELECT count(*)::int FROM catalog_editorial_create_receipts) AS creates,
    (SELECT count(*)::int FROM catalog_editorial_save_receipts) AS saves,
    (SELECT count(*)::int FROM editorial_options) AS options,
    (SELECT count(*)::int FROM editorial_units) AS units`,
  ).toEqual([{ states: 0, creates: 0, saves: 0, options: 0, units: 0 }]);
});
