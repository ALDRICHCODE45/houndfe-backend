/**
 * Backorder allocator (contract v1 §4, §5; owner Q1, Q2/Q3, D1, D2, D4).
 *
 * Runs INSIDE the transaction of every stock increase (the journal writer calls
 * it through the `StockIncreaseListener` seam after a positive `apply`, a sale
 * reversal — cancel and HOLD_EXPIRED — and every `BACKORDER_RELEASE`) and, for
 * the T2b sweep, on its own.
 *
 * Lock order (documented once, kept by every caller):
 *   sale row → products (id asc) → lots → variants → backorder rows
 * `allocate` takes the journal locks FIRST (`lockSellable`; a no-op when the
 * caller's journal write already holds them) and only then the WAITING
 * backorder rows `FOR UPDATE` ordered by `scheduledAt, id`. Anything that holds
 * a backorder row and also needs stock (cancel of a RESERVED backorder, the lot
 * swap, T3 checkout) must therefore lock the stock before its backorder row.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AppliedStockMovement,
  StockActor,
  StockIncreaseListener,
  StockIncreaseTarget,
} from '../../inventory/domain/stock-journal.types';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import { SalesService } from '../../sales/sales.service';
import { DomainError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  reservationWindow,
  unitPriceFromLine,
  walkQueue,
  type QueuedBackorder,
} from '../domain/backorder-allocation';
import {
  BACKORDER_RESERVED_HOOK,
  type BackorderReservedHook,
} from './ports/backorder-reserved-hook.port';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

/** Journal actor of the reservation movements: the system, no person. */
export const BACKORDER_SYSTEM_ACTOR: StockActor = {
  id: null,
  displayName: 'Sistema',
};

export interface AllocationResult {
  /** Backorders moved WAITING → RESERVED, in queue order. */
  reservedIds: string[];
  /** Backorders that did not fit while someone behind them was reserved (Q1). */
  passedOverIds: string[];
  /** Backorders that fitted but whose price could not be computed: left WAITING. */
  unpricedIds: string[];
  /**
   * `BACKORDER_RESERVE` rows written. Callers feed them (after the increase
   * rows) to the low-stock edge so it sees the net balance change.
   */
  movements: AppliedStockMovement[];
}

const NOTHING: Readonly<AllocationResult> = {
  reservedIds: [],
  passedOverIds: [],
  unpricedIds: [],
  movements: [],
};

interface QueueRow extends QueuedBackorder {
  folio: string;
}

@Injectable()
export class BackorderAllocator implements StockIncreaseListener {
  private readonly logger = new Logger(BackorderAllocator.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly writer: StockJournalWriter,
    private readonly sales: SalesService,
    @Inject(BACKORDER_RESERVED_HOOK)
    private readonly reservedHook: BackorderReservedHook,
  ) {
    // The inventory module does not know this one: the allocator subscribes
    // itself. Done in the constructor (providers are instantiated at boot) and
    // not in `onModuleInit`, which the AppModule boot harnesses treat as an
    // unreviewed lifecycle hook; it is only an in-memory registration.
    this.writer.registerStockIncreaseListener(this);
  }

  /** Journal seam: one allocation per product/variant whose stock went up. */
  async onStockIncreased(
    targets: StockIncreaseTarget[],
    now: Date,
  ): Promise<AppliedStockMovement[]> {
    const tx = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const movements: AppliedStockMovement[] = [];
    for (const target of targets) {
      const result = await this.allocate(
        tx,
        tenantId,
        target.productId,
        target.variantId,
        now,
      );
      movements.push(...result.movements);
    }
    return movements;
  }

