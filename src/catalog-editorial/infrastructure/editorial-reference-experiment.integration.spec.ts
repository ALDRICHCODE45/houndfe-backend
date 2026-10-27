import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';
import { PrismaEditorialDefinitions } from './prisma-editorial-definitions';
import {
  emptyDocument,
  type Definition,
  type EditorialDocument,
} from '../domain/document';
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
async function sources(
  client: Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>,
) {
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
  observer: Pick<PrismaClient, '$queryRawUnsafe'>,
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

const semanticScope = { actorId: 'actor', tenantId: 't', productId: 'p' };
const semanticTables = [
  'products',
  'variants',
  'private_media_assets',
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'tenant_memberships',
  'editorial_families',
  'editorial_definitions',
  'editorial_bindings',
  'editorial_options',
  'editorial_units',
  'catalog_editorial_states',
  'catalog_editorial_create_receipts',
  'catalog_editorial_save_receipts',
] as const;
const semanticDocument = (
  option = 'new',
  variantId = 'v',
): EditorialDocument => ({
  ...emptyDocument(),
  familyCode: 'f',
  mediaRefs: ['m'],
  values: [
    {
      code: 'color',
      owner: 'sellable',
      variantId,
      type: 'single',
      value: option,
    },
  ],
});
async function semanticFixture(
  work: (f: {
    a: PrismaClient;
    b: PrismaClient;
    run: <T>(
      call: (core: PrismaCatalogEditorial) => Promise<T>,
      receiptBarrier?: boolean,
    ) => Promise<T>;
    effects: () => Promise<Record<string, unknown>>;
  }) => Promise<void>,
) {
  await withEditorialReferenceDatabase(async ({ first: a, second: b }) => {
    let peerMutation: Promise<Outcome> | undefined;
    const peerPid = await pid(b);
    const effects = async () => {
      // Identifiers come only from the closed fixture table list, never input.
      return Object.fromEntries<unknown>(
        await Promise.all(
          semanticTables.map(
            async (table) =>
              [
                table,
                await b.$queryRaw(
                  Prisma.sql`SELECT to_jsonb(x) AS row FROM ${Prisma.raw(table)} x ORDER BY to_jsonb(x)::text`,
                ),
              ] as const,
          ),
        ),
      );
    };
    try {
      // Minimal owned fixture, not production migrations; constraints mirror accepted artifacts.
      for (const sql of [
        'CREATE TABLE products (id text PRIMARY KEY, "tenantId" text NOT NULL, UNIQUE ("tenantId", id))',
        'CREATE TABLE variants (id text PRIMARY KEY, "productId" text NOT NULL REFERENCES products(id) ON DELETE CASCADE, "tenantId" text NOT NULL)',
        'CREATE TABLE private_media_assets (id text PRIMARY KEY, "tenantId" text NOT NULL, "productId" text NOT NULL, "storageKey" text NOT NULL UNIQUE, "mimeType" text NOT NULL, "sizeBytes" integer NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT now(), FOREIGN KEY ("tenantId", "productId") REFERENCES products("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE)',
        'CREATE TABLE users (id text PRIMARY KEY, "isActive" boolean NOT NULL)',
        'CREATE TABLE roles (id text PRIMARY KEY, name text NOT NULL, "tenantId" text, description text, "isSystem" boolean NOT NULL DEFAULT false, "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(), UNIQUE ("tenantId", name))',
        'CREATE TABLE permissions (id text PRIMARY KEY, subject text NOT NULL, action text NOT NULL, description text, "createdAt" timestamp(3) NOT NULL DEFAULT now(), UNIQUE (subject, action))',
        'CREATE TABLE role_permissions (id text PRIMARY KEY, "roleId" text NOT NULL REFERENCES roles(id), "permissionId" text NOT NULL REFERENCES permissions(id), UNIQUE ("roleId", "permissionId"))',
        'CREATE TABLE tenant_memberships (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES users(id), "tenantId" text NOT NULL, "roleId" text NOT NULL REFERENCES roles(id), "createdAt" timestamp(3) NOT NULL DEFAULT now(), UNIQUE ("userId", "tenantId", "roleId"))',
        'CREATE TABLE editorial_families (id text PRIMARY KEY, code text NOT NULL UNIQUE)',
        `CREATE TABLE editorial_definitions (id text PRIMARY KEY, code text NOT NULL UNIQUE, type text NOT NULL CHECK (type IN ('text','boolean','number','single','multi')), UNIQUE(id, type))`,
        `CREATE TABLE editorial_bindings ("familyId" text REFERENCES editorial_families(id) ON DELETE RESTRICT ON UPDATE RESTRICT, "definitionId" text REFERENCES editorial_definitions(id) ON DELETE RESTRICT ON UPDATE RESTRICT, owner text NOT NULL CHECK (owner IN ('product','sellable')), PRIMARY KEY ("familyId", "definitionId"))`,
        `CREATE TABLE editorial_options ("definitionId" text, "definitionType" text NOT NULL CHECK ("definitionType" IN ('single','multi')), code text, "archivedAt" timestamp(3), PRIMARY KEY ("definitionId",code), FOREIGN KEY ("definitionId","definitionType") REFERENCES editorial_definitions(id,type) ON DELETE RESTRICT ON UPDATE RESTRICT)`,
        `CREATE TABLE editorial_units (id text PRIMARY KEY, "definitionId" text NOT NULL, "definitionType" text NOT NULL DEFAULT 'number' CHECK ("definitionType" = 'number'), "unitCode" text, UNIQUE NULLS NOT DISTINCT ("definitionId","unitCode"), FOREIGN KEY ("definitionId","definitionType") REFERENCES editorial_definitions(id,type) ON DELETE RESTRICT ON UPDATE RESTRICT)`,
        `CREATE TABLE catalog_editorial_states ("tenantId" text, "productId" text, cycle integer NOT NULL CHECK (cycle > 0), "draftRevision" integer, "basePublishedRevision" integer, "draftDocument" jsonb, "publishedRevision" integer, "publishedDocument" jsonb, PRIMARY KEY ("tenantId","productId"), FOREIGN KEY ("tenantId","productId") REFERENCES products("tenantId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
          CHECK (("draftRevision" IS NULL AND "draftDocument" IS NULL AND "basePublishedRevision" IS NULL) OR ("draftRevision" > 0 AND "draftRevision" IS NOT NULL AND "draftDocument" IS NOT NULL AND jsonb_typeof("draftDocument") = 'object' AND ("basePublishedRevision" IS NULL OR "basePublishedRevision" > 0))),
          CHECK (("publishedRevision" IS NULL AND "publishedDocument" IS NULL) OR ("publishedRevision" > 0 AND "publishedRevision" IS NOT NULL AND "publishedDocument" IS NOT NULL AND jsonb_typeof("publishedDocument") = 'object')))`,
        ...['create', 'save'].map(
          (operation) =>
            `CREATE TABLE catalog_editorial_${operation}_receipts ("tenantId" text, "productId" text, "actorId" text, "idempotencyKey" text CHECK (length("idempotencyKey") BETWEEN 1 AND 200), request jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY ("tenantId","productId","actorId","idempotencyKey"), FOREIGN KEY ("tenantId","productId") REFERENCES catalog_editorial_states("tenantId","productId") ON DELETE RESTRICT ON UPDATE CASCADE)`,
        ),
        "INSERT INTO products VALUES ('p','t'), ('foreign','other'), ('same-tenant','t')",
        "INSERT INTO variants VALUES ('v','p','t'), ('v2','p','t'), ('wrong-tenant','p','other'), ('wrong-product','same-tenant','t')",
        "INSERT INTO private_media_assets (id,\"tenantId\",\"productId\",\"storageKey\",\"mimeType\",\"sizeBytes\") VALUES ('m','t','p','opaque','image/png',1), ('foreign-m','other','foreign','foreign-opaque','image/png',1), ('same-tenant-m','t','same-tenant','same-opaque','image/png',1)",
        "INSERT INTO users VALUES ('actor',true)",
        "INSERT INTO roles (id,name,\"tenantId\") VALUES ('role','editor','t')",
        "INSERT INTO permissions (id,subject,action) VALUES ('read','ProductEditorialDraft','read'), ('edit','ProductEditorialDraft','update')",
        "INSERT INTO role_permissions VALUES ('r','role','read'), ('e','role','edit')",
        "INSERT INTO tenant_memberships (id,\"userId\",\"tenantId\",\"roleId\") VALUES ('member','actor','t','role')",
        "INSERT INTO editorial_families VALUES ('family','f')",
        "INSERT INTO editorial_definitions VALUES ('definition','color','single')",
        "INSERT INTO editorial_bindings VALUES ('family','definition','sellable')",
        "INSERT INTO editorial_options VALUES ('definition','single','old',now()), ('definition','single','new',NULL)",
      ])
        await a.$executeRawUnsafe(sql);
      const run = <T>(
        call: (core: PrismaCatalogEditorial) => Promise<T>,
        receiptBarrier = false,
      ) =>
        a.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2000ms'");
            await tx.$executeRawUnsafe(
              "SET LOCAL statement_timeout = '2500ms'",
            );
            await sources(tx); // Before authority/Product/reference observation.
            const authority = new PrismaEditorialAuthority(tx, {
              resolve: async (scope) => {
                const variants = await tx.$queryRaw<
                  { id: string }[]
                >`SELECT id FROM variants WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}`;
                const assets = await tx.$queryRaw<
                  { id: string }[]
                >`SELECT id FROM private_media_assets WHERE "tenantId" = ${scope.tenantId} AND "productId" = ${scope.productId}`;
                const vocabulary = await new PrismaEditorialDefinitions(
                  tx,
                ).read();
                return {
                  ...scope,
                  variantIds: variants.map((v) => v.id),
                  assetIds: assets.map((m) => m.id),
                  families: vocabulary.families.map((family) => ({
                    code: family.code,
                    attributes: family.bindings.map((binding): Definition => {
                      const d = vocabulary.definitions.find(
                        (d) => d.id === binding.definitionId,
                      );
                      if (!d) throw new Error('Missing definition');
                      const common = { code: d.code, owner: binding.owner };
                      switch (d.type) {
                        case 'single':
                        case 'multi':
                          return {
                            ...common,
                            type: d.type,
                            codes: d.options.map((o) => o.code),
                          };
                        case 'number':
                          return { ...common, type: d.type, units: d.units };
                        default:
                          return { ...common, type: d.type };
                      }
                    }),
                  })),
                };
              },
            });
            // Only transaction dispatch is adapted. Authority uses real Prisma delegates;
            // all core queries/validation/state/receipts execute on this very transaction.
            const coreTx = new Proxy(tx, {
              get(target, key) {
                if (key !== '$executeRaw')
                  return Reflect.get(target, key) as unknown;
                return async (sql: Prisma.Sql) => {
                  if (
                    receiptBarrier &&
                    sql.text.includes(
                      'INSERT INTO "catalog_editorial_create_receipts"',
                    )
                  ) {
                    peerMutation = execute(
                      b,
                      "DELETE FROM private_media_assets WHERE id = 'foreign-m'",
                    );
                    const [backend] = await tx.$queryRaw<
                      { pid: number }[]
                    >`SELECT pg_backend_pid() AS pid`;
                    expect(await waiting(tx, peerPid, backend.pid)).toBe(true);
                  }
                  return target.$executeRaw(sql);
                };
              },
            });
            const client = {
              $transaction: (
                work: (bound: Prisma.TransactionClient) => Promise<unknown>,
              ) => work(coreTx),
            } as unknown as PrismaClient;
            return call(
              new PrismaCatalogEditorial(
                client,
                authority,
                authority.createAuthority,
                authority.saveAuthority,
              ),
            );
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 1000,
            timeout: 2800,
          },
        );
      await work({ a, b, run, effects });
    } finally {
      const settled = await Promise.allSettled(
        peerMutation ? [peerMutation] : [],
      );
      const rollback = await Promise.allSettled(
        [a, b].map((c) => c.$executeRawUnsafe('ROLLBACK')),
      );
      expect(rollback.every((r) => r.status === 'fulfilled')).toBe(true);
      if (peerMutation)
        expect(settled).toEqual([{ status: 'fulfilled', value: { count: 1 } }]);
      expect(
        await a.$queryRawUnsafe(
          'SELECT state FROM pg_stat_activity WHERE pid = $1',
          peerPid,
        ),
      ).toEqual([{ state: 'idle' }]);
    }
  });
}
async function rejectSemantic(
  f: { effects: () => Promise<unknown> },
  attempt: () => Promise<unknown>,
  message: string,
) {
  const before = await f.effects();
  await expect(attempt()).rejects.toThrow(message);
  expect(await f.effects()).toEqual(before);
}
const createRequest = (document = semanticDocument()) => ({
  expectedCycle: null,
  idempotencyKey: 'create',
  document,
});
const saveRequest = (document = semanticDocument(), expectedRevision = 1) => ({
  expectedCycle: 1,
  expectedRevision,
  idempotencyKey: `save-${expectedRevision}`,
  document,
});

