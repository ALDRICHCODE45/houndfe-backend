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

/**
 * Internal-only evaluation result. `promotionId` is carried privately so the
 * capacity aggregation can count the units each SELECTED promotion actually
 * discounts without widening the public `EvaluatedCartItem` contract.
 */
interface InternallyEvaluatedCartItem {
  item: EvaluatedCartItem;
  promotionId: string | null;
}

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
      (promotion) => !isSupportedProductDiscountPromotion(promotion),
    );

    // Fix the supported snapshot ONCE. Every retry re-evaluates the whole cart
    // from clean state against this same snapshot minus the accumulated
    // capacity-excluded ids; an excluded promotion leaves as a whole and is
    // never partially applied.
    const supportedPromotions = promotions.filter(
      isSupportedProductDiscountPromotion,
    );

    // Termination: an excluded promotion can never be selected again, so any
    // overrun must belong to a not-yet-excluded promotion. Each iteration
    // grows the set by at least one id, bounded by the supported count.
    const capacityExcludedPromotionIds = new Set<string>();
    let evaluatedItems: InternallyEvaluatedCartItem[];
    for (;;) {
      evaluatedItems = evaluatePass(
        input.items,
        supportedPromotions,
        capacityExcludedPromotionIds,
      );
      const overrunPromotionIds = findCapacityOverrunIds(
        evaluatedItems,
        supportedPromotions,
      );
      if (overrunPromotionIds.length === 0) break;
      for (const id of overrunPromotionIds) {
        capacityExcludedPromotionIds.add(id);
      }
    }

    return {
      // Strip the private promotion id; the public shape stays untouched.
      items: evaluatedItems.map((evaluated) => evaluated.item),
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

function evaluatePass(
  items: CartItemForEvaluation[],
  promotions: Promotion[],
  excludedPromotionIds: ReadonlySet<string>,
): InternallyEvaluatedCartItem[] {
  const availablePromotions = promotions.filter(
    (promotion) => !excludedPromotionIds.has(promotion.id),
  );
  return items.map((item) => evaluateItem(item, availablePromotions));
}

function evaluateItem(
  item: CartItemForEvaluation,
  promotions: Promotion[],
): InternallyEvaluatedCartItem {
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
      item: {
        ...item,
        originalPriceCents,
        finalPriceCents: originalPriceCents,
        appliedPromotionTitle: null,
        discountAmountCents: 0,
      },
      promotionId: null,
    };
  }

  const discountAmountCents = resolveDiscountAmount(
    originalPriceCents,
    matchingPromotion.discountType!,
    matchingPromotion.discountValue!,
    item.quantity,
  );

  return {
    item: {
      ...item,
      originalPriceCents,
      finalPriceCents: Math.max(originalPriceCents - discountAmountCents, 0),
      appliedPromotionTitle: matchingPromotion.title,
      discountAmountCents,
    },
    promotionId: matchingPromotion.id,
  };
}

/**
 * pca-2b2 — benefited-unit demand is the full line `quantity` summed once per
 * selected promotion across ALL cart items. A promotion overruns only when a
 * capped remaining capacity is exceeded: an exact fit is allowed and `null`
 * (unlimited) never overruns.
 */
function findCapacityOverrunIds(
  evaluatedItems: InternallyEvaluatedCartItem[],
  promotions: Promotion[],
): string[] {
  const demandByPromotionId = new Map<string, number>();
  for (const { item, promotionId } of evaluatedItems) {
    if (promotionId === null) continue;
    demandByPromotionId.set(
      promotionId,
      (demandByPromotionId.get(promotionId) ?? 0) + item.quantity,
    );
  }

  const overrunPromotionIds: string[] = [];
  for (const promotion of promotions) {
    const demand = demandByPromotionId.get(promotion.id);
    if (demand === undefined) continue;
    const remainingProductUnits = promotion.remainingProductUnits;
    if (remainingProductUnits === null) continue;
    if (demand > remainingProductUnits) {
      overrunPromotionIds.push(promotion.id);
    }
  }
  return overrunPromotionIds;
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
