import { Prisma } from '@prisma/client';
import { emptyDocument } from '../domain/document';
import type { EditorialInitializeRequest } from '../application/catalog-editorial-core';
import {
  db,
  scope,
  request,
  document,
  access,
  core,
  snapshot,
  rejectUnchanged,
  published,
  assertOptionLock,
} from './d16-create-fixture';
const initialize = (
  input: object = request,
  grant = access(),
  client = db.first,
) => core(grant, client).initialize(scope, input as EditorialInitializeRequest);

it('initializes empty only when Published is absent and persists one result', async () => {
  const result = await initialize();
  expect(result).toEqual({
    cycle: 1,
    draft: {
      revision: 1,
      basePublishedRevision: null,
      document: emptyDocument(),
    },
    published: null,
  });
  expect(await core().read(scope)).toEqual(result);
  const before = await snapshot();
  expect(await initialize()).toEqual(result);
  expect(await snapshot()).toEqual(before);
  expect(
    await db.second
      .$queryRaw`SELECT count(*)::int AS n FROM catalog_editorial_create_receipts`,
  ).toEqual([{ n: 1 }]);
});
it('copies archived Published with exact provenance/warnings, replay never restores newer Draft', async () => {
  await published();
  const input = { ...request, expectedCycle: 2 };
  const result = await initialize(input);
  expect(result).toEqual({
    cycle: 3,
    draft: { revision: 1, basePublishedRevision: 7, document: document() },
    published: { revision: 7, document: document() },
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
  await core().save(scope, {
    expectedCycle: 3,
    expectedRevision: 1,
    idempotencyKey: 'save',
    document: { ...document(), values: [] },
  });
  const before = await snapshot();
  expect(await initialize(input)).toEqual(result);
  expect(await snapshot()).toEqual(before);
  await rejectUnchanged(
    () => initialize(input, { ...access(), canCreate: false }),
    'FORBIDDEN',
  );
  const revoked = access();
  revoked.documentAuthority.assetIds = [];
  await rejectUnchanged(() => initialize(input, revoked), 'MALFORMED');
  expect(await db.second.$queryRaw`SELECT name FROM products`).toEqual([
    { name: 'Operational' },
  ]);
});
it.each(['document', 'baseline', 'operation'])(
  'rejects caller-controlled %s unchanged',
  async (key) => {
    await rejectUnchanged(
      () => initialize({ ...request, [key]: document() }),
      'MALFORMED',
    );
  },
);
it.each(['initialize', 'create'])(
  'separates receipt requests when %s owns the key',
  async (first) => {
    const legacy = () =>
      core().create(scope, { ...request, document: emptyDocument() });
    if (first === 'initialize') {
      await initialize();
      await rejectUnchanged(legacy, 'CONFLICT');
    } else {
      await legacy();
      await rejectUnchanged(() => initialize(), 'CONFLICT');
    }
  },
);
it('rejects stale cycle, existing Draft and malformed Published without fallback', async () => {
  await published();
  await rejectUnchanged(() => initialize(), 'CONFLICT');
  await db.first
    .$executeRaw`UPDATE catalog_editorial_states SET "publishedDocument" = '{}'::jsonb`;
  await rejectUnchanged(
    () => initialize({ ...request, expectedCycle: 2 }),
    'MALFORMED',
  );
  await db.first
    .$executeRaw`UPDATE catalog_editorial_states SET "publishedDocument" = ${JSON.stringify(document())}::jsonb`;
  await initialize({ ...request, expectedCycle: 2 });
  await rejectUnchanged(
    () => initialize({ expectedCycle: 3, idempotencyKey: 'other' }),
    'CONFLICT',
  );
});
it.each(['draft', 'base', 'revision', 'cycle', 'published'])(
  'denies corrupted initialize receipt %s unchanged',
  async (kind) => {
    await published();
    const input = { ...request, expectedCycle: 2 };
    await initialize(input);
    const path =
      kind === 'draft'
        ? ['draft', 'document']
        : kind === 'base'
          ? ['draft', 'basePublishedRevision']
          : kind === 'revision'
            ? ['draft', 'revision']
            : [kind];
    const value =
      kind === 'draft'
        ? emptyDocument()
        : kind === 'published'
          ? { revision: 7, document: {} }
          : 99;
    await db.first.$executeRaw(
      Prisma.sql`UPDATE catalog_editorial_create_receipts SET result = jsonb_set(result, ${path}::text[], ${JSON.stringify(value)}::jsonb)`,
    );
    await rejectUnchanged(() => initialize(input), 'MALFORMED');
  },
);

it('holds initialize option locks through receipt insertion', async () => {
  await published();
  await assertOptionLock('old', (client) =>
    initialize({ ...request, expectedCycle: 2 }, access(), client),
  );
});
