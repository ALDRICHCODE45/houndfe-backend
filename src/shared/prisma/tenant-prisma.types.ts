/**
 * Utility types for tenant-aware Prisma operations.
 *
 * The Prisma Client Extension auto-injects `tenantId` at runtime for all
 * tenant-scoped models. These types make `tenantId` optional in create/update
 * inputs so TypeScript stays strict for all other fields.
 */

/** Makes `tenantId` optional in a Prisma input type */
export type WithOptionalTenant<T> = Omit<T, 'tenantId' | 'tenant'> & {
  tenantId?: string;
  tenant?: unknown;
};
