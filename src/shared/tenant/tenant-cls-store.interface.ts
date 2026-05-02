export interface TenantClsStore {
  [key: string]: unknown;
  [key: symbol]: unknown;
  userId: string;
  tenantId: string | null;
  tenantSlug?: string | null;
  isSuperAdmin: boolean;
}
