/**
 * SalesService - Application layer (Use Cases) for POS Sales.
 *
 * Orchestrates domain logic and infrastructure for the Sale aggregate.
 * Handles: draft creation, item management, validation, and ownership enforcement.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'crypto';
import { Sale, type SaleCancelReason } from './domain/sale.entity';
import type { ISaleRepository } from './domain/sale.repository';
import { SALE_REPOSITORY } from './domain/sale.repository';
import { ProductsService } from '../products/products.service';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../shared/domain/domain-error';
import type {
  IPosEvaluatePromotionsUseCase,
  PosEvalInput,
} from '../promotions/application/ports/pos-evaluate-promotions.port';
import { POS_EVALUATE_PROMOTIONS_USE_CASE } from '../promotions/application/ports/pos-evaluate-promotions.port';
import {
  SaleDraftOpenedEvent,
  SaleItemAddedEvent,
  SaleItemQuantityChangedEvent,
  SaleClearedEvent,
  SaleDraftDeletedEvent,
  SaleItemPriceOverriddenEvent,
  SaleItemDiscountAppliedEvent,
  SaleItemDiscountRemovedEvent,
  SaleItemRemovedEvent,
  SaleCustomerAssignedEvent,
  SaleCustomerClearedEvent,
  SaleShippingAddressSetEvent,
  SaleShippingAddressClearedEvent,
} from './domain/events/sale.events';
import type { AddItemDto } from './dto/add-item.dto';
import type { UpdateItemQuantityDto } from './dto/update-item-quantity.dto';
import type { OverrideItemPriceDto } from './dto/override-item-price.dto';
import type { AvailablePricesResponseDto } from './dto/available-prices-response.dto';
import type { ApplyItemDiscountDto } from './dto/apply-item-discount.dto';
import type { ChargeSaleDto } from './dto/charge-sale.dto';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto';
import type {
  SalesListBaseFilter,
  SalesListExtendedFilter,
} from './dto/sales-list-filter.types';
import type { SaleListResponseDto } from './dto/sale-list-response.dto';
import type { SaleDetailResponseDto } from './dto/sale-detail-response.dto';
import type { AssignCustomerDto } from './dto/assign-customer.dto';
import type { AssignSellerDto } from './dto/assign-seller.dto';
import type { SetShippingAddressDto } from './dto/set-shipping-address.dto';
import type { UpdateSaleDueDateDto } from './dto/update-sale-due-date.dto';
import { buildSaleTimeline } from './domain/build-sale-timeline';
import type {
  PersistedChargePayment,
  PersistedSaleRefundRecord,
  PersistedSalePaymentRecord,
} from './domain/sale.repository';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import {
  InvalidDueDateError,
  SaleFullyPaidError,
  SellerNotFoundError,
} from './domain/sale.errors';
import {
  ISaleCommentRepository,
  SALE_COMMENT_REPOSITORY,
} from './comments/domain/sale-comment.repository';

type SupportedChargeMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer'
  | 'credit';

type SupportedPaymentCollectionMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

type CollectionPaymentEntry = {
  method: SupportedPaymentCollectionMethod;
  amountCents: number;
  reference?: string;
  metadataJson?: unknown;
};

type AddPaymentAuthMode = 'owner' | 'reviewer';

type ChargePaymentEntry = {
  method: SupportedChargeMethod;
  amountCents: number;
  reference?: string;
};

type CanonicalChargePayment = PersistedChargePayment;

type ConfirmBotSaleInput = {
  cashierUserId: string;
  customerId: string;
  shippingAddressId?: string | null;
  items: Array<{
    productId: string;
    variantId?: string | null;
    productName: string;
    variantName?: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
};

type ConfirmBotSaleResult = {
  saleId: string;
  folio: string;
  paymentStatus: 'CREDIT';
  channel: 'ONLINE';
  deliveryStatus: 'PENDING';
  totalCents: number;
  paidCents: 0;
  debtCents: number;
  confirmedAt: string;
};

type CancelSaleDto = {
  reason: SaleCancelReason;
};

type CancelSaleResult = {
  saleId: string;
  status: 'CANCELED';
  refundedCents: number;
  restockedItems: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
  }>;
  canceledAt: string;
};

type CancelSaleRefundSource = {
  paymentId: string;
  method: string;
  amountCents: number;
};

function normalizeRefundMethod(
  method: string,
): PersistedSaleRefundRecord['method'] {
  switch (method.toUpperCase()) {
    case 'CASH':
      return 'cash';
    case 'CARD_CREDIT':
      return 'card_credit';
    case 'CARD_DEBIT':
      return 'card_debit';
    case 'TRANSFER':
      return 'transfer';
    case 'CREDIT':
      return 'credit';
    default:
      throw new BusinessRuleViolationError(
        'SALE_REFUND_METHOD_NOT_SUPPORTED',
        'SALE_REFUND_METHOD_NOT_SUPPORTED',
      );
  }
}

function buildCancellationRefunds(
  payments: CancelSaleRefundSource[],
  refundedCents: number,
  reason: SaleCancelReason,
): PersistedSaleRefundRecord[] {
  let remaining = refundedCents;
  const refunds: PersistedSaleRefundRecord[] = [];

  for (const payment of payments) {
    if (remaining <= 0) {
      break;
    }

    const amountCents = Math.min(payment.amountCents, remaining);
    if (amountCents <= 0) {
      continue;
    }

    refunds.push({
      salePaymentId: payment.paymentId,
      method: normalizeRefundMethod(payment.method),
      amountCents,
      reason,
    });
    remaining -= amountCents;
  }

  if (remaining !== 0) {
    throw new BusinessRuleViolationError(
      'SALE_REFUND_AUDIT_MISMATCH',
      'SALE_REFUND_AUDIT_MISMATCH',
    );
  }

  return refunds;
}

function isSupportedChargeMethod(
  method: ChargeSaleDto['method'],
): method is SupportedChargeMethod {
  return ['cash', 'card_credit', 'card_debit', 'transfer', 'credit'].includes(
    method ?? '',
  );
}

function chargeValidationError(
  code:
    | 'INVALID_CREDIT_CHARGE'
    | 'CUSTOMER_REQUIRED_FOR_CREDIT'
    | 'PAYMENT_AMOUNT_INVALID'
    | 'PAYMENT_AMOUNT_INSUFFICIENT'
    | 'AMBIGUOUS_PAYMENT_SHAPE'
    | 'CREDIT_METHOD_NOT_VALID_IN_MULTI'
    | 'REFERENCE_REQUIRED'
    | 'TOO_MANY_PAYMENTS',
): never {
  throw new BusinessRuleViolationError(code, code);
}

function normalizeChargeRequestPayments(
  dto: ChargeSaleDto,
): ChargePaymentEntry[] {
  const hasLegacy = dto.method !== undefined || dto.amountCents !== undefined;
  const hasArray = dto.payments !== undefined;

  if (hasLegacy && hasArray) {
    chargeValidationError('AMBIGUOUS_PAYMENT_SHAPE');
  }

  if (hasArray) {
    const entries = dto.payments ?? [];
    if (entries.length > 5) {
      chargeValidationError('TOO_MANY_PAYMENTS');
    }

    return entries.map((entry) => {
      if (!isSupportedChargeMethod(entry.method)) {
        throw new BusinessRuleViolationError(
          'PAYMENT_METHOD_NOT_SUPPORTED',
          'PAYMENT_METHOD_NOT_SUPPORTED',
        );
      }

      if (entry.method === 'credit') {
        chargeValidationError('CREDIT_METHOD_NOT_VALID_IN_MULTI');
      }

      if (
        ['card_credit', 'card_debit', 'transfer'].includes(entry.method) &&
        (!entry.reference || entry.reference.trim().length === 0)
      ) {
        chargeValidationError('REFERENCE_REQUIRED');
      }

      return {
        method: entry.method,
        amountCents: entry.amountCents,
        reference: entry.reference,
      };
    });
  }

  if (!dto.method || dto.amountCents === undefined) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  if (!isSupportedChargeMethod(dto.method)) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  return [
    {
      method: dto.method,
      amountCents: dto.amountCents,
    },
  ];
}

function toCanonicalChargePayments(
  payments: ChargePaymentEntry[],
): CanonicalChargePayment[] {
  return payments
    .filter(
      (payment): payment is CanonicalChargePayment =>
        payment.method !== 'credit',
    )
    .map((payment) => ({
      method: payment.method,
      amountCents: payment.amountCents,
      reference: payment.reference,
    }));
}

function sortPaymentsForHash(
  payments: ChargePaymentEntry[],
): ChargePaymentEntry[] {
  return [...payments].sort((left, right) =>
    `${left.method}|${left.amountCents}|${left.reference ?? ''}`.localeCompare(
      `${right.method}|${right.amountCents}|${right.reference ?? ''}`,
    ),
  );
}

function resolveDueDate(
  dueDateIso: string | undefined,
  confirmedAt: Date,
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT',
): Date | null {
  if (paymentStatus === 'PAID') {
    return null;
  }

  if (dueDateIso) {
    return new Date(dueDateIso);
  }

  const defaultDueDate = new Date(confirmedAt);
  defaultDueDate.setDate(defaultDueDate.getDate() + 15);
  return defaultDueDate;
}

function isSupportedCollectionMethod(
  method: string,
): method is SupportedPaymentCollectionMethod {
  return ['cash', 'card_credit', 'card_debit', 'transfer'].includes(method);
}

function normalizeCollectionRequestPayments(dto: {
  method?: string;
  amountCents?: number;
  reference?: string;
  payments?: Array<{ method: string; amountCents: number; reference?: string }>;
}): CollectionPaymentEntry[] {
  const hasLegacy = dto.method !== undefined || dto.amountCents !== undefined;
  const hasArray = dto.payments !== undefined;

  if (hasLegacy && hasArray) {
    throw new BusinessRuleViolationError(
      'AMBIGUOUS_PAYMENT_SHAPE',
      'AMBIGUOUS_PAYMENT_SHAPE',
    );
  }

  if (hasArray) {
    const entries = dto.payments ?? [];
    if (entries.length === 0) {
      throw new BusinessRuleViolationError('EMPTY_PAYMENTS', 'EMPTY_PAYMENTS');
    }

    return entries.map((entry) => {
      if (!isSupportedCollectionMethod(entry.method)) {
        throw new BusinessRuleViolationError(
          'PAYMENT_METHOD_NOT_SUPPORTED',
          'PAYMENT_METHOD_NOT_SUPPORTED',
        );
      }

      return {
        method: entry.method,
        amountCents: entry.amountCents,
        reference: entry.reference,
      };
    });
  }

  if (!dto.method || dto.amountCents === undefined) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  if (!isSupportedCollectionMethod(dto.method)) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  return [
    {
      method: dto.method,
      amountCents: dto.amountCents,
      reference: dto.reference,
    },
  ];
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly saleRepo: ISaleRepository,
    private readonly productsService: ProductsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly outboxWriter: OutboxWriterService,
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(SALE_COMMENT_REPOSITORY)
    private readonly saleCommentsRepo: Pick<
      ISaleCommentRepository,
      'findActiveBySale'
    > = {
      findActiveBySale: async () => [],
    },
    /**
     * Work Unit 4 — POS promotion engine port (Symbol-injected from
     * PromotionsModule). Drives `recomputePromotions(sale)` after every
     * draft mutation. Hexagonal: we depend on the I/O contract only, not
     * on promotions internals.
     */
    @Inject(POS_EVALUATE_PROMOTIONS_USE_CASE)
    private readonly posEvaluatePromotions: IPosEvaluatePromotionsUseCase,
  ) {}

  /**
   * Work Unit 4 — recompute POS promotions on the in-memory sale aggregate.
   *
   * Called AFTER each draft mutation (`addItem`, `updateItemQuantity`,
   * `removeItem`, `assignCustomer`) and BEFORE the caller's `saleRepo.save`.
   * Same method is re-used at charge time by Unit 5 inside the charge tx.
   *
   * Steps (per design.md — "Recompute Placement & Transaction Boundaries"):
   *  1. Collect the DISTINCT non-null `appliedPriceListId`s from the items
   *     and batch-resolve each to its `globalPriceListId` via
   *     `ProductsService.resolvePriceListGlobalIds` (C1 fix). Tenant-scoped.
   *  2. Build `PosEvalInput` from the CURRENT item state:
   *       `effectiveUnitPriceCents = item.prePriceCentsBeforeDiscount
   *         ?? item.unitPriceCents`  ← S3, pre-promo base so recompute
   *         never compounds on re-entry.
   *       `appliedGlobalPriceListId` from the resolution map (null when no
   *         override or unresolved).
   *       `hasManualDiscount = item.discountType !== null
   *         && item.promotionId === null`  ← auto-promo skips this line.
   *  3. Call the engine (`posEvaluatePromotions.evaluate(input)`).
   *  4. For each item that currently has a PROMO-sourced discount
   *     (`promotionId != null`), clear it before applying new results.
   *     Manual free-form discount lines are LEFT untouched (manual wins).
   *  5. Apply each engine `lines[]` result via `item.applyDiscount({...,
   *     promotionId})`. Engine only emits lines for items that should
   *     receive an auto promo, so manual-discount lines are not affected.
   *  6. Set or clear `sale.appliedOrderPromotion` from `result.order`.
   *
   * Recompute mutates the in-memory aggregate only — the caller persists
   * via `saleRepo.save` after this method returns. This keeps the
   * transactional boundary where the existing `save` lives.
   *
   * SAFE NO-OP: when no promotions match, the engine returns empty `lines`
   * and `null` `order`. Every item with `promotionId != null` is cleared
   * (recompute drops the auto-promo) and no new discount is applied. So
   * the ~1600 existing tests that don't involve promotions stay green:
   * the default mock returns empty and the in-memory sale ends in the
   * same state it was in (modulo any prior auto-promo being cleared,
   * which doesn't happen when no engine result is wired).
   */
  private async recomputePromotions(sale: Sale): Promise<void> {
    // (1) Build input + (2) call engine — see `buildPosEvalInput`.
    const result = await this.evaluatePromotionsForSale(sale);

    // (3) Clear prior PROMO-sourced discounts before applying the new results.
    //     Manual free-form discounts are skipped (no `promotionId`).
    for (const item of sale.items) {
      if (item.promotionId != null) {
        item.removeDiscount();
      }
    }

    // (4) Apply each per-line result. Engine guarantees `hasManualDiscount
    //     === false` for lines it returns, so manual-discount lines are
    //     never re-applied here.
    //
    //     WU4 (BXGY) — discriminated result routing (design.md Decision 8;
    //     spec.md:112-115,132-139). The engine emits a tagged
    //     `kind:'buy-x-get-y'` result for BUY_X_GET_Y winners and the
    //     untagged (per-unit) result for PRODUCT_DISCOUNT winners. The
    //     per-unit branch routes to `SaleItem.applyDiscount` (existing
    //     path, unchanged); the BXGY branch routes to
    //     `SaleItem.applyBuyXGetYReward`, which:
    //       - never mutates `unitPriceCents` (column-derived discriminator
    //         holds: unitPrice === prePrice),
    //       - stores the whole-line `R` in `discountAmountCents`,
    //       - stamps `discountType='amount'`, `discountValue=perUnit`,
    //         `promotionId`, `discountTitle`, `discountedAt`.
    //     The clear loop above already handles BXGY (lines with
    //     `promotionId != null` get `removeDiscount()`, which is a
    //     no-op on the unit price because the BXGY invariant forces
    //     unitPrice === prePrice) — so clear/re-apply converges byte-
    //     equal across N consecutive recomputes.
    for (const lineResult of result.lines) {
      const item = sale.items.find((i) => i.id === lineResult.itemId);
      if (!item) continue;
      if (lineResult.kind === 'buy-x-get-y') {
        item.applyBuyXGetYReward({
          lineDiscountCents: lineResult.lineDiscountCents,
          perUnitRewardCents: lineResult.perUnitRewardCents,
          discountedUnitCount: lineResult.discountedUnitCount,
          discountTitle: lineResult.discountTitle,
          promotionId: lineResult.promotionId,
        });
        continue;
      }
      item.applyDiscount({
        type: lineResult.discountType,
        amountCents:
          lineResult.discountType === 'amount'
            ? lineResult.discountValue
            : undefined,
        percent:
          lineResult.discountType === 'percentage'
            ? lineResult.discountValue
            : undefined,
        discountTitle: lineResult.discountTitle,
        promotionId: lineResult.promotionId,
      });
    }

    // (5) Set or clear the sale-level ORDER_DISCOUNT snapshot.
    if (result.order) {
      sale.setAppliedOrderPromotion({
        promotionId: result.order.promotionId,
        discountType: result.order.discountType,
        discountValue: result.order.discountValue,
        discountAmountCents: result.order.discountAmountCents,
        discountTitle: result.order.discountTitle,
      });
    } else {
      sale.clearAppliedOrderPromotion();
    }

    // (6) Work Unit 7 — Layer B self-heal: prune opted-in MANUAL promos
    //     that are ORPHANED (the cart no longer has a matching TARGET
    //     line for them). The engine reports the distinction via
    //     `result.targetableManualPromotionIds` (see
    //     pos-evaluate-promotions.use-case.ts:147+) — the subset of the
    //     current opt-in set whose target is still in the cart.
    //
    //     ORPHANED vs TEMPORARILY-INELIGIBLE — these are distinct, and
    //     we MUST NOT confuse them. A promo is:
    //       - ORPHANED: the cart has NO line that the promo's
    //         targetItems could match. The opt-in has no possible
    //         application ever. PRUNE.
    //       - TEMPORARILY-INELIGIBLE: a line IS in the cart that
    //         matches the target, but the promo can't apply right now
    //         (line carries hasManualDiscount, price-list mismatch,
    //         promo lost best-wins, daysOfWeek not today, customer
    //         scope doesn't match the current customerId, etc.).
    //         RETAIN — the seller's opt-in is still semantically valid
    //         and a future state change (manual discount removed,
    //         price list applied, competing winner gone) re-enables
    //         the promo without forcing the seller to re-opt-in.
    //
    //     The engine's `targetableManualPromotionIds` answers EXACTLY
    //     the orphaned-vs-ineligible question at the cart-shape level:
    //     it includes an opted-in MANUAL id IFF the cart has at least
    //     one line whose productId matches the target. Per-line
    //     price-list gates, hasManualDiscount, and best-wins ranking
    //     are NOT considered at this layer — the engine makes that
    //     distinction in the `targetable` filter (see
    //     pos-evaluate-promotions.use-case.ts:5b). ORDER_DISCOUNT
    //     opt-ins are always included (sale-level, never orphaned by
    //     removing a specific line — the sale still exists).
    //
    //     Without this prune, a stale opt-in (e.g. one that persisted
    //     from a prior session whose target line was removed before
    //     this fix was wired, or a manual delete from the DB) would
    //     re-apply the MANUAL promo on the next addItem of ANY
    //     matching product — the resurrection bug Layer A alone does
    //     not cover.
    const targetableSet = new Set(result.targetableManualPromotionIds);
    const currentOptIns = sale.optedInManualPromotionIds;
    for (const id of currentOptIns) {
      if (!targetableSet.has(id)) {
        sale.optOutManualPromotion(id);
      }
    }
  }

  /**
   * Work Unit 6 — Non-mutating engine call: builds the `PosEvalInput` from
   * the current draft state and runs the engine WITHOUT applying results
   * to the sale. Used by `listApplicablePromotions` to expose the
   * `availableManualPromotions[]` (what the seller could still opt-in to)
   * without changing the draft. Read-only — the spec scenario for
   * `GET /sales/drafts/:id/applicable-promotions` is non-mutating.
   */
  private async evaluatePromotionsForSale(sale: Sale) {
    const input = await this.buildPosEvalInput(sale);
    return this.posEvaluatePromotions.evaluate(input);
  }

  /**
   * Work Unit 6 — Build the engine input from the sale's current item
   * state. Extracted from `recomputePromotions` so the non-mutating
   * `evaluatePromotionsForSale` can reuse it without duplicating the
   * batch-resolve + per-line construction logic.
   *
   * W4 — wires `ProductsService.resolveProductCategoryBrandIds` so
   * each engine line carries the resolved `categoryId`/`brandId`
   * for the CATEGORIES/BRANDS matcher. The resolver is invoked once
   * per recompute with the DISTINCT productIds from the current
   * items. Lines whose product is missing from the map (silently
   * omitted by the resolver) fall back to `{ null, null }` — the
   * engine's null guard at `matchTargetTier` then correctly skips
   * any CATEGORIES/BRANDS promotion on those lines.
   */
  private async buildPosEvalInput(sale: Sale): Promise<PosEvalInput> {
    // Distinct non-null appliedPriceListIds.
    const distinctPriceListIds = [
      ...new Set(
        sale.items
          .map((item) => item.appliedPriceListId)
          .filter((id): id is string => id != null && id !== ''),
      ),
    ];
    // Batch-resolve to globalPriceListId (C1 fix).
    const priceListGlobalIdMap =
      distinctPriceListIds.length > 0
        ? await this.productsService.resolvePriceListGlobalIds(
            distinctPriceListIds,
          )
        : new Map<string, string>();

    // Distinct non-null productIds for the CATEGORIES/BRANDS resolver.
    // Resolver short-circuits on the empty array, so the `length > 0`
    // guard is redundant but explicit (matches the price-list branch
    // above — keeps the wiring symmetric and easy to read).
    const distinctProductIds = [
      ...new Set(
        sale.items
          .map((item) => item.productId)
          .filter((id): id is string => id != null && id !== ''),
      ),
    ];
    const productCategoryBrandMap =
      distinctProductIds.length > 0
        ? await this.productsService.resolveProductCategoryBrandIds(
            distinctProductIds,
          )
        : new Map<string, { categoryId: string | null; brandId: string | null }>();

    return {
      now: new Date(),
      customerId: sale.customerId,
      lines: sale.items.map((item) => {
        const resolved = productCategoryBrandMap.get(item.productId);
        return {
          itemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          effectiveUnitPriceCents:
            item.prePriceCentsBeforeDiscount ?? item.unitPriceCents,
          appliedPriceListId: item.appliedPriceListId,
          appliedGlobalPriceListId:
            item.appliedPriceListId != null
              ? (priceListGlobalIdMap.get(item.appliedPriceListId) ?? null)
              : null,
          // W4 — stamp resolved categoryId/brandId per line. A
          // missing product in the resolver map (silently omitted)
          // falls back to `{ null, null }` so the engine's null
          // guard at `matchTargetTier` returns null for any
          // CATEGORIES/BRANDS target on those lines — exactly the
          // "no match" semantics the spec demands.
          categoryId: resolved?.categoryId ?? null,
          brandId: resolved?.brandId ?? null,
          hasManualDiscount:
            item.discountType !== null && item.promotionId === null,
        };
      }),
      vetoedPromotionIds: sale.vetoedPromotionIds,
      optedInManualPromotionIds: sale.optedInManualPromotionIds,
    };
  }

  private async publishSaleConfirmedEvent(input: {
    saleId: string;
    tenantId: string;
    actorId: string;
    folio: string;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    confirmedAt: Date;
  }): Promise<void> {
    await this.outboxWriter.publish(
      this.tenantPrisma.getClient(),
      input.tenantId,
      'Sale',
      input.saleId,
      'sale.confirmed',
      {
        saleId: input.saleId,
        folio: input.folio,
        tenantId: input.tenantId,
        actorId: input.actorId,
        totalCents: input.totalCents,
        paidCents: input.paidCents,
        debtCents: input.debtCents,
        paymentStatus: input.paymentStatus,
        confirmedAt: input.confirmedAt.toISOString(),
      },
    );
  }

  private async publishPaymentReceivedEvents(input: {
    saleId: string;
    tenantId: string;
    actorId: string | null;
    payments: PersistedSalePaymentRecord[];
    paidCents: number;
    debtCents: number;
    occurredAt: Date;
    resultingPaymentStatus?: 'PAID' | 'PARTIAL' | 'CREDIT';
  }): Promise<void> {
    const payments = input.payments ?? [];
    let cumulativePaidCents =
      input.paidCents - payments.reduce((sum, p) => sum + p.amountCents, 0);
    let remainingDebtCents =
      input.paidCents + input.debtCents - cumulativePaidCents;

    for (const payment of payments) {
      cumulativePaidCents += payment.amountCents;
      remainingDebtCents = Math.max(
        remainingDebtCents - payment.amountCents,
        0,
      );

      await this.outboxWriter.publish(
        this.tenantPrisma.getClient(),
        input.tenantId,
        'Sale',
        input.saleId,
        'sale.payment.received',
        {
          saleId: input.saleId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          paymentId: payment.paymentId,
          method: payment.method,
          amountCents: payment.amountCents,
          reference: payment.reference ?? undefined,
          occurredAt: input.occurredAt.toISOString(),
          resultingPaidCents: cumulativePaidCents,
          resultingDebtCents: remainingDebtCents,
          resultingPaymentStatus:
            input.resultingPaymentStatus ??
            (remainingDebtCents === 0 ? 'PAID' : 'PARTIAL'),
        },
      );
    }
  }

  private async publishSaleFullyPaidEvent(input: {
    saleId: string;
    tenantId: string;
    folio: string;
    totalCents: number;
    paidAt: Date;
  }): Promise<void> {
    await this.outboxWriter.publish(
      this.tenantPrisma.getClient(),
      input.tenantId,
      'Sale',
      input.saleId,
      'sale.fully.paid',
      {
        saleId: input.saleId,
        tenantId: input.tenantId,
        folio: input.folio,
        totalCents: input.totalCents,
        paidAt: input.paidAt.toISOString(),
      },
    );
  }

  // ==================== Use Cases ====================

  /**
   * Open a new draft sale for a user.
   */
  async openDraft(userId: string) {
    const saleId = randomUUID();
    const sale = Sale.create({ id: saleId, userId });

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.draft.opened',
      new SaleDraftOpenedEvent(saleId, userId),
    );

    return sale.toResponse();
  }

  /**
   * Add item to a draft sale.
   * Validates ownership, product/variant, and stock availability.
   * Freezes price at add-time.
   */
  async addItem(saleId: string, userId: string, dto: AddItemDto) {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    // Fetch product info and freeze price
    const productInfo = await this.productsService.getProductInfoForSale(
      dto.productId,
      dto.variantId ?? null,
    );

    // Calculate cumulative quantity if stacking same product+variant
    const existingItem = sale.items.find(
      (item) =>
        item.productId === dto.productId &&
        item.variantId === (dto.variantId ?? null),
    );
    const cumulativeQuantity = existingItem
      ? existingItem.quantity + dto.quantity
      : dto.quantity;

    // Check stock availability for cumulative quantity (no reservation)
    const stockCheck = await this.productsService.checkStockAvailability(
      dto.productId,
      dto.variantId ?? null,
      cumulativeQuantity,
    );

    if (!stockCheck.available) {
      throw new BusinessRuleViolationError(
        `Insufficient stock for product ${dto.productId}. ` +
          `Available: ${stockCheck.currentStock}, Requested: ${cumulativeQuantity}`,
      );
    }

    // Add item to sale (stacks if same product+variant)
    const itemId = randomUUID();
    sale.addItem({
      id: itemId,
      saleId,
      productId: productInfo.productId,
      variantId: productInfo.variantId,
      productName: productInfo.productName,
      variantName: productInfo.variantName,
      imageUrl: productInfo.imageUrl,
      quantity: dto.quantity,
      unitPriceCents: productInfo.unitPriceCents,
      unitPriceCurrency: 'MXN',
    });

    // Work Unit 4 — recompute POS promotions on the new item state BEFORE
    // persisting. Same-engine call (so charge totals will agree with the
    // draft preview once Unit 5 wires charge).
    await this.recomputePromotions(sale);

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.item.added',
      new SaleItemAddedEvent(
        saleId,
        itemId,
        productInfo.productId,
        productInfo.variantId,
        dto.quantity,
        productInfo.unitPriceCents,
      ),
    );

    return sale.toResponse();
  }

  /**
   * Update quantity of an existing item in a draft sale.
   * Validates ownership and stock availability for new quantity.
   */
  async updateItemQuantity(
    saleId: string,
    userId: string,
    itemId: string,
    dto: UpdateItemQuantityDto,
  ) {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    // Find the item to get product/variant info
    const item = sale.items.find((i) => i.id === itemId);
    if (!item) {
      throw new BusinessRuleViolationError(`Item ${itemId} not found in sale`);
    }

    const previousQuantity = item.quantity;

    // Check stock for new quantity
    const stockCheck = await this.productsService.checkStockAvailability(
      item.productId,
      item.variantId,
      dto.quantity,
    );

    if (!stockCheck.available) {
      throw new BusinessRuleViolationError(
        `Insufficient stock for product ${item.productId}. ` +
          `Available: ${stockCheck.currentStock}, Requested: ${dto.quantity}`,
      );
    }

    // Update quantity
    sale.updateItemQuantity(itemId, dto.quantity);

    // Work Unit 4 — recompute (qty change can flip eligibility / re-apply).
    await this.recomputePromotions(sale);

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.item.quantity.changed',
      new SaleItemQuantityChangedEvent(
        saleId,
        itemId,
        previousQuantity,
        dto.quantity,
      ),
    );

    return sale.toResponse();
  }

  /**
   * Clear all items from a draft sale (idempotent).
   */
  async clearItems(saleId: string, userId: string) {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    const clearedItemCount = sale.items.length;
    sale.clearItems();

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.cleared',
      new SaleClearedEvent(saleId, clearedItemCount),
    );

    return sale.toResponse();
  }

  async removeItem(saleId: string, actorId: string, itemId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    sale.removeItem(itemId);
    // Work Unit 4 — recompute so any ORDER_DISCOUNT no longer references the
    // removed item, and remaining items re-evaluate against the new state.
    await this.recomputePromotions(sale);
    await this.saleRepo.save(sale);
    this.eventEmitter.emit(
      'sale.item.removed',
      new SaleItemRemovedEvent(saleId, itemId, actorId, new Date()),
    );

    return sale.toResponse();
  }

  /**
   * Delete a draft sale (hard delete).
   */
  async deleteDraft(saleId: string, userId: string): Promise<void> {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    await this.saleRepo.delete(saleId);

    this.eventEmitter.emit(
      'sale.draft.deleted',
      new SaleDraftDeletedEvent(saleId, userId),
    );
  }

  /**
   * Get all draft sales for a user.
   */
  async getUserDrafts(userId: string) {
    const sales = await this.saleRepo.findDraftsByUserId(userId);
    return sales.map((sale) => sale.toResponse());
  }

  /**
   * Search POS catalog (facade to ProductsService).
   * Delegates to ProductsService.searchForPOS.
   */
  async searchPosCatalog(dto: {
    q?: string;
    limit?: number;
    offset?: number;
    categoryId?: string;
    brandId?: string;
  }) {
    return this.productsService.searchForPOS(dto);
  }

  async listSales(query: ListSalesQueryDto): Promise<SaleListResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const extendedFilters = this.toSalesListExtendedFilter(query);
    const baseFilters: SalesListBaseFilter = {
      q: extendedFilters.q,
      cashierUserId: extendedFilters.cashierUserId,
      customerId: extendedFilters.customerId,
      customerIncludeNull: extendedFilters.customerIncludeNull,
      confirmedFrom: extendedFilters.confirmedFrom,
      confirmedTo: extendedFilters.confirmedTo,
    };

    const [data, total, groupedPaymentStatus, notDelivered] = await Promise.all(
      [
        this.saleRepo.findManyConfirmed({
          page,
          limit,
          sortBy: query.sortBy ?? 'confirmedAt',
          sortOrder: query.sortOrder ?? 'desc',
          ...extendedFilters,
        }),
        this.saleRepo.countConfirmed(baseFilters),
        this.saleRepo.groupByPaymentStatusConfirmed(baseFilters),
        this.saleRepo.countNotDeliveredConfirmed(baseFilters),
      ],
    );

    const paidCount = groupedPaymentStatus
      .filter((item) => item.paymentStatus === 'PAID')
      .reduce((acc, item) => acc + item._count._all, 0);
    const pendingPayments = Math.max(0, total - paidCount);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      data,
      pagination: { page, limit, total, totalPages },
      counts: {
        all: total,
        pendingPayments,
        notDelivered,
      },
    };
  }

  private toSalesListExtendedFilter(
    query: ListSalesQueryDto,
  ): SalesListExtendedFilter {
    return {
      q: query.q,
      folio: query.folio,
      status: query.status,
      paymentStatus: query.paymentStatus,
      deliveryStatus: query.deliveryStatus,
      paymentMethod: query.paymentMethod,
      paymentMethodIncludeNull: query.paymentMethodIncludeNull,
      totalMin: query.totalMin,
      totalMax: query.totalMax,
      debtMin: query.debtMin,
      debtMax: query.debtMax,
      dueDateFrom: query.dueDateFrom,
      dueDateTo: query.dueDateTo,
      dueDateIncludeNull: query.dueDateIncludeNull,
      cashierUserId: query.cashierUserId,
      customerId: query.customerId,
      customerIncludeNull: query.customerIncludeNull,
      confirmedFrom: query.confirmedFrom,
      confirmedTo: query.confirmedTo,
    };
  }

  async getSaleDetail(saleId: string): Promise<SaleDetailResponseDto> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        saleId,
      )
    ) {
      throw new BadRequestException('Validation failed (uuid is expected)');
    }

    const sale = await this.saleRepo.findOneWithRelations(saleId);
    if (!sale) {
      throw new NotFoundException('Sale not found');
    }

    const comments = await this.saleCommentsRepo.findActiveBySale(saleId);

    return {
      id: sale.id,
      folio: sale.folio,
      status: sale.status,
      channel: sale.channel,
      register: sale.register,
      confirmedAt: sale.confirmedAt?.toISOString() ?? null,
      dueDate: sale.dueDate ? sale.dueDate.toISOString() : null,
      subtotalCents: sale.subtotalCents,
      discountCents: sale.discountCents,
      totalCents: sale.totalCents,
      paidCents: sale.paidCents,
      debtCents: sale.debtCents,
      changeDueCents: sale.changeDueCents,
      paymentStatus: sale.paymentStatus,
      deliveryStatus: sale.deliveryStatus,
      customer: sale.customer,
      cashier: sale.cashier,
      seller: sale.seller,
      items: sale.items,
      payments: sale.payments.map((payment) => ({
        method: payment.method,
        amountCents: payment.amountCents,
        tenderedCents: payment.tenderedCents,
        changeCents: payment.changeCents,
        reference: payment.reference,
        paidAt: payment.paidAt.toISOString(),
      })),
      timeline: buildSaleTimeline({
        createdAt: sale.createdAt,
        confirmedAt: sale.confirmedAt,
        deliveryStatus: sale.deliveryStatus,
        register: sale.register,
        cashier: sale.cashier,
        payments: sale.payments.map((payment) => ({
          method: payment.method,
          amountCents: payment.amountCents,
          reference: payment.reference,
          createdAt: payment.createdAt,
          userId: payment.userId,
          user: payment.user,
        })),
        comments: comments.map((comment) => ({
          id: comment.id,
          createdAt: comment.createdAt,
          body: comment.body,
          author: comment.author,
        })),
      }),
    };
  }

  /**
   * Get single product detail for POS (facade to ProductsService).
   * Delegates to ProductsService.findOneForPOS.
   */
  async getProductDetail(productId: string) {
    const product = await this.productsService.findOneForPOS(productId);
    if (!product) {
      throw new EntityNotFoundError('Product', productId);
    }
    return product;
  }

  async getAvailablePrices(
    saleId: string,
    itemId: string,
    actorId: string,
  ): Promise<AvailablePricesResponseDto> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const item = sale.items.find((i) => i.id === itemId);
    if (!item)
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );

    const prices = await this.productsService.getApplicablePrices(
      item.productId,
      item.variantId,
      item.quantity,
    );

    return {
      saleId,
      itemId,
      prices: prices.map((p) => ({
        ...p,
        currency: 'MXN' as const,
        // Strategy: when item comes from price-list override, current marker is strict by applied list id.
        // Otherwise (default/custom paths with null list id), fallback to matching current unit price.
        isCurrent:
          item.appliedPriceListId !== null
            ? item.appliedPriceListId === p.priceListId
            : item.unitPriceCents === p.priceCents,
      })),
    };
  }

  async overrideItemPrice(
    saleId: string,
    itemId: string,
    dto: OverrideItemPriceDto,
    actorId: string,
  ) {
    if (
      (dto.priceListId && dto.customPriceCents) ||
      (!dto.priceListId && !dto.customPriceCents)
    ) {
      throw new BusinessRuleViolationError('INVALID_PRICE_OVERRIDE_INPUT');
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }
    const item = sale.items.find((i) => i.id === itemId);
    if (!item)
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );

    const previous = item.unitPriceCents;
    if (dto.priceListId) {
      const resolved = await this.productsService.resolveListPrice(
        dto.priceListId,
        item.productId,
        item.variantId,
        item.quantity,
      );
      sale.overrideItemPrice(itemId, {
        priceCents: resolved,
        priceSource: 'price_list',
        appliedPriceListId: dto.priceListId,
        customPriceCents: null,
      });
    } else {
      sale.overrideItemPrice(itemId, {
        priceCents: dto.customPriceCents!,
        priceSource: 'custom',
        appliedPriceListId: null,
        customPriceCents: dto.customPriceCents!,
      });
    }

    // Work Unit 5 — recompute after override. `overridePrice` calls
    // `clearDiscountFields()` (sale-item.entity.ts:226) which wipes any prior
    // discount / `promotionId` on the line. Without recompute, an eligible
    // auto-promo would silently disappear on override. Recompute re-applies
    // it on the NEW baseline (promo-on-top-of-price-list).
    await this.recomputePromotions(sale);

    await this.saleRepo.save(sale);
    const updated = sale.items.find((i) => i.id === itemId)!;
    this.eventEmitter.emit(
      'sale.item.price.overridden',
      new SaleItemPriceOverriddenEvent(
        saleId,
        itemId,
        actorId,
        previous,
        updated.unitPriceCents,
        updated.priceSource === 'price_list' ? 'price_list' : 'custom',
        updated.appliedPriceListId,
        updated.customPriceCents,
        new Date(),
      ),
    );

    return sale.toResponse();
  }

  async applyItemDiscount(
    saleId: string,
    itemId: string,
    dto: ApplyItemDiscountDto,
    actorId: string,
  ) {
    if (
      (dto.type === 'amount' && dto.amountCents === undefined) ||
      (dto.type === 'percentage' && dto.percent === undefined) ||
      (dto.amountCents !== undefined && dto.percent !== undefined)
    ) {
      throw new BusinessRuleViolationError(
        'INVALID_DISCOUNT_INPUT',
        'INVALID_DISCOUNT_INPUT',
      );
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    sale.applyItemDiscount(itemId, {
      type: dto.type,
      amountCents: dto.amountCents,
      percent: dto.percent,
      discountTitle: dto.title ?? dto.discountTitle,
    });
    await this.saleRepo.save(sale);

    const updated = sale.items.find((i) => i.id === itemId)!;
    this.eventEmitter.emit(
      'sale.item.discount.applied',
      new SaleItemDiscountAppliedEvent(
        saleId,
        itemId,
        actorId,
        updated.discountType!,
        updated.discountValue!,
        updated.discountAmountCents!,
        updated.discountTitle,
        new Date(),
      ),
    );

    return sale.toResponse();
  }

  async removeItemDiscount(saleId: string, itemId: string, actorId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    sale.removeItemDiscount(itemId);
    // Work Unit 4 — recompute so any remaining promo state and the
    // sale-level ORDER_DISCOUNT snapshot stay consistent after the
    // per-line removal. Mirrors `removeItem` at sales.service.ts:903
    // (which already recomputes). The aggregate-level opt-out in
    // `sale.removeItemDiscount` (Layer A — sale.entity.ts#removeItemDiscount)
    // already pruned the orphaned MANUAL opt-in; this recompute is the
    // engine-level mirror that also catches stale opt-ins that escaped
    // Layer A (Layer B — see recomputePromotions below).
    await this.recomputePromotions(sale);
    await this.saleRepo.save(sale);
    this.eventEmitter.emit(
      'sale.item.discount.removed',
      new SaleItemDiscountRemovedEvent(saleId, itemId, actorId, new Date()),
    );

    return sale.toResponse();
  }

  async applyGlobalDiscount(
    saleId: string,
    dto: ApplyItemDiscountDto,
    actorId: string,
  ) {
    if (
      (dto.type === 'amount' && dto.amountCents === undefined) ||
      (dto.type === 'percentage' && dto.percent === undefined) ||
      (dto.amountCents !== undefined && dto.percent !== undefined)
    ) {
      throw new BusinessRuleViolationError(
        'INVALID_DISCOUNT_INPUT',
        'INVALID_DISCOUNT_INPUT',
      );
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const result = sale.applyGlobalDiscount({
      type: dto.type,
      amountCents: dto.amountCents,
      percent: dto.percent,
      discountTitle: dto.title ?? dto.discountTitle,
      strategy: dto.strategy,
    });
    await this.saleRepo.save(sale);

    const skippedIds = new Set(result.skippedItems.map((item) => item.itemId));
    for (const item of sale.items) {
      if (
        skippedIds.has(item.id) ||
        !item.discountType ||
        !item.discountValue
      ) {
        continue;
      }

      this.eventEmitter.emit(
        'sale.item.discount.applied',
        new SaleItemDiscountAppliedEvent(
          saleId,
          item.id,
          actorId,
          item.discountType,
          item.discountValue,
          item.discountAmountCents!,
          item.discountTitle,
          new Date(),
        ),
      );
    }

    return {
      sale: result.sale.toResponse(),
      skippedItems: result.skippedItems,
    };
  }

  async removeGlobalDiscount(saleId: string, actorId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const discountedItemIds = sale.items
      .filter((item) => item.discountType !== null)
      .map((item) => item.id);

    sale.removeGlobalDiscount();
    await this.saleRepo.save(sale);

    for (const itemId of discountedItemIds) {
      this.eventEmitter.emit(
        'sale.item.discount.removed',
        new SaleItemDiscountRemovedEvent(saleId, itemId, actorId, new Date()),
      );
    }

    return sale.toResponse();
  }

  // ============================================================================
  // Work Unit 6 — Manual apply/remove + veto endpoints (6.1, 6.2, 6.3, 6.4, 6.5)
  // ============================================================================

  /**
   * 6.1 — `GET /sales/drafts/:id/applicable-promotions`
   *
   * Read-only: returns the MANUAL promotions the engine currently marks
   * as eligible for this draft (excludes opted-in + vetoed + ineligible).
   * Does NOT mutate the in-memory Sale aggregate — the engine call is
   * non-mutating and we do NOT call `saleRepo.save`.
   *
   * The list is a snapshot of the current draft state (items, customer,
   * vetoed ids, opted-in ids). Changing any of those via a mutation
   * endpoint will change the list on the next call.
   */
  async listApplicablePromotions(saleId: string, actorId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }
    if (sale.status !== 'DRAFT') {
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    }
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    // Non-mutating engine call — same input the recompute would use, but
    // we DO NOT apply the result to the sale and DO NOT save.
    const result = await this.evaluatePromotionsForSale(sale);

    return {
      saleId,
      promotions: result.availableManualPromotions,
    };
  }

  /**
   * 6.2 — `POST /sales/drafts/:id/manual-promotions/:promotionId`
   *
   * Opt a MANUAL promotion in. Adds the id to `sale.optedInManualPromotionIds`,
   * runs the recompute so the engine sees the opt-in (best-wins now
   * includes the manual candidate), then persists. If the same id was
   * previously vetoed, it is REMOVED from the veto set (reactivation
   * path per the design's precedence state machine).
   */
  async applyManualPromotion(
    saleId: string,
    actorId: string,
    promotionId: string,
  ) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }
    if (sale.status !== 'DRAFT') {
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    }
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    // Mutate BEFORE recompute so the engine sees the opt-in set.
    // The entity's optInManualPromotion cross-clears the veto set
    // when the same id was previously vetoed — reactivation path is
    // owned by the aggregate, NOT duplicated here.
    sale.optInManualPromotion(promotionId);

    await this.recomputePromotions(sale);
    await this.saleRepo.save(sale);

    return sale.toResponse();
  }

  /**
   * 6.3 — `DELETE /sales/drafts/:id/manual-promotions/:promotionId`
   *
   * Remove a MANUAL opt-in. Idempotent — removing an id that is NOT
   * currently opted-in is a safe no-op. The recompute runs so any
   * per-line discount sourced from the now-removed opt-in is cleared.
   */
  async removeManualPromotion(
    saleId: string,
    actorId: string,
    promotionId: string,
  ) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }
    if (sale.status !== 'DRAFT') {
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    }
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    // Mutate BEFORE recompute so the engine sees the updated opt-in set.
    sale.optOutManualPromotion(promotionId);

    await this.recomputePromotions(sale);
    await this.saleRepo.save(sale);

    return sale.toResponse();
  }

  /**
   * 6.4 — `DELETE /sales/drafts/:id/promotions/:promotionId`
   *
   * Tolerant semantics: the frontend uses this endpoint generically to
   * "remove" any applied promotion (it cannot tell MANUAL from
   * AUTOMATIC because the draft response does not expose the promotion
   * method). The correct behavior depends on whether the id is
   * currently opted-in:
   *
   * - If the id IS in `sale.optedInManualPromotionIds` (the seller
   *   had manually applied it) → OPT IT OUT. The promo returns to
   *   the available list (the seller can re-apply it later). Adding
   *   it to the veto set would create a (opted-in, vetoed) corrupt
   *   state — the entity's `addVetoedPromotion` would also cross-clear
   *   the opt-in, but opt-out is the right USER-FACING semantics:
   *   for a manual promo "remove" means "stop using it", not
   *   "ban it forever".
   * - If the id is NOT opted-in (a genuine AUTO-applied promo) →
   *   VETO it (existing behavior). The engine excludes it on every
   *   subsequent recompute.
   *
   * The Promotion catalog (status / method / discountValue) is NEVER
   * mutated — we only touch the per-draft opt-in / veto sets.
   */
  async removeAppliedPromotion(
    saleId: string,
    actorId: string,
    promotionId: string,
  ) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }
    if (sale.status !== 'DRAFT') {
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    }
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    // Mutate BEFORE recompute so the engine sees the updated sets.
    if (sale.optedInManualPromotionIds.includes(promotionId)) {
      // Manual promo the seller had opted-in: remove the opt-in so
      // the promo returns to the available list. No veto added.
      sale.optOutManualPromotion(promotionId);
    } else {
      // Genuine AUTO-applied (or already-opted-out) promo: veto.
      sale.addVetoedPromotion(promotionId);
    }

    await this.recomputePromotions(sale);
    await this.saleRepo.save(sale);

    return sale.toResponse();
  }

  async assignCustomer(saleId: string, userId: string, dto: AssignCustomerDto) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const prisma = this.tenantPrisma.getClient();
    const customer = await prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) {
      throw new BusinessRuleViolationError(
        'CUSTOMER_NOT_FOUND',
        'CUSTOMER_NOT_FOUND',
      );
    }

    if (dto.shippingAddressId !== undefined && dto.shippingAddressId !== null) {
      const address = await prisma.customerAddress.findUnique({
        where: { id: dto.shippingAddressId },
      });
      if (!address) {
        throw new BusinessRuleViolationError(
          'SHIPPING_ADDRESS_NOT_FOUND',
          'SHIPPING_ADDRESS_NOT_FOUND',
        );
      }
      if (address.customerId !== dto.customerId) {
        throw new BusinessRuleViolationError(
          'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
          'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
        );
      }
    }

    const previousCustomerId = sale.customerId;
    const previousShippingAddressId = sale.shippingAddressId;
    sale.assignCustomer(dto.customerId, dto.shippingAddressId ?? null);
    // Work Unit 4 — recompute (SPECIFIC / REGISTERED_ONLY promos only become
    // eligible after the eligible customer is assigned; removing the customer
    // would re-drop them).
    await this.recomputePromotions(sale);
    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.customer.assigned',
      new SaleCustomerAssignedEvent(
        sale.id,
        this.tenantPrisma.getTenantId() ?? '',
        userId,
        previousCustomerId,
        sale.customerId!,
        sale.shippingAddressId,
      ),
    );

    if (previousShippingAddressId !== sale.shippingAddressId) {
      if (sale.shippingAddressId) {
        this.eventEmitter.emit(
          'sale.shipping-address.set',
          new SaleShippingAddressSetEvent(
            sale.id,
            this.tenantPrisma.getTenantId() ?? '',
            userId,
            previousShippingAddressId,
            sale.shippingAddressId,
          ),
        );
      } else if (previousShippingAddressId) {
        this.eventEmitter.emit(
          'sale.shipping-address.cleared',
          new SaleShippingAddressClearedEvent(
            sale.id,
            this.tenantPrisma.getTenantId() ?? '',
            userId,
            previousShippingAddressId,
          ),
        );
      }
    }

    return this.saleRepo.findDraftResponseById(sale.id);
  }

  async clearCustomer(saleId: string, userId: string): Promise<void> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    if (!sale.customerId) {
      return;
    }

    const previousCustomerId = sale.customerId;
    const previousShippingAddressId = sale.shippingAddressId;
    sale.clearCustomer();
    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.customer.cleared',
      new SaleCustomerClearedEvent(
        sale.id,
        this.tenantPrisma.getTenantId() ?? '',
        userId,
        previousCustomerId,
        previousShippingAddressId,
      ),
    );

    if (previousShippingAddressId) {
      this.eventEmitter.emit(
        'sale.shipping-address.cleared',
        new SaleShippingAddressClearedEvent(
          sale.id,
          this.tenantPrisma.getTenantId() ?? '',
          userId,
          previousShippingAddressId,
        ),
      );
    }
  }

  async setShippingAddress(
    saleId: string,
    userId: string,
    dto: SetShippingAddressDto,
  ) {
    if (dto.shippingAddressId === null) {
      await this.clearShippingAddress(saleId, userId);
      return this.saleRepo.findDraftResponseById(saleId);
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }
    if (!sale.customerId) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
        'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
      );
    }

    const prisma = this.tenantPrisma.getClient();
    const address = await prisma.customerAddress.findUnique({
      where: { id: dto.shippingAddressId },
    });
    if (!address) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_NOT_FOUND',
        'SHIPPING_ADDRESS_NOT_FOUND',
      );
    }
    if (address.customerId !== sale.customerId) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
        'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
      );
    }

    const previousShippingAddressId = sale.shippingAddressId;
    sale.setShippingAddress(dto.shippingAddressId);
    await this.saleRepo.save(sale);

    if (
      previousShippingAddressId !== sale.shippingAddressId &&
      sale.shippingAddressId
    ) {
      this.eventEmitter.emit(
        'sale.shipping-address.set',
        new SaleShippingAddressSetEvent(
          sale.id,
          this.tenantPrisma.getTenantId() ?? '',
          userId,
          previousShippingAddressId,
          sale.shippingAddressId,
        ),
      );
    }

    return this.saleRepo.findDraftResponseById(sale.id);
  }

  async clearShippingAddress(saleId: string, userId: string): Promise<void> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    if (!sale.shippingAddressId) {
      return;
    }

    const previousShippingAddressId = sale.shippingAddressId;
    sale.setShippingAddress(null);
    await this.saleRepo.save(sale);
    this.eventEmitter.emit(
      'sale.shipping-address.cleared',
      new SaleShippingAddressClearedEvent(
        sale.id,
        this.tenantPrisma.getTenantId() ?? '',
        userId,
        previousShippingAddressId,
      ),
    );
  }

  async chargeDraft(
    saleId: string,
    actorId: string,
    dto: ChargeSaleDto,
    idempotencyKey: string,
  ) {
    const normalizedPayments = normalizeChargeRequestPayments(dto);
    const hashPayments = sortPaymentsForHash(normalizedPayments);

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          saleId,
          actorId,
          payments: hashPayments,
          dueDate: dto.dueDate ?? null,
        }),
      )
      .digest('hex');

    const idempotency = await this.saleRepo.acquireChargeIdempotency(
      saleId,
      idempotencyKey,
      requestHash,
    );
    if (idempotency.kind === 'replay') {
      return idempotency.payload as {
        saleId: string;
        folio: string;
        subtotalCents: number;
        discountCents: number;
        totalCents: number;
        paidCents: number;
        debtCents: number;
        changeDueCents: number;
        paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
        confirmedAt: string;
      };
    }
    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    return this.saleRepo.runInTransaction(async () => {
      const tenantId = this.tenantPrisma.getTenantId();
      const sale = await this.saleRepo.findByIdForUpdate(saleId);
      if (!sale) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      if (sale.userId !== actorId) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      if (sale.status !== 'DRAFT') {
        throw new BusinessRuleViolationError(
          'SALE_ALREADY_CONFIRMED',
          'SALE_ALREADY_CONFIRMED',
        );
      }

      for (const item of sale.items) {
        if (item.priceSource === 'custom') continue;

        const currentCents =
          item.priceSource === 'price_list' && item.appliedPriceListId
            ? await this.productsService.resolveListPrice(
                item.appliedPriceListId,
                item.productId,
                item.variantId,
                item.quantity,
              )
            : (
                await this.productsService.getProductInfoForSale(
                  item.productId,
                  item.variantId,
                )
              ).unitPriceCents;

        const expectedBaseCents =
          item.prePriceCentsBeforeDiscount ?? item.unitPriceCents;
        if (currentCents !== expectedBaseCents) {
          throw new BusinessRuleViolationError(
            'PRICE_OUT_OF_DATE',
            'PRICE_OUT_OF_DATE',
          );
        }
      }

      // Work Unit 5 — re-run the same engine call `addItem/qty/remove/assign`
      // already use, INSIDE the charge tx. A qty change between the last draft
      // recompute and the charge attempt can flip eligibility (date rollover,
      // customer change, etc.); the charge recompute is authoritative so the
      // charged totalCents / discountCents reflect the current state, not
      // whatever was last persisted. Reads go through the tenant+tx-scoped
      // prisma client because we are inside `runInTransaction`.
      await this.recomputePromotions(sale);

      // Work Unit 5 — inline totals use the SAME helper the draft preview
      // uses (`sale.previewTotals()`, Unit 3). This is the single source of
      // truth for `subtotalCents / discountCents / totalCents` on BOTH paths,
      // so the charged total can NEVER drift from the draft preview (C2).
      //   subtotalCents = Σ(unitPrice·qty)
      //   orderDiscountCents = appliedOrderPromotion?.discountAmountCents ?? 0
      //   totalCents = max(0, subtotalCents − orderDiscountCents)
      //   discountCents = min(subtotalCents, orderDiscountCents)
      const { subtotalCents, discountCents, totalCents } = sale.previewTotals();

      const tenderedCents = normalizedPayments.reduce(
        (acc, payment) => acc + payment.amountCents,
        0,
      );
      const hasCash = normalizedPayments.some(
        (payment) => payment.method === 'cash',
      );
      const hasCreditMethod = normalizedPayments.some(
        (payment) => payment.method === 'credit',
      );

      if (hasCreditMethod && normalizedPayments.length > 1) {
        chargeValidationError('INVALID_CREDIT_CHARGE');
      }

      if (hasCreditMethod && tenderedCents !== 0) {
        chargeValidationError('INVALID_CREDIT_CHARGE');
      }

      if (!hasCash && tenderedCents > totalCents) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (tenderedCents < 0) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (tenderedCents < totalCents && !sale.customerId) {
        chargeValidationError('CUSTOMER_REQUIRED_FOR_CREDIT');
      }

      if (
        !hasCreditMethod &&
        tenderedCents < totalCents &&
        tenderedCents <= 0 &&
        normalizedPayments.length > 0
      ) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (tenderedCents < totalCents && tenderedCents > 0 && !hasCash) {
        chargeValidationError('PAYMENT_AMOUNT_INSUFFICIENT');
      }

      const paidCents = Math.min(tenderedCents, totalCents);
      const debtCents = totalCents - paidCents;
      const paymentStatus =
        paidCents === totalCents
          ? 'PAID'
          : paidCents === 0
            ? 'CREDIT'
            : 'PARTIAL';
      const changeDueCents =
        hasCash && paymentStatus === 'PAID' ? tenderedCents - totalCents : 0;

      const canonicalPayments = toCanonicalChargePayments(normalizedPayments);

      const stockAdjustments = sale.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      }));
      // Slice E.3 — crossings return value is currently UNUSED at this
      // call site. `decrementStockForCharge` writes the durable
      // `stock.low.detected` outbox rows IN THE SAME transaction
      // (inserted via `OutboxWriterService.publish` inside
      // `PrismaProductRepository`). Slice F consumes those rows from
      // `OutboxEvent`. The returned `StockCrossing[]` is intentionally
      // discarded here — there is no post-commit work in this method
      // that consumes it.
      await this.productsService.decrementStockForCharge(stockAdjustments);

      const confirmedAt = new Date();
      const folio = await this.saleRepo.allocateNextFolio(confirmedAt);
      const dueDate = resolveDueDate(dto.dueDate, confirmedAt, paymentStatus);
      if (dueDate !== null) {
        sale.setDueDate(dueDate);
      }
      const createdPayments = await this.saleRepo.persistChargeConfirmation({
        saleId,
        userId: actorId,
        payments: canonicalPayments,
        subtotalCents,
        discountCents,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents,
        paymentStatus,
        // Forward draft-level associations explicitly so the confirmation
        // preserves them. Passing `null` for "Público en General" is the
        // intentional empty-customer case, not the destructive default.
        customerId: sale.customerId,
        sellerUserId: sale.sellerUserId,
        dueDate: sale.dueDate,
        confirmedAt,
        folio,
        // Work Unit 5 — W1 fix: the charge-time recompute may have changed
        // per-line state (promotionId / discountAmountCents / unitPriceCents)
        // since the last `save`. Persist the recomputed SaleItem rows in the
        // same tx so the audit log and the charged total stay consistent.
        items: sale.items,
        // Work Unit 5 — C2 audit: the charge-time recompute may also have
        // set / cleared / kept the applied ORDER_DISCOUNT snapshot. Passing
        // it explicitly lets the repo upsert or delete the row accordingly
        // (W1 + C2).
        appliedOrderPromotion: sale.appliedOrderPromotion,
      });

      await this.publishSaleConfirmedEvent({
        saleId,
        tenantId,
        actorId,
        folio,
        totalCents,
        paidCents,
        debtCents,
        paymentStatus,
        confirmedAt,
      });

      await this.publishPaymentReceivedEvents({
        saleId,
        tenantId,
        actorId,
        payments: createdPayments,
        paidCents,
        debtCents,
        occurredAt: confirmedAt,
      });

      if (debtCents === 0) {
        await this.publishSaleFullyPaidEvent({
          saleId,
          tenantId,
          folio,
          totalCents,
          paidAt: confirmedAt,
        });
      }

      const payload = {
        saleId,
        folio,
        subtotalCents,
        discountCents,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents,
        paymentStatus,
        confirmedAt: confirmedAt.toISOString(),
      };

      await this.saleRepo.markChargeIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );

      return payload;
    });
  }

  async cancelSale(
    saleId: string,
    actorId: string,
    dto: CancelSaleDto,
  ): Promise<CancelSaleResult> {
    const idempotencyKey = `sale:cancel:${saleId}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ saleId, actorId, reason: dto.reason }))
      .digest('hex');

    const idempotency = await this.saleRepo.acquireCancellationIdempotency(
      saleId,
      idempotencyKey,
      requestHash,
    );
    if (idempotency.kind === 'replay') {
      return idempotency.payload as CancelSaleResult;
    }
    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    return this.saleRepo.runInTransaction(async () => {
      const tenantId = this.tenantPrisma.getTenantId();
      const sale = await this.saleRepo.findByIdForUpdate(saleId);

      // Tenant isolation: findByIdForUpdate queries within the tenant-scoped
      // client — a null result means the sale does not belong to this tenant.
      // Authorization: RBAC (delete:Sale / sales:write) is enforced at the
      // controller layer. Creator-ownership is NOT an eligibility gate; any
      // authorized actor in the same tenant may cancel. actorId is still
      // recorded as canceledByUserId for audit purposes.
      if (!sale) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }

      const restockedItems = sale.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      }));

      const buildResult = (
        canceledSale: Sale,
        refundedCents: number,
      ): CancelSaleResult => ({
        saleId: canceledSale.id,
        status: 'CANCELED',
        refundedCents,
        restockedItems,
        canceledAt:
          canceledSale.canceledAt?.toISOString() ?? new Date().toISOString(),
      });

      if (sale.status === 'CANCELED') {
        const replayPayload = buildResult(
          sale,
          sale.paymentStatus === 'CREDIT' || sale.paidCents === 0
            ? 0
            : sale.paidCents,
        );

        await this.saleRepo.markCancellationIdempotencySucceeded(
          idempotency.token,
          saleId,
          replayPayload,
        );

        return replayPayload;
      }

      const { sale: canceledSale, refundedCents } = sale.cancel(dto.reason, {
        actorId,
      });

      await this.productsService.incrementStockForRestock(restockedItems);

      const detail =
        refundedCents === 0
          ? null
          : await this.saleRepo.findOneWithRelations(saleId);
      const refunds =
        refundedCents === 0
          ? []
          : buildCancellationRefunds(
              (detail?.payments ?? []).map((payment) => ({
                paymentId: payment.paymentId,
                method: payment.method,
                amountCents: payment.amountCents,
              })),
              refundedCents,
              dto.reason,
            );

      await this.saleRepo.persistCancellation(canceledSale, refunds);

      const payload = buildResult(canceledSale, refundedCents);

      await this.outboxWriter.publish(
        this.tenantPrisma.getClient(),
        tenantId,
        'Sale',
        saleId,
        'sale.canceled',
        {
          saleId,
          tenantId,
          actorId,
          folio: canceledSale.folio ?? 'N/A',
          reason: dto.reason,
          refundedCents,
          restockedItems,
          canceledAt: payload.canceledAt,
        },
      );

      await this.saleRepo.markCancellationIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );

      return payload;
    });
  }

  async confirmBotSale(
    input: ConfirmBotSaleInput,
  ): Promise<ConfirmBotSaleResult> {
    return this.saleRepo.runInTransaction(async () => {
      for (const item of input.items) {
        const applicablePrices = await this.productsService.getApplicablePrices(
          item.productId,
          item.variantId ?? null,
          item.quantity,
        );

        const hasMatchingLivePrice = applicablePrices.some(
          (candidate) => candidate.priceCents === item.unitPriceCents,
        );

        if (!hasMatchingLivePrice) {
          throw new BusinessRuleViolationError(
            'PRICE_OUT_OF_DATE',
            'PRICE_OUT_OF_DATE',
          );
        }
      }

      const tenantId = this.tenantPrisma.getTenantId();
      const saleId = randomUUID();
      const sale = Sale.create({
        id: saleId,
        userId: input.cashierUserId,
      });

      sale.assignCustomer(input.customerId, input.shippingAddressId ?? null);
      sale.assignSeller(input.cashierUserId);

      for (const item of input.items) {
        sale.addItem({
          id: randomUUID(),
          saleId,
          productId: item.productId,
          variantId: item.variantId ?? null,
          productName: item.productName,
          variantName: item.variantName ?? null,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: 'MXN',
        });
      }

      await this.saleRepo.save(sale);

      const totalCents = input.items.reduce(
        (sum, item) => sum + item.unitPriceCents * item.quantity,
        0,
      );
      const paidCents = 0 as const;
      const debtCents = totalCents;

      // Slice E.3 — crossings return value is currently UNUSED at this
      // call site. The product repository writes the durable
      // `stock.low.detected` outbox rows IN THE SAME transaction
      // (inserted via `OutboxWriterService.publish` inside
      // `PrismaProductRepository`). Slice F consumes those rows from
      // `OutboxEvent`. The returned `StockCrossing[]` is intentionally
      // discarded here — this method does not consume it.
      await this.productsService.decrementStockForCharge(
        input.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
        })),
      );

      const confirmedAt = new Date();
      const folio = await this.saleRepo.allocateNextFolio(confirmedAt);
      const dueDate = resolveDueDate(undefined, confirmedAt, 'CREDIT');

      await this.saleRepo.persistChargeConfirmation({
        saleId,
        userId: input.cashierUserId,
        payments: [],
        subtotalCents: totalCents,
        discountCents: 0,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents: 0,
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        customerId: input.customerId,
        sellerUserId: input.cashierUserId,
        dueDate,
        confirmedAt,
        folio,
      });

      await this.publishSaleConfirmedEvent({
        saleId,
        tenantId,
        actorId: input.cashierUserId,
        folio,
        totalCents,
        paidCents,
        debtCents,
        paymentStatus: 'CREDIT',
        confirmedAt,
      });

      return {
        saleId,
        folio,
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents,
        paidCents,
        debtCents,
        confirmedAt: confirmedAt.toISOString(),
      };
    });
  }

  async setDueDate(
    saleId: string,
    dto: UpdateSaleDueDateDto,
  ): Promise<SaleDetailResponseDto> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale || sale.status !== 'CONFIRMED') {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const detail = await this.saleRepo.findOneWithRelations(saleId);
    if (!detail) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    if (detail.paymentStatus === 'PAID') {
      throw new SaleFullyPaidError();
    }

    if (dto.dueDate !== null && dto.dueDate !== undefined) {
      const requestedDate = new Date(dto.dueDate);
      const todayStartOfDayUtc = new Date();
      todayStartOfDayUtc.setUTCHours(0, 0, 0, 0);

      const requestedStartOfDayUtc = new Date(requestedDate);
      requestedStartOfDayUtc.setUTCHours(0, 0, 0, 0);

      if (requestedStartOfDayUtc < todayStartOfDayUtc) {
        throw new InvalidDueDateError();
      }
    }

    sale.setDueDate(dto.dueDate ? new Date(dto.dueDate) : null);
    await this.saleRepo.save(sale);

    return this.getSaleDetail(saleId);
  }

  async assignSeller(
    saleId: string,
    actorUserId: string,
    dto: AssignSellerDto,
  ) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const seller = await this.tenantPrisma
      .getClient()
      .user.findUnique({ where: { id: dto.sellerUserId } });

    if (!seller) {
      throw new SellerNotFoundError();
    }

    const previousSellerUserId = sale.sellerUserId;
    sale.assignSeller(dto.sellerUserId);
    await this.saleRepo.save(sale);

    if (previousSellerUserId !== dto.sellerUserId) {
      this.eventEmitter.emit('sale.seller.assigned', {
        saleId: sale.id,
        tenantId: this.tenantPrisma.getTenantId() ?? '',
        userId: actorUserId,
        previousSellerUserId,
        sellerUserId: dto.sellerUserId,
      });
    }

    if (sale.status === 'DRAFT') {
      return this.saleRepo.findDraftResponseById(sale.id);
    }

    return this.getSaleDetail(sale.id);
  }

  async clearSeller(saleId: string, actorUserId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const previousSellerUserId = sale.sellerUserId;
    sale.clearSeller();
    await this.saleRepo.save(sale);

    if (previousSellerUserId !== null) {
      this.eventEmitter.emit('sale.seller.cleared', {
        saleId: sale.id,
        tenantId: this.tenantPrisma.getTenantId() ?? '',
        userId: actorUserId,
        previousSellerUserId,
      });
    }

    if (sale.status === 'DRAFT') {
      return this.saleRepo.findDraftResponseById(sale.id);
    }

    return this.getSaleDetail(sale.id);
  }

  async addPayment(
    saleId: string,
    actorId: string,
    dto: {
      method?: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';
      amountCents?: number;
      reference?: string;
      payments?: Array<{
        method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';
        amountCents: number;
        reference?: string;
      }>;
    },
    idempotencyKey: string,
    authMode: AddPaymentAuthMode = 'owner',
  ) {
    const normalizedPayments = normalizeCollectionRequestPayments(dto);
    const hashPayments = sortPaymentsForHash(
      normalizedPayments.map((payment) => ({
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference,
      })),
    );

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ saleId, actorId, payments: hashPayments }))
      .digest('hex');

    const idempotency = await this.saleRepo.acquirePaymentIdempotency(
      saleId,
      idempotencyKey,
      requestHash,
    );
    if (idempotency.kind === 'replay') {
      return idempotency.payload;
    }
    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    return this.saleRepo.runInTransaction(async () => {
      const tenantId = this.tenantPrisma.getTenantId();
      const sale = await this.saleRepo.findByIdForUpdate(saleId);
      if (!sale || (authMode === 'owner' && sale.userId !== actorId)) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      if (sale.status !== 'CONFIRMED') {
        throw new BusinessRuleViolationError(
          'SALE_NOT_CONFIRMABLE_FOR_PAYMENT',
          'SALE_NOT_CONFIRMABLE_FOR_PAYMENT',
        );
      }
      const paymentsToPersist =
        authMode === 'reviewer'
          ? normalizedPayments.map((payment) => ({
              ...payment,
              method: 'transfer' as const,
              metadataJson: {
                origin: { kind: 'bot', channel: sale.channel },
              },
            }))
          : normalizedPayments;

      const updated = await this.saleRepo.persistCollectedPayments({
        saleId,
        userId: authMode === 'reviewer' ? null : actorId,
        payments: paymentsToPersist,
      });

      const eventPayments = paymentsToPersist.map((payment, index) => ({
        paymentId: updated.paymentIds[index],
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference ?? null,
      }));

      await this.publishPaymentReceivedEvents({
        saleId,
        tenantId,
        actorId: authMode === 'reviewer' ? null : actorId,
        payments: eventPayments,
        paidCents: updated.paidCents,
        debtCents: updated.debtCents,
        occurredAt: new Date(),
        resultingPaymentStatus: updated.paymentStatus,
      });

      if (updated.debtCents === 0) {
        await this.publishSaleFullyPaidEvent({
          saleId,
          tenantId,
          folio: sale.folio ?? 'N/A',
          totalCents: updated.totalCents,
          paidAt: new Date(),
        });
      }

      const payload = {
        saleId,
        paidCents: updated.paidCents,
        debtCents: updated.debtCents,
        totalCents: updated.totalCents,
        paymentStatus: updated.paymentStatus,
        paymentIds: updated.paymentIds,
      };

      await this.saleRepo.markPaymentIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );

      return payload;
    });
  }
}
