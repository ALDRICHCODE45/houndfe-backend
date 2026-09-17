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
import { IsArray, IsEnum, IsInt, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { QUOTATION_IVA_CLASSIFICATIONS } from '../domain/quotation-tax.types';

export interface AppliedPromotionDto {
  /** ID of the promotion entity. */
  promotionId: string;
  /** Human-readable promotion title (e.g. "10% off en jeans"). */
  title: string;
  /** Total discount in cents this promotion contributed across all items. */
  discountCents: number;
}

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

/**
 * WU2 (T2.3) — one entry of the quotation-level `ivaBreakdown[]`
 * wire contract. The classification enum is CLOSED over exactly the
 * five public values (`NOT_TAXABLE` included — it is a response-only
 * classification derived from `chargeProductTaxesSnapshot=false`).
 * `amountCents` is exact integer addition over every snapshot-
 * complete line mapped to the classification: integer (no fractions)
 * and non-negative by construction.
 */
export class QuotationIvaBreakdownEntryDto {
  @IsEnum(QUOTATION_IVA_CLASSIFICATIONS)
  classification!: (typeof QUOTATION_IVA_CLASSIFICATIONS)[number];

  @IsInt()
  @Min(0)
  amountCents!: number;
}

export class QuotationResponseDto {
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
  /** Promotions currently applied to items, deduplicated by promotionId. */
  appliedPromotions: AppliedPromotionDto[];
  customerNotes: string | null;
  /**
   * WU2 (T2.3) — activated wire contract. `ivaBreakdown[]` contains
   * ONLY the classifications actually represented by snapshot-
   * complete lines (zero-amount buckets included when zero-tax
   * lines are present; the array does NOT always return all five
   * buckets). It is `[]` whenever any line lacks a complete tax
   * snapshot — never a fabricated aggregate zero, never a partial
   * breakdown. Ships in the SAME deployable unit as the T2.2
   * snapshot producer pipeline; the legacy `taxRate` / informational
   * `taxCents` response fields are removed with it (they never
   * participated in line, subtotal, discount, or grand totals).
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuotationIvaBreakdownEntryDto)
  ivaBreakdown!: QuotationIvaBreakdownEntryDto[];
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
  /**
   * Seller identity snapshot (id + display name) on the wire. Mirrors
   * `customer` so the FE can render the Vendedor chip / PDF header
   * without a separate `/users/:id` roundtrip. The name falls back to
   * the raw `sellerUserId` when the user record is missing, so this is
   * effectively always populated — kept nullable for forward-compat.
   */
  seller: { id: string; name: string } | null;
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
