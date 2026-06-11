import { Inject, Injectable } from '@nestjs/common';
import { PROMOTION_REPOSITORY } from '../domain/promotion.repository';
import type { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import type {
  CartEvaluationResult,
  CartItemForEvaluation,
  EvaluatedCartItem,
  IEvaluateCartPromotionsUseCase,
} from './ports/evaluate-cart-promotions.port';

@Injectable()
export class EvaluateCartPromotionsUseCase implements IEvaluateCartPromotionsUseCase {
  constructor(
    @Inject(PROMOTION_REPOSITORY)
    private readonly promotionRepository: IPromotionRepository,
  ) {}

  async execute(input: {
    items: CartItemForEvaluation[];
  }): Promise<CartEvaluationResult> {
    const { data: promotions } = await this.promotionRepository.findAll({
      page: 1,
      limit: 100,
      method: 'AUTOMATIC',
      status: 'ACTIVE',
    });

    const unsupportedPromotionExists = promotions.some(
      (promotion) =>
        promotion.type !== 'PRODUCT_DISCOUNT' ||
        promotion.appliesTo !== 'PRODUCTS' ||
        promotion.discountType == null ||
        promotion.discountValue == null,
    );

    const items = input.items.map((item) =>
      evaluateItem(
        item,
        promotions.filter(isSupportedProductDiscountPromotion),
      ),
    );

    return {
      items,
      promotionEvaluationStatus: unsupportedPromotionExists
        ? 'needs_human_review'
        : 'fully_evaluated',
    };
  }
}

function isSupportedProductDiscountPromotion(promotion: Promotion): boolean {
  return (
    promotion.type === 'PRODUCT_DISCOUNT' &&
    promotion.appliesTo === 'PRODUCTS' &&
    promotion.discountType != null &&
    promotion.discountValue != null
  );
}

function evaluateItem(
  item: CartItemForEvaluation,
  promotions: Promotion[],
): EvaluatedCartItem {
  const originalPriceCents = item.unitPriceCents * item.quantity;
  const matchingPromotion = promotions.find((promotion) =>
    promotion.targetItems.some(
      (target) =>
        target.side === 'DEFAULT' &&
        target.targetType === 'PRODUCTS' &&
        target.targetId === item.productId,
    ),
  );

  if (!matchingPromotion) {
    return {
      ...item,
      originalPriceCents,
      finalPriceCents: originalPriceCents,
      appliedPromotionTitle: null,
      discountAmountCents: 0,
    };
  }

  const discountAmountCents = resolveDiscountAmount(
    originalPriceCents,
    matchingPromotion.discountType!,
    matchingPromotion.discountValue!,
    item.quantity,
  );

  return {
    ...item,
    originalPriceCents,
    finalPriceCents: Math.max(originalPriceCents - discountAmountCents, 0),
    appliedPromotionTitle: matchingPromotion.title,
    discountAmountCents,
  };
}

function resolveDiscountAmount(
  originalPriceCents: number,
  discountType: 'PERCENTAGE' | 'FIXED',
  discountValue: number,
  quantity: number,
): number {
  const rawDiscount =
    discountType === 'PERCENTAGE'
      ? Math.round((originalPriceCents * discountValue) / 100)
      : discountValue * quantity;

  return Math.min(rawDiscount, originalPriceCents);
}
