import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { createCoordinatedEditorialWriteAuthority } from './prisma-coordinated-editorial-authority';
import { emptyDocument, type EditorialDocument } from '../domain/document';
import type { EditorialReadResult } from '../application/catalog-editorial-core';
import { EDITORIAL_PERMISSIONS as grants } from '../domain/editorial-permissions';

const scope = { actorId: 'actor', tenantId: 'tenant', productId: 'product' };
const body = { expectedCycle: 3, expectedRevision: 2, idempotencyKey: 'key' };
const operations = ['publish', 'discard'] as const;
type Operation = (typeof operations)[number];
const titled = (): EditorialDocument => ({
  ...emptyDocument(),
  commercialTitle: '  Exact 😀 title  ',
});
const membership = (permissions = [grants.read, grants.update, grants.publish]) => [
  {
    userId: scope.actorId,
    tenantId: scope.tenantId,
    role: { permissions: permissions.map((permission) => ({ permission })) },
  },
];
const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture() {
  const events: string[] = [];
  let state: EditorialReadResult = {
    cycle: 3,
    draft: { revision: 2, basePublishedRevision: null, document: titled() },
    published: null,
  };
  const receipts = new Map<
    string,
    { request: unknown; result: EditorialReadResult }
  >();
  const members = jest.fn().mockResolvedValue(membership());
  let exists = true;
  const query = jest.fn().mockImplementation((sql: Prisma.Sql) => {
    const text = sql.sql;
    if (text.includes('FROM "products"')) {
      expect(text).toContain('FOR UPDATE');
      expect(sql.values).toEqual([scope.tenantId, scope.productId]);
      events.push('gate');
      return exists ? [{ id: scope.productId }] : [];
    }
    if (text.includes('receipts')) {
      expect(events).toContain('gate');
      events.push('receipt');
      const table = text.match(/FROM "([^"]+)"/)![1];
      expect(text).toContain('"request" = CAST(? AS JSONB)');
      expect(sql.values.slice(1, 4)).toEqual([
        scope.tenantId,
        scope.productId,
        scope.actorId,
      ]);
      const found = receipts.get(`${table}:${String(sql.values.at(-1))}`);
      return found
        ? [
            {
              matches:
                JSON.stringify(found.request) ===
                JSON.stringify(JSON.parse(sql.values[0] as string)),
              result: detached(found.result),
            },
          ]
        : [];
    }
    if (text.includes('FROM "catalog_editorial_states"')) {
      expect(events.indexOf('gate')).toBeLessThan(events.indexOf('receipt'));
      events.push('state');
      return [
        {
          ...detached(state),
          draftRevision: state.draft?.revision ?? null,
          publishedRevision: state.published?.revision ?? null,
          publishedDocument: detached(state.published?.document ?? null),
        },
      ];
    }
    if (text.includes('FROM editorial_families'))
      return [{ id: 'family', code: 'family' }];
    if (text.includes('FROM editorial_definitions'))
      return [{ id: 'definition', code: 'choice', type: 'single' }];
    if (text.includes('FROM editorial_bindings'))
      return [
        {
          familyId: 'family',
          definitionId: 'definition',
          owner: state.draft?.document.values?.[0]?.owner ?? 'product',
        },
      ];
    if (text.includes('FROM private_media_assets')) return [{ id: 'asset' }];
    if (text.includes('FROM editorial_options'))
      return [{ definitionId: 'definition', code: 'old', archived: true }];
    return [];
  });
  const write = jest.fn().mockImplementation((sql: Prisma.Sql) => {
    const text = sql.sql;
    if (text.includes('receipts')) {
      const table = text.match(/INTO "([^"]+)"/)![1];
      receipts.set(`${table}:${String(sql.values[3])}`, {
        request: JSON.parse(sql.values[4] as string),
        result: JSON.parse(sql.values[5] as string) as EditorialReadResult,
      });
    } else if (text.includes('INSERT INTO "catalog_editorial_states"')) {
      state = {
        ...state,
        cycle: state.cycle! + 1,
        draft: {
          revision: 1,
          basePublishedRevision: state.published?.revision ?? null,
          document: state.published?.document ?? emptyDocument(),
        },
      };
    } else if (text.includes('"publishedDocument" =')) {
      state = {
        ...state,
        published: {
          revision: (state.published?.revision ?? 0) + 1,
          document: detached(state.draft!.document),
        },
        draft: null,
      };
    } else state = { ...state, draft: null };
    return 1;
  });
  const tx = {
    user: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
    tenantMembership: { findMany: members },
    product: {
      findFirst: jest.fn().mockResolvedValue({
        id: scope.productId,
        tenantId: scope.tenantId,
      }),
    },
    $queryRaw: query,
    $executeRaw: write,
  } as unknown as Prisma.TransactionClient;
  const transaction = jest.fn(
    (work: (client: typeof tx) => unknown, options: { isolationLevel: string }) => {
      expect(options.isolationLevel).toBe('ReadCommitted');
      events.length = 0;
      return work(tx);
    },
  );
  const core = new PrismaCatalogEditorial(
    { $transaction: transaction } as unknown as PrismaClient,
    { resolve: async () => null },
    undefined,
    undefined,
    createCoordinatedEditorialWriteAuthority,
  );
  const attempt = (operation: Operation, request = body) =>
    core[operation](scope, request);
  return {
    core,
    attempt,
    query,
    write,
    members,
    receipts,
    events,
    tx,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    set exists(value: boolean) {
      exists = value;
    },
  };
}

