import { Inject, Injectable } from '@nestjs/common';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import {
  InsufficientStockError,
  StockBucketNotFoundError,
} from '../inventory/domain/stock-journal.errors';
import type {
  AppliedStockMovement,
  SaleReversalOutcome,
  StockActor,
  StockChargeItem,
} from '../inventory/domain/stock-journal.types';
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import {
  STOCK_ALERT_STATE_REPOSITORY,
  type IStockAlertStateRepository,
} from '../stock-alerts/domain/stock-alert-state.repository';

/** Journal actor name for bot-originated sale movements. */
export const BOT_STOCK_ACTOR_NAME = 'Bot';

/** Fallback when the acting user row cannot be read (should not happen). */
const UNKNOWN_USER_NAME = 'Usuario';

/** Who moves the stock: the authenticated POS user, or the bot on their behalf. */
export interface SaleStockActor {
  kind: 'user' | 'bot';
  userId: string;
}

export const STOCK_INSUFFICIENT_AT_CONFIRM = 'STOCK_INSUFFICIENT_AT_CONFIRM';

interface BalanceChange {
  productId: string;
  variantId: string | null;
  before: number;
  after: number;
}

/**
 * Sale-side facade over the O1 stock journal (T4): FEFO charge on confirm,
 * exact reversal on cancel, plus the low-stock alert edge that used to live in
 * `PrismaProductRepository.decrementStockForCharge` / `incrementStockForRestock`.
 * Must run inside the sale's ambient `TenantPrismaService.runInTransaction`.
 */
@Injectable()
export class SaleStockService {
  constructor(
    private readonly journal: StockJournalWriter,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxWriterService,
    @Inject(STOCK_ALERT_STATE_REPOSITORY)
    private readonly alertState: IStockAlertStateRepository,
  ) {}

  /**
   * Charges the sale lines through the journal. Insufficient (or missing)
   * stock keeps the sales contract: 409 `STOCK_INSUFFICIENT_AT_CONFIRM`.
   */
  async charge(input: {
    saleId: string;
    items: StockChargeItem[];
    actor: SaleStockActor;
    now?: Date;
  }): Promise<AppliedStockMovement[]> {
    const actor = await this.resolveActor(input.actor);
    let movements: AppliedStockMovement[];
    try {
      movements = await this.journal.charge(
        input.items,
        { saleId: input.saleId, actor },
        input.now,
      );
    } catch (error) {
      if (
        error instanceof InsufficientStockError ||
        error instanceof StockBucketNotFoundError
      ) {
        throw new BusinessRuleViolationError(
          STOCK_INSUFFICIENT_AT_CONFIRM,
          STOCK_INSUFFICIENT_AT_CONFIRM,
        );
      }
      throw error;
    }
    await this.flagLowStock(movements);
    return movements;
  }

  /**
   * Restores exactly what the sale consumed. `LEGACY` (sale charged before the
   * journal) is returned untouched so the caller restocks the old way.
   */
  async reverse(input: {
    saleId: string;
    actor: SaleStockActor;
    now?: Date;
  }): Promise<SaleReversalOutcome> {
    const actor = await this.resolveActor(input.actor);
    const outcome = await this.journal.reverseSale(
      { saleId: input.saleId, actor },
      input.now,
    );
    if (outcome.status === 'REVERSED')
      await this.rearmAlerts(outcome.movements);
    return outcome;
  }

  private async resolveActor(actor: SaleStockActor): Promise<StockActor> {
    if (actor.kind === 'bot') {
      return { id: actor.userId, displayName: BOT_STOCK_ACTOR_NAME };
    }
    const user = await this.tenantPrisma
      .getClient()
      .user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    return { id: actor.userId, displayName: user?.name ?? UNKNOWN_USER_NAME };
  }

  /**
   * One entry per product (non-variant lines) or variant: the balance before
   * and after the call, read off the journal rows.
   */
  private balanceChanges(movements: AppliedStockMovement[]): BalanceChange[] {
    const byKey = new Map<string, BalanceChange>();
    for (const m of movements) {
      const variantId = m.variantId;
      const after = variantId ? m.balanceAfter : m.productBalanceAfter;
      const key = `${m.productId}:${variantId ?? ''}`;
      const current = byKey.get(key);
      byKey.set(key, {
        productId: m.productId,
        variantId,
        before: current ? current.before : after - m.delta,
        after,
      });
    }
    return [...byKey.values()];
  }

  private async alertThresholds(changes: BalanceChange[]) {
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

  /**
   * Low-stock edge (same gate as `PrismaProductRepository`): crossed from
   * above `minQuantity` to at/below it, product-level lines only when the
   * product does not use lots. The flip winner writes the durable outbox row.
   */
  private async flagLowStock(movements: AppliedStockMovement[]): Promise<void> {
    const changes = this.balanceChanges(movements);
    if (changes.length === 0) return;
    const { product, variant } = await this.alertThresholds(changes);
    const db = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    for (const change of changes) {
      const minQuantity = change.variantId
        ? variant.get(change.variantId)?.minQuantity
        : product.get(change.productId)?.minQuantity;
      const usesLots =
        !change.variantId &&
        (product.get(change.productId)?.useLotsAndExpirations ?? false);
      if (
        minQuantity === undefined ||
        usesLots ||
        !(change.before > minQuantity && change.after <= minQuantity)
      ) {
        continue;
      }
      const alertEpoch = await this.alertState.seedAndFlip({
        tx: db,
        tenantId,
        productId: change.productId,
        variantId: change.variantId,
      });
      if (alertEpoch === null) continue; // a concurrent tx owns this crossing
      const variantKey = change.variantId ?? '__PRODUCT__';
      // SAFETY: the tenant client (or its tx surrogate) is structurally a
      // Prisma.TransactionClient; same cast as PrismaProductRepository.
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
  }

  /** Restock re-arm: strictly above `minQuantity` again (no lot gate, as before). */
  private async rearmAlerts(movements: AppliedStockMovement[]): Promise<void> {
    const changes = this.balanceChanges(movements);
    if (changes.length === 0) return;
    const { product, variant } = await this.alertThresholds(changes);
    const db = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    for (const change of changes) {
      const minQuantity = change.variantId
        ? variant.get(change.variantId)?.minQuantity
        : product.get(change.productId)?.minQuantity;
      if (minQuantity === undefined || change.after <= minQuantity) continue;
      await this.alertState.rearm({
        tx: db,
        tenantId,
        productId: change.productId,
        variantId: change.variantId,
      });
    }
  }
}
