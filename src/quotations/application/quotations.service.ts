/**
 * QuotationsService — Application layer (Use Cases) for the Quotations
 * bounded context.
 *
 * WU3 — Items + promotions + price override + expiry + cancel + engine
 * widening (context='QUOTATION'). The recompute pipeline is now wired:
 *   clear (PROMO discounts) → reprice (non-sticky lines, via ProductsService)
 *   → eval (engine, context='QUOTATION') → apply (per-line discount).
 *
 * The dependency surface here:
 *   - `IQuotationRepository`                  — domain port (DI token).
 *   - `TenantPrismaService`                   — tenant-scoped Prisma client
 *                                              for catalog lookups
 *                                              (Customer, GlobalPriceList).
 *   - `ProductsService`                       — price-list resolution
 *                                              (`batchResolvePriceMap`,
 *                                              `getProductInfoForSale`)
 *                                              and `resolvePriceListGlobalIds`
 *                                              for the engine's C1 fix.
 *   - `IPosEvaluatePromotionsUseCase`         — engine port. The service
 *                                              passes `context: 'QUOTATION'`
 *                                              on every recompute (the only
 *                                              new write that sets the
 *                                              context explicitly).
 *
 * The recompute pipeline mirrors `SalesService.recomputePricingAndPromotions`
 * exactly (clear → reprice → eval → apply) — see sales.service.ts:484 for
 * the full design contract. The two divergences are:
 *   1. The eval call passes `context: 'QUOTATION'`.
 *   2. Quotes don't carry BXGY/ADVANCED whole-line cents rewards in this
 *      slice (the engine only emits `per-unit` results for the
 *      `Quotation` aggregate — the wire discriminator is the same
 *      `kind?: 'per-unit'` default, so existing engine consumer code
 *      routes identically).
 */
import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { render } from '@react-email/components';

import { Quotation } from '../domain/quotation.entity';
import {
  type AssignCustomerInput,
  type CreateQuotationInput,
  type QuotationFindAllInput,
  type QuotationListResult,
  type SetPriceListInput,
  QUOTATION_REPOSITORY,
  IQuotationRepository,
} from '../domain/quotation.repository';
import {
  QuotationCustomerHasNoEmailError,
  QuotationHasNoItemsError,
  QuotationNotDraftError,
  QuotationNotFoundError,
} from '../domain/quotation.errors';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { QuotationResponseDto } from '../dto/quotation-response.dto';
import { ProductsService } from '../../products/products.service';
import type {
  IPosEvaluatePromotionsUseCase,
  PosEvalInput,
  PosEvalLineResult,
} from '../../promotions/application/ports/pos-evaluate-promotions.port';
import { POS_EVALUATE_PROMOTIONS_USE_CASE } from '../../promotions/application/ports/pos-evaluate-promotions.port';
import type { QuotationItem } from '../domain/quotation-item.entity';
import type { QuotationCancelReason } from '../domain/quotation.entity';
import {
  MAILER,
  type IMailer,
  type SendMailInput,
} from '../../notifications/email/mailer.port';
import { PdfGenerationService } from '../../pdf-generation/pdf-generation.service';
import {
  QuotationEmail,
  type QuotationEmailProps,
} from '../../notifications/email/templates/quotation-email';

export interface AddQuotationItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface UpdateQuotationItemQuantityInput {
  quantity: number;
}

export interface OverrideQuotationItemPriceInput {
  unitPriceCents: number;
}

export interface SetQuotationExpiryInput {
  expiresAt?: string | null;
}

export interface CancelQuotationInput {
  cancelReason: QuotationCancelReason;
}

/**
 * WU4 — Result envelope for the `send()` atomic flow. Mirrors the
 * spec scenario "Send succeeds — status flips to SENT": the response
 * payload is the wire shape with `effectiveStatus` updated, plus the
 * raw status code so the FE can route on a single typed field.
 */
export interface SendQuotationResult {
  id: string;
  status: 'SENT';
  effectiveStatus: 'SENT';
  /** Recipient address the email was sent to (null when `sendEmail=false`). */
  sentTo: string | null;
}

