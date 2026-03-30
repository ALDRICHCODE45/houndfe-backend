/**
 * PORT: IUserRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for persistence.
 * Lives in domain, implemented in infrastructure.
 *
 * If you switch from Prisma to TypeORM or MongoDB,
 * you only create a new adapter — domain stays untouched.
 */

import { User } from './user.entity';
import { Email } from './value-objects/email.value-object';

export interface UserWithRoles {
  user: User;
  roles: Array<{ id: string; name: string }>;
}

export interface IUserRepository {
  save(user: User): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  existsByEmail(email: Email): Promise<boolean>;
  findAll(
    page: number,
    limit: number,
  ): Promise<{ users: User[]; total: number }>;
  findByIdWithRoles(id: string): Promise<UserWithRoles | null>;
  assignRoles(userId: string, roleIds: string[]): Promise<void>;
  update(user: User): Promise<User>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
