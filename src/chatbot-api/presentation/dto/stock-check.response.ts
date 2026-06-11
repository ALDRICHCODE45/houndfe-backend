import type { ChatbotStockState } from './catalog-item.response';

export interface StockCheckResponse {
  productId: string;
  name: string;
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
