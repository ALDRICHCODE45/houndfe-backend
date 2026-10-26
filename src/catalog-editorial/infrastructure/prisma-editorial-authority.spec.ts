import type { PrismaClient } from '@prisma/client';
import { EDITORIAL_PERMISSIONS as grants } from '../domain/editorial-permissions';
import { PrismaCatalogEditorial } from './prisma-catalog-editorial';
import { PrismaEditorialAuthority } from './prisma-editorial-authority';

const scope = { actorId: 'actor', tenantId: 'tenant', productId: 'product' };
const membership = (permissions: { subject: string; action: string }[]) => ({
  userId: scope.actorId,
  tenantId: scope.tenantId,
  role: { permissions: permissions.map((permission) => ({ permission })) },
});
function fixture() {
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
  const authority = new PrismaEditorialAuthority(prisma);
  const core = new PrismaCatalogEditorial(prisma, authority);
  return { user, members, product, query, write, authority, core };
}

describe('current Prisma editorial capability/read authority', () => {
  it.each([
    [[], false, false],
    [[grants.read], true, false],
    [[grants.update], false, true],
    [[grants.read, grants.update], true, true],
    [[{ subject: 'all', action: 'manage' }], false, false],
    [[{ subject: 'Product', action: 'manage' }], false, false],
    [[{ subject: 'ProductEditorialDraft', action: 'manage' }], false, false],
    [[{ subject: 'ProductEditorialDraft', action: 'create' }], false, false],
  ])('maps only exact rows %j', async (permissions, canRead, canEdit) => {
    const f = fixture();
    f.members.mockResolvedValue([membership(permissions)]);
    const input = {
      ...scope,
      isSuperAdmin: true,
      canRead: true,
      canSave: true,
    };
    expect(await f.authority.resolve(input)).toEqual({
      ...scope,
      activeMember: true,
      canRead,
      canCreate: canEdit,
      canSave: canEdit,
    });
    if (!canRead) await expect(f.core.read(input)).rejects.toThrow('FORBIDDEN');
    expect(f.query).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

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
