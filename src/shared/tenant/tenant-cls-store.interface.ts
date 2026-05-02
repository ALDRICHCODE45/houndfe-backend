export interface TenantClsStore {
  userId: string;
  tenantId: string | null;
  tenantSlug?: string | null;
  isSuperAdmin: boolean;
}
