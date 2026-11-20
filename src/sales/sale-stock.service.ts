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
import { LowStockCrossing } from '../stock-alerts/infrastructure/low-stock-crossing.service';
import { loadReservedStock } from '../inventory/infrastructure/backorder-reserved-stock';
import { StockReservedForBackorderError } from './stock-reserved-for-backorder.error';

/** Journal actor name for bot-originated sale movements. */
export const BOT_STOCK_ACTOR_NAME = 'Bot';

/**
 * Journal actor name for system movements (pay-in-store-pickup / T2: the hold
 * sweep releasing an expired hold). No user id.
 */
export const SYSTEM_STOCK_ACTOR_NAME = 'Sistema';

/** Fallback when the acting user row cannot be read (should not happen). */
const UNKNOWN_USER_NAME = 'Usuario';

/**
 * Who moves the stock: the authenticated POS user, the bot on their behalf, or
 * the system (no person; `userId` is not recorded).
 */
export interface SaleStockActor {
  kind: 'user' | 'bot' | 'system';
  userId: string;
}

export const STOCK_INSUFFICIENT_AT_CONFIRM = 'STOCK_INSUFFICIENT_AT_CONFIRM';

/**
 * Sale-side facade over the O1 stock journal (T4): FEFO charge on confirm,
 * exact reversal on cancel, each followed by the shared low-stock edge
 * (`LowStockCrossing`). Must run inside the sale's ambient `TenantPrismaService.runInTransaction`.
 */
@Injectable()
export class SaleStockService {
  private readonly crossing: LowStockCrossing;

  constructor(
    private readonly journal: StockJournalWriter,
    private readonly tenantPrisma: TenantPrismaService,
    outbox: OutboxWriterService,
    @Inject(STOCK_ALERT_STATE_REPOSITORY)
    alertState: IStockAlertStateRepository,
  ) {
    this.crossing = new LowStockCrossing(tenantPrisma, outbox, alertState);
  }

  /**
   * Takes the journal locks of these products (products, lots, variants; id
   * order) without writing. A confirmation calls this BEFORE it writes the sale
   * lines (their foreign keys take `FOR KEY SHARE` on the product / variant
   * rows) and before it claims promotion capacity: two confirmations of one
   * product would otherwise both hold KEY SHARE and both wait for the charge's
   * `FOR UPDATE` (deadlock, 40P01). Global order: stock → sale lines →
   * promotion capacity → backorder rows.
   */
  async lockStock(productIds: string[]): Promise<void> {
    await this.journal.lockStock(productIds);
  }

  /**
   * Charges the sale lines through the journal. Insufficient (or missing)
   * stock keeps the sales contract: 409 `STOCK_INSUFFICIENT_AT_CONFIRM`.
   *
   * `reservedAware` (the counter charge only, never a bot checkout): when the
   * shortage of the failing line is covered by units held for RESERVED
   * backorders (`sellable + reserved ≥ requested`) the answer is
   * `STOCK_RESERVED_FOR_BACKORDER {available, reserved}` instead (restock-
   * backorder / T5b, contract v1 §4).
   */
  async charge(input: {
    saleId: string;
    items: StockChargeItem[];
    actor: SaleStockActor;
    now?: Date;
    reservedAware?: boolean;
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
      if (input.reservedAware && error instanceof InsufficientStockError) {
        await this.throwIfCoveredByReservations(input.items, input.now);
      }
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
    await this.crossing.record(movements);
    return movements;
  }

  /**
   * restock-backorder / T3 — charges a cart in which some lines confirm RESERVED
   * backorders (contract v1 §7.4). The units a backorder holds go back to the
   * buckets they came from (`BACKORDER_RELEASE`) and the normal charge of the
   * whole cart follows in the same transaction. The release runs WITHOUT the
   * stock-increase listeners (`allocate: false`): the released units must not be
   * offered to another waiting backorder between the release and the sale.
   * Callers hold the product locks already (`lockStock` of every product of the
   * cart), so nobody else can take the released units either. The low-stock edge
   * sees the release and the sale rows together, i.e. the real net change.
   */
  async chargeConsumingBackorders(input: {
    saleId: string;
    items: StockChargeItem[];
    actor: SaleStockActor;
    backorderIds: string[];
    now?: Date;
  }): Promise<AppliedStockMovement[]> {
    const actor = await this.resolveActor(input.actor);
    const releaseAt = input.now ?? new Date();
    const released: AppliedStockMovement[] = [];
    for (const backorderId of input.backorderIds) {
      released.push(
        ...(await this.journal.releaseBackorder(
          { backorderId, actor, allocate: false },
          releaseAt,
        )),
      );
    }
    // The sale rows are stamped after the release rows (the kardex orders by createdAt).
    const chargeAt = new Date(Math.max(Date.now(), releaseAt.getTime() + 1));
    let charged: AppliedStockMovement[];
    try {
      charged = await this.journal.charge(
        input.items,
        { saleId: input.saleId, actor },
        chargeAt,
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
    const movements = [...released, ...charged];
    await this.crossing.record(movements);
    return movements;
  }

  /**
   * Restores exactly what the sale consumed. A sale confirmed before the
   * journal (no `SALE` rows) is restored from its `lines` through the journal
   * as well; a post-journal sale without `SALE` rows restores nothing.
   */
  async reverse(input: {
    saleId: string;
    actor: SaleStockActor;
    lines?: StockChargeItem[];
    confirmedAt?: Date | null;
    now?: Date;
  }): Promise<SaleReversalOutcome> {
    const actor = await this.resolveActor(input.actor);
    const outcome = await this.journal.reverseSale(
      {
        saleId: input.saleId,
        actor,
        lines: input.lines,
        confirmedAt: input.confirmedAt,
      },
      input.now,
    );
    if (outcome.status === 'REVERSED')
      await this.crossing.record(outcome.movements);
    return outcome;
  }

  /**
   * After an insufficient-stock charge: finds the FIRST cart line the sellable
   * stock cannot cover and, when the units reserved for backorders would cover
   * it, throws `STOCK_RESERVED_FOR_BACKORDER`; otherwise returns so the caller
   * raises the plain `STOCK_INSUFFICIENT_AT_CONFIRM`. Runs inside the charge
   * transaction (the journal already holds the stock locks), one batched read
   * of the reserved units for the whole cart.
   */
  private async throwIfCoveredByReservations(
    items: StockChargeItem[],
    now?: Date,
  ): Promise<void> {
    const reserved = await loadReservedStock(
      this.tenantPrisma,
      items.map((item) => item.productId),
    );
    for (const item of items) {
      const variantId = item.variantId ?? null;
      const sellable = await this.journal.lockSellable(
        item.productId,
        variantId,
        now,
      );
      if (sellable === null || sellable >= item.quantity) continue;
      const held = reserved.forLine(item.productId, variantId);
      if (held > 0 && sellable + held >= item.quantity) {
        throw new StockReservedForBackorderError(sellable, held);
      }
      return;
    }
  }

  private async resolveActor(actor: SaleStockActor): Promise<StockActor> {
    if (actor.kind === 'system') {
      return { id: null, displayName: SYSTEM_STOCK_ACTOR_NAME };
    }
    if (actor.kind === 'bot') {
      return { id: actor.userId, displayName: BOT_STOCK_ACTOR_NAME };
    }
    const user = await this.tenantPrisma
      .getClient()
      .user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    return { id: actor.userId, displayName: user?.name ?? UNKNOWN_USER_NAME };
  }
}
