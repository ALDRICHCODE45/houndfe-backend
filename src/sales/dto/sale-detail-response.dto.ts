import type { SaleCancelReason } from '../domain/sale.entity';
import type { SaleRefundMethod } from '../domain/sale.repository';
import type { SaleShippingAddressDto } from './sale-shipping-address.dto';

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
      // Custom Payment Methods (custom-payment-methods / WU2 — D10):
      // optional branded name/subtitle from `metadataJson.catalog`.
      // Falls back to the base-category label when absent.
      paymentMethodName?: string;
      paymentMethodSubtitle?: string;
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
  // WU7 — D4 wire discriminator. Widened to include 'advanced' for the
  // new ADVANCED promotion kind (Slice 2 / WU5). Both kinds ride the
  // applyBuyXGetYReward rail; the column-derived predicate cannot
  // distinguish them, so the mapper now reads the persisted
  // `SaleItemRewardKind` column to populate this field.
  rewardKind: 'buy_x_get_y' | 'advanced' | null;
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
  paymentId: string;
  method: string;
  amountCents: number;
  tenderedCents: number;
  changeCents: number;
  reference: string | null;
  paidAt: string;
  // Custom Payment Methods (custom-payment-methods / WU2 — D10):
  // optional branded identity from `metadataJson.catalog`. Absent on
  // legacy rows (no `catalog` key) — the base `method` field remains the
  // fallback. Surface only when non-null so legacy rows stay absent on
  // the wire (matches the spec scenario "Legacy rows fall back to
  // base-category label").
  paymentMethodId?: string;
  paymentMethodName?: string;
  paymentMethodSubtitle?: string;
}

/** Refund obligation recorded when a paid sale was canceled. */
export interface SaleDetailRefundDto {
  id: string;
  method: SaleRefundMethod;
  amountCents: number;
  settledCents: number;
  outstandingCents: number;
  reason: SaleCancelReason;
  status: 'PENDING';
  createdAt: string;
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
  /** Positive shipping charge, omitted on legacy/POS sales without a charge. */
  shippingChargeCents?: number;
  /**
   * shipping-zones / T7 — additive. `PICKUP` = store pickup (no address, no
   * shipping charge); `DELIVERY` = bot delivery. Omitted when not recorded
   * (POS and legacy sales).
   */
  fulfillmentMode?: 'DELIVERY' | 'PICKUP';
  totalCents: number;
  paidCents: number;
  debtCents: number;
  changeDueCents: number;
  paymentStatus: string | null;
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED';
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string };
  seller: { id: string; name: string } | null;
  /** Sale-time shipping snapshot with its source status; null without one. */
  shippingAddress: SaleShippingAddressDto | null;
  items: SaleDetailItemDto[];
  payments: SaleDetailPaymentDto[];
  timeline: SaleDetailTimelineEventDto[];
  /** Cancellation facts; all null and `refunds: []` unless canceled. */
  canceledAt: string | null;
  cancelReason: SaleCancelReason | null;
  canceledBy: { id: string; name: string } | null;
  refunds: SaleDetailRefundDto[];
}