live(
  'actual core through isolated transaction-bound SQL authority bridge',
  () => {
    test('core create holds source barrier through receipt write', async () => {
      await semanticFixture(async (f) => {
        const before = await f.effects();
        const result = await f.run(
          (core) => core.create(semanticScope, createRequest()),
          true,
        );
        expect(result).toEqual({
          cycle: 1,
          draft: {
            revision: 1,
            basePublishedRevision: null,
            document: semanticDocument(),
          },
          published: null,
        });
        expect(await f.run((core) => core.read(semanticScope))).toEqual(result);
        expect(
          await f.b.$queryRawUnsafe(
            'SELECT "tenantId", "productId", "actorId", "idempotencyKey", request, result FROM catalog_editorial_create_receipts',
          ),
        ).toEqual([
          {
            ...semanticScope,
            idempotencyKey: 'create',
            request: { expectedCycle: null, document: semanticDocument() },
            result,
          },
        ]);
        expect(
          await f.b.$queryRawUnsafe(
            'SELECT count(*)::int AS n FROM catalog_editorial_save_receipts',
          ),
        ).toEqual([{ n: 0 }]);
        const after = await f.effects();
        for (const table of semanticTables)
          if (
            ![
              'private_media_assets',
              'catalog_editorial_states',
              'catalog_editorial_create_receipts',
            ].includes(table)
          )
            expect(after[table]).toEqual(before[table]);
        expect(
          await f.b.$queryRawUnsafe(
            'SELECT id FROM private_media_assets ORDER BY id',
          ),
        ).toEqual([{ id: 'm' }, { id: 'same-tenant-m' }]);
      });
    });
    test('D16 conserves only the same archived assignment; create stays active-only', async () => {
      await semanticFixture(async (f) => {
        await rejectSemantic(
          f,
          () =>
            f.run((c) =>
              c.create(semanticScope, createRequest(semanticDocument('old'))),
            ),
          'MALFORMED',
        );
        const published = semanticDocument('old');
        await f.a.$executeRaw(
          Prisma.sql`INSERT INTO catalog_editorial_states ("tenantId","productId",cycle,"publishedRevision","publishedDocument") VALUES ('t','p',1,7,${JSON.stringify(published)}::jsonb)`,
        );
        const initial = await f.run((c) =>
          c.initialize(semanticScope, {
            expectedCycle: 1,
            idempotencyKey: 'initialize',
          }),
        );
        expect(initial.draft).toEqual({
          revision: 1,
          basePublishedRevision: 7,
          document: published,
        });
        expect(initial.warnings).toEqual([
          {
            code: 'ARCHIVED_OPTION',
            familyId: 'family',
            definitionId: 'definition',
            owner: 'sellable',
            variantId: 'v',
            optionCode: 'old',
          },
        ]);
        const request = { ...saveRequest(published), expectedCycle: 2 };
        const saved = await f.run((c) => c.save(semanticScope, request));
        expect(saved.draft?.revision).toBe(2);
        expect(saved.draft?.document).toEqual(published);
        expect(saved.warnings).toEqual(initial.warnings);
        expect(saved.published).toEqual({ revision: 7, document: published });
        expect(await f.run((c) => c.read(semanticScope))).toEqual({
          cycle: 2,
          draft: saved.draft,
          published: saved.published,
        });
        expect(
          await f.b.$queryRawUnsafe(
            'SELECT result FROM catalog_editorial_create_receipts',
          ),
        ).toEqual([{ result: initial }]);
        const moved = {
          ...semanticDocument('old', 'v2'),
          values: [
            ...published.values,
            ...semanticDocument('old', 'v2').values,
          ],
        };
        await rejectSemantic(
          f,
          () =>
            f.run((c) =>
              c.save(semanticScope, {
                ...request,
                expectedRevision: 2,
                idempotencyKey: 'move',
                document: moved,
              }),
            ),
          'MALFORMED',
        );
        const ownerChanged = {
          ...published,
          values: published.values.map((v) => ({
            ...v,
            owner: 'product' as const,
            variantId: null,
          })),
        };
        await rejectSemantic(
          f,
          () =>
            f.run((c) =>
              c.save(semanticScope, {
                ...request,
                expectedRevision: 2,
                idempotencyKey: 'owner',
                document: ownerChanged,
              }),
            ),
          'MALFORMED',
        );
        expect(
          await f.b.$queryRawUnsafe(
            'SELECT result FROM catalog_editorial_save_receipts',
          ),
        ).toEqual([{ result: saved }]);
      });
    });
    test('historical replay differs from current state and rechecks current permissions', async () => {
      await semanticFixture(async (f) => {
        const create = (c: PrismaCatalogEditorial) =>
          c.create(semanticScope, createRequest(emptyDocument()));
        const save = (c: PrismaCatalogEditorial) =>
          c.save(semanticScope, saveRequest(emptyDocument()));
        const created = await f.run(create);
        const saved = await f.run(save);
        const changed = { ...semanticDocument(), commercialTitle: 'later' };
        const current = await f.run((c) =>
          c.save(semanticScope, saveRequest(changed, 2)),
        );
        expect(
          await f.a.$executeRawUnsafe(
            'UPDATE editorial_options SET "archivedAt" = now() WHERE code = \'new\'',
          ),
        ).toBe(1);
        const before = await f.effects();
        expect(await f.run(create)).toEqual(created);
        expect(await f.run(save)).toEqual(saved);
        expect(await f.run((c) => c.read(semanticScope))).toEqual(current);
        expect([
          created.draft?.revision,
          saved.draft?.revision,
          current.draft?.revision,
        ]).toEqual([1, 2, 3]);
        expect(created.draft?.document).toEqual(emptyDocument());
        expect(saved.draft?.document).toEqual(emptyDocument());
        expect(current.draft?.document).toEqual(changed);
        expect(await f.effects()).toEqual(before);
        expect(
          await f.a.$executeRawUnsafe(
            "DELETE FROM role_permissions WHERE id = 'e'",
          ),
        ).toBe(1);
        for (const attempt of [() => f.run(create), () => f.run(save)])
          await rejectSemantic(f, attempt, 'FORBIDDEN');
        expect(await f.run((c) => c.read(semanticScope))).toEqual(current);
      });
    });
    test.each([
      'variants',
      'private_media_assets',
      'editorial_families',
    ] as const)(
      '%s query failure denies replay, never empty fallback',
      async (table) => {
        await semanticFixture(async (f) => {
          await f.run((c) => c.create(semanticScope, createRequest()));
          const current = await f.run((c) =>
            c.save(semanticScope, saveRequest()),
          );
          // Real undefined-column SQL failure, not a mocked authority/provider failure.
          const [alter, probe] = {
            variants: [
              'ALTER TABLE variants RENAME COLUMN "tenantId" TO unavailable',
              'SELECT "tenantId" FROM variants',
            ],
            private_media_assets: [
              'ALTER TABLE private_media_assets RENAME COLUMN "tenantId" TO unavailable',
              'SELECT "tenantId" FROM private_media_assets',
            ],
            editorial_families: [
              'ALTER TABLE editorial_families RENAME COLUMN code TO unavailable',
              'SELECT code FROM editorial_families',
            ],
          }[table];
          await f.a.$executeRawUnsafe(alter);
          // Same missing source column really raises PostgreSQL undefined_column.
          expect(await execute(f.b, probe)).toEqual({ code: '42703' });
          for (const attempt of [
            () => f.run((c) => c.create(semanticScope, createRequest())),
            () => f.run((c) => c.save(semanticScope, saveRequest())),
          ])
            await rejectSemantic(f, attempt, 'FORBIDDEN');
          expect(await f.run((c) => c.read(semanticScope))).toEqual(current);
        });
      },
    );
    test.each(['wrong-tenant', 'wrong-product', 'foreign-m', 'same-tenant-m'])(
      'rejects unqualified source %s without effects',
      async (id) => {
        await semanticFixture(async (f) => {
          const document = id.endsWith('-m')
            ? { ...semanticDocument(), mediaRefs: [id] }
            : semanticDocument('new', id);
          await rejectSemantic(
            f,
            () =>
              f.run((c) => c.create(semanticScope, createRequest(document))),
            'MALFORMED',
          );
          expect(await f.run((c) => c.read(semanticScope))).toEqual({
            cycle: null,
            draft: null,
            published: null,
          });
        });
      },
    );
    test('genuinely empty references and vocabulary permit empty create', async () => {
      await semanticFixture(async (f) => {
        for (const table of [
          'variants',
          'private_media_assets',
          'editorial_bindings',
          'editorial_options',
          'editorial_definitions',
          'editorial_families',
        ])
          await f.a.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(table)}`);
        const before = await f.effects();
        for (const table of [
          'variants',
          'private_media_assets',
          'editorial_families',
          'editorial_definitions',
        ])
          expect(before[table]).toEqual([]);
        const result = await f.run((c) =>
          c.create(semanticScope, createRequest(emptyDocument())),
        );
        expect(result).toEqual({
          cycle: 1,
          draft: {
            revision: 1,
            basePublishedRevision: null,
            document: emptyDocument(),
          },
          published: null,
        });
        expect(await f.run((c) => c.read(semanticScope))).toEqual(result);
        expect(
          await f.b.$queryRawUnsafe(
            'SELECT result FROM catalog_editorial_create_receipts',
          ),
        ).toEqual([{ result }]);
        const after = await f.effects();
        for (const table of semanticTables)
          if (
            ![
              'catalog_editorial_states',
              'catalog_editorial_create_receipts',
            ].includes(table)
          )
            expect(after[table]).toEqual(before[table]);
      });
    });
  },
);
