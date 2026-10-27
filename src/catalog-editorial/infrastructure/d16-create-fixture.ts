import { Prisma, PrismaClient } from '@prisma/client';
import { d16Postgres, D16Database } from './d16-postgres-runner';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { emptyDocument, EditorialDocument } from '../domain/document';
import type { EditorialReadResult } from '../application/catalog-editorial-core';

export let db: D16Database;
export const scope = { actorId: 'actor', tenantId: 't', productId: 'p' };
export const request = {
  expectedCycle: null as number | null,
  idempotencyKey: 'init',
};
export const document = (code = 'old'): EditorialDocument => ({
  ...emptyDocument(),
  familyCode: 'f',
  mediaRefs: ['private'],
  values: [
    {
      code: 'color',
      owner: 'product',
      variantId: null,
      type: 'single',
      value: code,
    },
  ],
});
export const access = () => ({
  ...scope,
  activeMember: true,
  canCreate: true,
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
            codes: ['old', 'new', 'missing'],
          },
        ],
      },
    ],
  },
});
export const core = (grant = access(), client = db.first) =>
  new PrismaCatalogEditorial(
    client,
    {
      resolve: () =>
        Promise.resolve({ ...scope, activeMember: true, canRead: true }),
    },
    { resolve: () => Promise.resolve(grant) },
    { resolve: () => Promise.resolve(grant) },
  );
export const snapshot = () => db.second.$queryRaw`SELECT
  (SELECT jsonb_agg(to_jsonb(s)) FROM catalog_editorial_states s) AS states,
  (SELECT jsonb_agg(to_jsonb(r)) FROM catalog_editorial_create_receipts r) AS receipts,
  (SELECT jsonb_agg(to_jsonb(r)) FROM catalog_editorial_save_receipts r) AS saves,
  (SELECT jsonb_agg(to_jsonb(p)) FROM products p) AS products`;
export async function rejectUnchanged(
  attempt: () => Promise<unknown>,
  message: string,
) {
  const before = await snapshot();
  await expect(attempt()).rejects.toThrow(message);
  expect(await snapshot()).toEqual(before);
}
export const published = () => db.first
  .$executeRaw`INSERT INTO catalog_editorial_states
  ("tenantId", "productId", cycle, "publishedRevision", "publishedDocument")
  VALUES ('t', 'p', 2, 7, CAST(${JSON.stringify(document())} AS jsonb))`;
beforeAll(async () => {
  db = await d16Postgres();
  await db.first
    .$executeRaw`INSERT INTO products (id, "tenantId", name) VALUES ('p', 't', 'Operational')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_families VALUES ('family', 'f')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_definitions VALUES ('definition', 'color', 'single')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_bindings VALUES ('family', 'definition', 'product')`;
  await db.first
    .$executeRaw`INSERT INTO editorial_options VALUES ('definition', 'single', 'old', now()), ('definition', 'single', 'new', NULL)`;
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.first.$executeRaw`DELETE FROM catalog_editorial_create_receipts`;
  await db.first.$executeRaw`DELETE FROM catalog_editorial_save_receipts`;
  await db.first.$executeRaw`DELETE FROM catalog_editorial_states`;
  await db.first
    .$executeRaw`UPDATE editorial_options SET "archivedAt" = CASE WHEN code = 'old' THEN now() ELSE NULL END`;
});

/** Real two-client PostgreSQL barrier at the final receipt write, before commit. */
export async function assertOptionLock(
  code: string,
  attempt: (client: PrismaClient) => Promise<EditorialReadResult>,
) {
  let archival: Promise<number> | undefined;
  const [{ pid: writerPid }] = await db.second.$queryRaw<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`;
  // SAFETY: this seam exposes only $transaction; every query executes on the real transaction.
  const client = {
    $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      db.first.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        return work(
          new Proxy(tx, {
            get(target, key) {
              if (key !== '$executeRaw') return Reflect.get(target, key);
              return async (sql: Prisma.Sql) => {
                if (
                  sql.text.includes(
                    'INSERT INTO "catalog_editorial_create_receipts"',
                  )
                ) {
                  archival = db.second
                    .$executeRaw`UPDATE editorial_options SET "archivedAt" = now() WHERE code = ${code}`.then(
                    (n) => n,
                  );
                  let waiting = false;
                  for (let i = 0; i < 250 && !waiting; i++) {
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
          }),
        );
      }),
  } as unknown as PrismaClient;
  try {
    expect((await attempt(client)).draft?.revision).toBe(1);
  } finally {
    if (archival) expect(await archival).toBe(1);
  }
}
