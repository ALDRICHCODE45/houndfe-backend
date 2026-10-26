import { PrismaClient } from '@prisma/client';
import { definitionsPostgres } from './definitions-postgres-runner';

let db: PrismaClient;
beforeAll(async () => {
  db = await definitionsPostgres();
});
afterAll(async () => {
  await db?.$disconnect();
});

async function state() {
  return db.$queryRaw`SELECT
    (SELECT jsonb_agg(f ORDER BY id) FROM editorial_families f) AS families,
    (SELECT jsonb_agg(d ORDER BY id) FROM editorial_definitions d) AS definitions,
    (SELECT jsonb_agg(b ORDER BY "familyId", "definitionId") FROM editorial_bindings b) AS bindings`;
}
async function rejected(sql: string, code: string) {
  const before = await state();
  await expect(db.$executeRawUnsafe(sql)).rejects.toMatchObject({
    meta: { code },
  });
  expect(await state()).toEqual(before);
}

it('persists company-wide families and typed definitions with explicit binding owner', async () => {
  expect(
    await db.$executeRaw`INSERT INTO editorial_families VALUES ('f', 'clothes')`,
  ).toBe(1);
  expect(
    await db.$executeRaw`INSERT INTO editorial_definitions VALUES ('d', 'title', 'text')`,
  ).toBe(1);
  expect(
    await db.$executeRaw`INSERT INTO editorial_bindings VALUES ('f', 'd', 'product')`,
  ).toBe(1);
  expect(await state()).toEqual([
    {
      families: [{ id: 'f', code: 'clothes' }],
      definitions: [{ id: 'd', code: 'title', type: 'text' }],
      bindings: [{ familyId: 'f', definitionId: 'd', owner: 'product' }],
    },
  ]);
});
it.each([
  ["INSERT INTO editorial_families VALUES ('f2', 'clothes')", '23505'],
  ["INSERT INTO editorial_definitions VALUES ('d2', 'title', 'text')", '23505'],
  ["INSERT INTO editorial_bindings VALUES ('f', 'd', 'sellable')", '23505'],
  [
    "INSERT INTO editorial_definitions VALUES ('bad', 'bad', 'unknown')",
    '23514',
  ],
  [
    "INSERT INTO editorial_bindings VALUES ('missing', 'd', 'product')",
    '23503',
  ],
  [
    "INSERT INTO editorial_bindings VALUES ('f', 'missing', 'sellable')",
    '23503',
  ],
  ["UPDATE editorial_bindings SET owner = 'unknown'", '23514'],
  ["DELETE FROM editorial_families WHERE id = 'f'", '23503'],
  ["DELETE FROM editorial_definitions WHERE id = 'd'", '23503'],
])('rejects invalid mutation without changing stored records: %s', rejected);
it.each(['boolean', 'number', 'single', 'multi'])(
  'accepts definition type %s',
  async (type) => {
    expect(
      await db.$executeRaw`INSERT INTO editorial_definitions VALUES (${type}, ${type}, ${type})`,
    ).toBe(1);
  },
);
it('allows the same definition in another family with a distinct owner', async () => {
  await db.$executeRaw`INSERT INTO editorial_families VALUES ('g', 'equipment')`;
  expect(
    await db.$executeRaw`INSERT INTO editorial_bindings VALUES ('g', 'd', 'sellable')`,
  ).toBe(1);
});
