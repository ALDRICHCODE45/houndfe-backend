export interface OrderHistoryItem {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderHistoryPayment {
  method: string;
  amountCents: number;
  reference: string | null;
}

export interface OrderHistoryResponse {
  saleId: string;
  folio: string | null;
  confirmedAt: string | null;
  channel: string;
  deliveryStatus: string;
  paymentStatus: string | null;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  items: OrderHistoryItem[];
  payments: OrderHistoryPayment[];
  shippingAddress: {
    street: string | null;
    zipCode: string | null;
  } | null;
}
