import type { PrismaClient } from '@prisma/client';
import { EDITORIAL_PERMISSIONS as grants } from '../domain/editorial-permissions';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { emptyDocument } from '../domain/document';
import {
  PrismaEditorialAuthority,
  type EditorialDocumentAuthorityProvider,
} from './prisma-editorial-authority';

const scope = { actorId: 'actor', tenantId: 'tenant', productId: 'product' };
const membership = (permissions: { subject: string; action: string }[]) => ({
  userId: scope.actorId,
  tenantId: scope.tenantId,
  role: { permissions: permissions.map((permission) => ({ permission })) },
});
function fixture(documents?: EditorialDocumentAuthorityProvider) {
  const user = jest.fn().mockResolvedValue({ isActive: true });
  const members = jest
    .fn()
    .mockResolvedValue([membership([grants.read, grants.update])]);
  const product = jest
    .fn()
    .mockResolvedValue({ id: scope.productId, tenantId: scope.tenantId });
  const query = jest.fn();
  const write = jest.fn();
  const prisma = {
    user: { findUnique: user },
    tenantMembership: { findMany: members },
    product: { findFirst: product },
    $transaction: (work: (tx: unknown) => unknown) =>
      work({ $queryRaw: query, $executeRaw: write }),
  } as unknown as PrismaClient;
  const authority = new PrismaEditorialAuthority(prisma, documents);
  const core = new PrismaCatalogEditorial(
    prisma,
    authority,
    authority.createAuthority,
    authority.saveAuthority,
  );
  return { user, members, product, query, write, authority, core };
}

