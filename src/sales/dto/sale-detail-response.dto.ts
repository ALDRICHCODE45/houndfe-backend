export type SaleTimelineEventType =
  | 'SALE_REGISTERED'
  | 'PAYMENT_RECEIVED'
  | 'PRODUCTS_DELIVERED'
  | 'COMMENT';

type TimelineActor = { id: string; name: string } | null;

export type SaleDetailTimelineEventDto =
  | {
      type: 'SALE_REGISTERED';
      at: string;
      actor: TimelineActor;
      register: string;
    }
  | {
      type: 'PAYMENT_RECEIVED';
      at: string;
      method: string;
      amountCents: number;
      reference: string | null;
      actor: TimelineActor;
      register: string;
    }
  | {
      type: 'PRODUCTS_DELIVERED';
      at: string;
      actor: TimelineActor;
      register: string;
    }
  | {
      type: 'COMMENT';
      at: string;
      actor: { id: string; name: string };
      body: string;
      commentId: string;
    };

export interface SaleDetailItemDto {
  productName: string;
  variantName: string | null;
  imageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
  discountCents: number;
  subtotalCents: number;
}

export interface SaleDetailPaymentDto {
  method: string;
  amountCents: number;
  tenderedCents: number;
  changeCents: number;
  reference: string | null;
  paidAt: string;
}

export interface SaleDetailResponseDto {
  id: string;
  folio: string | null;
  status: string;
  channel: 'POS' | 'ONLINE';
  register: string;
  confirmedAt: string | null;
  dueDate: string | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  changeDueCents: number;
  paymentStatus: string | null;
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string };
  seller: { id: string; name: string } | null;
  items: SaleDetailItemDto[];
  payments: SaleDetailPaymentDto[];
  timeline: SaleDetailTimelineEventDto[];
}
