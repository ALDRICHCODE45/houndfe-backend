import { Prisma } from '@prisma/client';
import { d16Postgres, D16Database } from './d16-postgres-runner';
import { readLockedEditorialDefinitions as observe } from './prisma-locked-editorial-definitions';
import { emptyDocument, EditorialDocument } from '../domain/document';
import { validateContextualDocument } from '../domain/contextual-document';

let db: D16Database;
let firstPid: number;
let secondPid: number;
const document = (): EditorialDocument => ({
  ...emptyDocument(),
  familyCode: 'family',
  values: [
    {
      code: 'color',
      owner: 'product',
      variantId: null,
      type: 'single',
      value: 'selected',
    },
  ],
});
const refs = { tenantId: 't', productId: 'p', variantIds: [], assetIds: [] };
async function blocked(
  tx: Prisma.TransactionClient,
  waiter: number,
  holder: number,
) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await tx.$queryRaw<
      { blocked: boolean }[]
    >`SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;
    if (rows[0].blocked) return;
  }
  throw new Error('Expected database-observed lock wait');
}
beforeAll(async () => {
  db = await d16Postgres();
  [firstPid] = (
    await db.first.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
  ).map((r) => r.pid);
  [secondPid] = (
    await db.second.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
  ).map((r) => r.pid);
  await db.first
    .$executeRaw`INSERT INTO editorial_families VALUES ('f', 'family'), ('g', 'other')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_definitions VALUES ('d', 'color', 'single'), ('n', 'weight', 'number')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_bindings VALUES ('f', 'd', 'product'), ('f', 'n', 'product'), ('g', 'd', 'product'), ('g', 'n', 'product')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_options VALUES ('d', 'single', 'selected', NULL), ('d', 'single', 'unrelated', NULL)`;
  await db.first
    .$executeRaw`INSERT INTO editorial_units VALUES ('u', 'n', 'number', NULL), ('v', 'n', 'number', 'kg')`;
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.first.$executeRaw`UPDATE editorial_options SET "archivedAt" = NULL`;
});
it('captures selectors before await and returns only exact requested bindings/options/units', async () => {
  const input = document();
  const other = {
    ...emptyDocument(),
    familyCode: 'other',
    values: [
      {
        code: 'weight',
        owner: 'product',
        variantId: null,
        type: 'number',
        value: 1,
        unit: null,
      },
    ],
  };
  await db.first.$transaction(async (tx) => {
    const pending = observe(tx, [input, other]);
    input.familyCode = 'mutated';
    input.values[0].code = 'mutated';
    const snapshot = await pending;
    expect(snapshot).toEqual({
      families: [
        {
          id: 'f',
          code: 'family',
          bindings: [{ definitionId: 'd', owner: 'product' }],
        },
        {
          id: 'g',
          code: 'other',
          bindings: [{ definitionId: 'n', owner: 'product' }],
        },
      ],
      definitions: [
        {
          id: 'd',
          code: 'color',
          type: 'single',
          options: [{ code: 'selected', archived: false }],
        },
        { id: 'n', code: 'weight', type: 'number', units: [null] },
      ],
    });
  });
});
it('blocks selected archival until the observer transaction ends', async () => {
  let update: Promise<number> | undefined;
  try {
    await db.first.$transaction(async (tx) => {
      const snapshot = await observe(tx, [document()]);
      update = db.second
        .$executeRaw`UPDATE editorial_options SET "archivedAt" = now() WHERE "definitionId" = 'd' AND code = 'selected'`.then(
        (n) => n,
      );
      await blocked(tx, secondPid, firstPid);
      expect(
        validateContextualDocument(document(), refs, snapshot, null).warnings,
      ).toEqual([]);
    });
  } finally {
    if (update) expect(await update).toBe(1);
  }
  expect(
    await db.second
      .$queryRaw`SELECT "archivedAt" IS NOT NULL AS archived FROM editorial_options WHERE code = 'selected'`,
  ).toEqual([{ archived: true }]);
});
it('allows an unselected option under the same definition to update before observer release', async () => {
  await db.first.$transaction(async (tx) => {
    const snapshot = await observe(tx, [document()]);
    await db.second.$transaction(async (writer) => {
      await writer.$executeRaw`SET LOCAL lock_timeout = '1s'`;
      expect(
        await writer.$executeRaw`UPDATE editorial_options SET "archivedAt" = now() WHERE "definitionId" = 'd' AND code = 'unrelated'`,
      ).toBe(1);
    });
    expect(snapshot.definitions).toEqual([
      {
        id: 'd',
        code: 'color',
        type: 'single',
        options: [{ code: 'selected', archived: false }],
      },
    ]);
  });
});
it('waits for an earlier archive writer and observes committed archive status', async () => {
  let observation: ReturnType<typeof observe> | undefined;
  try {
    await db.second.$transaction(async (writer) => {
      await writer.$executeRaw`UPDATE editorial_options SET "archivedAt" = now() WHERE "definitionId" = 'd' AND code = 'selected'`;
      observation = db.first.$transaction((tx) => observe(tx, [document()]));
      await blocked(writer, firstPid, secondPid);
    });
  } finally {
    if (observation) {
      const snapshot = await observation;
      expect(() =>
        validateContextualDocument(document(), refs, snapshot, null),
      ).toThrow('MALFORMED');
      expect(
        validateContextualDocument(document(), refs, snapshot, document())
          .warnings,
      ).toEqual([
        {
          code: 'ARCHIVED_OPTION',
          familyId: 'f',
          definitionId: 'd',
          owner: 'product',
          variantId: null,
          optionCode: 'selected',
        },
      ]);
    }
  }
});
it('denies missing selected positives without accepting unrelated membership', async () => {
  const input = document();
  input.values[0] = {
    code: 'color',
    owner: 'product',
    variantId: null,
    type: 'single',
    value: 'missing',
  };
  await expect(
    db.first.$transaction((tx) => observe(tx, [input])),
  ).rejects.toThrow('MALFORMED');
  expect(
    await db.second
      .$queryRaw`SELECT count(*)::int AS count FROM editorial_options`,
  ).toEqual([{ count: 2 }]);
});
