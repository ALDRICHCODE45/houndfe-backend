import type { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

/** What the allocator just reserved, handed to the post-reserve hook. */
export interface ReservedBackorder {
  tenantId: string;
  backorderId: string;
  folio: string;
  customerId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  referencePriceCents: number;
  currentPriceCents: number;
  finalPriceCents: number;
  reservedAt: Date;
  reservedUntil: Date;
  reminderAt: Date;
}

/**
 * Seam called by the allocator INSIDE the reserving transaction, right after
 * the backorder became `RESERVED`. The feed task (T2b) binds an implementation
 * that enqueues `backorder.reserved` in the same transaction; until then the
 * binding is a no-op. A throwing hook rolls the reservation back with the rest
 * of that allocation (the stock write that triggered it is kept).
 */
export interface BackorderReservedHook {
  onReserved(tx: TenantClient, reserved: ReservedBackorder): Promise<void>;
}

export const BACKORDER_RESERVED_HOOK = Symbol('BACKORDER_RESERVED_HOOK');
