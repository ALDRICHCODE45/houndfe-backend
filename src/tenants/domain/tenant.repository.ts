import type { Tenant } from './tenant.entity';

export interface ITenantRepository {
  create(data: {
    name: string;
    slug: string;
    address?: string;
    phone?: string;
  }): Promise<Tenant>;
  findById(id: string): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  findAll(includeInactive?: boolean): Promise<Tenant[]>;
  update(
    id: string,
    data: Partial<Pick<Tenant, 'name' | 'slug' | 'address' | 'phone' | 'isActive'>>,
  ): Promise<Tenant>;
  deactivate(id: string): Promise<void>;
}

export const TENANT_REPOSITORY = Symbol('TENANT_REPOSITORY');
