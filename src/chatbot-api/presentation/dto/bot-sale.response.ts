export interface BotSaleResponse {
  saleId: string;
  folio: string | null;
  paymentStatus: 'CREDIT' | 'PARTIAL' | 'PAID';
  channel: string;
  deliveryStatus: string;
  totalCents: number;
  // Q2 / WU3 — additive. 0 when no promotion applied; equals
  // engine-recomputed (subtotalCents − totalCents) when a promotion
  // applied. Legacy cached responses that pre-date this field are
  // normalized by the service with `discountCents ?? 0` (design risk
  // mitigation in tasks.md WU3-06).
  discountCents: number;
  paidCents: number;
  debtCents: number;
  confirmedAt: string | null;
}
