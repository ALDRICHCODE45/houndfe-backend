import { createCoordinatedEditorialWriteAuthority } from './prisma-coordinated-editorial-authority';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import {
  createPrismaEditorialWriteAuthority,
  type EditorialWriteAuthorityFactory,
} from './prisma-editorial-write-authority';
import { emptyDocument, type DocumentAuthority } from '../domain/document';
import { EDITORIAL_PERMISSIONS as grants } from '../domain/editorial-permissions';

const scope = { actorId: 'actor', tenantId: 'tenant', productId: 'product' };
const operations = ['create', 'initialize', 'save'] as const;
type Operation = (typeof operations)[number];

function fixture(operation: Operation, coordinated = true) {
  const events: string[] = [];
  const initial =
    operation === 'save'
      ? {
          cycle: 1,
          draft: {
            revision: 1,
            basePublishedRevision: null,
            document: emptyDocument(),
          },
          published: null,
        }
      : null;
  const persistence = { state: initial, receipts: [] as string[] };
  const before = structuredClone(persistence);
  const user = jest.fn().mockImplementation(() => {
    events.push('capability');
    return { isActive: true };
  });
  const members = jest.fn().mockResolvedValue([
    {
      userId: scope.actorId,
      tenantId: scope.tenantId,
      role: {
        permissions: [grants.read, grants.update].map((permission) => ({
          permission,
        })),
      },
    },
  ]);
  const product = jest
    .fn()
    .mockResolvedValue({ id: scope.productId, tenantId: scope.tenantId });
  const query = jest
    .fn<unknown[] | Promise<unknown[]>, [Prisma.Sql]>()
    .mockImplementation((sql) => {
      const text = sql.strings.join('?');
      if (text.includes('FROM "products"')) {
        events.push('gate');
        expect(sql.values).toEqual([scope.tenantId, scope.productId]);
        return [{ id: scope.productId }];
      }
      if (text.includes('receipts')) return [];
      if (text.includes('FROM "catalog_editorial_states"'))
        return persistence.state ? [persistence.state] : [];
      return [];
    });
  const write = jest.fn().mockImplementation((sql: Prisma.Sql) => {
    if (sql.strings.join('').includes('receipts'))
      persistence.receipts.push('receipt');
    else
      persistence.state = {
        cycle: 1,
        draft: {
          revision: operation === 'save' ? 2 : 1,
          basePublishedRevision: null,
          document: emptyDocument(),
        },
        published: null,
      };
    return 1;
  });
  const tx = {
    user: { findUnique: user },
    tenantMembership: { findMany: members },
    product: { findFirst: product },
    $queryRaw: query,
    $executeRaw: write,
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    $transaction: (work: (client: typeof tx) => unknown) => work(tx),
  } as unknown as PrismaClient;
  const legacy = { resolve: jest.fn().mockResolvedValue(null) };
  const document = {
    tenantId: scope.tenantId,
    productId: scope.productId,
    variantIds: [],
    assetIds: [],
    families: [],
  };
  const provider = {
    resolve: jest.fn().mockImplementation(() => {
      events.push('documents');
      return document;
    }),
  };
  legacy.resolve.mockResolvedValue({
    ...scope,
    activeMember: true,
    canRead: true,
    canCreate: true,
    canSave: true,
    documentAuthority: document,
  });
  const documents = jest.fn((client: typeof tx) => {
    expect(client).toBe(tx);
    expect(events.at(-1)).toBe('gate');
    return provider;
  });
  const factory = jest.fn<
    ReturnType<EditorialWriteAuthorityFactory>,
    [typeof tx]
  >((client) => createPrismaEditorialWriteAuthority(client, documents));
  const core = new PrismaCatalogEditorial(
    prisma,
    legacy,
    legacy,
    legacy,
    coordinated ? factory : undefined,
  );
  const attempt = () =>
    operation === 'save'
      ? core.save(scope, {
          expectedCycle: 1,
          expectedRevision: 1,
          idempotencyKey: 'key',
          document: emptyDocument(),
        })
      : operation === 'initialize'
        ? core.initialize(scope, { expectedCycle: null, idempotencyKey: 'key' })
        : core.create(scope, {
            expectedCycle: null,
            idempotencyKey: 'key',
            document: emptyDocument(),
          });
  return {
    core,
    attempt,
    factory,
    documents,
    tx,
    legacy,
    provider,
    document,
    user,
    members,
    product,
    query,
    write,
    events,
    persistence,
    before,
  };
}

