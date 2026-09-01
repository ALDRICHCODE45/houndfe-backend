import { Injectable } from '@nestjs/common';

import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ICatalogSettingsRepository } from '../domain/catalog-settings.repository';
import {
  TenantCatalogSettings,
  type TenantBaseProps,
} from '../domain/tenant-catalog-settings.aggregate';
import {
  TenantCatalogPriceListBinding,
  type TenantCatalogPriceListBindingProps,
} from '../domain/tenant-catalog-price-list.entity';

@Injectable()
export class PrismaCatalogSettingsRepository implements ICatalogSettingsRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findByTenantId(
    tenantId: string,
  ): Promise<TenantCatalogSettings | null> {
    const db = this.tenantPrisma.getClient();
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        isActive: true,
        catalogPublished: true,
        catalogStockPresentationDefault: true,
        catalogStockPresentationDefaultCustomQty: true,
        updatedAt: true,
      },
    });
    if (!tenant) return null;
    const bindings = await db.tenantCatalogPriceList.findMany({
      where: { tenantId },
      orderBy: { globalPriceListId: 'asc' },
      include: { globalPriceList: { select: { id: true, name: true } } },
    });
    return this.buildAggregate(
      tenant as TenantBaseProps & typeof tenant,
      bindings as Parameters<typeof this.buildAggregate>[1],
    );
  }

  async replace(
    settings: TenantCatalogSettings,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _actorUserId: string,
  ): Promise<TenantCatalogSettings> {
    const { tenantId } = settings;
    const requestedIds = settings.bindings.map((b) => b.globalPriceListId);

    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();

      // Explicit-tenant FOR UPDATE lock on tenant row.
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "tenants" WHERE id = ${tenantId} FOR UPDATE
      `;
      if (rows.length !== 1) throw new Error(`Tenant ${tenantId} not found`);

      // Validate every requested globalPriceListId inside the transaction.
      if (requestedIds.length > 0) {
        const validRows = await db.globalPriceList.findMany({
          where: { id: { in: requestedIds } },
          select: { id: true },
        });
        const validSet = new Set(validRows.map((r) => r.id));
        for (const id of requestedIds) {
          if (!validSet.has(id))
            throw new Error(
              `INVALID_GLOBAL_PRICE_LIST: "${id}" does not exist`,
            );
        }
      }

      // Sort requested bindings by globalPriceListId ascending.
      const sortedBindings = [...settings.bindings].sort((a, b) =>
        a.globalPriceListId.localeCompare(b.globalPriceListId),
      );

      // Clear all existing defaults.
      await db.tenantCatalogPriceList.updateMany({
        where: { tenantId, isCatalogDefault: true },
        data: { isCatalogDefault: false },
      });

      // Upsert (idempotent) every non-default binding; let the DB auto-generate
      // the row id — binding.id is not part of the upsert key.
      for (const binding of sortedBindings) {
        await db.tenantCatalogPriceList.upsert({
          where: {
            tenantId_globalPriceListId: {
              tenantId,
              globalPriceListId: binding.globalPriceListId,
            },
          },
          create: {
            tenantId,
            globalPriceListId: binding.globalPriceListId,
            isCatalogDefault: false,
          },
          update: { isCatalogDefault: false },
        });
      }

      // Delete stale rows by the same (tenantId, globalPriceListId) business key.
      // Handle the empty-set case explicitly — Prisma rejects notIn: [].
      const requestedGlobalIds = new Set(
        settings.bindings.map((b) => b.globalPriceListId),
      );
      if (requestedGlobalIds.size === 0) {
        await db.tenantCatalogPriceList.deleteMany({ where: { tenantId } });
      } else {
        await db.tenantCatalogPriceList.deleteMany({
          where: {
            tenantId,
            globalPriceListId: { notIn: [...requestedGlobalIds] },
          },
        });
      }

      // Promote the selected default.
      const defaultBinding = settings.defaultBinding;
      if (defaultBinding) {
        await db.tenantCatalogPriceList.updateMany({
          where: {
            tenantId,
            globalPriceListId: defaultBinding.globalPriceListId,
          },
          data: { isCatalogDefault: true },
        });
      }

      // Update tenant publication and stock-presentation columns.
      await db.tenant.update({
        where: { id: tenantId },
        data: {
          catalogPublished: settings.catalogPublished,
          catalogStockPresentationDefault: settings.stockPresentationDefault
            .mode as
            | 'SYSTEM_STATUS'
            | 'ABSTRACT_STATUS'
            | 'CUSTOM_QUANTITY'
            | 'HIDDEN',
          catalogStockPresentationDefaultCustomQty:
            settings.stockPresentationDefault.customQuantity,
        },
      });

      // Reload and return the aggregate (ordered projection).
      return this.reloadAggregate(tenantId);
    });
  }

  async findGlobalPriceListsByIds(
    ids: string[],
  ): Promise<Array<{ id: string; name: string }>> {
    if (ids.length === 0) return [];
    const db = this.tenantPrisma.getClient();
    return db.globalPriceList.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }

  async countDefaultContextCoverage(
    tenantId: string,
    globalPriceListId: string,
  ): Promise<number> {
    const db = this.tenantPrisma.getClient();
    return db.priceList.count({
      where: { tenantId, globalPriceListId, priceCents: { gt: 0 } },
    });
  }

  private buildAggregate(
    tenant: TenantBaseProps & { id: string },
    bindings: Array<
      TenantCatalogPriceListBindingProps & {
        globalPriceList: { id: string; name: string };
      }
    >,
  ): TenantCatalogSettings {
    const base: TenantBaseProps = {
      tenantId: tenant.id,
      isActive: tenant.isActive,
      catalogPublished: tenant.catalogPublished,
      catalogStockPresentationDefault: tenant.catalogStockPresentationDefault,
      catalogStockPresentationDefaultCustomQty:
        tenant.catalogStockPresentationDefaultCustomQty,
      updatedAt: tenant.updatedAt,
    };
    return TenantCatalogSettings.fromPersistence({
      tenant: base,
      bindings: bindings.map((b) =>
        TenantCatalogPriceListBinding.fromPersistence({
          id: b.id,
          tenantId: b.tenantId,
          globalPriceListId: b.globalPriceListId,
          isCatalogDefault: b.isCatalogDefault,
          createdAt: new Date(b.createdAt),
          updatedAt: new Date(b.updatedAt),
          globalPriceList: b.globalPriceList,
        }),
      ),
    });
  }

  private async reloadAggregate(
    tenantId: string,
  ): Promise<TenantCatalogSettings> {
    const db = this.tenantPrisma.getClient();
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        isActive: true,
        catalogPublished: true,
        catalogStockPresentationDefault: true,
        catalogStockPresentationDefaultCustomQty: true,
        updatedAt: true,
      },
    });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found after replace`);
    const bindings = await db.tenantCatalogPriceList.findMany({
      where: { tenantId },
      orderBy: { globalPriceListId: 'asc' },
      include: { globalPriceList: { select: { id: true, name: true } } },
    });
    return this.buildAggregate(
      tenant as TenantBaseProps & typeof tenant,
      bindings as Parameters<typeof this.buildAggregate>[1],
    );
  }
}
