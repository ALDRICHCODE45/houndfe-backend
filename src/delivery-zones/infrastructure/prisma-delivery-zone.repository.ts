/**
 * shipping-zones / T1 (S1) — ADAPTER: PrismaDeliveryZoneRepository.
 *
 * Store-side CRUD over `delivery_zones`. Tenant comes from
 * `TenantPrismaService.getTenantId()` and is repeated in every WHERE clause on
 * top of the CLS extension. `upsert` and `deactivate` take the per-postal-code
 * advisory lock shared with the bot intake and the validation resolve, so a
 * manual edit never races an open validation.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  DeliveryZoneError,
  type DeliveryZonePage,
  type DeliveryZoneRecord,
  type IDeliveryZoneRepository,
  type ListDeliveryZonesQuery,
  type UpsertDeliveryZoneCommand,
} from '../domain/delivery-zone.repository';
import {
  DELIVERY_ZONE_SELECT,
  loadZoneActor,
  lockZipCode,
  toDeliveryZoneRecord,
} from './delivery-zone-persistence';

@Injectable()
export class PrismaDeliveryZoneRepository implements IDeliveryZoneRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListDeliveryZonesQuery): Promise<DeliveryZonePage> {
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();
    const search = query.search?.trim();
    const where: Prisma.DeliveryZoneWhereInput = {
      tenantId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(search
        ? {
            OR: [
              { zipCode: { startsWith: search } },
              { municipality: { contains: search, mode: 'insensitive' } },
              { neighborhood: { contains: search, mode: 'insensitive' } },
              { state: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, totalCount] = await Promise.all([
      db.deliveryZone.findMany({
        where,
        select: DELIVERY_ZONE_SELECT,
        orderBy: [{ zipCode: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.deliveryZone.count({ where }),
    ]);
    return { items: rows.map(toDeliveryZoneRecord), totalCount };
  }

  async findByZipCode(zipCode: string): Promise<DeliveryZoneRecord | null> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await this.tenantPrisma.getClient().deliveryZone.findFirst({
      where: { tenantId, zipCode },
      select: DELIVERY_ZONE_SELECT,
    });
    return row === null ? null : toDeliveryZoneRecord(row);
  }

  async upsert(
    command: UpsertDeliveryZoneCommand,
  ): Promise<DeliveryZoneRecord> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      await lockZipCode(db, tenantId, command.zipCode);
      const actor = await loadZoneActor(
        db,
        tenantId,
        command.actorUserId,
        command.actorIsSuperAdmin,
      );
      const pending = await db.deliveryZoneValidation.findFirst({
        where: { tenantId, zipCode: command.zipCode, status: 'PENDING' },
        select: { id: true },
      });
      if (pending !== null) {
        throw new DeliveryZoneError(
          'DELIVERY_ZONE_VALIDATION_PENDING',
          'Resolve the pending validation for this postal code instead',
          { validationId: pending.id },
        );
      }
      const data = {
        type: command.settings.type,
        surchargeCents: command.settings.surchargeCents,
        etaDays: command.settings.etaDays,
        state: command.state,
        municipality: command.municipality,
        neighborhood: command.neighborhood,
        isActive: true,
        approvedById: actor.id,
        approvedByDisplayName: actor.displayName,
        approvedAt: new Date(),
        sourceValidationId: null,
      };
      const row = await db.deliveryZone.upsert({
        where: { tenantId_zipCode: { tenantId, zipCode: command.zipCode } },
        create: { tenantId, zipCode: command.zipCode, ...data },
        update: data,
        select: DELIVERY_ZONE_SELECT,
      });
      return toDeliveryZoneRecord(row);
    });
  }

  async deactivate(zipCode: string): Promise<DeliveryZoneRecord> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      await lockZipCode(db, tenantId, zipCode);
      const updated = await db.deliveryZone.updateMany({
        where: { tenantId, zipCode },
        data: { isActive: false },
      });
      if (updated.count === 0) {
        throw new DeliveryZoneError(
          'DELIVERY_ZONE_NOT_FOUND',
          'Delivery zone not found',
        );
      }
      const row = await db.deliveryZone.findFirstOrThrow({
        where: { tenantId, zipCode },
        select: DELIVERY_ZONE_SELECT,
      });
      return toDeliveryZoneRecord(row);
    });
  }
}