for (const operation of operations)
  describe(operation, () => {
    test('requires its exact capability before persistence', async () => {
      const f = fixture();
      f.members.mockResolvedValue(
        membership([
          grants.read,
          operation === 'publish' ? grants.update : grants.publish,
        ]),
      );
      await expect(f.attempt(operation)).rejects.toThrow('FORBIDDEN');
      expect(f.query).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    });
    test('tenant-qualified Product gate precedes receipt and state in ReadCommitted', async () => {
      const f = fixture();
      await f.attempt(operation);
      expect(f.events.indexOf('gate')).toBeLessThan(f.events.indexOf('receipt'));
      expect(f.events.indexOf('receipt')).toBeLessThan(f.events.indexOf('state'));
    });
    test('missing tenant-qualified product is NOT_FOUND', async () => {
      const f = fixture();
      f.exists = false;
      await expect(f.attempt(operation)).rejects.toThrow('NOT_FOUND');
      expect(f.write).not.toHaveBeenCalled();
    });
    test.each([
      { expectedCycle: 2 },
      { expectedRevision: 1 },
      { noDraft: true },
    ])('CAS rejects %j without effects', async (change) => {
      const f = fixture();
      if ('noDraft' in change) f.state = { ...f.state, draft: null };
      const before = detached(f.state);
      await expect(
        f.attempt(operation, {
          ...body,
          ...('noDraft' in change ? {} : change),
        }),
      ).rejects.toThrow('CONFLICT');
      expect(f.state).toEqual(before);
      expect(f.write).not.toHaveBeenCalled();
    });
    test.each([0, -1, 1.5, NaN])(
      'rejects invalid expectations %s',
      async (value) => {
        const f = fixture();
        await expect(
          f.attempt(operation, { ...body, expectedCycle: value }),
        ).rejects.toThrow('MALFORMED');
        await expect(
          f.attempt(operation, { ...body, expectedRevision: value }),
        ).rejects.toThrow('MALFORMED');
        expect(f.write).not.toHaveBeenCalled();
      },
    );
    test('replay returns recorded result without restoring or republishing; mismatched body conflicts', async () => {
      const f = fixture();
      const result = await f.attempt(operation);
      f.state = { cycle: 9, draft: null, published: null };
      f.write.mockClear();
      expect(
        await f.attempt(operation, {
          idempotencyKey: 'key',
          expectedRevision: 2,
          expectedCycle: 3,
        }),
      ).toEqual(result);
      expect(f.state.cycle).toBe(9);
      expect(f.write).not.toHaveBeenCalled();
      await expect(
        f.attempt(operation, { ...body, expectedRevision: 3 }),
      ).rejects.toThrow('CONFLICT');
      f.members.mockResolvedValue([]);
      await expect(f.attempt(operation)).rejects.toThrow('FORBIDDEN');
      f.members.mockResolvedValue(membership());
      f.exists = false;
      await expect(f.attempt(operation)).rejects.toThrow('NOT_FOUND');
    });
    test('consumed pair remains stale for save, publish and discard after initialize', async () => {
      const f = fixture();
      await f.attempt(operation);
      await f.core.initialize(scope, {
        expectedCycle: 3,
        idempotencyKey: 'init',
      });
      expect(f.state.cycle).toBe(4);
      expect(f.state.draft?.revision).toBe(1);
      const before = detached(f.state);
      f.write.mockClear();
      await expect(
        f.core.save(scope, {
          ...body,
          idempotencyKey: 'stale-save',
          document: titled(),
        }),
      ).rejects.toThrow('CONFLICT');
      for (const stale of operations)
        await expect(
          f.attempt(stale, { ...body, idempotencyKey: `stale-${stale}` }),
        ).rejects.toThrow('CONFLICT');
      expect(f.write).not.toHaveBeenCalled();
      expect(f.state).toEqual(before);
    });
  });

test.each([null, 1])(
  'publish increments Published %s and preserves stored document and cycle',
  async (revision) => {
    const f = fixture();
    if (revision)
      f.state = { ...f.state, published: { revision, document: titled() } };
    const document = JSON.stringify(f.state.draft!.document);
    const result = await f.attempt('publish');
    expect(result).toEqual({
      cycle: 3,
      draft: null,
      published: { revision: (revision ?? 0) + 1, document: JSON.parse(document) },
    });
    expect(JSON.stringify(result.published!.document)).toBe(document);
  },
);

test.each([null, '', '   ', '\u2003\n'])(
  'publish rejects incomplete title %j without writes',
  async (title) => {
    const f = fixture();
    f.state.draft!.document.commercialTitle = title;
    await expect(f.attempt('publish')).rejects.toThrow('MALFORMED');
    expect(f.write).not.toHaveBeenCalled();
  },
);

