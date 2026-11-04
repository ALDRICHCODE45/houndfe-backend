import { Inject, Injectable } from '@nestjs/common';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  STOCK_ALERT_STATE_REPOSITORY,
  type IStockAlertStateRepository,
} from '../domain/stock-alert-state.repository';

/** The journal-row fields the low-stock edge reads (`AppliedStockMovement` satisfies it). */
export interface JournalMovementLike {
  productId: string;
  variantId: string | null;
  delta: number;
  /** Balance of the row's own bucket after the change. */
  balanceAfter: number;
  /** Product total after the change. */
  productBalanceAfter: number;
}

interface BalanceChange {
  productId: string;
  variantId: string | null;
  before: number;
  after: number;
}

/**
 * The one low-stock edge of the inventory journal (O1). Every journal write
 * (sale, sale cancellation, adjustment, initial stock, removal) hands its rows
 * here, inside the same transaction:
 *
 * - flag: balance fell from above `minQuantity` to at/below it, product-level
 *   lines only when the product does not use lots; the flip winner writes the
 *   durable `stock.low.detected` outbox row;
 * - re-arm: balance rose to strictly above `minQuantity`.
 *
 * Variants are judged against their own `minQuantity`. Must run inside the
 * caller's `TenantPrismaService.runInTransaction`.
 */
@Injectable()
export class LowStockCrossing {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxWriterService,
    @Inject(STOCK_ALERT_STATE_REPOSITORY)
    private readonly alertState: IStockAlertStateRepository,
  ) {}

  async record(movements: JournalMovementLike[]): Promise<void> {
    const changes = this.balanceChanges(movements);
    if (changes.length === 0) return;
    const thresholds = await this.thresholds(changes);
    const db = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    for (const change of changes) {
      const minQuantity = change.variantId
        ? thresholds.variant.get(change.variantId)?.minQuantity
        : thresholds.product.get(change.productId)?.minQuantity;
      if (minQuantity === undefined) continue;

      if (change.after > minQuantity) {
        if (change.after > change.before) {
          await this.alertState.rearm({
            tx: db,
            tenantId,
            productId: change.productId,
            variantId: change.variantId,
          });
        }
        continue;
      }
      const usesLots =
        !change.variantId &&
        (thresholds.product.get(change.productId)?.useLotsAndExpirations ??
          false);
      if (usesLots || change.before <= minQuantity) continue;
      await this.flag(change, minQuantity);
    }
  }

  /** The flip winner writes the outbox row; a concurrent owner writes nothing. */
  private async flag(
    change: BalanceChange,
    minQuantity: number,
  ): Promise<void> {
    const db = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const alertEpoch = await this.alertState.seedAndFlip({
      tx: db,
      tenantId,
      productId: change.productId,
      variantId: change.variantId,
    });
    if (alertEpoch === null) return;
    const variantKey = change.variantId ?? '__PRODUCT__';
    // SAFETY: the tenant client (or its tx surrogate) is structurally a
    // Prisma.TransactionClient but not nominally.
    await this.outbox.publish(
      db as unknown as Parameters<OutboxWriterService['publish']>[0],
      tenantId,
      'StockAlert',
      `${change.productId}:${variantKey}`,
      'stock.low.detected',
      {
        tenantId,
        productId: change.productId,
        variantId: change.variantId,
        variantKey,
        alertEpoch,
        newQuantity: change.after,
        minQuantity,
        // Enriched by the dispatcher right before send (keeps the hot path cheap).
        productName: '',
        variantDescription: null,
        sku: null,
        category: null,
        deepLink: '',
        occurredAt: new Date().toISOString(),
      },
    );
  }

  /**
   * One entry per product (non-variant rows) or variant: the balance before
   * the first and after the last row of the call, read off the journal rows.
   */
  private balanceChanges(movements: JournalMovementLike[]): BalanceChange[] {
    const byKey = new Map<string, BalanceChange>();
    for (const m of movements) {
      const after = m.variantId ? m.balanceAfter : m.productBalanceAfter;
      const key = `${m.productId}:${m.variantId ?? ''}`;
      const current = byKey.get(key);
      byKey.set(key, {
        productId: m.productId,
        variantId: m.variantId,
        before: current ? current.before : after - m.delta,
        after,
      });
    }
    return [...byKey.values()];
  }

  private async thresholds(changes: BalanceChange[]) {
    const db = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const [products, variants] = await Promise.all([
      db.product.findMany({
        where: { id: { in: changes.map((c) => c.productId) }, tenantId },
        select: { id: true, minQuantity: true, useLotsAndExpirations: true },
      }),
      db.variant.findMany({
        where: {
          id: {
            in: changes.flatMap((c) => (c.variantId ? [c.variantId] : [])),
          },
          tenantId,
        },
        select: { id: true, minQuantity: true },
      }),
    ]);
    return {
      product: new Map(products.map((p) => [p.id, p])),
      variant: new Map(variants.map((v) => [v.id, v])),
    };
  }
}
