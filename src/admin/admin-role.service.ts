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
import type { IRoleRepository } from '../auth/authorization/domain/role.repository';
import type { IPermissionRepository } from '../auth/authorization/domain/permission.repository';
import { ROLE_REPOSITORY } from '../auth/authorization/domain/role.repository';
import { PERMISSION_REPOSITORY } from '../auth/authorization/domain/permission.repository';
import { Role } from '../auth/authorization/domain/role.entity';
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
  ) {}

  async findAll(): Promise<
    Array<{
      role: ReturnType<Role['toResponse']>;
      userCount: number;
    }>
  > {
    const result = await this.roleRepo.findAllWithCounts();
    return result.map((r) => ({
      role: r.role.toResponse(),
      userCount: r.userCount,
    }));
  }

  async findOne(id: string): Promise<ReturnType<Role['toResponse']>> {
    const role = await this.roleRepo.findById(id);
    if (!role) throw new EntityNotFoundError('Role', id);
    return role.toResponse();
  }

  async create(dto: CreateRoleDto): Promise<ReturnType<Role['toResponse']>> {
    // Validate name unique
    const existing = await this.roleRepo.findByName(dto.name);
    if (existing) throw new EntityAlreadyExistsError('Role', dto.name);

    const role = Role.create({
      id: crypto.randomUUID(),
      name: dto.name,
      description: dto.description,
    });

    const saved = await this.roleRepo.save(role);
    return saved.toResponse();
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
