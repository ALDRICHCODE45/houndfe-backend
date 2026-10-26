import { Prisma, PrismaClient } from '@prisma/client';
import { emptyDocument } from '../domain/document';
import type { EditorialCreateAuthority } from '../application/catalog-editorial-core';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { isolatedPostgres } from './isolated-postgres-runner';

const isolated = process.env.CATALOG_EDITORIAL_TEST_CONTAINER
  ? describe
  : describe.skip;
isolated('real PostgreSQL callable pure read', () => {
  let prisma: PrismaClient;
  let before: unknown;
  const context = { actorId: 'actor', tenantId: 'tenant', productId: 'p' };
  const document = { ...emptyDocument(), commercialTitle: 'Editorial only' };
  const documentJson = JSON.stringify(document);
  const read = (scope = context) =>
    new PrismaCatalogEditorial(prisma, {
      resolve: () =>
        Promise.resolve({ ...scope, activeMember: true, canRead: true }),
    }).read(scope);
  const snapshot = () => prisma.$queryRaw`
    SELECT
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY "productId") FROM catalog_editorial_states s) AS states,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM products p) AS products`;
  beforeAll(async () => {
    prisma = await isolatedPostgres();
    await prisma.$executeRaw`
      INSERT INTO products (id, "tenantId", name, description) VALUES
        ('p', 'tenant', 'Operational name', 'Operational description'),
        ('absent', 'tenant', 'Absent', NULL),
        ('consumed', 'tenant', 'Consumed', NULL),
        ('foreign', 'other', 'Foreign', NULL)`;
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO catalog_editorial_states
        ("tenantId", "productId", cycle, "draftRevision", "draftDocument")
      VALUES ('tenant', 'p', 7, 3, CAST(${documentJson} AS JSONB)),
        ('tenant', 'consumed', 9, NULL, NULL)`);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO catalog_editorial_states
        ("tenantId", "productId", cycle, "publishedRevision", "publishedDocument")
      VALUES ('other', 'foreign', 2, 4, CAST(${documentJson} AS JSONB))`);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    before = await snapshot();
  });
  afterEach(async () => {
    expect(await snapshot()).toEqual(before);
  });
  it('repeated absent reads create nothing', async () => {
    for (let i = 0; i < 2; i++) {
      await expect(read({ ...context, productId: 'absent' })).resolves.toEqual({
        cycle: null,
        draft: null,
        published: null,
      });
    }
  });
  it('projects Draft, nullable Published and durable consumed cycle', async () => {
    expect(await read()).toEqual({
      cycle: 7,
      draft: { revision: 3, basePublishedRevision: null, document },
      published: null,
    });
    expect(await read({ ...context, productId: 'consumed' })).toEqual({
      cycle: 9,
      draft: null,
      published: null,
    });
    expect(
      await read({ ...context, tenantId: 'other', productId: 'foreign' }),
    ).toEqual({ cycle: 2, draft: null, published: { revision: 4, document } });
  });
  it('rejects a foreign Product even with a matching authority snapshot', async () => {
    await expect(read({ ...context, productId: 'foreign' })).rejects.toThrow(
      'NOT_FOUND',
    );
  });
  it.each([
    null,
    { ...context, activeMember: false, canRead: true },
    { ...context, activeMember: true, canRead: false },
    { ...context, tenantId: 'other', activeMember: true, canRead: true },
    { ...context, productId: 'foreign', activeMember: true, canRead: true },
  ])('denies authority %j without modifying storage', async (access) => {
    const core = new PrismaCatalogEditorial(prisma, {
      resolve: () => Promise.resolve(access),
    });
    await expect(core.read(context)).rejects.toThrow('FORBIDDEN');
  });
  it('denies an unavailable authority without exposing present state', async () => {
    const core = new PrismaCatalogEditorial(prisma, {
      resolve: () => Promise.reject(new Error('offline')),
    });
    await expect(core.read(context)).rejects.toThrow('FORBIDDEN');
  });
  it.each([
    [Prisma.sql`('tenant', 'p', 1)`, '23505'],
    [Prisma.sql`('other', 'p', 1)`, '23503'],
    [Prisma.sql`('tenant', 'absent', 0)`, '23514'],
  ])(
    'enforces identity, tenant FK and cycle constraints',
    async (values, code) => {
      await expect(
        prisma.$executeRaw(Prisma.sql`
        INSERT INTO catalog_editorial_states ("tenantId", "productId", cycle)
        VALUES ${values}`),
      ).rejects.toMatchObject({ code: 'P2010', meta: { code } });
    },
  );
  it.each([
    Prisma.sql`"draftRevision"`,
    Prisma.sql`"publishedRevision"`,
    Prisma.sql`"basePublishedRevision"`,
  ])('rejects unpaired revision data', async (column) => {
    await expect(
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO catalog_editorial_states ("tenantId", "productId", cycle, ${column})
        VALUES ('tenant', 'absent', 1, 1)`),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
  });
});

isolated('real PostgreSQL atomic create and durable receipts', () => {
  let prisma: PrismaClient;
  const context = { actorId: 'actor', tenantId: 'tenant', productId: 'p' };
  const request = {
    expectedCycle: null,
    idempotencyKey: 'key',
    document: emptyDocument(),
  };
  const access = {
    ...context,
    activeMember: true,
    canCreate: true,
    documentAuthority: {
      tenantId: 'tenant',
      productId: 'p',
      variantIds: [],
      assetIds: [],
      families: [],
    },
  };
  const core = (
    authority: EditorialCreateAuthority = {
      resolve: () => Promise.resolve(access),
    },
  ) =>
    new PrismaCatalogEditorial(
      prisma,
      {
        resolve: (scope) =>
          Promise.resolve({ ...scope, activeMember: true, canRead: true }),
      },
      authority,
    );
  const snapshot = () => prisma.$queryRaw`
    SELECT (SELECT jsonb_agg(to_jsonb(s)) FROM catalog_editorial_states s) AS states,
      (SELECT jsonb_agg(to_jsonb(r)) FROM catalog_editorial_create_receipts r) AS receipts,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM products p) AS products`;
  const rejectUnchanged = async (
    operation: () => Promise<unknown>,
    error: string,
  ) => {
    const before = await snapshot();
    await expect(operation()).rejects.toThrow(error);
    expect(await snapshot()).toEqual(before);
  };
  afterEach(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    prisma = await isolatedPostgres();
    await prisma.$executeRaw`INSERT INTO products (id, "tenantId", name) VALUES
      ('p', 'tenant', 'Operational'), ('foreign', 'other', 'Foreign'), ('q', 'tenant', 'Q')`;
  });
  it('creates an incomplete Draft and durable replay without operational backwrite', async () => {
    const result = {
      cycle: 1,
      draft: {
        revision: 1,
        basePublishedRevision: null,
        document: emptyDocument(),
      },
      published: null,
    };
    await expect(core().create(context, request)).resolves.toEqual(result);
    const before = await snapshot();
    await expect(core().create(context, request)).resolves.toEqual(result);
    expect(await snapshot()).toEqual(before);
    expect(await core().read(context)).toEqual(result);
    expect(
      await prisma.$queryRaw`SELECT name FROM products WHERE id = 'p'`,
    ).toEqual([{ name: 'Operational' }]);
  });
  it('rejects mismatched receipt payload and cycle, and another key on an active Draft', async () => {
    await core().create(context, request);
    for (const change of [
      { document: { ...emptyDocument(), commercialTitle: 'changed' } },
      { expectedCycle: 1 },
      { idempotencyKey: 'different' },
    ]) {
      await rejectUnchanged(
        () => core().create(context, { ...request, ...change }),
        'CONFLICT',
      );
    }
  });
  it.each([
    'tenantId',
    'productId',
    'actorId',
    'activeMember',
    'canCreate',
    'documentAuthority',
    'offline',
    'missing',
  ])('checks current authority on replay: %s', async (field) => {
    await core().create(context, request);
    const denied = {
      ...access,
      [field]:
        field === 'documentAuthority'
          ? { ...access.documentAuthority, tenantId: 'other' }
          : false,
    };
    const authority: EditorialCreateAuthority = {
      resolve: () =>
        field === 'offline'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(
              field === 'missing' ? null : (denied as typeof access),
            ),
    };
    await rejectUnchanged(
      () => core(authority).create(context, request),
      'FORBIDDEN',
    );
  });
  it('rejects cross-tenant Products, malformed content and stale initial cycles without writes', async () => {
    const foreign = { ...context, productId: 'foreign' };
    await rejectUnchanged(() => core().create(foreign, request), 'FORBIDDEN');
    const authority: EditorialCreateAuthority = {
      resolve: (scope) =>
        Promise.resolve({
          ...access,
          ...scope,
          documentAuthority: {
            ...access.documentAuthority,
            productId: scope.productId,
          },
        }),
    };
    await rejectUnchanged(
      () => core(authority).create(foreign, request),
      'NOT_FOUND',
    );
    for (const change of [
      { document: {} },
      { document: { ...emptyDocument(), mediaRefs: ['public-upload'] } },
      { expectedCycle: -1 },
      { idempotencyKey: '' },
    ]) {
      await rejectUnchanged(
        () => core().create(context, { ...request, ...change }),
        'MALFORMED',
      );
    }
    await rejectUnchanged(
      () => core().create(context, { ...request, expectedCycle: 1 }),
      'CONFLICT',
    );
  });
  it('serializes duplicate requests across independent transaction connections', async () => {
    const results = await Promise.all([
      core().create(context, request),
      core().create(context, request),
    ]);
    expect(results[0]).toEqual(results[1]);
    const before = await snapshot();
    const outcomes = await Promise.allSettled(
      ['a', 'b'].map((idempotencyKey) =>
        core().create(context, { ...request, idempotencyKey }),
      ),
    );
    expect(outcomes.every((v) => v.status === 'rejected')).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
  it('allows exactly one competing new key to create the absent Draft', async () => {
    const outcomes = await Promise.allSettled(
      ['a', 'b'].map((idempotencyKey) =>
        core().create(context, { ...request, idempotencyKey }),
      ),
    );
    expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: new Error('CONFLICT') }),
    ]);
    expect(await core().read(context)).toMatchObject({ cycle: 1 });
    expect(
      await prisma.$queryRaw`SELECT count(*)::int AS n
      FROM catalog_editorial_create_receipts`,
    ).toEqual([{ n: 1 }]);
  });
  it('preserves consumed cycles and Published, never resurrecting via old receipt', async () => {
    const original = await core().create(context, request);
    await prisma.$executeRaw`UPDATE catalog_editorial_states SET "draftRevision" = NULL,
      "draftDocument" = NULL, "publishedRevision" = 4, "publishedDocument" = '{}'::jsonb
      WHERE "tenantId" = 'tenant' AND "productId" = 'p'`;
    await rejectUnchanged(
      () => core().create(context, { ...request, idempotencyKey: 'stale' }),
      'CONFLICT',
    );
    const before = await snapshot();
    expect(await core().create(context, request)).toEqual(original);
    expect(await snapshot()).toEqual(before);
    const next = await core().create(context, {
      ...request,
      expectedCycle: 1,
      idempotencyKey: 'next',
    });
    expect(next.cycle).toBe(2);
    expect(next.draft?.basePublishedRevision).toBe(4);
    expect(next.published).toEqual({ revision: 4, document: {} });
    await rejectUnchanged(
      () =>
        core().create(context, {
          ...request,
          expectedCycle: 1,
          idempotencyKey: 'aba',
        }),
      'CONFLICT',
    );
  });
  it('preserves ordered private refs and revalidates them on replay', async () => {
    const document = { ...emptyDocument(), mediaRefs: ['b', 'a'] };
    const allowed = {
      ...access,
      documentAuthority: { ...access.documentAuthority, assetIds: ['a', 'b'] },
    };
    const authority: EditorialCreateAuthority = {
      resolve: () => Promise.resolve(allowed),
    };
    const input = { ...request, document };
    const created = await core(authority).create(context, input);
    expect(created.draft?.document).toEqual(document);
    await rejectUnchanged(() => core().create(context, input), 'MALFORMED');
    await rejectUnchanged(
      () =>
        core(authority).create(context, {
          ...input,
          document: { ...document, mediaRefs: ['a', 'b'] },
        }),
      'CONFLICT',
    );
  });
  it('rolls state back if durable receipt insertion fails', async () => {
    await prisma.$executeRaw`ALTER TABLE catalog_editorial_create_receipts ADD CONSTRAINT proof_failure CHECK ("idempotencyKey" <> 'fail')`;
    await rejectUnchanged(
      () => core().create(context, { ...request, idempotencyKey: 'fail' }),
      'proof_failure',
    );
  });
  it('scopes keys to actor, tenant and Product rather than globally', async () => {
    await core().create(context, request);
    const scoped: EditorialCreateAuthority = {
      resolve: (scope) =>
        Promise.resolve({
          ...access,
          ...scope,
          documentAuthority: { ...access.documentAuthority, ...scope },
        }),
    };
    await rejectUnchanged(
      () => core(scoped).create({ ...context, actorId: 'another' }, request),
      'CONFLICT',
    );
    for (const scope of [
      { ...context, productId: 'q' },
      { ...context, tenantId: 'other', productId: 'foreign' },
    ]) {
      await expect(core(scoped).create(scope, request)).resolves.toMatchObject({
        cycle: 1,
      });
    }
  });
});
