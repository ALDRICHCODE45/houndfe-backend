/**
 * quotation-sale-conversion / T1 — the POS "Pedido" tab use cases (S1-S7).
 *
 *   createFromSaleDraft — POS DRAFT sale → DRAFT quotation, then the draft
 *                         sale is DISCARDED in the same transaction (S2, S3).
 *   convertToSale       — DRAFT / SENT quotation → POS DRAFT sale at the
 *                         QUOTED prices and discounts; the quotation becomes
 *                         CONVERTED_TO_SALE linked to the sale (S4-S6).
 *
 * Both run in ONE tenant-scoped interactive transaction:
 *
 *   1. Idempotency slot (`sale_idempotency`, own operation namespace).
 *      Same key + same request → the stored response is replayed; same key
 *      + different request → IDEMPOTENCY_KEY_CONFLICT; a concurrent holder
 *      of the key → wait, then replay (or IDEMPOTENCY_KEY_IN_FLIGHT).
 *   2. `FOR UPDATE` lock on the source row (sale / quotation) — concurrent
 *      converters of the same document serialize here, and the loser
 *      re-reads the committed state (ALREADY_CONVERTED / SALE_NOT_FOUND).
 *   3. Domain guards, line validation, writes, CAS, response.
 *   4. The slot is stamped SUCCEEDED with the response in the same
 *      transaction; any rejection rolls everything back, slot included, so
 *      the same key can be retried after fixing the cause.
 *
 * The response is JSON-normalized before it is returned so the first call
 * and every replay are byte-identical (dates are ISO strings in both).
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';
import {
  IQuotationRepository,
  QUOTATION_REPOSITORY,
} from '../domain/quotation.repository';
import { Quotation } from '../domain/quotation.entity';
import {
  type ConversionLineProblem,
  QuotationAlreadyConvertedError,
  QuotationLinesUnavailableError,
  QuotationNotFoundError,
  SaleLinesUnavailableError,
  SaleNotDiscardableError,
} from '../domain/quotation.errors';
import {
  computeDroppedSaleAdjustments,
  type DroppedSaleAdjustment,
  mapQuotationLineToSaleLine,
  mapSaleLineToQuotationLine,
} from '../domain/quotation-sale-conversion.mapper';
import type { QuotationResponseDto } from '../dto/quotation-response.dto';
import { QuotationsService } from './quotations.service';
import { PrismaQuotationSaleConversionStore } from '../infrastructure/prisma-quotation-sale-conversion.store';
import {
  ISaleRepository,
  SALE_REPOSITORY,
} from '../../sales/domain/sale.repository';
import type { Sale } from '../../sales/domain/sale.entity';
import { SalesService } from '../../sales/sales.service';
import { ProductsService } from '../../products/products.service';
import type { QuotationIvaRateClassification } from '../domain/quotation-tax.types';

export interface CreateQuotationFromSaleInput {
  /** Customer-facing notes for the new quotation (sales have no notes). */
  customerNotes?: string | null;
}

export interface CreateQuotationFromSaleResult {
  quotation: QuotationResponseDto;
  /** The POS draft sale that was deleted (S3). */
  discardedSaleId: string;
  /** Sale adjustments the quotation model cannot carry (see mapper). */
  droppedAdjustments: DroppedSaleAdjustment[];
}

export type ConvertedSaleResponse = ReturnType<Sale['toResponse']>;

export interface ConvertQuotationToSaleResult {
  quotation: QuotationResponseDto;
  /** The new POS DRAFT sale (`quotationId` set). */
  sale: ConvertedSaleResponse;
}

interface CatalogLine {
  productName: string;
  variantName: string | null;
  imageUrl: string | null;
  ivaRate: QuotationIvaRateClassification;
  chargeProductTaxes: boolean;
}

interface LineToValidate {
  lineId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
}