describe('current Prisma editorial capability/read authority', () => {
  it.each([
    [[], false, false, false],
    [[grants.read], true, false, false],
    [[grants.update], false, false, false],
    [[grants.read, grants.update], true, true, false],
    [
      [grants.read, { subject: 'ProductEditorialDraft', action: 'publish' }],
      true,
      false,
      true,
    ],
    [
      [{ subject: 'ProductEditorialDraft', action: 'publish' }],
      false,
      false,
      false,
    ],
    [[{ subject: 'all', action: 'manage' }], false, false, false],
    [[{ subject: 'Product', action: 'manage' }], false, false, false],
    [
      [{ subject: 'ProductEditorialDraft', action: 'manage' }],
      false,
      false,
      false,
    ],
    [
      [{ subject: 'ProductEditorialDraft', action: 'create' }],
      false,
      false,
      false,
    ],
    [[grants.read, { subject: 'all', action: 'manage' }], true, false, false],
    [
      [grants.read, { subject: 'ProductEditorialDraft', action: 'manage' }],
      true,
      false,
      false,
    ],
  ])(
    'maps only exact rows %j',
    async (permissions, canRead, canEdit, canPublish) => {
      const f = fixture();
      f.members.mockResolvedValue([membership(permissions)]);
      const input = {
        ...scope,
        isSuperAdmin: true,
        canRead: true,
        canSave: true,
        canDiscard: true,
        canPublish: true,
      };
      expect(await f.authority.resolve(input)).toEqual({
        ...scope,
        activeMember: true,
        canRead,
        canCreate: canEdit,
        canSave: canEdit,
        canDiscard: canEdit,
        canPublish,
      });
      if (!canRead)
        await expect(f.core.read(input)).rejects.toThrow('FORBIDDEN');
      expect(f.query).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it('unions roles and uses narrowly qualified queries', async () => {
    const f = fixture();
    f.members.mockResolvedValue([
      membership([grants.read]),
      membership([grants.update]),
    ]);
    expect(await f.authority.resolve(scope)).toEqual({
      ...scope,
      activeMember: true,
      canRead: true,
      canCreate: true,
      canSave: true,
      canDiscard: true,
      canPublish: false,
    });
    expect(f.user).toHaveBeenCalledWith({
      where: { id: scope.actorId },
      select: { isActive: true },
    });
    expect(f.members).toHaveBeenCalledWith({
      where: { userId: scope.actorId, tenantId: scope.tenantId },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });
    expect(f.product).toHaveBeenCalledWith({
      where: { id: scope.productId, tenantId: scope.tenantId },
      select: { id: true, tenantId: true },
    });
  });

  it.each([
    ['user', null],
    ['user', { isActive: false }],
    ['members', []],
    ['members', [{ ...membership([grants.read]), tenantId: 'other' }]],
    ['members', [{ ...membership([grants.read]), userId: 'other' }]],
    ['product', null],
    ['product', { id: scope.productId, tenantId: 'other' }],
    ['product', { id: 'other', tenantId: scope.tenantId }],
  ] as const)(
    'denies misqualified/absent %s: %j',
    async (dependency, value) => {
      const f = fixture();
      f[dependency].mockResolvedValue(value);
      expect(await f.authority.resolve(scope)).toBeNull();
      await expect(f.core.read(scope)).rejects.toThrow('FORBIDDEN');
      expect(f.query).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it.each(['user', 'members', 'product'] as const)(
    'fails closed when %s is unavailable',
    async (dependency) => {
      const f = fixture();
      f[dependency].mockRejectedValue(new Error('private dependency detail'));
      expect(await f.authority.resolve(scope)).toBeNull();
      await expect(f.core.read(scope)).rejects.toThrow('FORBIDDEN');
      expect(f.query).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it.each(['actorId', 'tenantId', 'productId'])(
    'rejects unusable %s before dependencies',
    async (key) => {
      const f = fixture();
      for (const value of ['', ' ', null, undefined]) {
        expect(
          await f.authority.resolve({ ...scope, [key]: value }),
        ).toBeNull();
      }
      expect(f.user).not.toHaveBeenCalled();
      expect(f.members).not.toHaveBeenCalled();
      expect(f.product).not.toHaveBeenCalled();
    },
  );

  it('captures scope before awaiting and does not reuse mutable snapshots', async () => {
    const f = fixture();
    const mutable = { ...scope };
    const pending = f.authority.resolve(mutable);
    mutable.actorId = mutable.tenantId = mutable.productId = 'other';
    const snapshot = await pending;
    expect(snapshot).toMatchObject(scope);
    expect(f.members).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: scope.actorId, tenantId: scope.tenantId },
      }),
    );
    expect(f.product).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: scope.productId, tenantId: scope.tenantId },
      }),
    );
    if (snapshot) snapshot.canRead = false;
    expect(await f.authority.resolve(scope)).toMatchObject({ canRead: true });
  });

  it.each(['permission', 'membership', 'account', 'product'] as const)(
    'revalidates %s on subsequent reads without exposing prior state',
    async (revoked) => {
      const f = fixture();
      const stored = { cycle: 1, draft: null, published: null };
      f.query
        .mockResolvedValueOnce([{ id: scope.productId }])
        .mockResolvedValueOnce([stored]);
      expect(await f.core.read(scope)).toEqual(stored);
      if (revoked === 'permission')
        f.members.mockResolvedValue([membership([])]);
      if (revoked === 'membership') f.members.mockResolvedValue([]);
      if (revoked === 'account') f.user.mockResolvedValue({ isActive: false });
      if (revoked === 'product') f.product.mockResolvedValue(null);
      await expect(f.core.read(scope)).rejects.toThrow('FORBIDDEN');
      expect(f.user).toHaveBeenCalledTimes(2);
      expect(f.query).toHaveBeenCalledTimes(2);
      expect(f.write).not.toHaveBeenCalled();
    },
  );
});

