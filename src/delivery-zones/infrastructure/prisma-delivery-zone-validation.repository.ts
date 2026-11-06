/**
 * shipping-zones / T1 (S1, S2, S3) — ADAPTER:
 * PrismaDeliveryZoneValidationRepository.
 *
 * `listPending` orders open validations by their OLDEST pending requester's
 * `lastCustomerMessageAt` (earliest WhatsApp deadline first). Open validations
 * per sucursal are few, so ordering is done in memory over one grouped query.
 *
 * `resolve` is a versioned one-winner CAS under the per-postal-code lock:
 * flip the validation 1 -> 2, upsert + activate the zone, and settle every
 * PENDING requester with the zone outcome — all in ONE transaction. An exact
 * retry (same resolutionRequestId, action, settings and actor) replays with no
 * write; the same key with another payload is IDEMPOTENCY_CONFLICT; a
 * different key against a resolved row is ALREADY_RESOLVED.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ZoneSettings } from '../domain/delivery-zone.policy';
import {
  DeliveryZoneError,
  type DeliveryZoneRecord,
} from '../domain/delivery-zone.repository';
import {
  APPROVE_DELIVERY_ZONE,
  type DeliveryZoneValidationPage,
  type DeliveryZoneValidationRecord,
  type IDeliveryZoneValidationRepository,
  type ListPendingValidationsQuery,
  type ResolveDeliveryZoneValidationCommand,
  type ResolveDeliveryZoneValidationResult,
} from '../domain/delivery-zone-validation.repository';
import {
  DELIVERY_ZONE_SELECT,
  loadZoneActor,
  lockZipCode,
  toDeliveryZoneRecord,
  type TenantScopedClient,
} from './delivery-zone-persistence';

const VALIDATION_SELECT = {
  id: true,
  zipCode: true,
  state: true,
  municipality: true,
  neighborhood: true,
  status: true,
  version: true,
  createdAt: true,
  resolutionAction: true,
  zoneType: true,
  surchargeCents: true,
  etaDays: true,
  resolutionRequestId: true,
  resolvedAt: true,
  resolvedByActorId: true,
  resolvedByDisplayName: true,
} satisfies Prisma.DeliveryZoneValidationSelect;

type ValidationRow = Prisma.DeliveryZoneValidationGetPayload<{
  select: typeof VALIDATION_SELECT;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface RequesterStats {
  count: number;
  oldestPending: Date | null;
}

function fail(code: ConstructorParameters<typeof DeliveryZoneError>[0]): never {
  const messages = {
    DELIVERY_ZONE_NOT_FOUND: 'Delivery zone not found',
    DELIVERY_ZONE_VALIDATION_NOT_FOUND: 'Delivery zone validation not found',
    DELIVERY_ZONE_VALIDATION_PENDING: 'A validation is pending',
    VERSION_CONFLICT: 'Delivery zone validation version conflict',
    IDEMPOTENCY_CONFLICT: 'Request conflicts with a previous submission',
    ALREADY_RESOLVED: 'Delivery zone validation was already resolved',
    UNAUTHORIZED: 'Authenticated user required',
  } as const;
  throw new DeliveryZoneError(code, messages[code]);
}

function toRecord(
  row: ValidationRow,
  stats: RequesterStats,
): DeliveryZoneValidationRecord {
  return {
    id: row.id,
    zipCode: row.zipCode,
    state: row.state,
    municipality: row.municipality,
    neighborhood: row.neighborhood,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    requesterCount: stats.count,
    oldestLastCustomerMessageAt:
      row.status === 'PENDING' ? stats.oldestPending : null,
    resolutionAction: row.resolutionAction,
    zoneType: row.zoneType,
    surchargeCents: row.surchargeCents,
    etaDays: row.etaDays,
    resolvedAt: row.resolvedAt,
    resolvedByActorId: row.resolvedByActorId,
    resolvedByDisplayName: row.resolvedByDisplayName,
  };
}

/** Settings the command resolves to: APPROVE carries them, REJECT = DENIED. */
function settingsOf(
  command: ResolveDeliveryZoneValidationCommand,
): ZoneSettings {
  return command.action === APPROVE_DELIVERY_ZONE
    ? command.settings
    : { type: 'DENIED', surchargeCents: null, etaDays: null };
}