describe.each(operations)('transaction-scoped %s authority', (operation) => {
  it('binds once to actual callback tx, gates before documents, and persists state plus receipt', async () => {
    const f = fixture(operation);
    await expect(f.attempt()).resolves.toMatchObject({
      cycle: 1,
      draft: { revision: operation === 'save' ? 2 : 1 },
    });
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.factory).toHaveBeenCalledWith(f.tx);
    expect(f.legacy.resolve).not.toHaveBeenCalled();
    expect(f.events.slice(0, 3)).toEqual(['capability', 'gate', 'documents']);
    expect(f.provider.resolve).toHaveBeenCalledWith(scope);
    expect(f.documents).toHaveBeenCalledTimes(1);
    expect(f.persistence.receipts).toEqual(['receipt']);
    expect(f.persistence.state).not.toEqual(f.before.state);
  });

  it.each([
    'factory',
    'nullFactory',
    'account',
    'read',
    'update',
    'qualification',
    'gate',
    'gateFailure',
    'provider',
    'nullProvider',
    'documentTenant',
    'documentProduct',
    'invalid',
  ] as const)(
    'denies %s without fallback or observable persistence effects',
    async (failure) => {
      const f = fixture(operation);
      if (failure === 'factory')
        f.factory.mockImplementation(() => {
          throw new Error('private');
        });
      if (failure === 'nullFactory') f.factory.mockReturnValue(null);
      if (failure === 'account') f.user.mockResolvedValue({ isActive: false });
      if (failure === 'read' || failure === 'update')
        f.members.mockResolvedValue([
          {
            userId: scope.actorId,
            tenantId: scope.tenantId,
            role: {
              permissions: [
                {
                  permission: failure === 'read' ? grants.update : grants.read,
                },
              ],
            },
          },
        ]);
      if (failure === 'qualification')
        f.product.mockResolvedValue({ id: 'other', tenantId: scope.tenantId });
      if (failure === 'gate') f.query.mockResolvedValue([{ id: 'other' }]);
      if (failure === 'gateFailure')
        f.query.mockRejectedValue(new Error('private'));
      if (failure === 'provider')
        f.provider.resolve.mockRejectedValue(new Error('private'));
      if (failure === 'nullProvider')
        f.provider.resolve.mockResolvedValue(null);
      if (failure === 'documentTenant') f.document.tenantId = 'other';
      if (failure === 'documentProduct') f.document.productId = 'other';
      const attempt =
        failure === 'invalid'
          ? () =>
              f.core[operation](scope, {
                expectedCycle: null,
                idempotencyKey: '',
                document: emptyDocument(),
                expectedRevision: 1,
              } as never)
          : f.attempt;
      await expect(attempt()).rejects.toThrow(
        failure === 'invalid' ? 'MALFORMED' : 'FORBIDDEN',
      );
      expect(f.legacy.resolve).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(f.before);
      if (
        [
          'factory',
          'nullFactory',
          'account',
          'read',
          'update',
          'qualification',
          'gate',
          'gateFailure',
        ].includes(failure)
      )
        expect(f.provider.resolve).not.toHaveBeenCalled();
    },
  );

  it('selects only the operation-specific authority port', async () => {
    const f = fixture(operation);
    const selected = {
      resolve: jest.fn().mockResolvedValue({
        ...scope,
        activeMember: true,
        canCreate: operation !== 'save',
        canSave: operation === 'save',
        documentAuthority: f.document,
      }),
    };
    const unused = {
      resolve: jest.fn().mockRejectedValue(new Error('wrong port')),
    };
    f.factory.mockResolvedValue({
      createAuthority: operation === 'save' ? unused : selected,
      saveAuthority: operation === 'save' ? selected : unused,
    });
    await expect(f.attempt()).resolves.toMatchObject({ cycle: 1 });
    expect(selected.resolve).toHaveBeenCalledWith(scope);
    expect(unused.resolve).not.toHaveBeenCalled();
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.legacy.resolve).not.toHaveBeenCalled();
  });

  it('preserves successful trusted noncoordinated callers', async () => {
    const f = fixture(operation, false);
    await expect(f.attempt()).resolves.toMatchObject({ cycle: 1 });
    expect(f.legacy.resolve).toHaveBeenCalledTimes(1);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.persistence.receipts).toEqual(['receipt']);
  });
});