describe.each(['create', 'save'] as const)(
  'guarded %s authority',
  (operation) => {
    function setup(withProvider = true) {
      // Test-only authoritative source; no fixture provider is registered at runtime.
      const document = {
        tenantId: scope.tenantId,
        productId: scope.productId,
        variantIds: [],
        assetIds: ['asset'],
        families: [],
      };
      const provider = { resolve: jest.fn().mockResolvedValue(document) };
      const f = fixture(withProvider ? provider : undefined);
      const request = {
        expectedCycle: 1,
        idempotencyKey: 'key',
        document: { ...emptyDocument(), mediaRefs: ['asset'] },
      };
      const attempt = () =>
        operation === 'create'
          ? f.core.create(scope, request)
          : f.core.save(scope, { ...request, expectedRevision: 1 });
      const port =
        operation === 'create'
          ? f.authority.createAuthority
          : f.authority.saveAuthority;
      return { ...f, provider, document, request, attempt, port };
    }

    it.each([
      [],
      [grants.read],
      [grants.update],
      [{ subject: 'all', action: 'manage' }],
      [{ subject: 'Product', action: 'manage' }],
      [{ subject: 'ProductEditorialDraft', action: 'manage' }],
    ])('requires both explicit permissions, not %j', async (...permissions) => {
      const f = setup();
      f.members.mockResolvedValue([membership(permissions)]);
      await expect(f.attempt()).rejects.toThrow('FORBIDDEN');
      expect(f.provider.resolve).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    });

    it.each(['absent', 'null', 'unavailable', 'tenant', 'product'])(
      'denies %s document provider before receipt/state/write',
      async (reason) => {
        const f = setup(reason !== 'absent');
        if (reason === 'null') f.provider.resolve.mockResolvedValue(null);
        if (reason === 'unavailable')
          f.provider.resolve.mockRejectedValue(new Error('private detail'));
        if (reason === 'tenant') f.document.tenantId = 'other';
        if (reason === 'product') f.document.productId = 'other';
        await expect(f.attempt()).rejects.toThrow('FORBIDDEN');
        expect(f.query).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
      },
    );

    it('captures caller scope and detaches returned document authority from provider mutation', async () => {
      const f = setup();
      f.provider.resolve.mockImplementation((input: typeof scope) => {
        expect(input).toEqual(scope);
        input.actorId = input.tenantId = input.productId = 'other';
        return Promise.resolve(f.document);
      });
      const input = { ...scope };
      const pending = f.port.resolve(input);
      input.actorId = input.tenantId = input.productId = 'changed';
      const access = await pending;
      expect(access).toMatchObject({ ...scope, activeMember: true });
      f.document.tenantId = f.document.productId = 'redirected';
      f.document.assetIds.push('foreign');
      expect(access?.documentAuthority).toEqual({
        tenantId: scope.tenantId,
        productId: scope.productId,
        variantIds: [],
        assetIds: ['asset'],
        families: [],
      });
      expect(scope).toEqual({
        actorId: 'actor',
        tenantId: 'tenant',
        productId: 'product',
      });
    });

    it.each(['read', 'update', 'membership', 'account', 'references'])(
      'returns full historical result only until current %s is revoked',
      async (revoked) => {
        const f = setup();
        const result = {
          cycle: 1,
          draft: {
            revision: operation === 'save' ? 2 : 1,
            basePublishedRevision: 2,
            document: f.request.document,
          },
          published: { revision: 2, document: emptyDocument() },
        };
        const enqueueReplay = () => {
          f.query
            .mockResolvedValueOnce([{ id: scope.productId }])
            .mockResolvedValueOnce([{ matches: true, result }]);
          // Save observes five locked vocabulary collections even for empty documents.
          if (operation === 'save')
            for (let table = 0; table < 5; table++)
              f.query.mockResolvedValueOnce([]);
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          enqueueReplay();
          expect(await f.attempt()).toEqual(result);
        }
        if (revoked === 'read')
          f.members.mockResolvedValue([membership([grants.update])]);
        if (revoked === 'update')
          f.members.mockResolvedValue([membership([grants.read])]);
        if (revoked === 'membership') f.members.mockResolvedValue([]);
        if (revoked === 'account')
          f.user.mockResolvedValue({ isActive: false });
        if (revoked === 'references') {
          f.document.assetIds = [];
          if (operation === 'save') enqueueReplay();
        }
        await expect(f.attempt()).rejects.toThrow(
          revoked === 'references' ? 'MALFORMED' : 'FORBIDDEN',
        );
        expect(f.user).toHaveBeenCalledTimes(3);
        expect(f.provider.resolve).toHaveBeenCalledTimes(
          revoked === 'references' ? 3 : 2,
        );
        expect(f.query).toHaveBeenCalledTimes(
          operation === 'save' ? (revoked === 'references' ? 21 : 14) : 4,
        );
        expect(f.write).not.toHaveBeenCalled();
      },
    );
  },
);
