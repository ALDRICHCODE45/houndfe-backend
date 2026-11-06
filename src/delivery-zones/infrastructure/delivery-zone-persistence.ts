/**
 * shipping-zones / T1 — persistence helpers shared by the delivery-zone
 * adapters (store CRUD, validation resolve and bot intake).
 */
import { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  DeliveryZoneError,
  type DeliveryZoneRecord,
} from '../domain/delivery-zone.repository';

export type TenantScopedClient = ReturnType<TenantPrismaService['getClient']>;

export const DELIVERY_ZONE_SELECT = {
  id: true,
  zipCode: true,
  type: true,
  surchargeCents: true,
  etaDays: true,
  state: true,
  municipality: true,
  neighborhood: true,
  isActive: true,
  approvedById: true,
  approvedByDisplayName: true,
  approvedAt: true,
  sourceValidationId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeliveryZoneSelect;

export function toDeliveryZoneRecord(
  row: Prisma.DeliveryZoneGetPayload<{ select: typeof DELIVERY_ZONE_SELECT }>,
): DeliveryZoneRecord {
  return { ...row };
}

/**
 * Serialize every writer of one tenant + postal code (bot intake, validation
 * resolve, store upsert) inside the caller's transaction. The lock is released
 * at commit/rollback; it makes "zone exists?" + "open validation?" + write a
 * single atomic step without SERIALIZABLE retries.
 */
export async function lockZipCode(
  db: TenantScopedClient,
  tenantId: string,
  zipCode: string,
): Promise<void> {
  const key = JSON.stringify(['delivery_zone', tenantId, zipCode]);
  await db.$queryRaw(
    // pg_advisory_xact_lock returns void; cast only its result to a scalar.
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`,
  );
}

export interface ZoneActor {
  id: string;
  displayName: string;
}

/**
 * Load the verified actor's display-name snapshot. Non-superadmins (the flag
 * comes from the verified JWT) must hold a membership in the tenant, the same
 * rule as the human-decision resolve port.
 */
export async function loadZoneActor(
  db: TenantScopedClient,
  tenantId: string,
  actorUserId: string,
  actorIsSuperAdmin: boolean,
): Promise<ZoneActor> {
  const user = await db.user.findUnique({
    where: { id: actorUserId },
    select: { id: true, name: true, isActive: true },
  });
  if (user === null || !user.isActive || user.name.trim().length === 0) {
    throw new DeliveryZoneError('UNAUTHORIZED', 'Authenticated user required');
  }
  if (!actorIsSuperAdmin) {
    const membership = await db.tenantMembership.findFirst({
      where: { tenantId, userId: actorUserId },
      select: { id: true },
    });
    if (membership === null) {
      throw new DeliveryZoneError(
        'UNAUTHORIZED',
        'Authenticated user required',
      );
    }
  }
  return { id: user.id, displayName: user.name };
}
