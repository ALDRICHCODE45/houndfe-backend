import { Inject, Injectable } from '@nestjs/common';
import { PROMOTION_REPOSITORY } from '../domain/promotion.repository';
import { isBotEligibilitySupported } from '../domain/bot-eligibility';
import type { IPromotionRepository } from '../domain/promotion.repository';
import type {
  CartEvaluationResult,
  CartItemForEvaluation,
  EvaluatedCartItem,
  IEvaluateCartPromotionsUseCase,
} from './ports/evaluate-cart-promotions.port';
import { POS_EVALUATE_PROMOTIONS_USE_CASE } from './ports/pos-evaluate-promotions.port';
import type { IPosEvaluatePromotionsUseCase } from './ports/pos-evaluate-promotions.port';

@Injectable()
export class EvaluateCartPromotionsUseCase implements IEvaluateCartPromotionsUseCase {
  constructor(
    @Inject(PROMOTION_REPOSITORY)
    private readonly promotionRepository: IPromotionRepository,
    @Inject(POS_EVALUATE_PROMOTIONS_USE_CASE)
    private readonly posEvaluatePromotions: IPosEvaluatePromotionsUseCase,
  ) {}

  async execute(input: {
    items: CartItemForEvaluation[];
  }): Promise<CartEvaluationResult> {
    const { promotions: snapshot, complete } =
      await this.promotionRepository.findActiveAutomaticSnapshot();
    // Defense in depth for adapters that return an unfiltered snapshot.
    const promotions = snapshot.filter((promotion) => promotion.botEligible);
    if (
      !complete ||
      promotions.some((promotion) => !isBotEligibilitySupported(promotion))
    ) {
      return {
        items: input.items.map(toBasePriceItem),
        promotionEvaluationStatus: 'needs_human_review',
      };
    }

    const result = await this.posEvaluatePromotions.evaluate({
      now: new Date(),
      customerId: null,
      botEligibleOnly: true,
      vetoedPromotionIds: [],
      optedInManualPromotionIds: [],
      lines: input.items.map((item, index) => ({
        itemId: `line-${index}`,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        effectiveUnitPriceCents: item.unitPriceCents,
        appliedPriceListId: null,
        appliedGlobalPriceListId: null,
        categoryId: null,
        brandId: null,
        hasManualDiscount: false,
      })),
    });

    if (
      result.order !== null ||
      result.lines.some(
        (line) => line.kind !== undefined && line.kind !== 'per-unit',
      )
    ) {
      return {
        items: input.items.map(toBasePriceItem),
        promotionEvaluationStatus: 'needs_human_review',
      };
    }

    const discountsByItemId = new Map(
      result.lines.map((line) => [line.itemId, line]),
    );
    return {
      items: input.items.map((item, index) => {
        const baseItem = toBasePriceItem(item);
        const discount = discountsByItemId.get(`line-${index}`);
        if (
          !discount ||
          (discount.kind !== undefined && discount.kind !== 'per-unit')
        ) {
          return baseItem;
        }
        // Match SaleItem.applyDiscount: round per unit, then multiply by qty.
        const perUnit =
          discount.discountType === 'amount'
            ? discount.discountValue
            : Math.round((item.unitPriceCents * discount.discountValue) / 100);
        const discountAmountCents = perUnit * item.quantity;
        return {
          ...baseItem,
          finalPriceCents: baseItem.originalPriceCents - discountAmountCents,
          discountAmountCents,
          appliedPromotionTitle: discount.discountTitle,
        };
      }),
      promotionEvaluationStatus: 'fully_evaluated',
    };
  }
}

function toBasePriceItem(item: CartItemForEvaluation): EvaluatedCartItem {
  const originalPriceCents = item.unitPriceCents * item.quantity;
  return {
    ...item,
    originalPriceCents,
    finalPriceCents: originalPriceCents,
    appliedPromotionTitle: null,
    discountAmountCents: 0,
  };
}