it('read ignores the opted-in write factory and retains the existing read authority', async () => {
  const f = fixture('save');
  f.factory.mockImplementation(() => {
    throw new Error('must not run');
  });
  await expect(f.core.read(scope)).resolves.toEqual(f.before.state);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.legacy.resolve).toHaveBeenCalledWith(scope);
  expect(f.persistence).toEqual(f.before);
});

function preparationFixture(operation: Operation) {
  const f = fixture(operation);
  const prepare = jest.fn(
    (context: {
      scope: Readonly<typeof scope>;
      documents: readonly unknown[];
      mode: 'create' | 'create-replay' | 'stored';
      authority: Readonly<DocumentAuthority>;
    }) => {
      f.events.push('prepare');
      expect(f.events).toContain('gate');
      expect(Object.isFrozen(context.scope)).toBe(true);
      expect(Object.isFrozen(context.documents)).toBe(true);
      expect(Object.isFrozen(context.documents[0])).toBe(true);
      expect(Object.isFrozen(context.authority.assetIds)).toBe(true);
      expect(
        Reflect.set(context.documents[0] as object, 'description', 'changed'),
      ).toBe(false);
      return Promise.resolve({ ...context.authority, assetIds: ['asset'] });
    },
  );
  f.factory.mockImplementation((tx) =>
    Object.assign(createPrismaEditorialWriteAuthority(tx, f.documents), {
      prepareDocuments: prepare,
    }),
  );
  return { ...f, prepare };
}

