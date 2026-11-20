/**
 * Bot-facing backorder use cases (contract v1 §6): schedule, read, list and
 * cancel. `ServiceAuthGuard` supplies the trusted tenant (CLS); nothing about
 * the tenant is read from the request.
 *
 * Intake runs in ONE transaction (like `CheckoutService.create`): advisory key
 * lock → idempotency receipt → validations → customer → folio → insert. The
 * receipt is the `backorders` row itself (`(tenantId, idempotencyKey)` unique +
 * `requestHash`), so a replay returns the CURRENT state of the same backorder.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import { SalesService } from '../../sales/sales.service';
import { BOT_STOCK_ACTOR_NAME } from '../../sales/sale-stock.service';
import { DomainError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BackorderError } from '../domain/backorder-error';
import {
  assertExpectedReferencePrice,
  assertStockShortfall,
  assertVariantSelection,
  computeBackorderRequestHash,
  queuePositions,
  resolveRestockEstimate,
  type BackorderIntent,
} from '../domain/backorder-rules';
import {
  decideCancel,
  type BackorderStatusValue,
} from '../domain/backorder-status';
import { allocateBackorderFolio } from '../infrastructure/backorder-folio.allocator';
import { BackorderCustomerResolver } from '../infrastructure/backorder-customer.resolver';
import { BackorderReferencePriceListResolver } from '../infrastructure/backorder-reference-price-list.resolver';
import { BackorderStockReader } from '../infrastructure/backorder-stock.reader';
import {
  toBackorderBot,
  type BackorderBot,
} from '../presentation/dto/backorder-bot.response';
import {
  BACKORDER_RESERVATION_RELEASER,
  type BackorderReservationReleaser,
} from './ports/backorder-reservation-releaser.port';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

/** `GET /chatbot-api/backorders` answers at most this many items (§6.3). */
export const BACKORDER_LIST_LIMIT = 50;

const BOT_INCLUDE = {
  product: { select: { name: true } },
  variant: { select: { name: true } },
  customer: { select: { firstName: true } },
  tenant: { select: { name: true } },
} satisfies Prisma.BackorderInclude;

export interface BackorderListFilter {
  phoneCountryCode?: string;
  phone?: string;
  statuses?: readonly BackorderStatusValue[];
  updatedSince?: Date;
}

export interface CreateBackorderResult {
  /** True when the idempotency key was already used by an identical request. */
  replayed: boolean;
  backorder: BackorderBot;
}