@Injectable()
export class QuotationsService {
  constructor(
    @Inject(QUOTATION_REPOSITORY)
    private readonly quotationRepo: IQuotationRepository,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly productsService: ProductsService,
    @Inject(POS_EVALUATE_PROMOTIONS_USE_CASE)
    private readonly posEvaluatePromotions: IPosEvaluatePromotionsUseCase,
    /**
     * WU4 — outbound email port. Only consumed by `send()`. The
     * `MAILER` token resolves to `ResendMailer` (or the dev logger
     * fallback). The adapter THROWS on Resend failure so the atomic
     * flow can rollback the SENT transition on error.
     */
    @Inject(MAILER)
    private readonly mailer: IMailer,
    /**
     * WU4 — PDF rendering port. Only consumed by `send()` (and the
     * PDF preview route). `@Optional()` so the existing service tests
     * that don't import PdfGenerationModule keep passing without a
     * second provider; production wires the module so the dependency
     * is always present.
     */
    @Optional()
    private readonly pdfService?: PdfGenerationService,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Use cases
  // ──────────────────────────────────────────────────────────────────

  /**
   * Open a new DRAFT quotation.
   *
   * When `input.customerId` is provided the service:
   *   1. Verifies the customer exists in the current tenant
   *      (else `EntityNotFoundError` → 404).
   *   2. Auto-seeds `globalPriceListId` from `customer.globalPriceListId`
   *      UNLESS the caller passed an explicit `input.globalPriceListId`
   *      (cashier's explicit choice — `priceListExplicitlySet` flips to
   *      true so a future `assignCustomer` does NOT re-seed).
   *
   * The recompute step is intentionally skipped — an empty draft has
   * no items, so there is nothing to reprice or re-evaluate.
   */
  async openDraft(
    sellerUserId: string,
    input: CreateQuotationInput = {},
  ): Promise<QuotationResponseDto> {
    let seededCustomerId: string | null = null;
    let seededPriceListId: string | null = null;
    let priceListExplicitlySet = false;

    if (input.customerId) {
      const customer = await this.findCustomerOrFail(input.customerId);
      seededCustomerId = customer.id;
      // Cashier-explicit override wins. The assignCustomer path follows
      // the same rule (entity-side `priceListExplicitlySet` guard).
      if (input.globalPriceListId) {
        seededPriceListId = input.globalPriceListId;
        priceListExplicitlySet = true;
      } else {
        seededPriceListId = customer.globalPriceListId ?? null;
        priceListExplicitlySet = false;
      }
    } else if (input.globalPriceListId) {
      // Customerless draft with an explicit list binding.
      seededPriceListId = input.globalPriceListId;
      priceListExplicitlySet = true;
    }

    const draft = Quotation.create({
      id: randomUUID(),
      sellerUserId,
      customerId: seededCustomerId ?? null,
      globalPriceListId: seededPriceListId ?? null,
    });

    if (priceListExplicitlySet && seededPriceListId !== null) {
      // Mark the cashier's explicit choice on the freshly-built entity
      // — `Quotation.create()` defaults `priceListExplicitlySet=false`.
      draft.setGlobalPriceList(seededPriceListId, true);
    }

    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Add an item to a DRAFT quotation.
   *
   * Order of operations:
   *   1. Load the draft (404 if absent in the current tenant).
   *   2. Verify the status is DRAFT (409 if not).
   *   3. Resolve product info via `ProductsService.getProductInfoForSale`
   *      (default PUBLICO price + product/variant names). The catalog
   *      lookup is the same path the POS uses for sales — shareable
   *      validation: sellInPos, hasVariants check, etc.
   *   4. Add the item to the entity (stacks when same productId +
   *      variantId already exists). priceSource = 'PRICE_LIST' so the
   *      recompute can re-resolve against the bound price list.
   *   5. Recompute (engine with context='QUOTATION').
   *   6. Persist + return the response.
   *
   * NO stock check — the spec requirement "Stock Checks Bypassed" is
   * enforced by an explicit absence of the `checkStockAvailability` call
   * the Sale equivalent uses. A quotation is a pricing promise, not a
   * stock reservation.
   */
  async addItem(
    id: string,
    input: AddQuotationItemInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    const productInfo = await this.productsService.getProductInfoForSale(
      input.productId,
      input.variantId ?? null,
    );

    draft.addItem({
      id: randomUUID(),
      quotationId: draft.id,
      productId: productInfo.productId,
      variantId: productInfo.variantId,
      productName: productInfo.productName,
      variantName: productInfo.variantName,
      quantity: input.quantity,
      unitPriceCents: productInfo.unitPriceCents,
      unitPriceCurrency: 'MXN',
      priceSource: 'PRICE_LIST',
    });

    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Update the quantity of an existing item in a DRAFT quotation.
   *
   * `quantity = 0` is rejected by the entity's `updateItemQuantity`
   * (it throws `InvalidArgumentError` because the entity's invariant
   * forbids qty < 1). The spec scenario "Quantity zero is rejected with
   * 400" maps to a `BusinessRuleViolationError` whose code is
   * `InvalidArgumentError` — the existing 400 mapping via the
   * DomainExceptionFilter applies.
   */
  async updateItemQuantity(
    id: string,
    itemId: string,
    input: UpdateQuotationItemQuantityInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.updateItemQuantity(itemId, input.quantity);
    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Remove an item from a DRAFT quotation. Triggers a recompute so the
   * remaining items re-evaluate against the new state.
   */
  async removeItem(
    id: string,
    itemId: string,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.removeItem(itemId);
    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Override the unit price of an item in a DRAFT quotation.
   *
   * Sets `priceSource = 'CUSTOM'` so subsequent recomputes skip the
   * line (it's "sticky" — the cashier's override wins). The override
   * also clears any prior per-line discount fields on the item so the
   * recompute re-applies an eligible AUTO promo on the NEW baseline
   * (matches Sale's `overrideItemPrice` contract).
   */
  async overrideItemPrice(
    id: string,
    itemId: string,
    input: OverrideQuotationItemPriceInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.overrideItemPrice(itemId, {
      priceCents: input.unitPriceCents,
      priceSource: 'CUSTOM',
      appliedPriceListId: null,
      customPriceCents: input.unitPriceCents,
    });

    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Opt in a MANUAL promotion. Rejects AUTOMATIC promotions with
   * PROMOTION_IS_NOT_MANUAL — for AUTOMATIC promos use the veto
   * endpoints (DELETE /promotions/:promoId/veto to apply,
   * POST /promotions/:promoId/veto to remove).
   */
  async applyManualPromotion(
    id: string,
    promotionId: string,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    // Guard: only MANUAL promotions can be applied through this endpoint.
    // AUTOMATIC promotions are engine-evaluated; the cashier controls them
    // via veto/opt-in, not via manual opt-in.
    await this.assertPromotionIsManual(promotionId);

    draft.optInManualPromotion(promotionId);
    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Remove a MANUAL opt-in. Idempotent — removing an id that is not
   * currently opted-in is a safe no-op. The recompute runs so any
   * per-line discount sourced from the now-removed opt-in is cleared.
   */
  async removeManualPromotion(
    id: string,
    promotionId: string,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.optOutManualPromotion(promotionId);
    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Remove an auto-applied AUTOMATIC promotion from a DRAFT quotation
   * (veto). The veto persists across recomputes (the entity's
   * `addVetoedPromotion` is idempotent and cross-clears the opt-in set
   * if the same id was previously opted-in).
   */
  async vetoPromotion(
    id: string,
    promotionId: string,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.addVetoedPromotion(promotionId);
    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Re-opt a previously vetoed promotion (reactivation). The entity's
   * `optInManualPromotion` cross-clears the veto set when the same id
   * was previously vetoed — but this method is for AUTOMATIC promos
   * (which are opt-out by default). We therefore explicitly remove the
   * id from the veto set so the engine re-evaluates the AUTO line.
   */
  async optInPromotion(
    id: string,
    promotionId: string,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.removeVetoedPromotion(promotionId);
    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Set or clear the expiry date on a DRAFT quotation. `null` clears
   * the expiry (the quotation never auto-transitions to EXPIRED).
   * The lazy EXPIRED transition happens on read via
   * `getEffectiveStatus` — `setExpiry` does NOT mutate the persisted
   * status.
   */
  async setExpiry(
    id: string,
    input: SetQuotationExpiryInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.setExpiry(
      input.expiresAt === null || input.expiresAt === undefined
        ? null
        : new Date(input.expiresAt),
    );
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Cancel a draft/sent/expired quotation. Idempotent: cancelling an
   * already-CANCELLED quotation returns the persisted instance unchanged
   * (the entity's `cancel` is idempotent on its own internal state; the
   * service short-circuits the read for spec compliance).
   */
  async cancel(
    id: string,
    input: CancelQuotationInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }

    // Idempotent: same `cancel` returns the same instance (entity-level
    // invariant). The persisted row is unchanged on a re-cancel.
    const cancelled = draft.cancel(input.cancelReason);
    const persisted = await this.quotationRepo.save(cancelled);
    return this.toResponse(persisted);
  }

  /**
   * Set or clear customer-facing notes on a DRAFT quotation.
   * Max 280 characters — enforced by the entity.
   */
  async setNotes(
    id: string,
    notes: string | null,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.setNotes(notes);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Override the tax rate for a DRAFT quotation. Rate must be between
   * 0 (exento) and 1 (e.g. 0.16 for 16%). taxCents is recomputed
   * automatically in toResponse().
   */
  async setTaxRate(
    id: string,
    rate: number,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    draft.setTaxRate(rate);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Hard-delete a quotation. Only DRAFT and CANCELLED quotations are
   * deletable — SENT and EXPIRED are permanent audit records (they were
   * already communicated to the customer).
   */
  async remove(id: string): Promise<void> {
    const quotation = await this.quotationRepo.findById(id);
    if (!quotation) {
      throw new QuotationNotFoundError(id);
    }
    if (quotation.status === 'SENT' || quotation.status === 'EXPIRED') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${quotation.status} status; only DRAFT and CANCELLED can be deleted`,
        'QUOTATION_CANNOT_DELETE',
      );
    }
    await this.quotationRepo.delete(id);
  }

  /**
   * Assign a customer to an existing DRAFT quotation.
   *
   * Order of operations:
   *   1. Load the draft (404 if absent in the current tenant).
   *   2. Verify the status is DRAFT (409 if not).
   *   3. Verify the customer exists (404 if absent).
   *   4. Seed `globalPriceListId` from the customer's default unless
   *      the cashier has already set one explicitly.
   *   5. Recompute (the price-list switch may re-tier existing items).
   *   6. Persist + return the response.
   */
  async assignCustomer(
    id: string,
    input: AssignCustomerInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    const customer = await this.findCustomerOrFail(input.customerId);

    // Auto-seed the price list — only when the cashier has NOT already
    // explicitly chosen one. The entity's `assignCustomer` enforces the
    // same invariant on the write side; the service-side pre-read here
    // is informational so we don't read the customer list twice.
    if (!draft.priceListExplicitlySet && customer.globalPriceListId) {
      draft.setGlobalPriceList(customer.globalPriceListId, false);
    }

    draft.assignCustomer(customer.id, draft.globalPriceListId);

    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Override the draft's price list.
   *
   * The unknown-list rejection is enforced here (returns
   * `BusinessRuleViolationError` → 400 — mirrors `PRICE_LIST_NOT_FOUND`);
   * on rejection we do NOT mutate the draft, so the cashier can correct
   * the payload without losing prior state.
   */
  async setPriceList(
    id: string,
    input: SetPriceListInput,
  ): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        `Quotation is in ${draft.status} status; mutation is not allowed`,
        'QUOTATION_NOT_DRAFT',
      );
    }

    if (input.globalPriceListId !== undefined && input.globalPriceListId !== null) {
      // Catalog existence check — mirrors sale.setSalePriceList but the
      // code label is `PRICE_LIST_NOT_FOUND` so the DomainExceptionFilter
      // maps to HTTP 400.
      const prisma = this.tenantPrisma.getClient();
      const exists = await prisma.globalPriceList.findUnique({
        where: { id: input.globalPriceListId },
        select: { id: true },
      });
      if (!exists) {
        throw new BusinessRuleViolationError(
          'PRICE_LIST_NOT_FOUND',
          'PRICE_LIST_NOT_FOUND',
        );
      }
    }

    draft.setGlobalPriceList(input.globalPriceListId ?? null, true);

    await this.recomputePricingAndPromotions(draft);
    const persisted = await this.quotationRepo.save(draft);
    return this.toResponse(persisted);
  }

  /**
   * Single-quotation read with the lazy EXPIRED transition.
   *
   * The transition is applied by the domain's `getEffectiveStatus`
   * (entity-level, idempotent across N reads). The wire shape keeps
   * both `status` (persisted) AND `effectiveStatus` (lazy-resolved)
   * so the FE can render the badge without re-computing.
   *
   * WU4 — also loads the assigned customer's `{id, name, email}` so
   * the PDF preview / send flow can stamp the customer's identity
   * on the rendered document without a second DB roundtrip. Null when
   * the quotation has no customer assigned.
   *
   * Tenant scoping: the repository's `findById` is tenant-scoped; a
   * cross-tenant id returns `null` which we translate to 404.
   */
  async findOne(id: string): Promise<QuotationResponseDto> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    const customer = await this.loadCustomerForWire(draft.customerId);
    return this.toResponse(draft, customer);
  }

  /**
   * Paginated list with optional filters.
   *
   * The repository handles the SQL pagination + filters
   * (status / customerId / date range + sort). The service then walks
   * every row and surfaces the lazy `effectiveStatus` on each. SENT
   * drafts whose `expiresAt` is in the past collapse to EXPIRED on
   * the wire — the upstream status filter still matches the
   * *persisted* status (so a status='EXPIRED' filter would not
   * surface expired-but-still-persisted-as-SENT rows today; that is
   * an explicit WU3 follow-up if it becomes a user need).
   */
  async findAll(input: QuotationFindAllInput): Promise<QuotationListResult> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));

    const { data, total } = await this.quotationRepo.findAll({
      page,
      limit,
      status: input.status,
      customerId: input.customerId,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      sortBy: input.sortBy ?? 'createdAt',
      sortOrder: input.sortOrder ?? 'desc',
    });

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    // WU4 — batch-load each row's customer (or null) so the list
    // surface mirrors the single-quotation detail. The set is
    // typically small (one customer per quotation by design) so the
    // batch `findMany` is cheap; if the same customer shows up on N
    // rows the map dedupes them implicitly via the cache.
    const customerCache = new Map<
      string,
      | {
          id: string;
          firstName: string;
          lastName: string | null;
          email: string | null;
        }
      | null
    >();
    const loadCustomerCached = async (customerId: string | null) => {
      if (!customerId) return null;
      if (customerCache.has(customerId)) {
        return customerCache.get(customerId) ?? null;
      }
      const customer = await this.loadCustomerForWire(customerId);
      customerCache.set(customerId, customer);
      return customer;
    };

    const enriched = await Promise.all(
      data.map(async (d) =>
        this.toResponse(d, await loadCustomerCached(d.customerId)),
      ),
    );

    return {
      data: enriched,
      pagination: { page, limit, total, totalPages },
    };
  }

  /**
   * WU4 — Send a quotation (atomic PDF render + email + SENT transition).
   *
   * This is the ONLY gate to `SENT` status (per spec scenario "Send
   * is the only gate to SENT"). The flow is:
   *
   *   1. Load the DRAFT quotation (404 if missing in tenant).
   *   2. Validate `status === 'DRAFT'` — otherwise 409.
   *   3. Validate `items.length >= 1` — otherwise 422
   *      `QUOTATION_HAS_NO_ITEMS`.
   *   4. If `sendEmail === true`: validate the customer has an email —
   *      otherwise 422 `QUOTATION_CUSTOMER_HAS_NO_EMAIL`.
   *   5. Render the PDF to a Buffer (in-memory).
   *   6. If `sendEmail === true`: render the React Email HTML and call
   *      `MAILER.send({ to, subject, html, attachments })`.
   *   7. ONLY if every step above succeeds: call `quotation.send()`
   *      → status='SENT', then `repo.save(sent)`.
   *
   * On Resend failure (the mailer throws) the flow aborts BEFORE the
   * SENT transition — the persisted quotation stays DRAFT and the
   * caller sees a `ServiceUnavailableException` (502).
   *
   * Why we render the PDF BEFORE the SENT flip:
   *   - Symmetric to the spec data flow (design.md §send-and-pdf):
   *     render → mailer → SENT. The renderer can throw (yoga-layout
   *     blowup, missing font) and we want the entity to stay DRAFT.
   *   - The alternative — flip to SENT first, then send the email —
   *     would leave a SENT quotation whose PDF was never delivered,
   *     contradicting the spec's atomicity requirement.
   *
   * Why we keep `sendEmail=false` as a valid call path:
   *   - Future FE workflows might want a "finalize" path that doesn't
   *     trigger an outbound email (e.g. a sales rep who delivers the
   *     PDF in person). The status transition is identical; only the
   *     mailer call is skipped.
   *
   * @returns `{ id, status: 'SENT', effectiveStatus: 'SENT', sentTo }`
   */
  async send(
    id: string,
    sendEmail: boolean = true,
  ): Promise<SendQuotationResult> {
    const draft = await this.quotationRepo.findById(id);
    if (!draft) {
      throw new QuotationNotFoundError(id);
    }
    if (draft.status !== 'DRAFT') {
      // The domain `QuotationNotDraftError` is the canonical carrier
      // for the 409 contract — mapped to HTTP 409 by the
      // DomainExceptionFilter (`BusinessRuleViolationError` → 409).
      throw new QuotationNotDraftError(draft.status);
    }
    if (draft.items.length === 0) {
      throw new QuotationHasNoItemsError(id);
    }

    // Load the assigned customer — we need name + email for the
    // email body + recipient list. Resolved AFTER the status guard
    // so an unrenderable draft doesn't pay the customer roundtrip.
    const customer = await this.loadCustomerForWire(draft.customerId);

    if (sendEmail) {
      if (!customer || !customer.email) {
        throw new QuotationCustomerHasNoEmailError(id);
      }
    }

    if (!this.pdfService) {
      // Defense-in-depth — the module imports PdfGenerationModule so
      // this branch is unreachable in production. A misconfigured test
      // graph that forgets to wire the service gets a clean 500.
      throw new ServiceUnavailableException(
        'PDF_GENERATION_UNAVAILABLE',
      );
    }

    // Build the wire DTO once — both the PDF renderer and the email
    // template consume the same view (customer snapshot, totals,
    // items). Building it here keeps the contract honest: a single
    // snapshot drives both downstream calls.
    const draftResponse = draft.toResponse();
    const wireDto: import('../dto/quotation-response.dto').QuotationResponseDto = {
      ...draftResponse,
      customer,
      effectiveStatus: draft.getEffectiveStatus(),
    } as import('../dto/quotation-response.dto').QuotationResponseDto;

    // Step 5: render the PDF in-memory. Failure here surfaces as a
    // 500 (InternalServerErrorException inside PdfGenerationService).
    // The entity is NOT yet touched, so the status stays DRAFT.
    const pdfBuffer = await this.pdfService.renderQuotationPdfToBuffer(
      wireDto,
      'quotation-a4',
    );

    // Step 6: send the email (if requested). The mailer THROWS on
    // Resend failure — we wrap the throw in a 502-mappable
    // ServiceUnavailableException so the FE can branch on the
    // HTTP status code without parsing the upstream error string.
    let sentTo: string | null = null;
    if (sendEmail && customer?.email) {
      try {
        const mailInput = await this.buildQuotationMailInput({
          customer,
          draftResponse: wireDto,
          pdfBuffer,
        });
        await this.mailer.send(mailInput);
        sentTo = customer.email;
      } catch (err) {
        // The persisted quotation is still DRAFT — we never
        // reached the SENT flip below. Surface a 502 with the
        // upstream error message so the FE can prompt the
        // cashier to retry.
        throw new ServiceUnavailableException(
          `QUOTATION_EMAIL_SEND_FAILED: ${(err as Error).message}`,
        );
      }
    }

    // Step 7: flip to SENT and persist. The atomicity guarantee
    // lives here: the email has already been delivered (or skipped)
    // before this transition, so a failure above keeps the entity
    // in DRAFT.
    const sent = draft.send();
    const persisted = await this.quotationRepo.save(sent);

    return {
      id: persisted.id,
      status: 'SENT',
      effectiveStatus: 'SENT',
      sentTo,
    };
  }

  /**
   * WU4 — Compose the `SendMailInput` for the quotation email. Side-
   * effect-free so the unit tests can pin the subject + attachment
   * shape without booting the renderer or the mailer.
   *
   * Subject: `Cotización #XXXX — [Business Name]` (short id, uppercased
   * for inbox readability — full UUID is in the body).
   *
   * Attachment: the rendered PDF as `application/pdf` base64, named
   * `cotizacion-{shortId}.pdf` so the recipient downloads a stable,
   * recognizable filename.
   */
  private async buildQuotationMailInput(args: {
    customer: {
      id: string;
      firstName: string;
      lastName: string | null;
      email: string | null;
    };
    draftResponse: QuotationResponseDto;
    pdfBuffer: Buffer;
  }): Promise<SendMailInput> {
    const { customer, draftResponse, pdfBuffer } = args;
    const shortId = draftResponse.id.slice(0, 8).toUpperCase();
    const fullName = [customer.firstName, customer.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    const emailProps: QuotationEmailProps = {
      businessName: 'HoundFe',
      quotationId: draftResponse.id,
      quotationDate:
        draftResponse.createdAt instanceof Date
          ? draftResponse.createdAt.toISOString()
          : new Date(draftResponse.createdAt).toISOString(),
      itemCount: draftResponse.items.length,
      totalFormatted: formatCurrency(draftResponse.totalCents),
      expiresAtIso: draftResponse.expiresAt
        ? draftResponse.expiresAt instanceof Date
          ? draftResponse.expiresAt.toISOString()
          : new Date(draftResponse.expiresAt).toISOString()
        : null,
      customerName: fullName || null,
      sellerName: draftResponse.sellerUserId,
    };

    return {
      to: customer.email ? [customer.email] : [],
      subject: `Cotización #${shortId} — HoundFe`,
      html: await render(QuotationEmail(emailProps)),
      attachments: [
        {
          filename: `cotizacion-${shortId}.pdf`,
          content: pdfBuffer.toString('base64'),
          contentType: 'application/pdf',
        },
      ],
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal — recompute pipeline (clear → reprice → eval → apply)
  // ──────────────────────────────────────────────────────────────────

  /**
   * WU3 — Promotion engine recompute. Pipeline mirrors the Sale
   * equivalent (`sales.service.ts:484`) with the engine context set to
   * `'QUOTATION'`:
   *
   *   1. Clear PROMO-sourced discounts on items. Manual free-form
   *      discounts are flagged by `promotionId === null` and PRESERVED
   *      by the `removeDiscount()` skip — same rule Sale uses.
   *   2. Reprice non-sticky lines tier-aware via
   *      `ProductsService.batchResolvePriceMap`. Lines with
   *      `priceSource === 'CUSTOM'` are SKIPPED (sticky). Lines without
   *      a resolvable price list fallback to the default PUBLICO list.
   *   3. Build `PosEvalInput` from the REPRICED item state. Pass
   *      `context: 'QUOTATION'` so the engine sees the new forward-
   *      looking discriminant.
   *   4. Call the engine (`posEvaluatePromotions.evaluate(input)`).
   *   5. Apply each per-line engine result via `item.applyDiscount`.
   *      BXGY/ADVANCED whole-line rewards are not on the quotation
   *      surface in this slice (the engine emits identical per-unit
   *      results for both contexts), so the WU3 path routes ALL
   *      `lineResults` through the per-unit `applyDiscount` branch.
   *
   * Idempotency: called twice in a row with no mutations between
   * yields byte-identical items, totals, and applied state. The
   * clear/reprice/apply loop is convergent on every line because the
   * input to the engine is rebuilt from the entity's current state
   * AND the entity's discount fields are CLEARED before the engine
   * reads them.
   */
  private async recomputePricingAndPromotions(
    draft: Quotation,
  ): Promise<void> {
    // (1) Clear prior PROMO-sourced discounts. Manual free-form
    //     discounts (promotionId === null) are skipped.
    for (const item of draft.items) {
      if (item.promotionId != null) {
        item.removeDiscount();
      }
    }

    // (2) Reprice non-sticky lines (PRICE_LIST source) via the
    //     ProductsService batch resolver. CUSTOM lines are sticky and
    //     are SKIPPED — the cashier's override wins.
    await this.repriceNonStickyLines(draft);

    // (3) Build the engine input + (4) call the engine.
    const result = await this.evaluatePromotions(draft);

    // (5) Apply each per-line result. WU3 narrows the engine's
    //     discriminated union to the per-unit branch only — BXGY and
    //     ADVANCED whole-line rewards are not on the quotation surface
    //     in this slice.
    for (const lineResult of result.lines) {
      const item = draft.items.find((i) => i.id === lineResult.itemId);
      if (!item) continue;
      this.applyLineResultToItem(item, lineResult);
    }

    // (6) Self-heal: prune opted-in MANUAL promos whose target is gone
    //     (mirrors Sale's sales.service.ts:621 Layer B fix). Quotes
    //     don't have a sale-level ORDER_DISCOUNT snapshot, so the
    //     pruning is the only post-apply mutation.
    const targetableSet = new Set(result.targetableManualPromotionIds);
    const currentOptIns = draft.optedInManualPromotionIds;
    for (const promotionId of currentOptIns) {
      if (!targetableSet.has(promotionId)) {
        draft.optOutManualPromotion(promotionId);
      }
    }
  }

  /**
   * WU3 — Tier-aware repricing loop on non-sticky lines. Mirrors
   * `SalesService.repriceNonStickyLines` (sales.service.ts:674) but
   * for the quotation aggregate.
   *
   * A line is "sticky" (SKIPPED) iff `priceSource === 'CUSTOM'`. The
   * engine's `applyDiscount` path operates on the post-reprice
   * `unitPriceCents` so the manual-free-form discount shape is
   * preserved (the Sale equivalent also has a `hasManualDiscount` gate
   * — quotations don't carry manual free-form discounts in this slice,
   * so the gate is omitted).
   */
  private async repriceNonStickyLines(draft: Quotation): Promise<void> {
    const nonStickyInputs: Array<{
      productId: string;
      variantId: string | null;
      priceListId: string;
      quantity: number;
      globalPriceListId?: string;
    }> = [];

    const effectiveGlobalListId =
      draft.globalPriceListId ?? (await this.resolveDefaultGlobalPriceListId());

    for (const item of draft.items) {
      if (item.priceSource === 'CUSTOM') continue;
      const effectiveListId = item.appliedPriceListId ?? effectiveGlobalListId;
      if (effectiveListId === null) continue;
      nonStickyInputs.push({
        productId: item.productId,
        variantId: item.variantId,
        priceListId: effectiveListId,
        quantity: item.quantity,
        globalPriceListId:
          effectiveListId === effectiveGlobalListId &&
          effectiveGlobalListId !== null
            ? effectiveGlobalListId
            : undefined,
      });
    }

    if (nonStickyInputs.length === 0) return;

    const tierMap =
      await this.productsService.batchResolvePriceMap(nonStickyInputs);

    for (const item of draft.items) {
      if (item.priceSource === 'CUSTOM') continue;
      const effectiveListId = item.appliedPriceListId ?? effectiveGlobalListId;
      if (effectiveListId === null) continue;
      const key = `${item.productId}::${
        item.variantId ?? ''
      }::${effectiveListId}`;
      const inner = tierMap.get(key);
      if (!inner) continue;
      const resolvedCents = inner.get(item.quantity);
      if (resolvedCents === undefined) continue;
      item.reprice({
        priceCents: resolvedCents,
        priceSource: 'PRICE_LIST',
        appliedPriceListId: item.appliedPriceListId,
      });
    }
  }

  /**
   * Returns the id of the default GlobalPriceList (isDefault=true).
   * Mirrors `SalesService.resolveDefaultGlobalPriceListId`. When no
   * default exists, the caller falls back to a null list (the batch
   * resolver omits null-list entries from the map).
   */
  private async resolveDefaultGlobalPriceListId(): Promise<string | null> {
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Non-mutating engine call: builds the `PosEvalInput` from the draft
   * state and runs the engine. Mirrors
   * `SalesService.evaluatePromotionsForSale` (sales.service.ts:638) but
   * wires the C1 price-list resolution + the category/brand resolver
   * for the engine's `matchTargetTier` PRE-pass.
   *
   * WU3 — passes `context: 'QUOTATION'` on the wire. The engine treats
   * both contexts identically in this slice.
   */
  private async evaluatePromotions(draft: Quotation) {
    const input = await this.buildPosEvalInput(draft);
    return this.posEvaluatePromotions.evaluate(input);
  }

  /**
   * Build `PosEvalInput` from the current draft state. The
   * `effectiveUnitPriceCents` is the post-reprice `unitPriceCents`
   * (no prePriceBXGY column on quotations — the round-trip is a
   * direct read; the engine's per-unit `applyDiscount` rewrites
   * `unitPriceCents` to the NET price).
   *
   * The `categoryId` / `brandId` fields are batch-resolved once per
   * recompute via `ProductsService.resolveProductCategoryBrandIds` —
   * same pattern as Sale.
   */
  private async buildPosEvalInput(draft: Quotation): Promise<PosEvalInput> {
    const distinctPriceListIds = [
      ...new Set(
        draft.items
          .map((item) => item.appliedPriceListId)
          .filter((id): id is string => id != null && id !== ''),
      ),
    ];
    const priceListGlobalIdMap =
      distinctPriceListIds.length > 0
        ? await this.productsService.resolvePriceListGlobalIds(
            distinctPriceListIds,
          )
        : new Map<string, string>();

    const distinctProductIds = [
      ...new Set(
        draft.items
          .map((item) => item.productId)
          .filter((id): id is string => id != null && id !== ''),
      ),
    ];
    const productCategoryBrandMap =
      distinctProductIds.length > 0
        ? await this.productsService.resolveProductCategoryBrandIds(
            distinctProductIds,
          )
        : new Map<
            string,
            { categoryId: string | null; brandId: string | null }
          >();

    return {
      now: new Date(),
      customerId: draft.customerId,
      lines: draft.items.map((item) => {
        const resolved = productCategoryBrandMap.get(item.productId);
        return {
          itemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          effectiveUnitPriceCents: item.unitPriceCents,
          appliedPriceListId: item.appliedPriceListId,
          appliedGlobalPriceListId:
            item.appliedPriceListId != null
              ? (priceListGlobalIdMap.get(item.appliedPriceListId) ?? null)
              : null,
          categoryId: resolved?.categoryId ?? null,
          brandId: resolved?.brandId ?? null,
          hasManualDiscount: false, // quotations don't carry manual free-form discounts in this slice
        };
      }),
      vetoedPromotionIds: draft.vetoedPromotionIds,
      optedInManualPromotionIds: draft.optedInManualPromotionIds,
      context: 'QUOTATION',
    };
  }

  /**
   * WU3 — Per-line result applier. The engine emits a discriminated
   * union; for the QUOTATION context we only consume the per-unit
   * `PRODUCT_DISCOUNT` shape (BXGY/ADVANCED whole-line rewards are not
   * on the quotation surface in this slice). The discriminated
   * `kind?: 'per-unit'` default keeps the existing engine consumer
   * working without changing the engine.
   */
  private applyLineResultToItem(
    item: QuotationItem,
    lineResult: PosEvalLineResult,
  ): void {
    if (
      lineResult.kind === 'buy-x-get-y' ||
      lineResult.kind === 'advanced'
    ) {
      // BXGY/ADVANCED emissions are not on the QUOTATION surface in this
      // slice. The engine still emits the same shape (the QUOTATION
      // context is a forward-looking gate) — silently skip rather than
      // throw to keep the recompute idempotent.
      return;
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

  // ──────────────────────────────────────────────────────────────────
  // Internal — helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Catalog-side guard for `assignCustomer` and `openDraft({customerId})`.
   * We only need two columns (`id`, `globalPriceListId`); reading them
   * directly avoids forcing a `CustomersService` dependency into the
   * service module just for one lookup. The throw maps to 404 via
   * `EntityNotFoundError`.
   */
  private async findCustomerOrFail(
    customerId: string,
  ): Promise<{ id: string; globalPriceListId: string | null }> {
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, globalPriceListId: true },
    });
    if (!row) {
      throw new EntityNotFoundError('Customer', customerId);
    }
    return {
      id: row.id,
      globalPriceListId: row.globalPriceListId ?? null,
    };
  }

  /**
   * Assert the promotion exists and has `method: 'MANUAL'`. Throws
   * `BusinessRuleViolationError` with code `PROMOTION_IS_NOT_MANUAL`
   * when the caller tries to manually opt-in an AUTOMATIC promotion —
   * AUTOMATIC promos are controlled via veto/opt-in endpoints.
   */
  private async assertPromotionIsManual(promotionId: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const promo = await prisma.promotion.findUnique({
      where: { id: promotionId },
      select: { id: true, method: true },
    });
    if (!promo) {
      throw new EntityNotFoundError('Promotion', promotionId);
    }
    if (promo.method !== 'MANUAL') {
      throw new BusinessRuleViolationError(
        `Promotion ${promotionId} is method=${promo.method}, not MANUAL. Use veto/opt-in endpoints for AUTOMATIC promotions.`,
        'PROMOTION_IS_NOT_MANUAL',
      );
    }
  }

  /**
   * Domain → wire shape. Enriches the entity's own `toResponse()` with
   * the lazy `effectiveStatus` so callers don't have to recompute. The
   * entity carries the persisted status verbatim; the lazy field is a
   * pure view-only addition.
   *
   * WU4 — also threads the customer snapshot through. The repository
   * returns the entity without the customer row (to keep the
   * `findById` aggregate lean), so the service does a single
   * `findUnique` per read here. The PDF preview + send flow consume
   * `customer.email` directly from the wire shape.
   */
  private toResponse(
    draft: Quotation,
    customer: {
      id: string;
      firstName: string;
      lastName: string | null;
      email: string | null;
    } | null = null,
  ): QuotationResponseDto {
    const wire = draft.toResponse();
    return {
      ...wire,
      effectiveStatus: draft.getEffectiveStatus(),
      customer,
    } as QuotationResponseDto;
  }

  /**
   * WU4 — Lookup helper for the wire `customer` field. Returns null
   * when the quotation has no customer assigned. Returns the snapshot
   * `{ id, firstName, lastName, email }` when assigned — the email
   * rides along so the PDF preview / send flow can stamp the
   * recipient address on the rendered document.
   *
   * The wire surface uses `firstName` + `lastName` (the Customer
   * schema splits them, no `name` column). Consumers that need a
   * single display name compose `${firstName} ${lastName}` at the
   * presentation boundary (PDF template + email template).
   *
   * Reads from the same tenant-scoped Prisma client the rest of the
   * service uses, so the cross-tenant guard is implicit.
   */
  private async loadCustomerForWire(
    customerId: string | null,
  ): Promise<
    | { id: string; firstName: string; lastName: string | null; email: string | null }
    | null
  > {
    if (!customerId) return null;
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName ?? null,
      email: row.email ?? null,
    };
  }
}

/**
 * Format cents as a fixed-decimal currency string (`$X.XX`). Mirrors
 * the helper in the PDF templates — duplicated here (not shared via
 * the PDF module) because the email body and the PDF render are two
 * independent consumers; hoisting would require a shared "utils"
 * module that neither context currently owns. If a third consumer
 * appears the helpers should converge.
 */
function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}
