import { Prisma, PrismaClient } from '@prisma/client';
import { emptyDocument } from '../domain/document';
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