@Injectable()
export class PrismaDeliveryZoneValidationRepository implements IDeliveryZoneValidationRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listPending(
    query: ListPendingValidationsQuery,
  ): Promise<DeliveryZoneValidationPage> {
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();
    const rows = await db.deliveryZoneValidation.findMany({
      where: { tenantId, status: 'PENDING' },
      select: VALIDATION_SELECT,
    });
    const stats = await this.statsFor(
      db,
      tenantId,
      rows.map((row) => row.id),
    );
    const records = rows
      .map((row) => toRecord(row, stats.get(row.id) ?? emptyStats()))
      .sort(
        (a, b) =>
          sortKey(a) - sortKey(b) ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    const start = (query.page - 1) * query.limit;
    return {
      items: records.slice(start, start + query.limit),
      totalCount: records.length,
    };
  }

  async findById(id: string): Promise<DeliveryZoneValidationRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();
    const row = await db.deliveryZoneValidation.findFirst({
      where: { id, tenantId },
      select: VALIDATION_SELECT,
    });
    if (row === null) {
      return null;
    }
    const stats = await this.statsFor(db, tenantId, [row.id]);
    return toRecord(row, stats.get(row.id) ?? emptyStats());
  }

  async resolve(
    command: ResolveDeliveryZoneValidationCommand,
  ): Promise<ResolveDeliveryZoneValidationResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    if (!UUID_PATTERN.test(command.validationId)) {
      return fail('DELIVERY_ZONE_VALIDATION_NOT_FOUND');
    }
    const settings = settingsOf(command);

    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      const actor = await loadZoneActor(
        db,
        tenantId,
        command.actorUserId,
        command.actorIsSuperAdmin,
      );
      const located = await db.deliveryZoneValidation.findFirst({
        where: { id: command.validationId, tenantId },
        select: { zipCode: true },
      });
      if (located === null) {
        return fail('DELIVERY_ZONE_VALIDATION_NOT_FOUND');
      }
      await lockZipCode(db, tenantId, located.zipCode);
      const current = await this.readRow(db, tenantId, command.validationId);

      if (current.status === 'RESOLVED') {
        this.assertExactReplay(current, command, settings, actor.id);
        return this.result(db, tenantId, current, 'replayed');
      }
      if (command.expectedVersion !== current.version) {
        return fail('VERSION_CONFLICT');
      }

      const resolvedAt = new Date();
      const flipped = await db.deliveryZoneValidation.updateMany({
        where: {
          id: current.id,
          tenantId,
          status: 'PENDING',
          version: command.expectedVersion,
        },
        data: {
          status: 'RESOLVED',
          version: 2,
          resolutionAction: command.action,
          zoneType: settings.type,
          surchargeCents: settings.surchargeCents,
          etaDays: settings.etaDays,
          resolutionRequestId: command.resolutionRequestId,
          resolvedAt,
          resolvedByActorId: actor.id,
          resolvedByDisplayName: actor.displayName,
        },
      });
      if (flipped.count !== 1) {
        return fail('VERSION_CONFLICT');
      }

      const zoneData = {
        type: settings.type,
        surchargeCents: settings.surchargeCents,
        etaDays: settings.etaDays,
        state: current.state,
        municipality: current.municipality,
        neighborhood: current.neighborhood,
        isActive: true,
        approvedById: actor.id,
        approvedByDisplayName: actor.displayName,
        approvedAt: resolvedAt,
        sourceValidationId: current.id,
      };
      await db.deliveryZone.upsert({
        where: { tenantId_zipCode: { tenantId, zipCode: current.zipCode } },
        create: { tenantId, zipCode: current.zipCode, ...zoneData },
        update: zoneData,
      });
      await db.deliveryZoneRequest.updateMany({
        where: { tenantId, validationId: current.id, status: 'PENDING' },
        data: {
          status: 'RESOLVED',
          version: 2,
          resolutionSource: 'VALIDATION',
          zoneType: settings.type,
          surchargeCents: settings.surchargeCents,
          etaDays: settings.etaDays,
          resolvedAt,
        },
      });

      const committed = await this.readRow(db, tenantId, current.id);
      return this.result(db, tenantId, committed, 'resolved');
    });
  }

  private async readRow(
    db: TenantScopedClient,
    tenantId: string,
    id: string,
  ): Promise<ValidationRow> {
    const row = await db.deliveryZoneValidation.findFirst({
      where: { id, tenantId },
      select: VALIDATION_SELECT,
    });
    return row ?? fail('DELIVERY_ZONE_VALIDATION_NOT_FOUND');
  }

  private assertExactReplay(
    row: ValidationRow,
    command: ResolveDeliveryZoneValidationCommand,
    settings: ZoneSettings,
    actorId: string,
  ): void {
    if (row.resolutionRequestId !== command.resolutionRequestId) {
      fail('ALREADY_RESOLVED');
    }
    const exact =
      command.expectedVersion === 1 &&
      row.resolutionAction === command.action &&
      row.zoneType === settings.type &&
      row.surchargeCents === settings.surchargeCents &&
      row.etaDays === settings.etaDays &&
      row.resolvedByActorId === actorId;
    if (!exact) {
      fail('IDEMPOTENCY_CONFLICT');
    }
  }

  private async result(
    db: TenantScopedClient,
    tenantId: string,
    row: ValidationRow,
    status: ResolveDeliveryZoneValidationResult['status'],
  ): Promise<ResolveDeliveryZoneValidationResult> {
    const zone = await db.deliveryZone.findFirst({
      where: { tenantId, zipCode: row.zipCode },
      select: DELIVERY_ZONE_SELECT,
    });
    if (zone === null) {
      throw new Error('Resolved delivery-zone validation without a zone');
    }
    const stats = await this.statsFor(db, tenantId, [row.id]);
    return {
      status,
      validation: toRecord(row, stats.get(row.id) ?? emptyStats()),
      zone: toDeliveryZoneRecord(zone) satisfies DeliveryZoneRecord,
    };
  }

  /** Requester count and oldest PENDING requester message per validation. */
  private async statsFor(
    db: TenantScopedClient,
    tenantId: string,
    validationIds: string[],
  ): Promise<Map<string, RequesterStats>> {
    const stats = new Map<string, RequesterStats>();
    if (validationIds.length === 0) {
      return stats;
    }
    const [all, pending] = await Promise.all([
      db.deliveryZoneRequest.groupBy({
        by: ['validationId'],
        where: { tenantId, validationId: { in: validationIds } },
        _count: { _all: true },
      }),
      db.deliveryZoneRequest.groupBy({
        by: ['validationId'],
        where: {
          tenantId,
          validationId: { in: validationIds },
          status: 'PENDING',
        },
        _min: { lastCustomerMessageAt: true },
      }),
    ]);
    for (const group of all) {
      if (group.validationId !== null) {
        stats.set(group.validationId, {
          count: group._count._all,
          oldestPending: null,
        });
      }
    }
    for (const group of pending) {
      const entry =
        group.validationId === null ? undefined : stats.get(group.validationId);
      if (entry) {
        entry.oldestPending = group._min.lastCustomerMessageAt;
      }
    }
    return stats;
  }
}

function emptyStats(): RequesterStats {
  return { count: 0, oldestPending: null };
}

function sortKey(record: DeliveryZoneValidationRecord): number {
  return (
    record.oldestLastCustomerMessageAt?.getTime() ?? Number.MAX_SAFE_INTEGER
  );
}
