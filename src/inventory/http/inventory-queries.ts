import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  requireInventoryAuthority,
  resolveInventoryPrincipal,
} from './inventory-authority';
import {
  InventoryContractError,
  parseInventoryId,
  parseMovementsQuery,
  type MovementView,
  type Page,
  type StockSnapshot,
} from './inventory-contract';
import { InventoryCursor } from './inventory-cursor';
import { InventoryStockReader } from './inventory-stock-reader';
import { toMovementView } from './inventory-views';

@Injectable()
export class InventoryQueries {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly cursor: InventoryCursor,
    private readonly stock: InventoryStockReader,
  ) {}

  async getStock(value: unknown): Promise<StockSnapshot> {
    return this.sanitized(() => {
      const productId = parseInventoryId(value);
      return this.read(async (tenantId) => {
        const snapshot = await this.stock.read(tenantId, productId);
        if (!snapshot) throw new InventoryContractError('NOT_FOUND');
        return snapshot;
      });
    });
  }

  /** Newest first. History survives deletes, so an unknown product is an empty page. */
  async listMovements(value: unknown): Promise<Page<MovementView>> {
    return this.sanitized(() => {
      const query = parseMovementsQuery(value);
      return this.read(async (tenantId) => {
        const scope = { ...query, tenantId };
        const after = query.cursor
          ? this.cursor.decode(query.cursor, scope)
          : undefined;
        const afterAt = after ? new Date(after.createdAt) : undefined;
        const rows = await this.db.getClient().stockMovement.findMany({
          where: {
            tenantId,
            productId: query.productId,
            ...(query.variantId ? { variantId: query.variantId } : {}),
            ...(query.lotId ? { lotId: query.lotId } : {}),
            ...(after && afterAt
              ? {
                  OR: [
                    { createdAt: { lt: afterAt } },
                    { createdAt: afterAt, id: { lt: after.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const items = rows.slice(0, query.limit).map(toMovementView);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            rows.length > query.limit && last
              ? this.cursor.encode(scope, last)
              : null,
        };
      });
    });
  }

  private async sanitized<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof InventoryContractError) throw error;
      throw new InventoryContractError('INTERNAL_ERROR');
    }
  }

  /** Current authority is held (locked) through the bounded reads; nothing is written. */
  private read<T>(work: (tenantId: string) => Promise<T>): Promise<T> {
    const scope = resolveInventoryPrincipal(this.cls, this.db);
    return this.db.runInTransaction(async () => {
      // SAFETY: own runInTransaction supplies the ambient Prisma transaction.
      const tx = this.db.getClient() as unknown as Prisma.TransactionClient;
      const tenants = await tx.$queryRaw<{ id: string; isActive: boolean }[]>(
        Prisma.sql`SELECT t."id", t."isActive" FROM "tenants" t
          WHERE t."id" = ${scope.tenantId} FOR SHARE OF t`,
      );
      if (tenants[0]?.id !== scope.tenantId || tenants[0].isActive !== true)
        throw new InventoryContractError('FORBIDDEN');
      await requireInventoryAuthority(tx, scope, 'READ');
      return work(scope.tenantId);
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
