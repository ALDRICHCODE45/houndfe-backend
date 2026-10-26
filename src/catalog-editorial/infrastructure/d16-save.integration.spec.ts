import { Prisma, PrismaClient } from '@prisma/client';
import { d16Postgres, D16Database } from './d16-postgres-runner';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { emptyDocument } from '../domain/document';

let db: D16Database;
const scope = { actorId: 'actor', tenantId: 't', productId: 'p' };
const original = {
  ...emptyDocument(),
  familyCode: 'f',
  mediaRefs: ['private'],
  values: [
    {
      code: 'color',
      owner: 'product',
      variantId: null,
      type: 'single',
      value: 'old',
    },
  ],
};
const request = {
  expectedCycle: 1,
  expectedRevision: 1,
  idempotencyKey: 'save',
  document: original,
};
const access = () => ({
  ...scope,
  activeMember: true,
  canSave: true,
  documentAuthority: {
    ...scope,
    variantIds: [],
    assetIds: ['private'],
    families: [
      {
        code: 'f',
        attributes: [
          {
            code: 'color',
            owner: 'product' as const,
            type: 'single' as const,
            codes: ['new'],
          },
        ],
      },
    ],
  },
});
const core = (grant = access(), client = db.first) =>
  new PrismaCatalogEditorial(
    client,
    {
      resolve: () =>
        Promise.resolve({ ...scope, activeMember: true, canRead: true }),
    },
    undefined,
    { resolve: () => Promise.resolve(grant) },
  );
const snapshot = () => db.second.$queryRaw`SELECT
  (SELECT jsonb_agg(to_jsonb(s)) FROM catalog_editorial_states s) AS states,
  (SELECT jsonb_agg(to_jsonb(r)) FROM catalog_editorial_save_receipts r) AS receipts,
  (SELECT jsonb_agg(to_jsonb(p)) FROM products p) AS products`;