  /**
   * Reserves the waiting backorders of one product/variant out of its sellable
   * stock. Walks the WHOLE queue (`scheduledAt, id`): each backorder whose full
   * quantity fits is reserved (no partial reservation); one that does not fit
   * keeps its place and, when someone behind it was reserved in this pass,
   * gets `passedOverCount += 1`. Must run inside an ambient transaction.
   * Returns the movements written; it does NOT touch the low-stock edge.
   */
  async allocate(
    tx: TenantClient,
    tenantId: string,
    productId: string,
    variantId: string | null,
    now: Date = new Date(),
  ): Promise<AllocationResult> {
    // Cheap unlocked check first: the common stock increase has no queue.
    const waiting = await tx.backorder.findFirst({
      where: { tenantId, productId, variantId, status: 'WAITING' },
      select: { id: true },
    });
    if (!waiting) return { ...NOTHING };

    // Journal locks first (lock order), then the queue.
    const sellable = await this.writer.lockSellable(productId, variantId, now);
    if (sellable === null || sellable <= 0) return { ...NOTHING };

    const queue = await this.lockQueue(tx, tenantId, productId, variantId);
    const walk = await walkQueue({
      queue,
      sellable,
      priceOf: (backorder) =>
        this.currentPrice(backorder, productId, variantId),
    });

    const movements: AppliedStockMovement[] = [];
    const folios = new Map(queue.map((row) => [row.id, row.folio]));
    // Reservation rows are stamped strictly after `now` and after each other, so
    // the kardex (createdAt, id) order matches the journal order.
    let clock = now;
    for (const reservation of walk.reservations) {
      const { backorder } = reservation;
      const rows = await this.writer.reserveBackorder(
        {
          backorderId: backorder.id,
          productId,
          variantId,
          quantity: backorder.quantity,
          actor: BACKORDER_SYSTEM_ACTOR,
        },
        clock,
      );
      clock = new Date(clock.getTime() + rows.length);
      movements.push(...rows);

      const window = reservationWindow(now);
      await tx.backorder.update({
        where: { id: backorder.id, tenantId },
        data: {
          status: 'RESERVED',
          reservedAt: window.reservedAt,
          reservedUntil: window.reservedUntil,
          reminderAt: window.reminderAt,
          reservationStage: 0,
          currentPriceCents: reservation.currentPriceCents,
          finalPriceCents: reservation.finalPriceCents,
          version: { increment: 1 },
        },
      });
      await this.reservedHook.onReserved(tx, {
        tenantId,
        backorderId: backorder.id,
        folio: folios.get(backorder.id) ?? '',
        customerId: backorder.customerId,
        productId,
        variantId,
        quantity: backorder.quantity,
        referencePriceCents: backorder.referencePriceCents,
        currentPriceCents: reservation.currentPriceCents,
        finalPriceCents: reservation.finalPriceCents,
        ...window,
      });
    }

    if (walk.passedOverIds.length > 0) {
      await tx.backorder.updateMany({
        where: { tenantId, id: { in: walk.passedOverIds } },
        data: { passedOverCount: { increment: 1 } },
      });
    }
    return {
      reservedIds: walk.reservations.map((r) => r.backorder.id),
      passedOverIds: walk.passedOverIds,
      unpricedIds: walk.unpricedIds,
      movements,
    };
  }

  /** WAITING rows of the product/variant, oldest first, locked FOR UPDATE. */
  private lockQueue(
    tx: TenantClient,
    tenantId: string,
    productId: string,
    variantId: string | null,
  ): Promise<QueueRow[]> {
    const variantFilter =
      variantId === null
        ? Prisma.sql`"variantId" IS NULL`
        : Prisma.sql`"variantId" = ${variantId}`;
    return tx.$queryRaw<QueueRow[]>(Prisma.sql`
      SELECT "id", "folio", "quantity", "customerId", "referencePriceCents"
      FROM "backorders"
      WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
        AND ${variantFilter} AND "status" = 'WAITING'
      ORDER BY "scheduledAt" ASC, "id" ASC
      FOR UPDATE
    `);
  }

  /**
   * That customer's bot price for the backorder quantity TODAY, with the
   * auto-evaluated promotions (owner Q2/Q3): the same preview the bot's
   * `evaluate-cart` and checkout use. `null` (and a log line) when no price can
   * be justified, so the backorder is not reserved at an invented price.
   */
  private async currentPrice(
    backorder: QueuedBackorder,
    productId: string,
    variantId: string | null,
  ): Promise<number | null> {
    try {
      const preview = await this.sales.previewBotPricing({
        customerId: backorder.customerId,
        items: [
          {
            productId,
            variantId,
            quantity: backorder.quantity,
            unitPriceCents: 0,
          },
        ],
      });
      return unitPriceFromLine(
        preview.items[0].finalPriceCents,
        backorder.quantity,
      );
    } catch (error) {
      if (error instanceof DomainError) {
        this.logger.warn(
          `Backorder ${backorder.id} stays WAITING: no price could be computed (${error.code})`,
        );
        return null;
      }
      throw error;
    }
  }
}
