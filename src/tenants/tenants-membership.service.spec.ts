import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
    const userFindMany = jest.fn().mockResolvedValue([]);
    const userCount = jest.fn().mockResolvedValue(0);
    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue({
        tenantMembership: {
          findMany,
        },
        user: {
          findMany: userFindMany,
          count: userCount,
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
      userFindMany,
      userCount,
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

  it("findEligibleUsers() checks tenant permission with ('create', 'TenantMembership')", async () => {
    const { service, ability } = createService({ can: true });

    await service.findEligibleUsers(tenantId, {});

    expect(ability.can).toHaveBeenCalledWith('create', 'TenantMembership');
  });

  it('findEligibleUsers() throws SEARCH_QUERY_TOO_SHORT for 1-char search', async () => {
    const { service } = createService({ can: true });

    await expect(
      service.findEligibleUsers(tenantId, { search: 'j' }),
    ).rejects.toThrow(new BadRequestException('SEARCH_QUERY_TOO_SHORT'));
  });

  it('findEligibleUsers() does not apply search filter when search is undefined', async () => {
    const { service, userFindMany } = createService({ can: true });

    await service.findEligibleUsers(tenantId, {});

    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          tenantMemberships: { none: { tenantId } },
        },
      }),
    );
  });

  it('findEligibleUsers() applies OR filter for 2+ char search', async () => {
    const { service, userFindMany } = createService({ can: true });

    await service.findEligibleUsers(tenantId, { search: 'ju' });

    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          tenantMemberships: { none: { tenantId } },
          OR: [
            { email: { contains: 'ju', mode: 'insensitive' } },
            { name: { contains: 'ju', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('findEligibleUsers() defaults to active users only', async () => {
    const { service, userFindMany } = createService({ can: true });

    await service.findEligibleUsers(tenantId, {});

    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  it('findEligibleUsers() removes isActive filter when includeInactive=true', async () => {
    const { service, userFindMany } = createService({ can: true });

    await service.findEligibleUsers(tenantId, { includeInactive: true });

    const whereArg = userFindMany.mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty('isActive');
  });

  it('findEligibleUsers() paginates with skip/take from page and limit', async () => {
    const { service, userFindMany } = createService({ can: true });

    await service.findEligibleUsers(tenantId, { page: 2, limit: 10 });

    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('findEligibleUsers() returns pagination meta with totalPages ceil', async () => {
    const { service, userCount } = createService({ can: true });
    userCount.mockResolvedValue(21);

    const result = await service.findEligibleUsers(tenantId, { page: 2, limit: 10 });

    expect(result.meta).toEqual({
      total: 21,
      page: 2,
      limit: 10,
      totalPages: 3,
    });
  });

  it('findEligibleUsers() returns empty shape when no results', async () => {
    const { service, userFindMany, userCount } = createService({ can: true });
    userFindMany.mockResolvedValue([]);
    userCount.mockResolvedValue(0);

    const result = await service.findEligibleUsers(tenantId, {});

    expect(result).toEqual({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
    });
  });
});
