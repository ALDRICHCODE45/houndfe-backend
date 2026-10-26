import { Prisma, PrismaClient } from '@prisma/client';
import { emptyDocument } from '../domain/document';
import type {
  EditorialCreateAuthority,
  EditorialSaveAuthority,
  EditorialSaveRequest,
} from '../application/catalog-editorial-core';
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
    saveAuthority?: EditorialSaveAuthority,
  ) =>
    new PrismaCatalogEditorial(
      prisma,
      {
        resolve: (scope) =>
          Promise.resolve({ ...scope, activeMember: true, canRead: true }),
      },
      authority,
      saveAuthority,
    );
  const snapshot = () => prisma.$queryRaw`
    SELECT (SELECT jsonb_agg(to_jsonb(s)) FROM catalog_editorial_states s) AS states,
      (SELECT jsonb_agg(to_jsonb(r)) FROM catalog_editorial_create_receipts r) AS receipts,
      (SELECT jsonb_agg(to_jsonb(r)) FROM catalog_editorial_save_receipts r) AS saves,
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
  describe('save/CAS/replay', () => {
    const input: EditorialSaveRequest = {
      expectedCycle: 1,
      expectedRevision: 1,
      idempotencyKey: 'key',
      document: emptyDocument(),
    };
    const granted = { ...access, canSave: true };
    const authority: EditorialSaveAuthority = {
      resolve: () => Promise.resolve(granted),
    };
    const scoped: EditorialSaveAuthority = {
      resolve: (scope) =>
        Promise.resolve({
          ...granted,
          ...scope,
          documentAuthority: { ...granted.documentAuthority, ...scope },
        }),
    };
    const save = (value = input, port = authority, scope = context) =>
      core(undefined, port).save(scope, value);
    beforeEach(async () => {
      await core().create(context, request);
    });
    it('saves incomplete content, preserves Published/base and operational fields', async () => {
      await prisma.$executeRaw`UPDATE catalog_editorial_states SET
        "basePublishedRevision" = 3, "publishedRevision" = 3,
        "publishedDocument" = CAST(${JSON.stringify(emptyDocument())} AS jsonb) WHERE "productId" = 'p'`;
      const document = { ...emptyDocument(), commercialTitle: 'Editorial' };
      const result = await save({ ...input, document });
      expect(result).toEqual({
        cycle: 1,
        draft: { revision: 2, basePublishedRevision: 3, document },
        published: { revision: 3, document: emptyDocument() },
      });
      expect(await core().read(context)).toEqual(result);
      expect(
        await prisma.$queryRaw`SELECT name FROM products WHERE id = 'p'`,
      ).toEqual([{ name: 'Operational' }]);
    });
    it('replays durably before CAS without replacing a newer document', async () => {
      const original = await save();
      await save({
        ...input,
        expectedRevision: 2,
        idempotencyKey: 'next',
        document: { ...emptyDocument(), description: 'Newer' },
      });
      const before = await snapshot();
      expect(await save()).toEqual(original);
      expect(await snapshot()).toEqual(before);
    });
    it.each([
      { expectedRevision: 2 },
      { expectedCycle: 2 },
      { document: { ...emptyDocument(), description: 'Changed' } },
    ])('rejects same-key request mismatch %j', async (change) => {
      await save();
      await rejectUnchanged(() => save({ ...input, ...change }), 'CONFLICT');
    });
    it.each([
      'activeMember',
      'canSave',
      'actorId',
      'tenantId',
      'productId',
      'documentAuthority',
      'offline',
      'missing',
    ])('rechecks authority on replay: %s', async (field) => {
      await save();
      const denied = {
        ...granted,
        [field]:
          field === 'documentAuthority'
            ? { ...granted.documentAuthority, productId: 'other' }
            : false,
      };
      const port: EditorialSaveAuthority = {
        resolve: () =>
          field === 'offline'
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(
                field === 'missing' ? null : (denied as typeof granted),
              ),
      };
      await rejectUnchanged(() => save(input, port), 'FORBIDDEN');
    });
    it.each([
      { document: {} },
      { document: { ...emptyDocument(), mediaRefs: ['public'] } },
      { expectedCycle: 0 },
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { idempotencyKey: '' },
    ])('rejects malformed request unchanged: %j', async (change) => {
      await rejectUnchanged(() => save({ ...input, ...change }), 'MALFORMED');
    });
    it('checks current private references before replay and preserves media order', async () => {
      const port: EditorialSaveAuthority = {
        resolve: () =>
          Promise.resolve({
            ...granted,
            documentAuthority: {
              ...granted.documentAuthority,
              assetIds: ['a', 'b'],
            },
          }),
      };
      const value = {
        ...input,
        document: { ...emptyDocument(), mediaRefs: ['b', 'a'] },
      };
      expect((await save(value, port)).draft?.document).toEqual(value.document);
      await rejectUnchanged(() => save(value), 'MALFORMED');
      await rejectUnchanged(
        () =>
          save(
            {
              ...value,
              document: { ...value.document, mediaRefs: ['a', 'b'] },
            },
            port,
          ),
        'CONFLICT',
      );
    });
    it('rejects absent/consumed Drafts, stale revisions, stale cycles and overflow', async () => {
      await rejectUnchanged(
        () => save({ ...input, expectedRevision: 2 }),
        'CONFLICT',
      );
      await rejectUnchanged(
        () => save(input, scoped, { ...context, productId: 'q' }),
        'CONFLICT',
      );
      await prisma.$executeRaw`UPDATE catalog_editorial_states SET
        "draftRevision" = NULL, "draftDocument" = NULL WHERE "productId" = 'p'`;
      await rejectUnchanged(() => save(), 'CONFLICT');
      await core().create(context, {
        ...request,
        expectedCycle: 1,
        idempotencyKey: 'new-cycle',
      });
      await rejectUnchanged(() => save(), 'CONFLICT');
      await prisma.$executeRaw`UPDATE catalog_editorial_states SET
        "draftRevision" = 2147483647 WHERE "productId" = 'p'`;
      await rejectUnchanged(
        () =>
          save({ ...input, expectedCycle: 2, expectedRevision: 2147483647 }),
        'CONFLICT',
      );
    });
    it('isolates actor/Product/tenant keys and rejects foreign Products', async () => {
      await save();
      await rejectUnchanged(
        () => save(input, scoped, { ...context, productId: 'foreign' }),
        'NOT_FOUND',
      );
      const another = { ...context, actorId: 'another' };
      await rejectUnchanged(() => save(input, scoped, another), 'CONFLICT');
      await expect(
        save({ ...input, expectedRevision: 2 }, scoped, another),
      ).resolves.toMatchObject({ draft: { revision: 3 } });
      for (const scope of [
        { ...context, productId: 'q' },
        { ...context, productId: 'foreign', tenantId: 'other' },
      ]) {
        const createAuthority: EditorialCreateAuthority = {
          resolve: () =>
            Promise.resolve({
              ...access,
              ...scope,
              documentAuthority: { ...access.documentAuthority, ...scope },
            }),
        };
        await core(createAuthority).create(scope, request);
        await expect(save(input, scoped, scope)).resolves.toMatchObject({
          draft: { revision: 2 },
        });
      }
    });
    it.each([true, false])(
      'serializes concurrent saves; duplicate key=%s',
      async (duplicate) => {
        const outcomes = await Promise.allSettled(
          ['key', duplicate ? 'key' : 'rival'].map((idempotencyKey) =>
            save({ ...input, idempotencyKey }),
          ),
        );
        expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(
          duplicate ? 2 : 1,
        );
        if (duplicate) expect(outcomes[0]).toEqual(outcomes[1]);
        else
          expect(outcomes.find((v) => v.status === 'rejected')).toMatchObject({
            reason: new Error('CONFLICT'),
          });
        expect((await core().read(context)).draft?.revision).toBe(2);
        expect(
          await prisma.$queryRaw`SELECT count(*)::int AS n FROM catalog_editorial_save_receipts`,
        ).toEqual([{ n: 1 }]);
      },
    );
    it('rolls revision/document back if receipt insertion fails', async () => {
      await prisma.$executeRaw`ALTER TABLE catalog_editorial_save_receipts
        ADD CONSTRAINT save_proof_failure CHECK ("idempotencyKey" <> 'fail')`;
      await rejectUnchanged(
        () => save({ ...input, idempotencyKey: 'fail' }),
        'save_proof_failure',
      );
    });
  });
});
