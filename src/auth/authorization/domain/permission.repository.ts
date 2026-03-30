/**
 * PORT: IPermissionRepository (Driven Port)
 *
 * Contract that the domain DEMANDS for permission queries.
 * Lives in domain, implemented in infrastructure.
 *
 * Read-only operations - permissions are seeded and managed via repository.
 */

export interface PermissionRecord {
  id: string;
  subject: string;
  action: string;
  description: string | null;
  createdAt: Date;
}

export interface IPermissionRepository {
  findAll(): Promise<PermissionRecord[]>;
  findByIds(ids: string[]): Promise<PermissionRecord[]>;
}

/** Injection token — used by NestJS DI to resolve the interface. */
export const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY');
