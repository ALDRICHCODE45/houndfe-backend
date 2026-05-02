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
import { Inject, Injectable } from '@nestjs/common';
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
import { AssignRolesDto } from './dto/assign-roles.dto';

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

  async findAll(
    page: number,
    limit: number,
  ): Promise<{
    data: ReturnType<User['toResponse']>[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { tenantId, isSuperAdmin } = this.cls.get();
    const tenantPrisma = this.tenantPrisma.getClient();
    const skip = (page - 1) * limit;

    if (isSuperAdmin && tenantId === null) {
      const [users, total] = await Promise.all([
        this.prisma.user.findMany({ skip, take: limit }),
        this.prisma.user.count(),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        data: users.map((u) =>
          User.fromPersistence({
            ...u,
            hashedRefreshToken: u.hashedRefreshToken ?? null,
          }).toResponse(),
        ),
        meta: { total, page, limit, totalPages },
      };
    }

    const [memberships, total] = await Promise.all([
      tenantPrisma.tenantMembership.findMany({
        where: { tenantId: tenantId ?? undefined },
        include: { user: true },
        skip,
        take: limit,
      }),
      tenantPrisma.tenantMembership.count({
        where: { tenantId: tenantId ?? undefined },
      }),
    ]);

    const users = memberships.map((m) => m.user);
    const totalPages = Math.ceil(total / limit);

    return {
      data: users.map((u) =>
        User.fromPersistence({
          ...u,
          hashedRefreshToken: u.hashedRefreshToken ?? null,
        }).toResponse(),
      ),
      meta: { total, page, limit, totalPages },
    };
  }

  async findOne(id: string): Promise<{
    user: ReturnType<User['toResponse']>;
    roles: Array<{ id: string; name: string }>;
  }> {
    const result = await this.userRepo.findByIdWithRoles(id);
    if (!result) throw new EntityNotFoundError('User', id);

    return {
      user: result.user.toResponse(),
      roles: result.roles,
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
        throw new EntityAlreadyExistsError('TenantMembership', `${userId}:${tenantId}:${dto.roleId}`);
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

  async assignRoles(userId: string, dto: AssignRolesDto): Promise<void> {
    // Validate user exists
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('User', userId);

    // Validate all roles exist
    for (const roleId of dto.roleIds) {
      const role = await this.roleRepo.findById(roleId);
      if (!role) throw new EntityNotFoundError('Role', roleId);
    }

    // REPLACE strategy (atomic)
    await this.userRepo.assignRoles(userId, dto.roleIds);
  }

  async deactivate(id: string): Promise<void> {
    const user = await this.userRepo.findById(id);
    if (!user) throw new EntityNotFoundError('User', id);

    user.deactivate();
    await this.userRepo.save(user);
  }
}
