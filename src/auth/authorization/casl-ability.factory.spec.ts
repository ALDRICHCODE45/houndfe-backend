import { CaslAbilityFactory } from './casl-ability.factory';
import { subject as caslSubject } from '@casl/ability';
import type { PrismaService } from '../../shared/prisma/prisma.service';

type MockPrismaService = {
  user: { findUnique: jest.Mock };
  tenantMembership: { findMany: jest.Mock };
};

describe('CaslAbilityFactory — tenant-scoped ability resolution', () => {
  const createFactory = () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      tenantMembership: { findMany: jest.fn() },
    } satisfies MockPrismaService;

    const factory = new CaslAbilityFactory(prisma as unknown as PrismaService);

    return { factory, prisma };
  };

  it('builds permissions only from current tenant membership (Tenant A cashier, not Tenant B manager)', async () => {
    const { factory, prisma } = createFactory();

    prisma.tenantMembership.findMany.mockResolvedValue([
      {
        id: 'membership-a',
        role: {
          permissions: [
            { permission: { action: 'read', subject: 'Product' } },
            { permission: { action: 'create', subject: 'Sale' } },
          ],
        },
      },
    ]);

    const ability = await factory.createForUser('user-1', {
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'Product')).toBe(true);
    expect(ability.can('create', 'Sale')).toBe(true);
    expect(ability.can('manage', 'all')).toBe(false);
    const findMany = prisma.tenantMembership.findMany;
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', tenantId: 'tenant-a' },
      }),
    );
  });

  it('allows receipt evidence review actions granted by tenant role permissions', async () => {
    const { factory, prisma } = createFactory();

    prisma.tenantMembership.findMany.mockResolvedValue([
      {
        id: 'membership-reviewer',
        role: {
          permissions: [
            { permission: { action: 'read', subject: 'ReceiptEvidence' } },
            { permission: { action: 'update', subject: 'ReceiptEvidence' } },
            { permission: { action: 'manage', subject: 'ReceiptEvidence' } },
          ],
        },
      },
    ]);

    const ability = await factory.createForUser('reviewer-1', {
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'ReceiptEvidence')).toBe(true);
    expect(ability.can('update', 'ReceiptEvidence')).toBe(true);
    expect(ability.can('manage', 'ReceiptEvidence')).toBe(true);
    expect(ability.can('update', 'Sale')).toBe(false);
  });

  it('returns only manage:all for global super admin context', async () => {
    const { factory, prisma } = createFactory();

    const ability = await factory.createForUser('user-1', {
      tenantId: null,
      isSuperAdmin: true,
    });

    expect(ability.can('manage', 'all')).toBe(true);
    expect(ability.can('read', 'Product')).toBe(true);
    const findMany = prisma.tenantMembership.findMany;
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns empty ability when user requests tenant without membership', async () => {
    const { factory, prisma } = createFactory();

    prisma.tenantMembership.findMany.mockResolvedValue([]);

    const ability = await factory.createForUser('user-1', {
      tenantId: 'tenant-b',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'Product')).toBe(false);
    expect(ability.can('create', 'Sale')).toBe(false);
    expect(ability.can('manage', 'all')).toBe(false);
  });

  // delivery-routes / WU3 (3.15) — driver-ownership condition matcher.
  // A driver-only caller (has `read` + `update` on DeliveryRoute but
  // NOT `create`/`delete`) gets `{ driverUserId }` conditions so the
  // PermissionsGuard can re-check with `subject(...)`; a route-manager
  // caller (HAS `create` or `delete`) gets unconditional grants.
  describe('delivery-routes — driver vs route-manager discriminator (ADR-5)', () => {
    it('Given a driver-only caller (read+update, no create/delete), when the ability is built, then read/update carry { driverUserId } conditions and create/delete are denied', async () => {
      const { factory, prisma } = createFactory();
      prisma.tenantMembership.findMany.mockResolvedValue([
        {
          id: 'membership-driver',
          role: {
            permissions: [
              { permission: { action: 'read', subject: 'DeliveryRoute' } },
              { permission: { action: 'update', subject: 'DeliveryRoute' } },
            ],
          },
        },
      ]);

      const ability = await factory.createForUser('driver-1', {
        tenantId: 'tenant-a',
        isSuperAdmin: false,
      });

      // Coarse check passes (user holds the permission at all).
      expect(ability.can('read', 'DeliveryRoute')).toBe(true);
      expect(ability.can('update', 'DeliveryRoute')).toBe(true);
      // Condition-matcher check: a tagged subject with `driverUserId`
      // matching the caller MUST pass; one with a different id MUST fail.
      const matching = caslSubject('DeliveryRoute', {
        driverUserId: 'driver-1',
      });
      const foreign = caslSubject('DeliveryRoute', {
        driverUserId: 'driver-2',
      });
      expect(ability.can('read', matching)).toBe(true);
      expect(ability.can('read', foreign)).toBe(false);
      expect(ability.can('update', matching)).toBe(true);
      expect(ability.can('update', foreign)).toBe(false);
      // create/delete are NOT granted.
      expect(ability.can('create', 'DeliveryRoute')).toBe(false);
      expect(ability.can('delete', 'DeliveryRoute')).toBe(false);
    });

    it('Given a route-manager caller (has create OR delete on DeliveryRoute), when the ability is built, then the driver condition is NOT emitted (manager path is unconditional)', async () => {
      const { factory, prisma } = createFactory();
      prisma.tenantMembership.findMany.mockResolvedValue([
        {
          id: 'membership-manager',
          role: {
            permissions: [
              { permission: { action: 'read', subject: 'DeliveryRoute' } },
              { permission: { action: 'create', subject: 'DeliveryRoute' } },
              { permission: { action: 'delete', subject: 'DeliveryRoute' } },
            ],
          },
        },
      ]);

      const ability = await factory.createForUser('manager-1', {
        tenantId: 'tenant-a',
        isSuperAdmin: false,
      });

      // Coarse check passes.
      expect(ability.can('read', 'DeliveryRoute')).toBe(true);
      expect(ability.can('create', 'DeliveryRoute')).toBe(true);
      expect(ability.can('delete', 'DeliveryRoute')).toBe(true);
      // Foreign driver subject also passes (no driverUserId condition).
      const foreign = caslSubject('DeliveryRoute', {
        driverUserId: 'driver-2',
      });
      expect(ability.can('read', foreign)).toBe(true);
    });

    it('Given a super-admin context, when the ability is built, then `manage:all` short-circuits and the driver condition is irrelevant', async () => {
      const { factory } = createFactory();
      const ability = await factory.createForUser('super-1', {
        tenantId: null,
        isSuperAdmin: true,
      });
      expect(ability.can('manage', 'all')).toBe(true);
      // Even on a DeliveryRoute tagged subject with a foreign driver.
      const foreign = caslSubject('DeliveryRoute', {
        driverUserId: 'driver-2',
      });
      expect(ability.can('update', foreign)).toBe(true);
    });

    it('Given a driver-only caller without `update`, when the ability is built, then only the read condition is emitted (no spurious update rule)', async () => {
      const { factory, prisma } = createFactory();
      prisma.tenantMembership.findMany.mockResolvedValue([
        {
          id: 'membership-driver-readonly',
          role: {
            permissions: [
              { permission: { action: 'read', subject: 'DeliveryRoute' } },
            ],
          },
        },
      ]);

      const ability = await factory.createForUser('driver-1', {
        tenantId: 'tenant-a',
        isSuperAdmin: false,
      });

      const matching = caslSubject('DeliveryRoute', {
        driverUserId: 'driver-1',
      });
      expect(ability.can('read', matching)).toBe(true);
      expect(ability.can('update', matching)).toBe(false);
    });
  });
});

