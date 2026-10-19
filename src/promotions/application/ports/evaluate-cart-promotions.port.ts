export interface CartItemForEvaluation {
  productId: string;
  variantId: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface EvaluatedCartItem extends CartItemForEvaluation {
  originalPriceCents: number;
  finalPriceCents: number;
  appliedPromotionTitle: string | null;
  discountAmountCents: number;
}

export interface BotPricingPreview {
  items: EvaluatedCartItem[];
}

export interface CartPromotionEvaluation {
  items: EvaluatedCartItem[];
  promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
}

export interface CartEvaluationResult extends CartPromotionEvaluation {
  customerResolution: 'unique' | 'not_found' | 'ambiguous' | 'not_provided';
}

export interface IEvaluateCartPromotionsUseCase {
  execute(input: BotPricingPreview): Promise<CartPromotionEvaluation>;
}

export const EVALUATE_CART_PROMOTIONS_USE_CASE = Symbol(
  'EVALUATE_CART_PROMOTIONS_USE_CASE',
);
