import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import {
  businessToday,
  isLotExpired,
} from '../../inventory/domain/fefo-allocator';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import type {
  StockActor,
  StockChange,
  StockRemovalCause,
} from '../../inventory/domain/stock-journal.types';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { LowStockCrossing } from '../../stock-alerts/infrastructure/low-stock-crossing.service';

const SYSTEM_ACTOR: StockActor = { id: null, displayName: 'Sistema' };

/**
 * Product-side entry point to the inventory journal (O1): records the
 * `INITIAL` stock a create carries and the `REMOVAL` of stock that is about to
 * disappear with a variant, a product or a first-variant conversion. Every
 * method must run inside `TenantPrismaService.runInTransaction`.
 */
@Injectable()
export class ProductStockJournal {
  private readonly businessTimezone: string;

  constructor(
    private readonly writer: StockJournalWriter,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly crossing: LowStockCrossing,
    config: ConfigService,
  ) {
    this.businessTimezone = config.get<string>(
      'PROMOTIONS_BUSINESS_TIMEZONE',
      'America/Mexico_City',
    );
  }

  /**
   * Units sitting in lots whose expiration calendar date is before today in
   * the business timezone (S6): never sellable, same rule as the FEFO charge.
   */
  async expiredLotQuantity(
    productId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const lots = await this.tenantPrisma.getClient().lot.findMany({
      where: {
        productId,
        tenantId: this.tenantPrisma.getTenantId(),
        quantity: { gt: 0 },
      },
      select: { quantity: true, expirationDate: true },
    });
    const today = businessToday(now, this.businessTimezone);
    return lots
      .filter((lot) => isLotExpired(lot.expirationDate, today))
      .reduce((sum, lot) => sum + lot.quantity, 0);
  }

  /** `INITIAL` movements for the strictly positive deltas of one product's new buckets. */
  async recordInitial(
    productId: string,
    changes: StockChange[],
  ): Promise<void> {
    const initial = changes.filter((change) => change.delta > 0);
    if (initial.length === 0) return;
    const movements = await this.writer.apply(initial, {
      type: 'INITIAL',
      groupType: 'PRODUCT',
      groupId: productId,
      actor: await this.actor(),
    });
    await this.crossing.record(movements);
  }

  /**
   * `REMOVAL` of all stock a product holds (lots, variants, untracked
   * portion) so the history survives the rows that carried it. The product row
   * is locked first so the quantities read here are the ones removed.
   */
  async removeProductStock(
    productId: string,
    cause: StockRemovalCause,
  ): Promise<void> {
    const { product, lots, variants } = await this.lockAndRead(productId);
    if (!product) return;
    const changes: StockChange[] = [];
    // Variant products keep `quantity = 0` and cannot journal lots (S6): only
    // non-variant products have lot and untracked buckets.
    if (!product.hasVariants) {
      for (const lot of lots) {
        changes.push({
          bucket: { kind: 'LOT', productId, lotId: lot.id },
          delta: -lot.quantity,
        });
      }
      const untracked =
        product.quantity - lots.reduce((sum, lot) => sum + lot.quantity, 0);
      if (untracked > 0) {
        changes.push({
          bucket: { kind: 'PRODUCT_UNTRACKED', productId },
          delta: -untracked,
          skipIfNotStocked: true,
        });
      }
    }
    for (const variant of variants) {
      changes.push({
        bucket: { kind: 'VARIANT', productId, variantId: variant.id },
        delta: -variant.quantity,
      });
    }
    await this.removal(productId, changes, cause);
  }

  /** `REMOVAL` of the stock one variant holds. */
  async removeVariantStock(
    productId: string,
    variantId: string,
    cause: StockRemovalCause,
  ): Promise<void> {
    const { variants } = await this.lockAndRead(productId);
    const variant = variants.find((v) => v.id === variantId);
    if (!variant) return;
    await this.removal(
      productId,
      [
        {
          bucket: { kind: 'VARIANT', productId, variantId },
          delta: -variant.quantity,
        },
      ],
      cause,
    );
  }

  private async removal(
    productId: string,
    changes: StockChange[],
    removalCause: StockRemovalCause,
  ): Promise<void> {
    const removable = changes.filter((change) => change.delta < 0);
    if (removable.length === 0) return;
    const movements = await this.writer.apply(removable, {
      type: 'REMOVAL',
      groupType: 'PRODUCT',
      groupId: productId,
      removalCause,
      actor: await this.actor(),
    });
    // A deleted product or variant must not raise a low-stock alert for
    // itself; only zeroing that keeps the product alive is a real crossing.
    if (removalCause === 'FIRST_VARIANT_ZEROING') {
      await this.crossing.record(movements);
    }
  }

  /** Product row `FOR UPDATE` first (journal lock order), then its stocked lots/variants. */
  private async lockAndRead(productId: string) {
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();
    await db.$queryRaw(Prisma.sql`
      SELECT "id" FROM "products" WHERE "id" = ${productId}
        AND "tenantId" = ${tenantId} FOR UPDATE
    `);
    const [product, lots, variants] = await Promise.all([
      db.product.findFirst({
        where: { id: productId, tenantId },
        select: { quantity: true, hasVariants: true },
      }),
      db.lot.findMany({
        where: { productId, tenantId, quantity: { gt: 0 } },
        select: { id: true, quantity: true },
        orderBy: { id: 'asc' },
      }),
      db.variant.findMany({
        where: { productId, tenantId, quantity: { gt: 0 } },
        select: { id: true, quantity: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return { product, lots, variants };
  }

  /** Authenticated user as a display-name snapshot; `Sistema` when there is none. */
  private async actor(): Promise<StockActor> {
    const userId = this.cls.get('userId');
    if (!userId) return SYSTEM_ACTOR;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user ? { id: userId, displayName: user.name } : SYSTEM_ACTOR;
  }
}
