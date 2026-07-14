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
  originalPriceCents: number | null;
  priceSource: 'default' | 'price_list' | 'custom' | null;
  appliedPriceListId: string | null;
  discountType: 'amount' | 'percentage' | null;
  discountValue: number | null;
  discountAmountCents: number | null;
  discountTitle: string | null;
  prePriceCentsBeforeDiscount: number | null;
  /**
   * Wire-level BXGY discriminator (design.md Decision 6; spec.md:97-106).
   * `'buy_x_get_y'` iff the persisted row satisfies the column-derived
   * predicate (`promotionId != null && discountAmountCents > 0 &&
   * prePriceCentsBeforeDiscount != null && unitPriceCents ===
   * prePriceCentsBeforeDiscount`). Null on every other line so the
   * frontend can render the "free"/reward badge without inferring it.
   */
  rewardKind: 'buy_x_get_y' | null;
  /**
   * Exact BUY_X_GET_Y `getDiscountPercent` (0..100; 100=free, 50=half) of the
   * applied promotion, persisted verbatim (never derived from cents). Null on
   * every non-reward line — same `isBxgy` guard as `rewardKind`. Lets the
   * frontend show "GRATIS" only at 100%, otherwise the real percent.
   */
  rewardDiscountPercent: number | null;
  /**
   * Id of the promotion the line was sourced from (WUA — frontend asks).
   * Set when `item.promotionId` is non-null (AUTO PD winner, AUTO BXGY
   * winner, or opted-in MANUAL winner). Null on plain lines (no promo
   * applied) and on lines with a free-form seller discount. The value is
   * already selected by the mapper so we just surface it on the wire.
   */
  promotionId: string | null;
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
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED';
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string };
  seller: { id: string; name: string } | null;
  items: SaleDetailItemDto[];
  payments: SaleDetailPaymentDto[];
  timeline: SaleDetailTimelineEventDto[];
}
