/**
 * AdminUserService - User management use cases.
 *
 * RESPONSIBILITIES:
 * - CRUD operations for users (admin perspective)
 * - Role assignment
 * - User activation/deactivation
 *
 * DOES NOT contain business logic (that's in User entity).
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { IUserRepository } from '../auth/domain/user.repository';
import type { IRoleRepository } from '../auth/authorization/domain/role.repository';
import { USER_REPOSITORY } from '../auth/domain/user.repository';
import { ROLE_REPOSITORY } from '../auth/authorization/domain/role.repository';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { User } from '../auth/domain/user.entity';
import { Email } from '../auth/domain/value-objects/email.value-object';
import { HashedPassword } from '../auth/domain/value-objects/hashed-password.value-object';
import {
  EntityNotFoundError,
  EntityAlreadyExistsError,
} from '../shared/domain/domain-error';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  PaginationQueryDto,
  type UserSortField,
  type UserSortOrder,
} from './dto/pagination-query.dto';

/** A `TenantMembership` row with its user and the role's id + name. */
type TenantMembershipWithUser = Prisma.TenantMembershipGetPayload<{
  include: { user: true; role: { select: { id: true; name: true } } };
}>;

type AdminUserListResponse = {
  data: Array<
    ReturnType<User['toResponse']> & {
      roles: Array<{ id: string; name: string }>;
    }
  >;
  meta: { total: number; page: number; limit: number; totalPages: number };
};

/**
 * Aggregates the roles of a user's memberships into a single array,
 * deduplicated by role id (a user may hold the same role across tenants).
 */
function aggregateRoles(
  memberships: Array<{ role: { id: string; name: string } }>,
): Array<{ id: string; name: string }> {
  const rolesById = new Map<string, { id: string; name: string }>();
  for (const membership of memberships) {
    rolesById.set(membership.role.id, {
      id: membership.role.id,
      name: membership.role.name,
    });
  }
  return [...rolesById.values()];
}

