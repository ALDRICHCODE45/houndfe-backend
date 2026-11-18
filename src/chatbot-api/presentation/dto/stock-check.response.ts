import type {
  ChatbotProductCategory,
  ChatbotStockState,
} from './catalog-item.response';

export interface StockCheckResponse {
  productId: string;
  name: string;
  category: ChatbotProductCategory | null;
  stock: {
    status: ChatbotStockState;
    quantity: number | null;
  };
  variants: Array<{
    variantId: string;
    name: string;
    option: string | null;
    value: string | null;
    stock: {
      status: ChatbotStockState;
      quantity: number | null;
    };
  }>;
}
