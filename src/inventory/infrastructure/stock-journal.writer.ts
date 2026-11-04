import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { businessToday } from '../domain/fefo-allocator';
import { mapSaleReversal } from '../domain/sale-reversal';
import { StockPlan } from '../domain/stock-plan';
import type {
  AppliedStockMovement,
  ProductStockState,
  SaleReversalOutcome,
  StockActor,
  StockBucketRef,
  StockChange,
  StockChargeItem,
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
 */
/** Migration whose completion marks the moment the journal went live. */
const JOURNAL_MIGRATION = '20261104020000_inventory_journal_storage';

@Injectable()
export class StockJournalWriter {
  private readonly businessTimezone: string;
  private activatedAt: Date | null = null;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    config: ConfigService,
  ) {
    this.businessTimezone = config.get<string>(
      'PROMOTIONS_BUSINESS_TIMEZONE',
      'America/Mexico_City',
    );
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
    return this.persist(plan, context, now);
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
    const movements = await this.persist(
      plan,
      {
        type: 'SALE_CANCELLATION',
        groupType: 'SALE',
        groupId: sale.saleId,
        actor: sale.actor,
      },
      now,
    );
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
    const movements = await this.persist(
      plan,
      {
        type: 'SALE_CANCELLATION',
        groupType: 'SALE',
        groupId: sale.saleId,
        actor: sale.actor,
      },
      now,
    );
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

  /** Locks products then their lots/variants (id order), loads state, builds a plan. */
  private async lockAndPlan(
    productIds: string[],
    now: Date,
  ): Promise<StockPlan> {
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
