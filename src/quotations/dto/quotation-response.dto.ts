/**
 * Wire shape returned by the quotations endpoints (mirrors
 * `sale-detail-response.dto.ts` minus the payment/timeline/customer-jack
 * surface that is irrelevant for a pre-sale document).
 *
 * The totals (`subtotalCents`, `discountCents`, `totalCents`) and the
 * applied-promotions snapshot are computed on every recompute; WU2 ships
 * a stub recompute that returns the entity's own totals, so the wire
 * shape remains stable across WU3.
 *
 * Status semantics:
 *   - `status`            — the PERSISTED status (DRAFT | SENT | EXPIRED
 *                            | CANCELLED).
 *   - `effectiveStatus`   — the lazy-resolved status. For SENT drafts
 *                            whose `expiresAt` is in the past this is
 *                            'EXPIRED'; identical to `status` otherwise.
 *                            Mirrors Sale's `getEffectiveStatus` lazy
 *                            transition.
 */
import type { QuotationStatus } from '../domain/quotation.entity';

export interface QuotationItemResponseDto {
  id: string;
  quotationId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  unitPriceCurrency: string;
  priceSource: 'PRICE_LIST' | 'CUSTOM';
  appliedPriceListId: string | null;
  customPriceCents: number | null;
  discountType: 'amount' | 'percentage' | null;
  discountValue: number | null;
  discountAmountCents: number;
  /**
   * WU4 — Human-readable discount title (e.g. "Cliente frecuente",
   * "Promo 2x1"). Mirrors `SaleDetailItemDto.discountTitle` so the
   * PDF receipt + email body can render the discount row verbatim.
   * Null when no discount is applied to the line.
   */
  discountTitle: string | null;
  promotionId: string | null;
  subtotalCents: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface QuotationResponseDto {
  id: string;
  sellerUserId: string;
  status: QuotationStatus;
  effectiveStatus?: QuotationStatus;
  customerId: string | null;
  globalPriceListId: string | null;
  priceListExplicitlySet: boolean;
  expiresAt: Date | null;
  cancelReason: string | null;
  canceledAt: Date | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  manuallyEnded: boolean;
  items: QuotationItemResponseDto[];
  vetoedPromotionIds: string[];
  optedInManualPromotionIds: string[];
  /**
   * WU4 — Customer identity snapshot (id + name + email) on the wire.
   * Mirrors `SaleDetailResponseDto.customer` so the FE can render the
   * PDF preview / customer chip without a separate `/customers/:id`
   * roundtrip. Null when the quotation has no customer assigned.
   * The email is required for the `send()` flow (a missing email is
   * rejected with 422 `QUOTATION_CUSTOMER_HAS_NO_EMAIL`).
   */
  customer: { id: string; firstName: string; lastName: string | null; email: string | null } | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pagination envelope around the list endpoint response. Mirrors
 * `sale-list-response.dto.ts` so the FE can reuse the same pagination
 * helper. `pagination.total` is the row count BEFORE
 * `limit`/`skip` apply; `data.length` is the page size.
 */
export interface QuotationListResponseDto {
  data: QuotationResponseDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