async function rejectUnchanged(
  attempt: () => Promise<unknown>,
  message: string,
) {
  const before = await snapshot();
  await expect(attempt()).rejects.toThrow(message);
  expect(await snapshot()).toEqual(before);
}
beforeAll(async () => {
  db = await d16Postgres();
  await db.first
    .$executeRaw`INSERT INTO products (id, "tenantId", name) VALUES ('p', 't', 'Operational')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_families VALUES ('family', 'f'), ('other', 'g')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_definitions VALUES ('definition', 'color', 'single')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_bindings VALUES ('family', 'definition', 'product'), ('other', 'definition', 'product')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_options VALUES ('definition', 'single', 'old', now()), ('definition', 'single', 'new', NULL)`;
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.first.$executeRaw`DELETE FROM catalog_editorial_save_receipts`;
  await db.first.$executeRaw`DELETE FROM catalog_editorial_states`;
  await db.first
    .$executeRaw`INSERT INTO catalog_editorial_states ("tenantId", "productId", cycle, "draftRevision", "draftDocument") VALUES ('t', 'p', 1, 1, CAST(${JSON.stringify(original)} AS jsonb))`;
});
it('conserves archived values from locked persisted Draft and returns warnings', async () => {
  const result = await core().save(scope, request);
  expect(result).toEqual({
    cycle: 1,
    draft: { revision: 2, basePublishedRevision: null, document: original },
    published: null,
    warnings: [
      {
        code: 'ARCHIVED_OPTION',
        familyId: 'family',
        definitionId: 'definition',
        owner: 'product',
        variantId: null,
        optionCode: 'old',
      },
    ],
  });
  expect((await core().read(scope)).draft).toEqual(result.draft);
  expect(await db.second.$queryRaw`SELECT name FROM products`).toEqual([
    { name: 'Operational' },
  ]);
});
it('rejects moved, caller-baseline and reintroduced archived assignments unchanged', async () => {
  await rejectUnchanged(
    () =>
      core().save(scope, {
        ...request,
        document: { ...original, familyCode: 'g' },
      }),
    'MALFORMED',
  );
  await rejectUnchanged(
    () =>
      core().save(scope, { ...request, baseline: original } as typeof request),
    'MALFORMED',
  );
  await core().save(scope, {
    ...request,
    document: { ...original, values: [] },
  });
  await rejectUnchanged(
    () =>
      core().save(scope, {
        ...request,
        expectedRevision: 2,
        idempotencyKey: 'readd',
      }),
    'MALFORMED',
  );
});
it('replays matching persisted success without restoring a newer Draft and rechecks current gates', async () => {
  const result = await core().save(scope, request);
  await core().save(scope, {
    ...request,
    expectedRevision: 2,
    idempotencyKey: 'next',
    document: { ...original, values: [] },
  });
  const before = await snapshot();
  expect(await core().save(scope, request)).toEqual(result);
  expect(await snapshot()).toEqual(before);
  await rejectUnchanged(
    () =>
      core().save(scope, {
        ...request,
        document: { ...original, commercialTitle: 'different' },
      }),
    'CONFLICT',
  );
  await rejectUnchanged(
    () => core({ ...access(), canSave: false }).save(scope, request),
    'FORBIDDEN',
  );
  const revoked = access();
  revoked.documentAuthority.assetIds = [];
  await rejectUnchanged(() => core(revoked).save(scope, request), 'MALFORMED');
});
it.each(['result-document', 'published', 'revision'])(
  'denies corrupted persisted receipt %s before disclosure without writes',
  async (kind) => {
    await core().save(scope, request);
    const path =
      kind === 'result-document'
        ? ['draft', 'document', 'commercialTitle']
        : kind === 'published'
          ? ['published']
          : ['draft', 'revision'];
    const value =
      kind === 'result-document'
        ? 'changed'
        : kind === 'published'
          ? { revision: 1, document: {} }
          : 99;
    await db.first.$executeRaw(
      Prisma.sql`UPDATE catalog_editorial_save_receipts SET result = jsonb_set(result, ${path}::text[], ${JSON.stringify(value)}::jsonb)`,
    );
    await rejectUnchanged(() => core().save(scope, request), 'MALFORMED');
  },
);
it('denies malformed persisted Published before fresh save without writes', async () => {
  await db.first
    .$executeRaw`UPDATE catalog_editorial_states SET "publishedRevision" = 1, "publishedDocument" = '{}'::jsonb`;
  await rejectUnchanged(() => core().save(scope, request), 'MALFORMED');
});
it('holds selected vocabulary locks through the actual state write', async () => {
  let archival: Promise<number> | undefined;
  const [{ pid: writerPid }] = await db.second.$queryRaw<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`;
  const client = {
    $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      db.first.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const wrapped = new Proxy(tx, {
          get(target, key) {
            if (key !== '$executeRaw') return Reflect.get(target, key);
            return async (sql: Prisma.Sql) => {
              if (sql.text.includes('UPDATE "catalog_editorial_states"')) {
                archival = db.second
                  .$executeRaw`UPDATE editorial_options SET "archivedAt" = now() WHERE "definitionId" = 'definition' AND code = 'old'`.then(
                  (n) => n,
                );
                let waiting = false;
                for (let attempt = 0; attempt < 250 && !waiting; attempt++) {
                  const rows = await tx.$queryRaw<
                    { waiting: boolean }[]
                  >`SELECT ${pid}::int = ANY(pg_blocking_pids(${writerPid}::int)) AS waiting`;
                  waiting = rows[0].waiting;
                }
                expect(waiting).toBe(true);
              }
              return target.$executeRaw(sql);
            };
          },
        });
        return work(wrapped);
      }),
  } as unknown as PrismaClient;
  try {
    expect(
      (await core(access(), client).save(scope, request)).draft?.revision,
    ).toBe(2);
  } finally {
    if (archival) expect(await archival).toBe(1);
  }
});
