import { ForbiddenException } from '@nestjs/common';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantsMembershipService } from './tenants-membership.service';

describe('TenantsMembershipService', () => {
  const tenantId = 'tenant-b';
  const userId = 'user-1';

  const createService = (options?: {
    isSuperAdmin?: boolean;
    memberships?: Array<{ id: string }>;
    can?: boolean;
  }) => {
    const membershipRepo = {
      findByUserAndTenant: jest
        .fn()
        .mockResolvedValue(options?.memberships ?? [{ id: 'm-1' }]),
      create: jest.fn().mockResolvedValue({ id: 'created-membership' }),
      findByTenant: jest.fn().mockResolvedValue([{ id: 'membership-1' }]),
      update: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    const cls = {
      get: jest.fn().mockReturnValue({
        userId,
        isSuperAdmin: options?.isSuperAdmin ?? false,
      }),
    } as any;

    const ability = {
      can: jest.fn().mockReturnValue(options?.can ?? true),
    };

    const caslAbilityFactory = {
      createForUser: jest.fn().mockResolvedValue(ability),
    } as any;

    const findMany = jest.fn().mockResolvedValue([]);
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        tenantMembership: {
          findMany,
        },
      }),
    } as unknown as TenantPrismaService;

    const service = new TenantsMembershipService(
      membershipRepo,
      cls,
      caslAbilityFactory,
      tenantPrisma,
    );

    return {
      service,
      membershipRepo,
      caslAbilityFactory,
      ability,
      tenantPrisma,
      findMany,
    };
  };

  it('bypasses CASL checks for super-admin across all public methods', async () => {
    const { service, caslAbilityFactory, membershipRepo } = createService({
      isSuperAdmin: true,
    });

    await service.create(tenantId, { userId: 'u-2', roleId: 'r-2' });
    await service.findByTenant(tenantId);
    await service.update(tenantId, 'membership-1', { roleId: 'r-3' });
    await service.remove(tenantId, 'membership-1');

    expect(caslAbilityFactory.createForUser).not.toHaveBeenCalled();
    expect(membershipRepo.findByUserAndTenant).not.toHaveBeenCalled();
  });

  it('throws TENANT_ACCESS_DENIED when user has no membership in target tenant', async () => {
    const { service, membershipRepo, caslAbilityFactory } = createService({
      memberships: [],
    });

    await expect(
      service.create(tenantId, { userId: 'u-2', roleId: 'r-2' }),
    ).rejects.toThrow(new ForbiddenException('TENANT_ACCESS_DENIED'));

    expect(membershipRepo.create).not.toHaveBeenCalled();
    expect(caslAbilityFactory.createForUser).not.toHaveBeenCalled();
  });

  it('blocks cross-tenant escalation when ability denies action', async () => {
    const { service, membershipRepo } = createService({ can: false });

    await expect(
      service.create(tenantId, { userId: 'u-2', roleId: 'r-2' }),
    ).rejects.toThrow(
      new ForbiddenException('INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT'),
    );

    expect(membershipRepo.create).not.toHaveBeenCalled();
  });

  it('allows operation when user has required target-tenant permission', async () => {
    const { service, membershipRepo } = createService({ can: true });

    await service.create(tenantId, { userId: 'u-2', roleId: 'r-2' });

    expect(membershipRepo.create).toHaveBeenCalledWith({
      userId: 'u-2',
      roleId: 'r-2',
      tenantId,
    });
  });

  it("maps create() to ability.can('create', 'TenantMembership')", async () => {
    const { service, ability } = createService({ can: true });
    await service.create(tenantId, { userId: 'u-2', roleId: 'r-2' });
    expect(ability.can).toHaveBeenCalledWith('create', 'TenantMembership');
  });

  it("maps findByTenant() to ability.can('read', 'TenantMembership')", async () => {
    const { service, ability } = createService({ can: true });
    await service.findByTenant(tenantId);
    expect(ability.can).toHaveBeenCalledWith('read', 'TenantMembership');
  });

  it("maps update() to ability.can('update', 'TenantMembership')", async () => {
    const { service, ability } = createService({ can: true });
    await service.update(tenantId, 'membership-1', { roleId: 'r-2' });
    expect(ability.can).toHaveBeenCalledWith('update', 'TenantMembership');
  });

  it("maps remove() to ability.can('delete', 'TenantMembership')", async () => {
    const { service, ability } = createService({ can: true });
    await service.remove(tenantId, 'membership-1');
    expect(ability.can).toHaveBeenCalledWith('delete', 'TenantMembership');
  });

  it("findByTenantDetailed() calls assert gate with ('read', 'TenantMembership')", async () => {
    const { service, ability } = createService({ can: true });

    await service.findByTenantDetailed(tenantId);

    expect(ability.can).toHaveBeenCalledWith('read', 'TenantMembership');
  });

  it('findByTenantDetailed() uses include(user, role) and orderBy createdAt desc', async () => {
    const { service, findMany } = createService({ can: true });

    await service.findByTenantDetailed(tenantId);

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId },
      include: {
        user: {
          select: { id: true, email: true, name: true, isActive: true },
        },
        role: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  });
});
