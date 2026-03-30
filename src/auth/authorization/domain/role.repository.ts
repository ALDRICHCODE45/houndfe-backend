/**
 * PORT: IRoleRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for role persistence.
 * Lives in domain, implemented in infrastructure.
 *
 * If you switch from Prisma to TypeORM or MongoDB,
 * you only create a new adapter — domain stays untouched.
 */

import { Role } from './role.entity';

export interface RoleWithUserCount {
  role: Role;
  userCount: number;
}

export interface IRoleRepository {
  save(role: Role): Promise<Role>;
  findById(id: string): Promise<Role | null>;
  findByName(name: string): Promise<Role | null>;
  findAll(): Promise<Role[]>;
  delete(id: string): Promise<void>;
  assignPermissions(roleId: string, permissionIds: string[]): Promise<void>;
  findAllWithCounts(): Promise<RoleWithUserCount[]>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
