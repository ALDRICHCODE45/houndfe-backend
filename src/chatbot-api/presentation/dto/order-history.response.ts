/**
 * Pet of an order line (contract §4.1). `id`, `name` and `species` are the
 * line's own snapshot; `status` is the pet's CURRENT status, `null` when the
 * pet row is gone but the snapshot remains.
 */
export interface OrderHistoryPet {
  id: string | null;
  name: string;
  species: 'DOG' | 'CAT' | 'OTHER';
  status: 'ACTIVE' | 'ARCHIVED' | null;
}

export interface OrderHistoryItem {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  /** `null` for lines without a pet snapshot (never an object of nulls). */
  pet: OrderHistoryPet | null;
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
