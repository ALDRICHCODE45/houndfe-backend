import type { PickupLocation } from '../../../shipping/pickup/application/pickup-location.service';

export interface BotSaleResponse {
  saleId: string;
  folio: string | null;
  paymentStatus: 'CREDIT' | 'PARTIAL' | 'PAID';
  channel: string;
  deliveryStatus: string;
  totalCents: number;
  /** Merchandise subtotal and approved shipping charge; present only for charged shipping sales. */
  subtotalCents?: number;
  shippingChargeCents?: number;
  // Q2 / WU3 — additive. 0 when no promotion applied; for shipping sales
  // equals merchandise subtotal minus merchandise total (never discounts
  // the shipping charge). Legacy cached responses that pre-date this field are
  // normalized by the service with `discountCents ?? 0` (design risk
  // mitigation in tasks.md WU3-06).
  discountCents: number;
  paidCents: number;
  debtCents: number;
  confirmedAt: string | null;
  /**
   * shipping-zones / T7 — additive, only for `shipping: { quoteId }`
   * (`DELIVERY`) and `{ mode: "pickup" }` (`PICKUP`). Quote sales also carry
   * `subtotalCents` + `shippingChargeCents` (0 for a FREE zone).
   */
  fulfillmentMode?: 'DELIVERY' | 'PICKUP';
  /** POST /chatbot-api/sales pickup only (checkouts put it at the top level). */
  pickupLocation?: PickupLocation;
}
