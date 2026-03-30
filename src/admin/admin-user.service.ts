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
import type { IUserRepository } from '../auth/domain/user.repository';
import type { IRoleRepository } from '../auth/authorization/domain/role.repository';
import { USER_REPOSITORY } from '../auth/domain/user.repository';
import { ROLE_REPOSITORY } from '../auth/authorization/domain/role.repository';
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
  ) {}

  async findAll(
    page: number,
    limit: number,
  ): Promise<{
    data: ReturnType<User['toResponse']>[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { users, total } = await this.userRepo.findAll(page, limit);
    const totalPages = Math.ceil(total / limit);

    return {
      data: users.map((u) => u.toResponse()),
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
    const email = Email.create(dto.email);

    const exists = await this.userRepo.existsByEmail(email);
    if (exists) throw new EntityAlreadyExistsError('User', dto.email);

    const hashedPassword = await HashedPassword.fromPlain(dto.password);

    const user = User.create({
      id: crypto.randomUUID(),
      email,
      hashedPassword,
      name: dto.name,
    });

    const saved = await this.userRepo.save(user);
    return saved.toResponse();
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