@Injectable()
export class QuotationSaleConversionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(QUOTATION_REPOSITORY)
    private readonly quotationRepo: IQuotationRepository,
    @Inject(SALE_REPOSITORY)
    private readonly saleRepo: ISaleRepository,
    private readonly quotationsService: QuotationsService,
    private readonly salesService: SalesService,
    private readonly productsService: ProductsService,
    private readonly store: PrismaQuotationSaleConversionStore,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  // Sale DRAFT → quotation (S2, S3)
  // ──────────────────────────────────────────────────────────────────

  async createFromSaleDraft(
    saleId: string,
    actorUserId: string,
    input: CreateQuotationFromSaleInput,
    idempotencyKey: string,
  ): Promise<CreateQuotationFromSaleResult> {
    const customerNotes = input.customerNotes ?? null;
    const requestHash = hashRequest({ saleId, customerNotes });

    return this.tenantPrisma.runInTransaction(async () => {
      const slot = await this.acquire(
        'quotation_from_sale',
        idempotencyKey,
        requestHash,
      );
      if (slot.kind === 'replay') {
        return slot.payload as CreateQuotationFromSaleResult;
      }

      // Lock FIRST, then read: a concurrent conversion of the same draft
      // waits here and then sees it gone (SALE_NOT_FOUND).
      const sale = await this.saleRepo.findByIdForUpdate(saleId);
      if (!sale) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      // Same ownership rule as `DELETE /sales/drafts/:id` (the discard IS
      // a delete): POS drafts belong to the cashier who opened them.
      if (sale.userId !== actorUserId) {
        throw new BusinessRuleViolationError(
          'SALE_UPDATE_FORBIDDEN',
          'SALE_UPDATE_FORBIDDEN',
        );
      }
      sale.ensureDraft();
      if (sale.items.length === 0) {
        throw new SaleNotDiscardableError('SALE_HAS_NO_ITEMS', sale.id);
      }
      const blocker = await this.store.findSaleDiscardBlocker(sale.id);
      if (blocker) {
        throw new SaleNotDiscardableError(blocker, sale.id);
      }

      // Catalog facts for every line (names + the IVA snapshot pair). A
      // line whose product can no longer be quoted rejects the whole call.
      const catalog = await this.loadCatalog(
        sale.items.map((item) => ({
          lineId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
        })),
        { checkStock: false },
      );
      if (catalog.problems.length > 0) {
        throw new SaleLinesUnavailableError(catalog.problems);
      }

      const draft = Quotation.create({
        id: randomUUID(),
        sellerUserId: sale.sellerUserId ?? actorUserId,
        customerId: sale.customerId,
        globalPriceListId: sale.globalPriceListId,
      });
      draft.setGlobalPriceList(
        sale.globalPriceListId,
        sale.priceListExplicitlySet,
      );
      for (const item of sale.items) {
        const line = mapSaleLineToQuotationLine(item);
        const facts = catalog.byLineId.get(item.id)!;
        draft.addItem({
          id: randomUUID(),
          quotationId: draft.id,
          productId: line.productId,
          variantId: line.variantId,
          productName: facts.productName,
          variantName: facts.variantName,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          unitPriceCurrency: 'MXN',
          priceSource: line.priceSource,
          appliedPriceListId: line.appliedPriceListId,
          customPriceCents: line.customPriceCents,
          ivaRateClassification: facts.ivaRate,
          chargeProductTaxesSnapshot: facts.chargeProductTaxes,
        });
      }
      for (const promotionId of sale.vetoedPromotionIds) {
        draft.addVetoedPromotion(promotionId);
      }
      for (const promotionId of sale.optedInManualPromotionIds) {
        draft.optInManualPromotion(promotionId);
      }
      draft.setNotes(customerNotes);

      // Same pipeline as every quotation draft mutation: current list /
      // tier price, promotions (context QUOTATION), per-line IVA snapshot.
      await this.quotationsService.recomputeConvertedDraft(draft);
      const persisted = await this.quotationRepo.save(draft);

      const droppedAdjustments = computeDroppedSaleAdjustments({
        saleLines: sale.items,
        appliedOrderPromotion: sale.appliedOrderPromotion,
        quotationLines: persisted.items,
      });

      // S3 — discard the draft (tenant-qualified, re-checks DRAFT under the
      // lock this transaction already holds). Lines / promo rows cascade.
      await this.saleRepo.delete(sale.id);

      const result = normalize<CreateQuotationFromSaleResult>({
        quotation: await this.quotationsService.toWireResponse(persisted),
        discardedSaleId: sale.id,
        droppedAdjustments,
      });
      // The sale row is gone: the slot keeps no FK to it.
      await this.store.markIdempotencySucceeded(slot.token, null, result);
      return result;
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Quotation → sale DRAFT (S4, S5, S6)
  // ──────────────────────────────────────────────────────────────────

  async convertToSale(
    quotationId: string,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<ConvertQuotationToSaleResult> {
    const requestHash = hashRequest({ quotationId });

    return this.tenantPrisma.runInTransaction(async () => {
      const slot = await this.acquire(
        'quotation_to_sale',
        idempotencyKey,
        requestHash,
      );
      if (slot.kind === 'replay') {
        return slot.payload as ConvertQuotationToSaleResult;
      }

      if (!(await this.store.lockQuotation(quotationId))) {
        throw new QuotationNotFoundError(quotationId);
      }
      const quotation = await this.quotationRepo.findById(quotationId);
      if (!quotation) {
        throw new QuotationNotFoundError(quotationId);
      }
      const now = new Date();
      // S6 — DRAFT / SENT only; EXPIRED (persisted or lazy), CANCELLED and
      // already-converted are rejected with their own codes.
      quotation.assertConvertibleToSale(now);

      // S5 — every line must still be sellable in the POS with enough
      // stock (the same rules `POST /sales/drafts/:id/items` enforces).
      const catalog = await this.loadCatalog(
        quotation.items.map((item) => ({
          lineId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
        })),
        { checkStock: true },
      );
      if (catalog.problems.length > 0) {
        throw new QuotationLinesUnavailableError(catalog.problems);
      }

      const titles = await this.store.findPromotionTitles(
        quotation.items
          .map((item) => item.promotionId)
          .filter((id): id is string => id !== null),
      );
      const created = await this.salesService.openDraftFromQuotation({
        userId: actorUserId,
        customerId: quotation.customerId,
        sellerUserId: quotation.sellerUserId,
        globalPriceListId: quotation.globalPriceListId,
        priceListExplicitlySet: quotation.priceListExplicitlySet,
        vetoedPromotionIds: quotation.vetoedPromotionIds,
        lines: quotation.items.map((item) => {
          const facts = catalog.byLineId.get(item.id)!;
          return mapQuotationLineToSaleLine(item, {
            productName: facts.productName,
            variantName: facts.variantName,
            imageUrl: facts.imageUrl,
            promotionTitle: item.promotionId
              ? (titles.get(item.promotionId) ?? null)
              : null,
            now,
          });
        }),
      });

      const flipped = await this.store.markQuotationConverted(
        quotation.id,
        created.id,
        now,
      );
      if (!flipped) {
        // Unreachable while the row lock is held; defense in depth.
        throw new QuotationAlreadyConvertedError(
          quotation.id,
          quotation.convertedSaleId,
        );
      }

      const [converted, sale] = await Promise.all([
        this.quotationRepo.findById(quotation.id),
        this.saleRepo.findById(created.id),
      ]);
      const result = normalize<ConvertQuotationToSaleResult>({
        quotation: await this.quotationsService.toWireResponse(converted!),
        sale: sale!.toResponse(),
      });
      await this.store.markIdempotencySucceeded(slot.token, created.id, result);
      return result;
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────────────────────

  private async acquire(
    operation: 'quotation_from_sale' | 'quotation_to_sale',
    key: string,
    requestHash: string,
  ): Promise<
    { kind: 'acquired'; token: string } | { kind: 'replay'; payload: unknown }
  > {
    const outcome = await this.store.acquireIdempotency(
      operation,
      key,
      requestHash,
    );
    if (outcome.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (outcome.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }
    return outcome;
  }

  /**
   * Resolve catalog facts for every line and collect EVERY problem (not
   * just the first) so the FE can tell the seller which lines to fix.
   * Uses the POS catalog rules (`getProductInfoForSale`: exists, sellable in
   * POS, variant shape) and, when asked, the POS stock check.
   */
  private async loadCatalog(
    lines: ReadonlyArray<LineToValidate>,
    options: { checkStock: boolean },
  ): Promise<{
    byLineId: Map<string, CatalogLine>;
    problems: ConversionLineProblem[];
  }> {
    const byLineId = new Map<string, CatalogLine>();
    const problems: ConversionLineProblem[] = [];

    for (const line of lines) {
      const problem = (
        reason: ConversionLineProblem['reason'],
        availableQuantity: number | null = null,
      ): ConversionLineProblem => ({
        lineId: line.lineId,
        productId: line.productId,
        variantId: line.variantId,
        productName: line.productName,
        variantName: line.variantName,
        reason,
        requestedQuantity: line.quantity,
        availableQuantity,
      });

      let info: Awaited<ReturnType<ProductsService['getProductInfoForSale']>>;
      try {
        info = await this.productsService.getProductInfoForSale(
          line.productId,
          line.variantId,
        );
      } catch (err) {
        if (err instanceof EntityNotFoundError) {
          problems.push(
            problem(
              /Variant/.test(err.message)
                ? 'VARIANT_NOT_FOUND'
                : 'PRODUCT_NOT_FOUND',
            ),
          );
          continue;
        }
        if (err instanceof BusinessRuleViolationError) {
          problems.push(problem('PRODUCT_NOT_SELLABLE'));
          continue;
        }
        throw err;
      }

      if (options.checkStock) {
        const stock = await this.productsService.checkStockAvailability(
          line.productId,
          line.variantId,
          line.quantity,
        );
        if (!stock.available) {
          problems.push(problem('INSUFFICIENT_STOCK', stock.currentStock ?? 0));
          continue;
        }
      }

      byLineId.set(line.lineId, {
        productName: info.productName,
        variantName: info.variantName,
        imageUrl: info.imageUrl,
        ivaRate: info.ivaRate,
        chargeProductTaxes: info.chargeProductTaxes,
      });
    }

    return { byLineId, problems };
  }
}

function hashRequest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** JSON round-trip so the first response equals every idempotent replay. */
function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