test.each(['media', 'orphan', 'unknown', 'title-limit', 'description-limit'])(
  'publish revalidates %s without writes',
  async (kind) => {
    const f = fixture();
    const d = f.state.draft!.document;
    if (kind === 'media') d.mediaRefs = ['asset'];
    if (kind === 'title-limit') d.commercialTitle = '😀'.repeat(201);
    if (kind === 'description-limit') d.description = '😀'.repeat(20001);
    if (kind === 'orphan' || kind === 'unknown') {
      d.familyCode = 'family';
      d.values = [
        {
          code: kind === 'unknown' ? 'unknown' : 'choice',
          type: 'single',
          owner: 'sellable',
          variantId: 'deleted',
          value: 'old',
        },
      ];
    }
    await expect(f.attempt('publish')).rejects.toThrow('MALFORMED');
    expect(f.write).not.toHaveBeenCalled();
  },
);

const archived = (): EditorialDocument => ({
  ...titled(),
  familyCode: 'family',
  values: [
    {
      code: 'choice',
      type: 'single',
      owner: 'product',
      variantId: null,
      value: 'old',
    },
  ],
});
test.each(['present', 'absent', 'invalid'])(
  'archived conservation uses only valid current Published: %s',
  async (baseline) => {
    const f = fixture();
    f.state.draft!.document = archived();
    if (baseline !== 'absent')
      f.state.published = { revision: 1, document: archived() };
    if (baseline === 'invalid')
      f.state.published!.document.mediaRefs = ['missing'];
    if (baseline === 'present')
      expect((await f.attempt('publish')).published?.revision).toBe(2);
    else {
      await expect(f.attempt('publish')).rejects.toThrow('MALFORMED');
      expect(f.write).not.toHaveBeenCalled();
    }
  },
);

test('discard clears invalid draft without validation and preserves Published and cycle', async () => {
  const f = fixture();
  f.state.draft!.document = { invalid: true } as unknown as EditorialDocument;
  f.state.published = { revision: 7, document: titled() };
  const published = detached(f.state.published);
  expect(await f.attempt('discard')).toEqual({ cycle: 3, draft: null, published });
  expect(
    f.query.mock.calls.some(([sql]: [Prisma.Sql]) =>
      sql.sql.includes('FROM editorial_'),
    ),
  ).toBe(false);
});

test('read+publish without update can publish', async () => {
  const f = fixture();
  f.members.mockResolvedValue(membership([grants.read, grants.publish]));
  expect((await f.attempt('publish')).published?.revision).toBe(1);
});

test.each([200, 201])(
  'publish enforces actual values limit at %s valid assignments',
  async (count) => {
    const f = fixture();
    const d = f.state.draft!.document;
    d.familyCode = 'family';
    d.values = Array.from({ length: count }, (_, i) => ({
      code: `text-${i}`,
      type: 'text',
      owner: 'product',
      variantId: null,
      value: 'x',
    }));
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((sql: Prisma.Sql) => {
      if (sql.sql.includes('FROM editorial_definitions'))
        return d.values.map((v) => ({ id: v.code, code: v.code, type: 'text' }));
      if (sql.sql.includes('FROM editorial_bindings'))
        return d.values.map((v) => ({
          familyId: 'family',
          definitionId: v.code,
          owner: 'product',
        }));
      return original(sql);
    });
    if (count === 200)
      expect((await f.attempt('publish')).published?.document).toEqual(d);
    else {
      await expect(f.attempt('publish')).rejects.toThrow('MALFORMED');
      expect(f.write).not.toHaveBeenCalled();
    }
  },
);

test('publish accepts exact Unicode code point limits without normalization', async () => {
  const f = fixture();
  f.state.draft!.document.commercialTitle = '😀'.repeat(200);
  f.state.draft!.document.description = '😀'.repeat(20000);
  const document = JSON.stringify(f.state.draft!.document);
  expect(JSON.stringify((await f.attempt('publish')).published!.document)).toBe(
    document,
  );
});

test('publish does not recover invalid draft or swallow reference reader errors', async () => {
  const f = fixture();
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation((sql: Prisma.Sql) => {
    if (sql.sql.includes('FROM variants')) throw new Error('reference unavailable');
    return original(sql);
  });
  await expect(f.attempt('publish')).rejects.toThrow('reference unavailable');
  expect(f.write).not.toHaveBeenCalled();
});

test('save, publish and discard receipts are independent namespaces', async () => {
  const f = fixture();
  f.receipts.set('catalog_editorial_save_receipts:key', {
    request: {},
    result: f.state,
  });
  await f.attempt('publish');
  f.state = {
    cycle: 4,
    draft: { revision: 1, basePublishedRevision: 1, document: titled() },
    published: f.state.published,
  };
  await f.attempt('discard', { ...body, expectedCycle: 4, expectedRevision: 1 });
  expect(f.receipts.size).toBe(3);
});
