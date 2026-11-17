export type ChatbotStockState =
  | 'available'
  | 'low_stock'
  | 'out_of_stock'
  | 'not_managed';

export interface CatalogItemResponse {
  /**
   * Additive and optional. Present only for word-based searches: `all` = the
   * item matched every effective word of `q`, `partial` = only some. Omitted
   * when `q` has no searchable words (blank or punctuation only).
   */
  match?: 'all' | 'partial';
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  description: string | null;
  price: {
    priceCents: number | null;
    fromPriceCents: number | null;
    promoPriceCents: number | null;
    promotionEvaluationStatus: 'needs_human_review';
  };
  stock: {
    status: ChatbotStockState;
    quantity: number | null;
  };
  packageInfo: {
    weightGrams: null;
    dimensions: null;
  };
  variants: Array<{
    variantId: string;
    name: string;
    option: string | null;
    value: string | null;
    priceCents: number | null;
    stock: {
      status: ChatbotStockState;
      quantity: number | null;
    };
  }>;
}