@Injectable()
export class AdminUserService {
  constructor(
    @Inject(USER_REPOSITORY)
    private readonly userRepo: IUserRepository,
    @Inject(ROLE_REPOSITORY)
    private readonly roleRepo: IRoleRepository,
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async findAll(query: PaginationQueryDto): Promise<AdminUserListResponse> {
    const { tenantId, isSuperAdmin } = this.cls.get();
    const tenantPrisma = this.tenantPrisma.getClient();

    const search = query.search;
    if (search !== undefined && search.length === 1) {
      throw new BadRequestException('SEARCH_QUERY_TOO_SHORT');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy: UserSortField = query.sortBy ?? 'name';
    const sortOrder: UserSortOrder = query.sortOrder ?? 'asc';
    const skip = (page - 1) * limit;
    const orderBy: Prisma.UserOrderByWithRelationInput = {
      [sortBy]: sortOrder,
    };

    if (isSuperAdmin && tenantId === null) {
      // Global branch: NO tenant scoping. `search` matches the user's name,
      // email OR any role they hold across tenants (a `some` relation filter).
      // Roles are aggregated from all memberships in a single query (no N+1).
      const where: Prisma.UserWhereInput =
        typeof search === 'string' && search.length >= 2
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                {
                  tenantMemberships: {
                    some: {
                      role: {
                        name: { contains: search, mode: 'insensitive' },
                      },
                    },
                  },
                },
              ],
            }
          : {};

      const [users, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          include: {
            tenantMemberships: {
              select: { role: { select: { id: true, name: true } } },
            },
          },
          orderBy,
          skip,
          take: limit,
        }),
        this.prisma.user.count({ where }),
      ]);

      return {
        data: users.map((u) => ({
          ...User.fromPersistence({
            ...u,
            hashedRefreshToken: u.hashedRefreshToken ?? null,
          }).toResponse(),
          roles: aggregateRoles(u.tenantMemberships),
        })),
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }

    // Tenant branch: rows are TenantMembership. A user may hold SEVERAL role
    // memberships in the same tenant, but the admin users screen shows one row
    // per user, so memberships are merged by userId with their roles
    // aggregated. Prisma cannot combine `distinct` with `include`, so we fetch
    // the filtered + sorted memberships (orderBy on the USER fields sorts
    // BEFORE grouping; the first-seen row per user carries the sort key),
    // merge by userId preserving that order, and only then slice for
    // pagination. `total` is the distinct-user count of the SAME filtered
    // `where` — one user equals one response row. Correct-first: tenants with
    // very large membership tables pay for the in-memory merge.
    const memberships = await tenantPrisma.tenantMembership.findMany({
      where: {
        tenantId: tenantId ?? undefined,
        ...(typeof search === 'string' && search.length >= 2
          ? {
              OR: [
                { user: { name: { contains: search, mode: 'insensitive' } } },
                { user: { email: { contains: search, mode: 'insensitive' } } },
                { role: { name: { contains: search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: { user: true, role: { select: { id: true, name: true } } },
      orderBy: { user: orderBy },
    });

    // Merge memberships by userId. Within a tenant the
    // `@@unique([userId, tenantId, roleId])` constraint guarantees a user can
    // never hold the same role twice, so no per-user role dedup is needed here.
    const usersByUserId = new Map<
      string,
      {
        user: TenantMembershipWithUser['user'];
        roles: Array<{ id: string; name: string }>;
      }
    >();

    for (const membership of memberships) {
      const existing = usersByUserId.get(membership.user.id);
      const role = { id: membership.role.id, name: membership.role.name };
      if (existing) {
        existing.roles.push(role);
      } else {
        usersByUserId.set(membership.user.id, {
          user: membership.user,
          roles: [role],
        });
      }
    }

    const users = [...usersByUserId.values()];
    const total = users.length;

    return {
      data: users.slice(skip, skip + limit).map(({ user, roles }) => ({
        ...User.fromPersistence({
          ...user,
          hashedRefreshToken: user.hashedRefreshToken ?? null,
        }).toResponse(),
        roles,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<{
    user: ReturnType<User['toResponse']>;
    roles: Array<{ id: string; name: string }>;
  }> {
    const { tenantId, isSuperAdmin } = this.cls.get();
    const tenantPrisma = this.tenantPrisma.getClient();
    const result = await this.userRepo.findByIdWithRoles(id);
    if (!result) throw new EntityNotFoundError('User', id);

    if (isSuperAdmin && tenantId === null) {
      return {
        user: result.user.toResponse(),
        roles: result.roles,
      };
    }

    const membership = await tenantPrisma.tenantMembership.findFirst({
      where: { userId: id, tenantId: tenantId ?? undefined },
      select: { id: true },
    });

    if (!membership) {
      throw new EntityNotFoundError('User', id);
    }

    const memberships = await tenantPrisma.tenantMembership.findMany({
      where: { userId: id, tenantId: tenantId ?? undefined },
      include: { role: { select: { id: true, name: true } } },
    });

    return {
      user: result.user.toResponse(),
      roles: memberships.map((tenantMembership) => ({
        id: tenantMembership.role.id,
        name: tenantMembership.role.name,
      })),
    };
  }

  async create(dto: CreateUserDto): Promise<ReturnType<User['toResponse']>> {
    const { tenantId } = this.cls.get();
    const tenantPrisma = this.tenantPrisma.getClient();
    const email = Email.create(dto.email);

    const existing = await this.prisma.user.findUnique({
      where: { email: email.value },
    });

    const userId = existing?.id ?? crypto.randomUUID();

    if (!dto.roleId) {
      throw new EntityNotFoundError('Role', 'roleId');
    }

    const role = await this.roleRepo.findById(dto.roleId);
    if (!role) throw new EntityNotFoundError('Role', dto.roleId);

    if (!existing) {
      const hashedPassword = await HashedPassword.fromPlain(dto.password);

      const user = User.create({
        id: userId,
        email,
        hashedPassword,
        name: dto.name,
      });

      await this.userRepo.save(user);
    }

    if (tenantId) {
      const membershipExists = await tenantPrisma.tenantMembership.findFirst({
        where: { userId, tenantId, roleId: dto.roleId },
        select: { id: true },
      });

      if (membershipExists) {
        throw new EntityAlreadyExistsError(
          'TenantMembership',
          `${userId}:${tenantId}:${dto.roleId}`,
        );
      }

      await tenantPrisma.tenantMembership.create({
        data: {
          userId,
          tenantId,
          roleId: dto.roleId,
        },
      });
    }

    const finalUser = await this.userRepo.findById(userId);
    if (!finalUser) throw new EntityNotFoundError('User', userId);

    return finalUser.toResponse();
  }

  async update(
    id: string,
    dto: UpdateUserDto,
  ): Promise<ReturnType<User['toResponse']>> {
    const user = await this.userRepo.findById(id);
    if (!user) throw new EntityNotFoundError('User', id);

    user.updateProfile(dto.name);

    const updated = await this.userRepo.update(user);
    return updated.toResponse();
  }

  async deactivate(id: string): Promise<void> {
    const user = await this.userRepo.findById(id);
    if (!user) throw new EntityNotFoundError('User', id);

    user.deactivate();
    await this.userRepo.save(user);
  }
}
