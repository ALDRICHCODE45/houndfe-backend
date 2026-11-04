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
    await this.crossing.record(movements);
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
      await this.crossing.record(outcome.movements);
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
}
