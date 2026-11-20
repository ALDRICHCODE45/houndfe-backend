import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  foldHeldBuckets,
  mapBackorderRelease,
} from '../domain/backorder-reservation';
import { businessToday } from '../domain/fefo-allocator';
import { mapSaleReversal } from '../domain/sale-reversal';
import { InsufficientStockError } from '../domain/stock-journal.errors';
import { StockPlan } from '../domain/stock-plan';
import type {
  AppliedStockMovement,
  BackorderReleaseInput,
  BackorderReserveInput,
  BackorderRevalidation,
  ProductStockState,
  StockIncreaseListener,
  SaleReversalOutcome,
  StockActor,
  StockBucketRef,
  StockChange,
  StockChargeItem,
  StockIncreaseTarget,
  StockJournalContext,
} from '../domain/stock-journal.types';

/**
 * Single writer of stock quantities (O1). Every method must run inside an
 * ambient `TenantPrismaService.runInTransaction` so the quantity updates and
 * the movement rows commit (or roll back) together with the caller's work.
 *
 * Lock order (aligned with `PrismaProductRepository.lockStockAdjustments`):
 * product rows `FOR UPDATE` in ascending id order first, then the lots and
 * variants of those products in ascending id order. Product-level exclusive
 * locking serialises journal writes per product, which keeps the
 * `balanceAfter` / `productBalanceAfter` chain exact.
 *
 * Backorders (restock-backorder T2a): units reserved for a backorder are taken
 * out of `quantity` by `BACKORDER_RESERVE` rows and handed back by
 * `BACKORDER_RELEASE` rows (groupType `BACKORDER`, groupId = backorderId), so
 * every reader that looks at `quantity` already treats them as unavailable.
 * After every increase (positive `apply`, `reverseSale`, a release) the
 * registered {@link StockIncreaseListener} (the backorder allocator) runs in
 * the SAME transaction, still holding the journal locks above; it locks the
 * backorder rows only AFTER them. Global order for anything that touches both:
 * sale row → products (id asc) → lots → variants → backorder rows.
 */
/** Migration whose completion marks the moment the journal went live. */
const JOURNAL_MIGRATION = '20261104020000_inventory_journal_storage';