describe('all-role union', () => {
  const context = { tenantId: 'tenant-a', isSuperAdmin: false };
  const membership = (...permissions: Array<[string, string]>) => ({
    role: {
      permissions: permissions.map(([action, subject]) => ({
        permission: { action, subject },
      })),
    },
  });
  function setup(roles: ReturnType<typeof membership>[]) {
    const prisma = {
      tenantMembership: {
        findFirst: jest.fn().mockResolvedValue(roles[0] ?? null),
        findMany: jest.fn().mockResolvedValue(roles),
      },
    };
    return {
      prisma,
      factory: new CaslAbilityFactory(prisma as unknown as PrismaService),
    };
  }

  it.each([false, true])(
    'unions both roles independent of row order, deduplicated and sorted (%p)',
    async (reverse) => {
      const roles = [
        membership(['update', 'User'], ['read', 'Role']),
        membership(['update', 'TenantMembership'], ['read', 'Role']),
      ];
      const { prisma, factory } = setup(reverse ? roles.reverse() : roles);
      const ability = await factory.createForUser('user-1', context);
      expect(ability.can('update', 'User')).toBe(true);
      expect(ability.can('update', 'TenantMembership')).toBe(true);
      await expect(
        factory.getEffectivePermissions('user-1', context),
      ).resolves.toEqual([
        { action: 'read', subject: 'Role' },
        { action: 'update', subject: 'TenantMembership' },
        { action: 'update', subject: 'User' },
      ]);
      expect(prisma.tenantMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', tenantId: 'tenant-a' },
        }),
      );
    },
  );

  it('evaluates manager permission in the second role after union', async () => {
    const { factory } = setup([
      membership(['read', 'DeliveryRoute']),
      membership(['create', 'DeliveryRoute']),
    ]);
    const ability = await factory.createForUser('user-1', context);
    expect(
      ability.can(
        'read',
        caslSubject('DeliveryRoute', { driverUserId: 'other' }),
      ),
    ).toBe(true);
  });

  it('preserves legacy manage:all and does not shortcut selected-tenant superadmin', async () => {
    const { factory, prisma } = setup([
      membership(['read', 'User']),
      membership(['manage', 'all']),
    ]);
    const selected = { ...context, isSuperAdmin: true };
    expect(
      (await factory.createForUser('user-1', selected)).can('manage', 'all'),
    ).toBe(true);
    await expect(
      factory.getEffectivePermissions('user-1', selected),
    ).resolves.toEqual([
      { action: 'manage', subject: 'all' },
      { action: 'read', subject: 'User' },
    ]);
    expect(prisma.tenantMembership.findMany).toHaveBeenCalledTimes(2);
  });

  it('keeps driver ownership conditions after combining read and update roles', async () => {
    const { factory } = setup([
      membership(['read', 'DeliveryRoute']),
      membership(['update', 'DeliveryRoute']),
    ]);
    const ability = await factory.createForUser('user-1', context);
    const own = caslSubject('DeliveryRoute', { driverUserId: 'user-1' });
    const foreign = caslSubject('DeliveryRoute', { driverUserId: 'other' });
    expect(ability.can('read', own)).toBe(true);
    expect(ability.can('update', own)).toBe(true);
    expect(ability.can('read', foreign)).toBe(false);
    expect(ability.can('update', foreign)).toBe(false);
    await expect(
      factory.getEffectivePermissions('user-1', context),
    ).resolves.toEqual([
      { action: 'read', subject: 'DeliveryRoute' },
      { action: 'update', subject: 'DeliveryRoute' },
    ]);
  });

  it('does not grant global power from the superadmin flag in a selected tenant', async () => {
    const { factory } = setup([membership(['read', 'User'])]);
    const selected = { ...context, isSuperAdmin: true };
    const ability = await factory.createForUser('user-1', selected);
    expect(ability.can('read', 'User')).toBe(true);
    expect(ability.can('update', 'User')).toBe(false);
    expect(ability.can('manage', 'all')).toBe(false);
    await expect(
      factory.getEffectivePermissions('user-1', selected),
    ).resolves.toEqual([{ action: 'read', subject: 'User' }]);
  });

  it('returns empty output without memberships and avoids queries without tenant', async () => {
    const { factory, prisma } = setup([]);
    await expect(
      factory.getEffectivePermissions('user-1', context),
    ).resolves.toEqual([]);
    expect(
      (await factory.createForUser('user-1', context)).can('update', 'User'),
    ).toBe(false);
    prisma.tenantMembership.findMany.mockClear();
    for (const isSuperAdmin of [false, true]) {
      const global = { tenantId: null, isSuperAdmin };
      expect(
        (await factory.createForUser('user-1', global)).can('manage', 'all'),
      ).toBe(isSuperAdmin);
      await expect(
        factory.getEffectivePermissions('user-1', global),
      ).resolves.toEqual(
        isSuperAdmin ? [{ action: 'manage', subject: 'all' }] : [],
      );
    }
    expect(prisma.tenantMembership.findMany).not.toHaveBeenCalled();
  });
});