describe('staged document preparation', () => {
  it.each(operations)(
    'prepares only selected %s documents with detached inputs',
    async (operation) => {
      const f = preparationFixture(operation);
      const result = await f.attempt();
      expect(f.prepare).toHaveBeenCalledTimes(1);
      const context = f.prepare.mock.calls[0][0];
      expect(context.scope).toEqual(scope);
      expect(context.mode).toBe(operation === 'create' ? 'create' : 'stored');
      expect(context.documents).toEqual(
        operation === 'create'
          ? [emptyDocument()]
          : [emptyDocument(), emptyDocument()],
      );
      expect(result.draft?.document).toEqual(emptyDocument());
      expect(f.document.assetIds).toEqual([]);
      expect(f.write).toHaveBeenCalledTimes(2);
      expect(f.legacy.resolve).not.toHaveBeenCalled();
      expect(f.factory).toHaveBeenCalledWith(f.tx);
    },
  );

  it.each(['throw', 'null', 'foreign', 'shape'])(
    'denies %s preparation without fallback or effects',
    async (failure) => {
      const f = preparationFixture('create');
      const error = new Error('preparation failed');
      if (failure === 'throw') f.prepare.mockRejectedValueOnce(error);
      if (failure === 'null') f.prepare.mockResolvedValueOnce(null as never);
      if (failure === 'foreign')
        f.prepare.mockResolvedValueOnce({ ...f.document, tenantId: 'foreign' });
      if (failure === 'shape')
        f.prepare.mockResolvedValueOnce({
          ...f.document,
          assetIds: null as never,
        });
      await expect(f.attempt()).rejects.toThrow(
        failure === 'throw' ? error : 'FORBIDDEN',
      );
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(f.before);
      expect(f.legacy.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(['receipt', 'revision'])(
    'keeps %s conflict ahead of malformed stored documents',
    async (failure) => {
      const f = preparationFixture('save');
      const query = f.query.getMockImplementation()!;
      if (failure === 'receipt')
        f.query.mockImplementation((sql: Prisma.Sql) =>
          sql.strings.join('').includes('catalog_editorial_save_receipts')
            ? [{ matches: false, result: { draft: 'invalid' } }]
            : query(sql),
        );
      else {
        f.persistence.state!.cycle = 2;
        f.persistence.state!.draft.document = { invalid: true } as never;
      }
      const before = structuredClone(f.persistence);
      await expect(f.attempt()).rejects.toThrow('CONFLICT');
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(before);
    },
  );

  it('retains invalid create before receipt conflict', async () => {
    const f = preparationFixture('create');
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation((sql: Prisma.Sql) =>
      sql.strings.join('').includes('receipts')
        ? [{ matches: false }]
        : query(sql),
    );
    await expect(
      f.core.create(scope, {
        expectedCycle: null,
        idempotencyKey: 'key',
        document: { invalid: true } as never,
      }),
    ).rejects.toThrow('MALFORMED');
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(
      f.query.mock.calls.some(([sql]: [Prisma.Sql]) =>
        sql.strings.join('').includes('receipts'),
      ),
    ).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.persistence).toEqual(f.before);
  });

  it('prepares matched create receipt draft only, without newly validating published history', async () => {
    const f = preparationFixture('create');
    const receipt = {
      cycle: 1,
      draft: {
        revision: 1,
        basePublishedRevision: null,
        document: emptyDocument(),
      },
      published: {
        revision: 1,
        document: { mediaRefs: ['irrelevant-history'] },
      },
    };
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation((sql: Prisma.Sql) =>
      sql.strings.join('').includes('receipts')
        ? [{ matches: true, result: receipt }]
        : query(sql),
    );
    await expect(f.attempt()).resolves.toEqual(receipt);
    expect(f.prepare.mock.calls.map(([context]) => context.mode)).toEqual([
      'create',
      'create-replay',
    ]);
    expect(f.prepare.mock.calls.map(([context]) => context.documents)).toEqual([
      [emptyDocument()],
      [emptyDocument()],
    ]);
    expect(f.provider.resolve).toHaveBeenCalledTimes(1);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.persistence).toEqual(f.before);
  });

  it.each(['save', 'initialize'] as const)(
    'prepares existing %s receipt baselines at the stored boundary',
    async (operation) => {
      const f = preparationFixture(operation);
      const receipt = {
        cycle: 1,
        draft: {
          revision: operation === 'save' ? 2 : 1,
          basePublishedRevision: 1,
          document: emptyDocument(),
        },
        published: { revision: 1, document: emptyDocument() },
      };
      const query = f.query.getMockImplementation()!;
      f.query.mockImplementation((sql: Prisma.Sql) =>
        sql.strings.join('').includes('receipts')
          ? [{ matches: true, result: receipt }]
          : query(sql),
      );
      await expect(f.attempt()).resolves.toEqual(receipt);
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.prepare.mock.calls[0][0].documents).toEqual([
        emptyDocument(),
        emptyDocument(),
        emptyDocument(),
      ]);
      expect(f.prepare.mock.calls[0][0].mode).toBe('stored');
      expect(f.provider.resolve).toHaveBeenCalledTimes(1);
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(f.before);
    },
  );

  it('captures request identity and selectors before suspended capability resolution', async () => {
    const f = preparationFixture('create');
    const context = { ...scope };
    const request = {
      expectedCycle: null,
      idempotencyKey: 'original',
      document: { ...emptyDocument(), mediaRefs: ['asset'] },
    };
    f.user.mockImplementationOnce(() => {
      context.tenantId = 'foreign';
      context.actorId = 'intruder';
      request.idempotencyKey = 'changed';
      request.document.mediaRefs.push('injected');
      return Promise.resolve({ isActive: true });
    });
    const result = await f.core.create(context, request);
    expect(result.draft?.document.mediaRefs).toEqual(['asset']);
    expect(f.prepare.mock.calls[0][0].scope).toEqual(scope);
    expect(f.prepare.mock.calls[0][0].documents).toEqual([
      { ...emptyDocument(), mediaRefs: ['asset'] },
    ]);
    const receiptQuery = f.query.mock.calls.find(([sql]: [Prisma.Sql]) =>
      sql.strings.join('').includes('receipts'),
    )![0];
    expect(receiptQuery.values).toContain('original');
    expect(receiptQuery.values).not.toContain('changed');
  });

  it.each(operations)(
    'does not prepare %s after current capability denial',
    async (operation) => {
      const f = preparationFixture(operation);
      f.user.mockResolvedValue({ isActive: false });
      await expect(f.attempt()).rejects.toThrow('FORBIDDEN');
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(f.before);
    },
  );

  it.each([true, false])(
    'enforces the core create gate for a custom preparation factory; exists=%s',
    async (exists) => {
      const f = preparationFixture('create');
      const port = {
        resolve: jest.fn().mockResolvedValue({
          ...scope,
          activeMember: true,
          canCreate: true,
          canSave: true,
          documentAuthority: f.document,
        }),
      };
      f.factory.mockResolvedValue({
        createAuthority: port,
        saveAuthority: port,
        prepareDocuments: f.prepare,
      } as never);
      if (!exists) f.query.mockResolvedValue([]);
      if (exists) {
        await expect(f.attempt()).resolves.toMatchObject({ cycle: 1 });
        expect(f.events.slice(0, 2)).toEqual(['gate', 'prepare']);
      } else {
        await expect(f.attempt()).rejects.toThrow('NOT_FOUND');
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
        expect(f.persistence).toEqual(f.before);
      }
    },
  );
});

