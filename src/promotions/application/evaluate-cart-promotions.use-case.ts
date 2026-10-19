import { Inject, Injectable } from '@nestjs/common';
import { PROMOTION_REPOSITORY } from '../domain/promotion.repository';
import { isBotEligibilitySupported } from '../domain/bot-eligibility';
import type { IPromotionRepository } from '../domain/promotion.repository';
import type {
  BotPricingPreview,
  CartPromotionEvaluation,
  IEvaluateCartPromotionsUseCase,
} from './ports/evaluate-cart-promotions.port';

@Injectable()
export class EvaluateCartPromotionsUseCase implements IEvaluateCartPromotionsUseCase {
  constructor(
    @Inject(PROMOTION_REPOSITORY)
    private readonly promotionRepository: IPromotionRepository,
  ) {}

  // Pricing is already computed by the same transient-sale path as confirmation.
  // This adapter only enforces the narrower bot response contract.
  async execute(input: BotPricingPreview): Promise<CartPromotionEvaluation> {
    const { promotions: snapshot, complete } =
      await this.promotionRepository.findActiveAutomaticSnapshot();
    const needsReview =
      !complete ||
      snapshot.some(
        (promotion) =>
          promotion.botEligible && !isBotEligibilitySupported(promotion),
      ) ||
      input.hasAdvancedReward;

    return {
      items: needsReview
        ? input.items.map((item) => ({
            ...item,
            originalPriceCents: item.unitPriceCents * item.quantity,
            finalPriceCents: item.unitPriceCents * item.quantity,
            appliedPromotionTitle: null,
            discountAmountCents: 0,
          }))
        : input.items,
      promotionEvaluationStatus: needsReview
        ? 'needs_human_review'
        : 'fully_evaluated',
    };
  }
}