@Injectable()
export class BackordersBotService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly sales: SalesService,
    private readonly customers: BackorderCustomerResolver,
    private readonly stock: BackorderStockReader,
    private readonly referencePriceLists: BackorderReferencePriceListResolver,
    private readonly journal: StockJournalWriter,
    @Inject(BACKORDER_RESERVATION_RELEASER)
    private readonly releaser: BackorderReservationReleaser,
  ) {}

  async create(
    intent: BackorderIntent,
    key: string,
  ): Promise<CreateBackorderResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    const requestHash = computeBackorderRequestHash(intent);
    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const tx = this.tenantPrisma.getClient();
        // Separate namespaces prevent key/phone/active lock collisions from lock-order inversion.
        const keyLock = JSON.stringify(['bot_backorder_key', tenantId, key]);
        const acquired = await tx.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${keyLock}, 0)) AS acquired
        `;
        if (!acquired[0]?.acquired) {
          throw new BackorderError('IDEMPOTENCY_KEY_IN_FLIGHT');
        }
        const receipt = await tx.backorder.findFirst({
          where: { tenantId, idempotencyKey: key },
          select: { id: true, requestHash: true },
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash) {
            throw new BackorderError('IDEMPOTENCY_KEY_CONFLICT');
          }
          return {
            replayed: true,
            backorder: await this.readOne(tx, receipt.id),
          };
        }
        return {
          replayed: false,
          backorder: await this.schedule(
            tx,
            tenantId,
            intent,
            key,
            requestHash,
          ),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          // PostgreSQL aborted the transaction: this read is deliberately OUTSIDE it.
          const receipt = await this.tenantPrisma
            .getClient()
            .backorder.findFirst({
              where: { tenantId, idempotencyKey: key },
              select: { id: true, requestHash: true },
            });
          if (receipt) {
            if (receipt.requestHash !== requestHash) {
              throw new BackorderError('IDEMPOTENCY_KEY_CONFLICT');
            }
            return {
              replayed: true,
              backorder: await this.readOne(
                this.tenantPrisma.getClient(),
                receipt.id,
              ),
            };
          }
        }
        if (['P2034', 'P2028', 'P2024'].includes(error.code)) {
          throw new BackorderError('BACKORDER_RETRY_REQUIRED');
        }
      }
      throw error;
    }
  }

  async findById(id: string): Promise<BackorderBot> {
    return this.readOne(this.tenantPrisma.getClient(), id);
  }

  async list(filter: BackorderListFilter): Promise<BackorderBot[]> {
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    let customerId: string | undefined;
    if (filter.phoneCountryCode !== undefined && filter.phone !== undefined) {
      const customers = await tx.customer.findMany({
        where: {
          tenantId,
          phoneCountryCode: filter.phoneCountryCode,
          phone: filter.phone,
        },
        select: { id: true },
        take: 2,
      });
      if (customers.length === 0) return [];
      if (customers.length > 1) {
        throw new BackorderError('CUSTOMER_PHONE_AMBIGUOUS');
      }
      customerId = customers[0].id;
    }
    const rows = await tx.backorder.findMany({
      where: {
        tenantId,
        ...(customerId ? { customerId } : {}),
        ...(filter.statuses?.length
          ? { status: { in: [...filter.statuses] } }
          : {}),
        ...(filter.updatedSince
          ? { updatedAt: { gte: filter.updatedSince } }
          : {}),
      },
      include: BOT_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: BACKORDER_LIST_LIMIT,
    });
    const positions = await this.waitingPositions(tx, tenantId, rows);
    return rows.map((row) =>
      toBackorderBot(row, positions.get(row.id) ?? null),
    );
  }

  /**
   * Customer cancel (`cancelledByKind: CUSTOMER`). WAITING cancels now; a
   * RESERVED backorder first hands its units back through the releaser seam.
   * Terminal states answer `BACKORDER_NOT_CANCELLABLE {status}`.
   */
  async cancel(id: string, reason: string | null): Promise<BackorderBot> {
    const tenantId = this.tenantPrisma.getTenantId();
    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const tx = this.tenantPrisma.getClient();
        // Lock order: stock BEFORE the backorder row (the allocator takes the
        // journal locks, then the WAITING rows; a RESERVED row may be released
        // by it concurrently). The status is re-read under the row lock below.
        const probe = await tx.backorder.findFirst({
          where: { id, tenantId },
          select: { productId: true, status: true },
        });
        if (!probe) throw new BackorderError('BACKORDER_NOT_FOUND');
        if (probe.status === 'WAITING' || probe.status === 'RESERVED') {
          await this.journal.lockStock([probe.productId]);
        }
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM backorders WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`,
        );
        if (locked.length === 0)
          throw new BackorderError('BACKORDER_NOT_FOUND');
        const row = await tx.backorder.findFirst({
          where: { id, tenantId },
          select: {
            id: true,
            status: true,
            productId: true,
            variantId: true,
            quantity: true,
          },
        });
        if (!row) throw new BackorderError('BACKORDER_NOT_FOUND');
        const decision = decideCancel(row.status);
        if (!decision.allowed) {
          throw new BackorderError('BACKORDER_NOT_CANCELLABLE', {
            status: decision.status,
          });
        }
        if (decision.releasesReservation) {
          await this.releaser.releaseReservation({
            tenantId,
            backorderId: row.id,
            productId: row.productId,
            variantId: row.variantId,
            quantity: row.quantity,
            actor: { id: null, displayName: BOT_STOCK_ACTOR_NAME },
          });
        }
        await tx.backorder.update({
          where: { id: row.id, tenantId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledByKind: 'CUSTOMER',
            cancelReason: reason,
            version: { increment: 1 },
          },
        });
        return this.readOne(tx, row.id);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2034', 'P2028', 'P2024'].includes(error.code)
      ) {
        throw new BackorderError('BACKORDER_RETRY_REQUIRED');
      }
      throw error;
    }
  }

  /** Validations (inputs first, then state) and the insert of one new backorder. */
  private async schedule(
    tx: TenantClient,
    tenantId: string,
    intent: BackorderIntent,
    key: string,
    requestHash: string,
  ): Promise<BackorderBot> {
    const variantId = intent.variantId ?? null;
    const product = await tx.product.findFirst({
      where: { id: intent.productId, tenantId },
      select: {
        id: true,
        hasVariants: true,
        useStock: true,
        quantity: true,
      },
    });
    if (!product) throw new BackorderError('PRODUCT_NOT_FOUND');
    const variant = variantId
      ? await tx.variant.findFirst({
          where: { id: variantId, tenantId },
          select: { id: true, productId: true, quantity: true },
        })
      : null;
    assertVariantSelection({
      productHasVariants: product.hasVariants,
      productId: product.id,
      variantId,
      variant,
    });

    const decision = await tx.humanDecision.findFirst({
      where: { id: intent.sourceDecisionId, tenantId, type: 'RESTOCK' },
      select: {
        type: true,
        status: true,
        resolutionAction: true,
        restockDays: true,
        resolvedAt: true,
        productId: true,
        variantId: true,
      },
    });
    const estimate = resolveRestockEstimate(decision, {
      productId: product.id,
      variantId,
    });

    if (intent.chatbotRequestId) {
      const wrapper = await tx.chatbotRequest.findFirst({
        where: { id: intent.chatbotRequestId, tenantId },
        select: { id: true },
      });
      if (!wrapper) throw new BackorderError('CHATBOT_REQUEST_NOT_FOUND');
    }

    const resolved = await this.customers.resolve(tx, tenantId, intent);

    assertStockShortfall({
      sellable: await this.stock.sellable(product, variant),
      quantity: intent.quantity,
    });

    if (resolved.kind === 'existing') {
      const activeLock = JSON.stringify([
        'bot_backorder_active',
        tenantId,
        resolved.customer.id,
        product.id,
        variantId ?? '',
      ]);
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${activeLock}, 0))::text`,
      );
      const active = await tx.backorder.findFirst({
        where: {
          tenantId,
          customerId: resolved.customer.id,
          productId: product.id,
          variantId,
          status: { in: ['WAITING', 'RESERVED'] },
        },
        select: { id: true },
      });
      if (active) {
        throw new BackorderError('BACKORDER_DUPLICATE', {
          backorderId: active.id,
        });
      }
    }

    const referencePriceCents = await this.referencePrice(
      resolved.kind === 'existing' ? resolved.customer.id : null,
      { productId: product.id, variantId, quantity: intent.quantity },
    );
    assertExpectedReferencePrice(
      intent.expectedReferencePriceCents,
      referencePriceCents,
    );

    const customerId =
      resolved.kind === 'existing'
        ? resolved.customer.id
        : (await this.customers.createCustomer(tx, tenantId, intent, resolved))
            .id;
    const folio = await allocateBackorderFolio(tx, tenantId);
    // etaStage stays 0 even when `estimatedAt` already passed: the overdue-ETA
    // sweep (T4) picks such a backorder up and requests the re-estimate.
    const created = await tx.backorder.create({
      data: {
        tenantId,
        folio,
        customerId,
        productId: product.id,
        variantId,
        quantity: intent.quantity,
        referencePriceCents,
        // Null when the price came from the PUBLICO fallback (T1b).
        referencePriceListId:
          resolved.kind === 'existing'
            ? await this.referencePriceLists.resolve(
                resolved.customer.globalPriceListId,
                {
                  productId: product.id,
                  variantId,
                  quantity: intent.quantity,
                },
              )
            : null,
        scheduledAt: new Date(),
        estimatedArrivalDays: estimate.estimatedArrivalDays,
        estimatedAt: estimate.estimatedAt,
        sourceDecisionId: intent.sourceDecisionId,
        chatbotRequestId: intent.chatbotRequestId ?? null,
        idempotencyKey: key,
        requestHash,
      },
      select: { id: true },
    });
    return this.readOne(tx, created.id);
  }

  /**
   * The unit price this customer pays for `quantity` today through the bot,
   * before promotions (the list price of the customer's price list, tier for
   * the quantity). Same resolution the bot checkout and `evaluate-cart` use
   * (`SalesService.previewBotPricing`). A customer that does not exist yet is
   * priced as PUBLICO, exactly as checkout prices a `createIfAbsent` customer.
   */
  private async referencePrice(
    customerId: string | null,
    line: { productId: string; variantId: string | null; quantity: number },
  ): Promise<number> {
    try {
      const preview = await this.sales.previewBotPricing({
        customerId,
        items: [{ ...line, unitPriceCents: 0 }],
      });
      return preview.items[0].unitPriceCents;
    } catch (error) {
      // No catalog price for that product/variant in any applicable list.
      if (error instanceof DomainError && error.code === 'PRICE_OUT_OF_DATE') {
        throw new BackorderError('PRICE_UNAVAILABLE');
      }
      throw error;
    }
  }

  private async readOne(tx: TenantClient, id: string): Promise<BackorderBot> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await tx.backorder.findFirst({
      where: { id, tenantId },
      include: BOT_INCLUDE,
    });
    if (!row) throw new BackorderError('BACKORDER_NOT_FOUND');
    const positions = await this.waitingPositions(tx, tenantId, [row]);
    return toBackorderBot(row, positions.get(row.id) ?? null);
  }

  /** Queue position of every WAITING row, counted inside its own product/variant queue. */
  private async waitingPositions(
    tx: TenantClient,
    tenantId: string,
    rows: ReadonlyArray<{
      status: BackorderStatusValue;
      productId: string;
      variantId: string | null;
    }>,
  ): Promise<Map<string, number>> {
    const queues = new Map<
      string,
      { productId: string; variantId: string | null }
    >();
    for (const row of rows) {
      if (row.status !== 'WAITING') continue;
      queues.set(`${row.productId}\u0000${row.variantId ?? ''}`, {
        productId: row.productId,
        variantId: row.variantId,
      });
    }
    if (queues.size === 0) return new Map();
    const waiting = await tx.backorder.findMany({
      where: {
        tenantId,
        status: 'WAITING',
        OR: [...queues.values()],
      },
      select: { id: true, productId: true, variantId: true, scheduledAt: true },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });
    return queuePositions(waiting);
  }
}