const referenceSources = [
  'variants',
  'private_media_assets',
  'editorial_families',
  'editorial_definitions',
  'editorial_bindings',
  'editorial_options',
  'editorial_units',
] as const;

function coordinatedFixture(operation: Operation, archived = false) {
  const f = fixture(operation);
  f.factory.mockImplementation(createCoordinatedEditorialWriteAuthority);
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation((sql) => {
    const text = sql.sql;
    if (text.includes('SELECT o."archivedAt"'))
      return [{ archivedAt: archived ? new Date('2020-01-01') : null }];
    if (!referenceSources.some((source) => text.includes('FROM ' + source)))
      return original(sql);
    if (text.includes('FALSE')) return [];
    if (text.includes('FROM private_media_assets'))
      return sql.values.includes('asset') ? [{ id: 'asset' }] : [];
    if (text.includes('FROM editorial_families'))
      return [{ id: 'family-id', code: 'family' }];
    if (text.includes('FROM editorial_definitions'))
      return [{ id: 'color-id', code: 'color', type: 'single' }];
    if (text.includes('FROM editorial_bindings'))
      return [
        { familyId: 'family-id', definitionId: 'color-id', owner: 'sellable' },
      ];
    if (text.includes('FROM editorial_options'))
      return [{ definitionId: 'color-id', code: 'red', archived }];
    return [];
  });
  return f;
}
const selectedDocument = () => ({
  ...emptyDocument(),
  mediaRefs: ['asset'],
  familyCode: 'family',
  values: [
    {
      code: 'color',
      owner: 'sellable' as const,
      variantId: null,
      type: 'single' as const,
      value: 'red',
    },
  ],
});

