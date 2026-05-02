import { CaslAbilityFactory } from './casl-ability.factory';
import type { PrismaService } from '../../shared/prisma/prisma.service';

describe('CaslAbilityFactory — tenant-scoped ability resolution', () => {
  const createFactory = () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      tenantMembership: { findFirst: jest.fn() },
    } as unknown as PrismaService;

    const factory = new CaslAbilityFactory(prisma);

    return { factory, prisma };
  };

  it('builds permissions only from current tenant membership (Tenant A cashier, not Tenant B manager)', async () => {
    const { factory, prisma } = createFactory();

    (prisma.tenantMembership.findFirst as jest.Mock).mockResolvedValue({
      id: 'membership-a',
      role: {
        permissions: [
          { permission: { action: 'read', subject: 'Product' } },
          { permission: { action: 'create', subject: 'Sale' } },
        ],
      },
    });

    const ability = await (factory as any).createForUser('user-1', {
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'Product')).toBe(true);
    expect(ability.can('create', 'Sale')).toBe(true);
    expect(ability.can('manage', 'all')).toBe(false);
    expect(prisma.tenantMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', tenantId: 'tenant-a' },
      }),
    );
  });

  it('returns only manage:all for global super admin context', async () => {
    const { factory, prisma } = createFactory();

    const ability = await (factory as any).createForUser('user-1', {
      tenantId: null,
      isSuperAdmin: true,
    });

    expect(ability.can('manage', 'all')).toBe(true);
    expect(ability.can('read', 'Product')).toBe(true);
    expect(prisma.tenantMembership.findFirst).not.toHaveBeenCalled();
  });

  it('returns empty ability when user requests tenant without membership', async () => {
    const { factory, prisma } = createFactory();

    (prisma.tenantMembership.findFirst as jest.Mock).mockResolvedValue(null);

    const ability = await (factory as any).createForUser('user-1', {
      tenantId: 'tenant-b',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'Product')).toBe(false);
    expect(ability.can('create', 'Sale')).toBe(false);
    expect(ability.can('manage', 'all')).toBe(false);
  });
});
