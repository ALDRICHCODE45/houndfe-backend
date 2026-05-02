import type { TenantMembership } from './tenant-membership.entity';

export interface ITenantMembershipRepository {
  create(data: {
    userId: string;
    tenantId: string;
    roleId: string;
  }): Promise<TenantMembership>;
  findByTenant(tenantId: string): Promise<TenantMembership[]>;
  findByUserAndTenant(
    userId: string,
    tenantId: string,
  ): Promise<TenantMembership[]>;
  findByUserId(userId: string): Promise<TenantMembership[]>;
  update(id: string, data: { roleId: string }): Promise<TenantMembership>;
  delete(id: string): Promise<void>;
}

export const TENANT_MEMBERSHIP_REPOSITORY = Symbol('TENANT_MEMBERSHIP_REPOSITORY');