@Injectable()
export class StockJournalWriter {
  private readonly logger = new Logger(StockJournalWriter.name);
  private readonly businessTimezone: string;
  private activatedAt: Date | null = null;
  private readonly increaseListeners = new Set<StockIncreaseListener>();

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    config: ConfigService,
  ) {
    this.businessTimezone = config.get<string>(
      'PROMOTIONS_BUSINESS_TIMEZONE',
      'America/Mexico_City',
    );
  }

  /**
   * Registers an observer called after every stock increase (see class doc).
   * Registration is idempotent; the inventory module does not depend on the
   * observer's module, which registers itself at startup.
   */
  registerStockIncreaseListener(listener: StockIncreaseListener): void {
    this.increaseListeners.add(listener);
  }

  /**
   * Takes the journal locks of these products (products, then their lots, then
   * their variants, id order) without writing. Callers that must hold a
   * backorder row AND the stock call this FIRST (journal lock order).
   */
  async lockStock(productIds: string[]): Promise<void> {
    await this.lockRows(productIds);
  }

  /**
   * Locks the product (journal order) and returns what one reservation may
   * take now: a variant's own quantity, or for a non-variant product the
   * untracked portion plus NON-expired lots. `null` when stock is not tracked.
   */
  async lockSellable(
    productId: string,
    variantId: string | null,
    now: Date = new Date(),
  ): Promise<number | null> {
    const plan = await this.lockAndPlan([productId], now);
    return plan.sellable(productId, variantId);
  }

  /**
   * Reserves `quantity` sellable units for a backorder exactly like a sale
   * charge: a variant line hits its variant, a product line goes FEFO over
   * NON-expired lots then the untracked portion. One `BACKORDER_RESERVE` row
   * per consumed bucket. Insufficient sellable stock throws
   * `InsufficientStockError` and writes nothing.
   */
  async reserveBackorder(
    input: BackorderReserveInput,
    now: Date = new Date(),
  ): Promise<AppliedStockMovement[]> {
    const plan = await this.lockAndPlan([input.productId], now);
    plan.charge({
      productId: input.productId,
      variantId: input.variantId,
      quantity: input.quantity,
    });
    // Stamped strictly AFTER `now` (rows span now+1 … now+n): the reservation
    // usually follows rows the same transaction wrote at `now`, and the kardex
    // orders by (createdAt, id), so equal timestamps would shuffle the chain.
    return this.persist(
      plan,
      {
        type: 'BACKORDER_RESERVE',
        groupType: 'BACKORDER',
        groupId: input.backorderId,
        actor: input.actor,
      },
      new Date(now.getTime() + plan.movements.length),
    );
  }

  /**
   * Hands every unit the backorder still holds (reserves minus releases) back
   * to the SAME buckets it took them from, as `BACKORDER_RELEASE` rows. Nothing
   * held → nothing written, so a repeated release is harmless. Then (unless
   * `allocate` is false) the increase listeners run in the same transaction so
   * the next waiting backorder is served; their movements are appended.
   */
  async releaseBackorder(
    input: BackorderReleaseInput,
    now: Date = new Date(),
  ): Promise<AppliedStockMovement[]> {
    const rows = await this.releaseHeld(input, now);
    if (input.allocate === false) return rows;
    return [...rows, ...(await this.afterIncrease(rows, now))];
  }

  /**
   * Lot swap (owner Q6): if any lot the backorder holds has expired, its units
   * go back to that (expired, unsellable) lot and the same quantity is
   * re-reserved from valid stock. If valid stock cannot cover it, everything
   * the backorder holds is released and `LOST` is reported — the caller moves
   * the backorder back to WAITING and runs the allocator. Never leaves expired
   * units reserved. Listeners are NOT run here (the caller owns the order).
   */
  async revalidateBackorder(
    input: { backorderId: string; actor: StockActor },
    now: Date = new Date(),
  ): Promise<BackorderRevalidation> {
    const productId = await this.heldProductId(input.backorderId);
    if (!productId) return { status: 'NOT_HELD', movements: [] };
    const plan = await this.lockAndPlan([productId], now);
    const held = await this.heldBuckets(input.backorderId);
    if (held.length === 0) return { status: 'NOT_HELD', movements: [] };
    const expired = held.filter(
      (bucket) =>
        bucket.bucketKind === 'LOT' &&
        bucket.lotId !== null &&
        plan.isLotExpired(bucket.productId, bucket.lotId),
    );
    if (expired.length === 0) return { status: 'VALID', movements: [] };

    const quantity = expired.reduce((sum, bucket) => sum + bucket.held, 0);
    const released = await this.releaseHeld(
      {
        backorderId: input.backorderId,
        actor: input.actor,
        lotIds: expired.map((bucket) => bucket.lotId as string),
      },
      now,
    );
    try {
      const reserved = await this.reserveBackorder(
        {
          backorderId: input.backorderId,
          productId,
          variantId: null,
          quantity,
          actor: input.actor,
        },
        now,
      );
      return { status: 'SWAPPED', movements: [...released, ...reserved] };
    } catch (error) {
      if (!(error instanceof InsufficientStockError)) throw error;
    }
    const rest = await this.releaseHeld(
      { backorderId: input.backorderId, actor: input.actor },
      now,
    );
    return { status: 'LOST', movements: [...released, ...rest] };
  }

  /** Explicit signed bucket changes (adjustments, initial stock, removals, opening-style writes). */
  async apply(
    changes: StockChange[],
    context: StockJournalContext,
    now: Date = new Date(),
  ): Promise<AppliedStockMovement[]> {
    const plan = await this.lockAndPlan(
      changes.map((c) => c.bucket.productId),
      now,
    );
    for (const change of changes) plan.apply(change);
    const rows = await this.persist(plan, context, now);
    return [...rows, ...(await this.afterIncrease(rows, now))];
  }

  /**
   * Charges sale lines: variant lines hit their variant, product lines are
   * allocated FEFO (S6). One `SALE` row per consumed bucket, grouped by sale.
   * Lines of products with `useStock=false` write nothing.
   */
  async charge(
    items: StockChargeItem[],
    sale: { saleId: string; actor: StockActor },
    now: Date = new Date(),
  ): Promise<AppliedStockMovement[]> {
    const plan = await this.lockAndPlan(
      items.map((i) => i.productId),
      now,
    );
    for (const item of items) plan.charge(item);
    return this.persist(
      plan,
      {
        type: 'SALE',
        groupType: 'SALE',
        groupId: sale.saleId,
        actor: sale.actor,
      },
      now,
    );
  }

  /**
   * Reverses a sale (S7). A sale with `SALE` movements restores exactly those
   * buckets. A sale without them restores nothing unless it was confirmed
   * before the journal went live (`confirmedAt` earlier than the activation
   * marker) — then its `lines` are restored through the journal as
   * `SALE_CANCELLATION` rows, with the same versioning and locking as any
   * other write. `ALREADY_REVERSED` means cancellation rows exist and nothing
   * was written.
   */
  async reverseSale(
    sale: {
      saleId: string;
      actor: StockActor;
      lines?: StockChargeItem[];
      confirmedAt?: Date | null;
    },
    now: Date = new Date(),
  ): Promise<SaleReversalOutcome> {
    const tenantId = this.requireTx();
    const db = this.tenantPrisma.getClient();
    const group = {
      tenantId,
      groupType: 'SALE' as const,
      groupId: sale.saleId,
    };
    const consumed = await db.stockMovement.findMany({
      where: { ...group, type: 'SALE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (consumed.length === 0) {
      return this.reverseLegacySale(sale, group, now);
    }

    const plan = await this.lockAndPlan(
      consumed.map((m) => m.productId),
      now,
    );
    // Re-check under the product locks: a concurrent cancel committed first.
    const reversed = await db.stockMovement.count({
      where: { ...group, type: 'SALE_CANCELLATION' },
    });
    if (reversed > 0) return { status: 'ALREADY_REVERSED', movements: [] };

    const existingLotIds = new Set(
      consumed
        .filter(
          (m) =>
            m.lotId &&
            plan.has({ kind: 'LOT', productId: m.productId, lotId: m.lotId }),
        )
        .map((m) => m.lotId as string),
    );
    const changes = mapSaleReversal(consumed, existingLotIds);
    let skipped = 0;
    for (const change of changes) {
      if (!plan.has(change.bucket)) {
        skipped += 1; // product/variant deleted since the sale: nothing to restore to
        continue;
      }
      plan.apply({ ...change, skipIfNotStocked: true });
    }
    const restored = await this.persist(
      plan,
      {
        type: 'SALE_CANCELLATION',
        groupType: 'SALE',
        groupId: sale.saleId,
        actor: sale.actor,
      },
      now,
    );
    // Backorder allocation (same tx, journal locks still held): the restored
    // units may now cover waiting backorders. Its movements ride along so the
    // low-stock edge sees the net balance change.
    const movements = [
      ...restored,
      ...(await this.afterIncrease(restored, now)),
    ];
    return { status: 'REVERSED', movements, skipped };
  }

  /**
   * Sales confirmed before the journal have no `SALE` rows: their lines are
   * restored to the product (untracked portion) or variant they decremented.
   * Lines of products that no longer track stock (or are gone) are skipped.
   */
  private async reverseLegacySale(
    sale: {
      saleId: string;
      actor: StockActor;
      lines?: StockChargeItem[];
      confirmedAt?: Date | null;
    },
    group: { tenantId: string; groupType: 'SALE'; groupId: string },
    now: Date,
  ): Promise<SaleReversalOutcome> {
    const lines = (sale.lines ?? []).filter((line) => line.quantity > 0);
    // Without a confirmation time a sale cannot be proven pre-journal: fail
    // closed rather than restore stock it may never have decremented.
    if (lines.length === 0 || !sale.confirmedAt) {
      return { status: 'NOTHING_TO_RESTORE', movements: [] };
    }
    const activatedAt = await this.journalActivatedAt();
    if (sale.confirmedAt.getTime() >= activatedAt.getTime()) {
      return { status: 'NOTHING_TO_RESTORE', movements: [] };
    }

    const db = this.tenantPrisma.getClient();
    const plan = await this.lockAndPlan(
      lines.map((l) => l.productId),
      now,
    );
    // Re-check under the product locks: a concurrent cancel committed first.
    const reversed = await db.stockMovement.count({
      where: { ...group, type: 'SALE_CANCELLATION' },
    });
    if (reversed > 0) return { status: 'ALREADY_REVERSED', movements: [] };

    let skipped = 0;
    for (const line of lines) {
      const bucket: StockBucketRef = line.variantId
        ? {
            kind: 'VARIANT',
            productId: line.productId,
            variantId: line.variantId,
          }
        : { kind: 'PRODUCT_UNTRACKED', productId: line.productId };
      if (!plan.has(bucket) || !plan.tracksStock(line.productId)) {
        skipped += 1; // deleted, or no stock tracking (useStock=false / service)
        continue;
      }
      plan.apply({ bucket, delta: line.quantity });
    }
    const restored = await this.persist(
      plan,
      {
        type: 'SALE_CANCELLATION',
        groupType: 'SALE',
        groupId: sale.saleId,
        actor: sale.actor,
      },
      now,
    );
    // Backorder allocation (same tx, journal locks still held): the restored
    // units may now cover waiting backorders. Its movements ride along so the
    // low-stock edge sees the net balance change.
    const movements = [
      ...restored,
      ...(await this.afterIncrease(restored, now)),
    ];
    return { status: 'REVERSED', movements, skipped };
  }

  /**
   * Instant the journal went live: `finished_at` of the storage migration
   * (it also inserts the OPENING movements). Stock writers are stopped while
   * it runs, so a sale confirmed earlier decremented stock without a `SALE`
   * row. Immutable once set, hence cached. Fails closed when the marker is
   * missing: without it a pre-journal sale cannot be told from a post-journal
   * one that consumed nothing.
   */
  private async journalActivatedAt(): Promise<Date> {
    if (this.activatedAt) return this.activatedAt;
    const rows = await this.tenantPrisma.getClient().$queryRaw<
      Array<{ finishedAt: Date }>
    >`SELECT "finished_at" AS "finishedAt" FROM "_prisma_migrations"
      WHERE "migration_name" = ${JOURNAL_MIGRATION}
        AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
      ORDER BY "finished_at" DESC LIMIT 1`;
    if (rows.length === 0) {
      throw new Error(
        `Inventory journal activation marker (migration ${JOURNAL_MIGRATION}) not found`,
      );
    }
    this.activatedAt = rows[0].finishedAt;
    return this.activatedAt;
  }

  private requireTx(): string {
    if (!this.tenantPrisma.isInTransaction()) {
      throw new Error(
        'StockJournalWriter must be called inside TenantPrismaService.runInTransaction',
      );
    }
    return this.tenantPrisma.getTenantId();
  }

  /** Locks products then their lots/variants (id order). Returns the tenant and sorted ids. */
  private async lockRows(
    productIds: string[],
  ): Promise<{ tenantId: string; ids: string[] }> {
    const tenantId = this.requireTx();
    const db = this.tenantPrisma.getClient();
    const ids = [...new Set(productIds)].sort();

    for (const id of ids) {
      await db.$queryRaw`SELECT "id" FROM "products"
        WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    }
    await db.$queryRaw`SELECT "id" FROM "lots"
      WHERE "productId" = ANY(${ids}::text[]) AND "tenantId" = ${tenantId}
      ORDER BY "id" FOR UPDATE`;
    await db.$queryRaw`SELECT "id" FROM "variants"
      WHERE "productId" = ANY(${ids}::text[]) AND "tenantId" = ${tenantId}
      ORDER BY "id" FOR UPDATE`;
    return { tenantId, ids };
  }

  /** Locks (see `lockRows`), loads state, builds a plan. */
  private async lockAndPlan(
    productIds: string[],
    now: Date,
  ): Promise<StockPlan> {
    const { tenantId, ids } = await this.lockRows(productIds);
    const db = this.tenantPrisma.getClient();

    const [products, lots, variants] = await Promise.all([
      db.product.findMany({
        where: { id: { in: ids }, tenantId },
        select: {
          id: true,
          name: true,
          quantity: true,
          stockVersion: true,
          useStock: true,
          hasVariants: true,
        },
      }),
      db.lot.findMany({
        where: { productId: { in: ids }, tenantId },
        select: {
          id: true,
          productId: true,
          lotNumber: true,
          quantity: true,
          stockVersion: true,
          expirationDate: true,
        },
      }),
      db.variant.findMany({
        where: { productId: { in: ids }, tenantId },
        select: {
          id: true,
          productId: true,
          name: true,
          quantity: true,
          stockVersion: true,
        },
      }),
    ]);

    const states: ProductStockState[] = products.map((p) => ({
      ...p,
      lots: lots.filter((l) => l.productId === p.id),
      variants: variants.filter((v) => v.productId === p.id),
    }));
    return new StockPlan(states, businessToday(now, this.businessTimezone));
  }

  /** Release core shared by `releaseBackorder` and the lot swap: no listeners. */
  private async releaseHeld(
    input: BackorderReleaseInput,
    now: Date,
  ): Promise<AppliedStockMovement[]> {
    const productId = await this.heldProductId(input.backorderId);
    if (!productId) return [];
    const plan = await this.lockAndPlan([productId], now);
    // Re-read under the product locks: a concurrent release committed first.
    const held = await this.heldBuckets(input.backorderId);
    const existingLotIds = new Set(
      held
        .filter(
          (bucket) =>
            bucket.lotId &&
            plan.has({
              kind: 'LOT',
              productId: bucket.productId,
              lotId: bucket.lotId,
            }),
        )
        .map((bucket) => bucket.lotId as string),
    );
    let changes = mapBackorderRelease(held, existingLotIds, input.lotIds);
    changes = changes.filter((change) => plan.has(change.bucket));
    for (const change of changes)
      plan.apply({ ...change, skipIfNotStocked: true });
    return this.persist(
      plan,
      {
        type: 'BACKORDER_RELEASE',
        groupType: 'BACKORDER',
        groupId: input.backorderId,
        actor: input.actor,
      },
      now,
    );
  }

  /** Product a backorder's journal rows belong to (one backorder = one product). */
  private async heldProductId(backorderId: string): Promise<string | null> {
    const tenantId = this.requireTx();
    const row = await this.tenantPrisma.getClient().stockMovement.findFirst({
      where: { tenantId, groupType: 'BACKORDER', groupId: backorderId },
      select: { productId: true },
    });
    return row?.productId ?? null;
  }

  /** Units the backorder holds per bucket (reserves minus releases), in journal order. */
  private async heldBuckets(backorderId: string) {
    const tenantId = this.requireTx();
    const rows = await this.tenantPrisma.getClient().stockMovement.findMany({
      where: {
        tenantId,
        groupType: 'BACKORDER',
        groupId: backorderId,
        type: { in: ['BACKORDER_RESERVE', 'BACKORDER_RELEASE'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return foldHeldBuckets(rows);
  }

  /**
   * Runs the increase listeners for the buckets that just went UP. Each runs
   * inside a savepoint: stock paths (adjustments, sale cancellation, hold
   * expiry) must never fail because a backorder could not be served, so a
   * listener failure rolls back only its own writes, is logged, and the
   * sweep's safety-net allocation retries later.
   */
  private async afterIncrease(
    rows: readonly AppliedStockMovement[],
    now: Date,
  ): Promise<AppliedStockMovement[]> {
    if (this.increaseListeners.size === 0) return [];
    const targets = new Map<string, StockIncreaseTarget>();
    for (const row of rows) {
      if (row.delta <= 0) continue;
      const key = `${row.productId}:${row.variantId ?? ''}`;
      if (!targets.has(key)) {
        targets.set(key, {
          productId: row.productId,
          variantId: row.variantId,
        });
      }
    }
    if (targets.size === 0) return [];

    const db = this.tenantPrisma.getClient();
    const extra: AppliedStockMovement[] = [];
    for (const listener of this.increaseListeners) {
      await db.$executeRaw`SAVEPOINT stock_increase_listener`;
      try {
        extra.push(
          ...(await listener.onStockIncreased([...targets.values()], now)),
        );
        await db.$executeRaw`RELEASE SAVEPOINT stock_increase_listener`;
      } catch (error) {
        await db.$executeRaw`ROLLBACK TO SAVEPOINT stock_increase_listener`;
        await db.$executeRaw`RELEASE SAVEPOINT stock_increase_listener`;
        this.logger.error(
          `Stock increase listener failed; its writes were rolled back and the stock write kept: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`,
        );
      }
    }
    return extra;
  }

  private async persist(
    plan: StockPlan,
    context: StockJournalContext,
    now: Date,
  ): Promise<AppliedStockMovement[]> {
    const tenantId = this.requireTx();
    const db = this.tenantPrisma.getClient();

    for (const [id, state] of plan.touchedProducts) {
      await db.product.update({
        where: { id, tenantId },
        data: {
          quantity: state.quantity,
          ...(state.bumpVersion ? { stockVersion: { increment: 1 } } : {}),
        },
      });
    }
    for (const [id, quantity] of plan.touchedLots) {
      await db.lot.update({
        where: { id, tenantId },
        data: { quantity, stockVersion: { increment: 1 } },
      });
    }
    for (const [id, quantity] of plan.touchedVariants) {
      await db.variant.update({
        where: { id, tenantId },
        data: { quantity, stockVersion: { increment: 1 } },
      });
    }

    // Consecutive milliseconds ending at `now` so (createdAt desc, id desc)
    // reads back in the order the rows were planned.
    const total = plan.movements.length;
    const rows: AppliedStockMovement[] = plan.movements.map((m, index) => ({
      ...m,
      id: randomUUID(),
      type: context.type,
      groupType: context.groupType,
      groupId: context.groupId,
      createdAt: new Date(now.getTime() - (total - 1 - index)),
    }));
    if (rows.length > 0) {
      await db.stockMovement.createMany({
        data: rows.map((r) => ({
          id: r.id,
          tenantId,
          productId: r.productId,
          variantId: r.variantId,
          lotId: r.lotId,
          productName: r.productName,
          variantLabel: r.variantLabel,
          lotNumber: r.lotNumber,
          bucketKind: r.bucketKind,
          type: context.type,
          reason: context.reason ?? null,
          note: context.note ?? null,
          removalCause: context.removalCause ?? null,
          delta: r.delta,
          balanceAfter: r.balanceAfter,
          productBalanceAfter: r.productBalanceAfter,
          groupType: context.groupType,
          groupId: context.groupId,
          actorId: context.actor.id,
          actorDisplayName: context.actor.displayName,
          createdAt: r.createdAt,
        })),
      });
    }
    return rows;
  }
}