describe('coordinated reference composition', () => {
  it.each(operations)(
    'observes every real source for empty %s',
    async (operation) => {
      const f = coordinatedFixture(operation);
      await expect(f.attempt()).resolves.toMatchObject({ cycle: 1 });
      for (const source of referenceSources)
        expect(
          f.query.mock.calls.some(([sql]) =>
            sql.sql.includes('FROM ' + source),
          ),
        ).toBe(true);
      expect(f.legacy.resolve).not.toHaveBeenCalled();
      expect(f.write).toHaveBeenCalledTimes(2);
    },
  );

  it.each(referenceSources)(
    'denies unavailable %s even for empty create',
    async (source) => {
      const f = coordinatedFixture('create');
      const query = f.query.getMockImplementation()!;
      f.query.mockImplementation((sql) => {
        if (sql.sql.includes('FROM ' + source))
          throw new Error('source unavailable');
        return query(sql);
      });
      await expect(f.attempt()).rejects.toThrow('FORBIDDEN');
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(f.before);
      expect(f.legacy.resolve).not.toHaveBeenCalled();
    },
  );

  it('creates nonempty selected references with positive vocabulary locks', async () => {
    const f = coordinatedFixture('create');
    const document = selectedDocument();
    const result = await f.core.create(scope, {
      expectedCycle: null,
      idempotencyKey: 'selected',
      document,
    });
    expect(result.draft?.document).toEqual(document);
    const assets = f.query.mock.calls
      .map(([sql]) => sql)
      .filter(
        (sql) =>
          sql.sql.includes('FROM private_media_assets') &&
          !sql.sql.includes('FALSE'),
      );
    expect(assets).toHaveLength(1);
    expect(assets[0].values).toEqual([
      scope.tenantId,
      scope.productId,
      'asset',
    ]);
    expect(assets[0].sql).toContain('ORDER BY id FOR SHARE');
    for (const source of [
      'editorial_families',
      'editorial_definitions',
      'editorial_bindings',
      'editorial_options',
    ]) {
      expect(
        f.query.mock.calls.some(
          ([sql]) =>
            sql.sql.includes('FROM ' + source) &&
            !sql.sql.includes('FALSE') &&
            sql.sql.includes('FOR SHARE'),
        ),
      ).toBe(true);
    }
    expect(f.write).toHaveBeenCalledTimes(2);
    const [stateWrite] = f.write.mock.calls[0] as [Prisma.Sql];
    expect(stateWrite.values).toContain(JSON.stringify(document));
    expect(f.persistence.receipts).toEqual(['receipt']);
  });

  it.each(['missing asset', 'archived option'])(
    'rejects new %s without effects',
    async (failure) => {
      const f = coordinatedFixture('create', failure === 'archived option');
      const document = selectedDocument();
      if (failure === 'missing asset') document.mediaRefs = ['missing'];
      await expect(
        f.core.create(scope, {
          expectedCycle: null,
          idempotencyKey: 'selected',
          document,
        }),
      ).rejects.toThrow('MALFORMED');
      expect(f.write).not.toHaveBeenCalled();
      expect(f.persistence).toEqual(f.before);
    },
  );

  it('preserves an archived assignment on nonempty save replay', async () => {
    const f = coordinatedFixture('save', true);
    const document = selectedDocument();
    const receipt = {
      cycle: 1,
      draft: {
        revision: 2,
        basePublishedRevision: null,
        document,
      },
      published: null,
    };
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation((sql) =>
      sql.sql.includes('catalog_editorial_save_receipts')
        ? [{ matches: true, result: receipt }]
        : query(sql),
    );
    const result = await f.core.save(scope, {
      expectedCycle: 1,
      expectedRevision: 1,
      idempotencyKey: 'replay',
      document,
    });
    expect(result.draft?.document).toEqual(document);
    expect(result.warnings).toEqual([
      {
        code: 'ARCHIVED_OPTION',
        familyId: 'family-id',
        definitionId: 'color-id',
        owner: 'sellable',
        variantId: null,
        optionCode: 'red',
      },
    ]);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.persistence).toEqual(f.before);
  });
});
