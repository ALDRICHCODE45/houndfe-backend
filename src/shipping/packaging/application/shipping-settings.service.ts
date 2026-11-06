/**
 * shipping-zones / T2 (S5) — standard boxes and shipping origin per sucursal.
 *
 * The controller has already admitted the path tenant (own JWT tenant, or
 * `manage:all`). `ShippingBox` and `ShippingOrigin` are in
 * `TENANT_SCOPED_MODELS` and every query also carries `tenantId` explicitly,
 * so a box id from another tenant resolves to 404.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type ShippingBox, type ShippingOrigin } from '@prisma/client';
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
} from '../../../shared/domain/domain-error';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import type { StandardBox } from '../domain/order-package';
import type {
  CreateShippingBoxDto,
  PutShippingOriginDto,
  ShippingBoxView,
  ShippingOriginResponse,
  UpdateShippingBoxDto,
} from '../dto/shipping-settings.dto';

const toBoxView = (row: ShippingBox): ShippingBoxView => ({
  id: row.id,
  name: row.name,
  innerLengthCm: Number(row.innerLengthCm),
  innerWidthCm: Number(row.innerWidthCm),
  innerHeightCm: Number(row.innerHeightCm),
  weightG: row.weightG,
  maxContentWeightG: row.maxContentWeightG,
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toOriginResponse = (
  row: ShippingOrigin | null,
): ShippingOriginResponse =>
  row
    ? {
        configured: true,
        origin: {
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          neighborhood: row.neighborhood,
          municipality: row.municipality,
          state: row.state,
          postalCode: row.postalCode,
          contactPhone: row.contactPhone,
          updatedAt: row.updatedAt.toISOString(),
        },
      }
    : { configured: false, origin: null };

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

@Injectable()
export class ShippingSettingsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  async listBoxes(tenantId: string): Promise<{ data: ShippingBoxView[] }> {
    const rows = await this.db.shippingBox.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return { data: rows.map(toBoxView) };
  }

  /**
   * Quote-engine entry point (T3): active boxes for `buildOrderPackage`.
   * Explicit tenant on the base client, so it works outside a request scope.
   */
  async listActiveBoxes(tenantId: string): Promise<StandardBox[]> {
    const rows = await this.prisma.shippingBox.findMany({
      where: { tenantId, isActive: true },
    });
    return rows.map((row) => {
      const view = toBoxView(row);
      return {
        id: view.id,
        name: view.name,
        innerLengthCm: view.innerLengthCm,
        innerWidthCm: view.innerWidthCm,
        innerHeightCm: view.innerHeightCm,
        weightG: view.weightG,
        maxContentWeightG: view.maxContentWeightG,
      };
    });
  }

  async createBox(
    tenantId: string,
    dto: CreateShippingBoxDto,
  ): Promise<ShippingBoxView> {
    try {
      const row = await this.db.shippingBox.create({
        data: { ...dto, tenantId },
      });
      return toBoxView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EntityAlreadyExistsError('ShippingBox', dto.name);
      }
      throw error;
    }
  }

  async updateBox(
    tenantId: string,
    boxId: string,
    dto: UpdateShippingBoxDto,
  ): Promise<ShippingBoxView> {
    await this.requireBox(tenantId, boxId);
    try {
      const row = await this.db.shippingBox.update({
        where: { id: boxId, tenantId },
        data: { ...dto },
      });
      return toBoxView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EntityAlreadyExistsError('ShippingBox', dto.name ?? boxId);
      }
      throw error;
    }
  }

  async deleteBox(tenantId: string, boxId: string): Promise<void> {
    await this.requireBox(tenantId, boxId);
    await this.db.shippingBox.deleteMany({ where: { id: boxId, tenantId } });
  }

  async getOrigin(tenantId: string): Promise<ShippingOriginResponse> {
    const row = await this.db.shippingOrigin.findFirst({ where: { tenantId } });
    return toOriginResponse(row);
  }

  async putOrigin(
    tenantId: string,
    actorUserId: string,
    dto: PutShippingOriginDto,
  ): Promise<ShippingOriginResponse> {
    const data = {
      ...dto,
      addressLine2: dto.addressLine2 || null,
      updatedById: actorUserId,
    };
    const row = await this.db.shippingOrigin.upsert({
      where: { tenantId },
      create: { ...data, tenantId },
      update: data,
    });
    return toOriginResponse(row);
  }

  private get db() {
    return this.tenantPrisma.getClient();
  }

  private async requireBox(tenantId: string, boxId: string): Promise<void> {
    const found = await this.db.shippingBox.findFirst({
      where: { id: boxId, tenantId },
      select: { id: true },
    });
    if (!found) throw new EntityNotFoundError('ShippingBox', boxId);
  }
}
