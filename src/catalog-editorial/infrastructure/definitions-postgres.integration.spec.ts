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

describe('typed options and allowed units', () => {
  async function children() {
    return db.$queryRaw`SELECT
      (SELECT jsonb_agg(o ORDER BY "definitionId", code) FROM editorial_options o) AS options,
      (SELECT jsonb_agg(u ORDER BY id) FROM editorial_units u) AS units`;
  }
  async function rejectChild(sql: string, code: string) {
    const before = [await state(), await children()];
    await expect(db.$executeRawUnsafe(sql)).rejects.toMatchObject({
      meta: { code },
    });
    expect([await state(), await children()]).toEqual(before);
  }
  it('persists option identity with archive status and explicit null/named units', async () => {
    expect(
      await db.$executeRaw`INSERT INTO editorial_options VALUES ('single', 'single', 'red', NULL), ('multi', 'multi', 'red', NULL)`,
    ).toBe(2);
    expect(
      await db.$executeRaw`INSERT INTO editorial_units VALUES ('n', 'number', 'number', NULL), ('kg', 'number', 'number', 'kg')`,
    ).toBe(2);
    expect(await children()).toEqual([
      {
        options: [
          {
            definitionId: 'multi',
            definitionType: 'multi',
            code: 'red',
            archivedAt: null,
          },
          {
            definitionId: 'single',
            definitionType: 'single',
            code: 'red',
            archivedAt: null,
          },
        ],
        units: [
          {
            id: 'kg',
            definitionId: 'number',
            definitionType: 'number',
            unitCode: 'kg',
          },
          {
            id: 'n',
            definitionId: 'number',
            definitionType: 'number',
            unitCode: null,
          },
        ],
      },
    ]);
  });
  it.each([
    [
      "INSERT INTO editorial_options VALUES ('single', 'single', 'red', NULL)",
      '23505',
    ],
    [
      "INSERT INTO editorial_units VALUES ('duplicate-null', 'number', 'number', NULL)",
      '23505',
    ],
    [
      "INSERT INTO editorial_units VALUES ('duplicate-kg', 'number', 'number', 'kg')",
      '23505',
    ],
    [
      "INSERT INTO editorial_options VALUES ('d', 'text', 'invalid', NULL)",
      '23514',
    ],
    [
      "INSERT INTO editorial_options VALUES ('number', 'number', 'invalid', NULL)",
      '23514',
    ],
    [
      "INSERT INTO editorial_options VALUES ('d', 'single', 'invalid', NULL)",
      '23503',
    ],
    [
      "INSERT INTO editorial_options VALUES ('missing', 'single', 'invalid', NULL)",
      '23503',
    ],
    [
      "INSERT INTO editorial_units VALUES ('invalid', 'single', 'single', 'kg')",
      '23514',
    ],
    [
      "INSERT INTO editorial_units VALUES ('invalid', 'single', 'number', 'kg')",
      '23503',
    ],
    [
      "INSERT INTO editorial_units VALUES ('invalid', 'missing', 'number', 'kg')",
      '23503',
    ],
    [
      "UPDATE editorial_definitions SET type = 'text' WHERE id = 'single'",
      '23503',
    ],
    [
      "UPDATE editorial_definitions SET type = 'text' WHERE id = 'number'",
      '23503',
    ],
    ["DELETE FROM editorial_definitions WHERE id = 'single'", '23503'],
    ["DELETE FROM editorial_definitions WHERE id = 'number'", '23503'],
  ])(
    'rejects invalid child mutation and preserves all records: %s',
    rejectChild,
  );
  it('archives an option without losing or recycling its identity', async () => {
    await db.$executeRaw`UPDATE editorial_options SET "archivedAt" = TIMESTAMP '2026-10-26 00:00:00' WHERE "definitionId" = 'single' AND code = 'red'`;
    expect(
      await db.$queryRaw`SELECT code, "archivedAt" IS NOT NULL AS archived FROM editorial_options WHERE "definitionId" = 'single'`,
    ).toEqual([{ code: 'red', archived: true }]);
    await rejectChild(
      "INSERT INTO editorial_options VALUES ('single', 'single', 'red', NULL)",
      '23505',
    );
  });
  it('distinguishes legitimate unit strings from null and scopes uniqueness by definition', async () => {
    await db.$executeRaw`INSERT INTO editorial_definitions VALUES ('number2', 'other-number', 'number')`;
    expect(
      await db.$executeRaw`INSERT INTO editorial_units VALUES ('other-null', 'number2', 'number', NULL), ('literal-null', 'number', 'number', 'null')`,
    ).toBe(2);
    expect(
      await db.$queryRaw`SELECT "unitCode" FROM editorial_units WHERE "definitionId" = 'number' ORDER BY "unitCode" NULLS FIRST`,
    ).toEqual([{ unitCode: null }, { unitCode: 'kg' }, { unitCode: 'null' }]);
  });
});
