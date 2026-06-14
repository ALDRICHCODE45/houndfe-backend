import { CaslAbilityFactory } from './casl-ability.factory';
import type { PrismaService } from '../../shared/prisma/prisma.service';

type MockPrismaService = {
  user: { findUnique: jest.Mock };
  tenantMembership: { findFirst: jest.Mock };
};

describe('CaslAbilityFactory — tenant-scoped ability resolution', () => {
  const createFactory = () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      tenantMembership: { findFirst: jest.fn() },
    } satisfies MockPrismaService;

    const factory = new CaslAbilityFactory(prisma as unknown as PrismaService);

    return { factory, prisma };
  };

  it('builds permissions only from current tenant membership (Tenant A cashier, not Tenant B manager)', async () => {
    const { factory, prisma } = createFactory();

    prisma.tenantMembership.findFirst.mockResolvedValue({
      id: 'membership-a',
      role: {
        permissions: [
          { permission: { action: 'read', subject: 'Product' } },
          { permission: { action: 'create', subject: 'Sale' } },
        ],
      },
    });

    const ability = await factory.createForUser('user-1', {
      tenantId: 'tenant-a',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'Product')).toBe(true);
    expect(ability.can('create', 'Sale')).toBe(true);
    expect(ability.can('manage', 'all')).toBe(false);
    const findFirst = prisma.tenantMembership.findFirst;
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', tenantId: 'tenant-a' },
      }),
    );
  });

  it('allows receipt evidence review actions granted by tenant role permissions', async () => {
    const { factory, prisma } = createFactory();

    prisma.tenantMembership.findFirst.mockResolvedValue({
      id: 'membership-reviewer',
      role: {
        permissions: [
          { permission: { action: 'read', subject: 'ReceiptEvidence' } },
          { permission: { action: 'update', subject: 'ReceiptEvidence' } },
          { permission: { action: 'manage', subject: 'ReceiptEvidence' } },
        ],
      },
    });

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
    const findFirst = prisma.tenantMembership.findFirst;
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns empty ability when user requests tenant without membership', async () => {
    const { factory, prisma } = createFactory();

    prisma.tenantMembership.findFirst.mockResolvedValue(null);

    const ability = await factory.createForUser('user-1', {
      tenantId: 'tenant-b',
      isSuperAdmin: false,
    });

    expect(ability.can('read', 'Product')).toBe(false);
    expect(ability.can('create', 'Sale')).toBe(false);
    expect(ability.can('manage', 'all')).toBe(false);
  });
});
