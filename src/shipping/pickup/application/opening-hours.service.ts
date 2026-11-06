/**
 * shipping-zones / T7 (S10) — sucursal weekly opening hours.
 *
 * The controller has already admitted the path tenant (own JWT tenant, or
 * `manage:all`). `TenantOpeningHours` is in `TENANT_SCOPED_MODELS` and every
 * query also carries `tenantId` explicitly.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, TenantOpeningHours } from '@prisma/client';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import {
  normalizeOpeningHours,
  type OpeningDay,
  type OpeningHours,
} from '../domain/opening-hours';
import type {
  OpeningHoursResponse,
  PutOpeningHoursDto,
} from '../dto/opening-hours.dto';

// SAFETY: rows are only written by `put`, which stores the normalized week.
const storedDays = (row: TenantOpeningHours): OpeningDay[] =>
  row.days as unknown as OpeningDay[];

const toResponse = (row: TenantOpeningHours | null): OpeningHoursResponse =>
  row
    ? {
        configured: true,
        openingHours: {
          timeZone: row.timeZone,
          days: storedDays(row),
          updatedAt: row.updatedAt.toISOString(),
        },
      }
    : { configured: false, openingHours: null };

@Injectable()
export class OpeningHoursService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async get(tenantId: string): Promise<OpeningHoursResponse> {
    return toResponse(await this.find(tenantId));
  }

  async put(
    tenantId: string,
    actorUserId: string,
    dto: PutOpeningHoursDto,
  ): Promise<OpeningHoursResponse> {
    const hours = normalizeOpeningHours(dto);
    const data = {
      timeZone: hours.timeZone,
      // SAFETY: the normalized week is plain strings/arrays/objects only.
      days: hours.days as unknown as Prisma.InputJsonValue,
      updatedById: actorUserId,
    };
    const row = await this.db.tenantOpeningHours.upsert({
      where: { tenantId },
      create: { ...data, tenantId },
      update: data,
    });
    return toResponse(row);
  }

  /** The stored week, or null until the first PUT. */
  async find(tenantId: string): Promise<TenantOpeningHours | null> {
    return this.db.tenantOpeningHours.findFirst({ where: { tenantId } });
  }

  async findHours(tenantId: string): Promise<OpeningHours | null> {
    const row = await this.find(tenantId);
    return row ? { timeZone: row.timeZone, days: storedDays(row) } : null;
  }

  private get db() {
    return this.tenantPrisma.getClient();
  }
}
