/**
 * PORT + VIEW MODEL: confirmed-delivered sale summary for the customer
 * thank-you email — delivery-routes / DTE-2.
 *
 * The future `delivery-thank-you-email` Inngest function needs a
 * TRUTHFUL, persisted snapshot of the sale it just delivered: folio,
 * confirmation date, the persisted money totals in MXN cents, and the
 * persisted per-line data (name, variant, quantity, unit price and the
 * discount snapshot). This port is the read seam that produces it.
 *
 * Tenant scoping — CRITICAL.
 *
 * The adapter is invoked from an Inngest step body that opens its own
 * CLS scope via `tenantRunner.runWithTenant`, so the port takes an
 * explicit `tenantId` and the query carries `{ id, tenantId }` in its
 * `where` clause (defense in depth on top of the ambient scope). A
 * cross-tenant sale id, a cancelled sale, or a sale that is not
 * `DELIVERED` resolves to `null`; the caller treats `null` as a soft
 * skip, never as an error.
 *
 * No customer email on this projection.
 *
 * The authoritative recipient address is resolved separately and at
 * send time through `ISaleCustomerEmailLookup`, so this projection
 * deliberately does NOT select `customer.email`. That keeps a single
 * authoritative lookup for the address and prevents a stale write-time
 * snapshot from ever being used as a recipient.
 *
 * Money semantics — DO NOT INVENT, DO NOT DOUBLE COUNT.
 *
 * `subtotalCents` / `discountCents` / `totalCents` are the PERSISTED
 * sale columns, passed through verbatim. Per line, `unitPriceCents` is
 * the persisted price and `lineTotalCents` mirrors the confirmed-sale
 * receipt convention
 * (`unitPriceCents * quantity - rewardCents`). The reward is subtracted
 * ONLY for a persisted promotion-reward line (the `isBxgy` shape). On a
 * free-form / coupon discount row the unit price is already NET and
 * `discountAmountCents` is informational, so subtracting it again would
 * double count — `lineTotalCents` must be the only line total the
 * template renders.
 */
export interface SaleDeliverySummaryItem {
  /** Persisted `SaleItem.productName`. */
  productName: string;
  /** Persisted `SaleItem.variantName` (null when the line has no variant). */
  variantName: string | null;
  /** Persisted `SaleItem.quantity`. */
  quantity: number;
  /** Persisted `SaleItem.unitPriceCents` (already NET for per-unit discounts). */
  unitPriceCents: number;
  /**
   * NET line total the template renders:
   * `unitPriceCents * quantity - rewardCents`, where `rewardCents` is
   * the persisted `discountAmountCents` of a promotion-reward line only.
   * Never subtract `discountAmountCents` again for reward lines, and
   * never subtract it at all for coupon/free-form rows.
   */
  lineTotalCents: number;
  /** Persisted `SaleItem.discountAmountCents`; null when no discount row. */
  discountAmountCents: number | null;
  /** Persisted `SaleItem.discountTitle`; null when no discount label. */
  discountTitle: string | null;
  /**
   * Reward discriminator, mirroring the confirmed-sale read path: the
   * persisted `SaleItem.rewardKind` column is surfaced verbatim, with the
   * column-derived `isBxgy` shape as the back-compat fallback for
   * pre-migration rows whose column is null.
   *
   * A non-null kind does NOT by itself prove a positive discount. The
   * persisted column can be set on a row whose `discountAmountCents` is
   * zero, and this read path (like the confirmed-sale mapper) surfaces the
   * persisted kind unchanged. Only `lineTotalCents` proves whether a
   * reward was actually netted: it subtracts the reward solely when the
   * column-derived shape matches (promotion set, pre-price present, unit
   * price equal to pre-price, positive discount). Consumers must not gate
   * "was discounted" on `rewardKind` alone.
   */
  rewardKind: 'buy_x_get_y' | 'advanced' | null;
}

export interface SaleDeliverySummary {
  /** The sale the summary belongs to (useful for logging / dedupe). */
  saleId: string;
  /** Persisted `Sale.folio`; null on legacy rows that predate folios. */
  folio: string | null;
  /** Persisted `Sale.confirmedAt`; null is surfaced, never invented. */
  confirmedAt: Date | null;
  /** Persisted sale money is MXN cents; stated so the template cannot guess. */
  currency: 'MXN';
  /** Persisted `Sale.subtotalCents`. */
  subtotalCents: number;
  /** Persisted `Sale.discountCents`. */
  discountCents: number;
  /** Persisted `Sale.totalCents`. */
  totalCents: number;
  /**
   * Customer display name, included ONLY after re-checking the child
   * customer's tenant identity. Null when the sale has no customer, when
   * the customer belongs to another tenant, or when the persisted name
   * is blank. Never the email address.
   */
  customerName: string | null;
  /**
   * Persisted lines in deterministic order (`createdAt` then `id`).
   * Never empty: a confirmed-delivered sale with zero lines fails
   * closed to `null` at the port boundary.
   */
  items: SaleDeliverySummaryItem[];
}

export interface ISaleDeliverySummaryReader {
  /**
   * Read the persisted confirmed+delivered sale summary for the caller's
   * tenant. Returns `null` when:
   *   - `tenantId` or `saleId` is empty,
   *   - the sale does not exist in the tenant,
   *   - the sale is not `CONFIRMED` or not `DELIVERED` (cancelled /
   *     undelivered / pending / not-applicable),
   *   - any persisted line row belongs to another tenant (unsafe
   *     cross-tenant child relation),
   *   - the sale has zero persisted lines (nothing truthful to send).
   * A foreign customer relation does NOT null the summary; it only
   * suppresses `customerName`, so the caller can still skip the send via
   * the separate authoritative email lookup without leaking a name.
   */
  findConfirmedDeliveredSummary(input: {
    tenantId: string;
    saleId: string;
  }): Promise<SaleDeliverySummary | null>;
}

/**
 * NestJS injection token. `Symbol.for(...)` so identical tokens are
 * deduped across module instances (matches the cross-context seam
 * convention used by `MAILER`, `SALE_CUSTOMER_EMAIL_LOOKUP`).
 */
export const SALE_DELIVERY_SUMMARY_READER = Symbol.for(
  'ISaleDeliverySummaryReader',
);
