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

export interface CartEvaluationResult {
  items: EvaluatedCartItem[];
  promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
}

export interface IEvaluateCartPromotionsUseCase {
  execute(input: {
    items: CartItemForEvaluation[];
  }): Promise<CartEvaluationResult>;
}

export const EVALUATE_CART_PROMOTIONS_USE_CASE = Symbol(
  'EVALUATE_CART_PROMOTIONS_USE_CASE',
);
