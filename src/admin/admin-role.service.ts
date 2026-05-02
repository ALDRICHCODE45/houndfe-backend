/**
 * AdminRoleService - Role management use cases.
 *
 * RESPONSIBILITIES:
 * - CRUD operations for roles (admin perspective)
 * - Permission assignment
 * - System role protection
 *
 * DOES NOT contain business logic (that's in Role entity).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { IRoleRepository } from '../auth/authorization/domain/role.repository';
import type { IPermissionRepository } from '../auth/authorization/domain/permission.repository';
import { ROLE_REPOSITORY } from '../auth/authorization/domain/role.repository';
import { PERMISSION_REPOSITORY } from '../auth/authorization/domain/permission.repository';
import { Role } from '../auth/authorization/domain/role.entity';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  EntityNotFoundError,
  EntityAlreadyExistsError,
  SystemRoleProtectedError,
} from '../shared/domain/domain-error';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';

@Injectable()
export class AdminRoleService {
  constructor(
    @Inject(ROLE_REPOSITORY)
    private readonly roleRepo: IRoleRepository,
    @Inject(PERMISSION_REPOSITORY)
    private readonly permissionRepo: IPermissionRepository,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async findAll(): Promise<
    Array<{
      role: ReturnType<Role['toResponse']>;
      userCount: number;
    }>
  > {
    const { tenantId, isSuperAdmin } = this.cls.get();
    const prisma = this.tenantPrisma.getClient();
    const where = isSuperAdmin && tenantId === null ? {} : { tenantId };
    const result = await prisma.role.findMany({
      where,
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { tenantMemberships: true } },
      },
    });

    return result.map((r) => ({
      role: Role.fromPersistence({
        id: r.id,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: r.permissions.map((rp) => ({
          subject: rp.permission.subject as any,
          action: rp.permission.action as any,
          description: rp.permission.description ?? '',
        })),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }).toResponse(),
      userCount: r._count.tenantMemberships,
    }));
  }

  async findOne(id: string): Promise<ReturnType<Role['toResponse']>> {
    const role = await this.roleRepo.findById(id);
    if (!role) throw new EntityNotFoundError('Role', id);
    return role.toResponse();
  }

  async create(dto: CreateRoleDto): Promise<ReturnType<Role['toResponse']>> {
    const { tenantId, isSuperAdmin } = this.cls.get();
    const prisma = this.tenantPrisma.getClient();
    const targetTenantId = isSuperAdmin && tenantId === null ? null : tenantId;

    // Validate name unique
    const existing = await prisma.role.findUnique({
      where: {
        tenantId_name: {
          tenantId: targetTenantId,
          name: dto.name,
        },
      },
    });
    if (existing) throw new EntityAlreadyExistsError('Role', dto.name);

    const role = Role.create({
      id: crypto.randomUUID(),
      name: dto.name,
      description: dto.description,
    });

    const saved = await prisma.role.create({
      data: {
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        tenantId: targetTenantId,
      },
      include: {
        permissions: { include: { permission: true } },
      },
    });

    const domain = Role.fromPersistence({
      id: saved.id,
      name: saved.name,
      description: saved.description,
      isSystem: saved.isSystem,
      permissions: saved.permissions.map((rp) => ({
        subject: rp.permission.subject as any,
        action: rp.permission.action as any,
        description: rp.permission.description ?? '',
      })),
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    return domain.toResponse();
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
  ): Promise<ReturnType<Role['toResponse']>> {
    const role = await this.roleRepo.findById(id);
    if (!role) throw new EntityNotFoundError('Role', id);

    // If name is being updated, check uniqueness
    if (dto.name && dto.name !== role.name) {
      const existing = await this.roleRepo.findByName(dto.name);
      if (existing) throw new EntityAlreadyExistsError('Role', dto.name);
    }

    // Create updated role with new values (Role is immutable)
    const updatedRole = Role.fromPersistence({
      id: role.id,
      name: dto.name ?? role.name,
      description:
        dto.description !== undefined ? dto.description : role.description,
      isSystem: role.isSystem,
      permissions: Array.from(role.permissions),
      createdAt: role.createdAt,
      updatedAt: new Date(),
    });

    const saved = await this.roleRepo.save(updatedRole);
    return saved.toResponse();
  }

  async assignPermissions(
    roleId: string,
    dto: AssignPermissionsDto,
  ): Promise<void> {
    // Validate role exists
    const role = await this.roleRepo.findById(roleId);
    if (!role) throw new EntityNotFoundError('Role', roleId);

    // Validate all permissions exist
    const permissions = await this.permissionRepo.findByIds(dto.permissionIds);
    if (permissions.length !== dto.permissionIds.length) {
      throw new EntityNotFoundError('Permission', 'one or more invalid IDs');
    }

    // REPLACE strategy (atomic)
    await this.roleRepo.assignPermissions(roleId, dto.permissionIds);
  }

  async delete(id: string): Promise<void> {
    const role = await this.roleRepo.findById(id);
    if (!role) throw new EntityNotFoundError('Role', id);

    // Protect system roles from deletion
    if (role.isSystem) {
      throw new SystemRoleProtectedError(role.name);
    }

    await this.roleRepo.delete(id);
  }
}
