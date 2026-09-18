/**
 * Quotation-owned IVA classification types (WU1 — product IVA snapshot).
 *
 * Deliberately separate from the Prisma `IvaRate` enum and from the
 * products-domain `IvaRateValue`:
 *
 * - `NOT_TAXABLE` is a response-only classification. It is never stored in
 *   the `ivaRateClassification` column; it is derived from
 *   `chargeProductTaxesSnapshot = false` at aggregation time and renders
 *   the third distinct zero-tax meaning (`do not charge IVA`), separate
 *   from `IVA_0` (rate is 0%) and `IVA_EXENTO` (exempt by classification).
 * - The stored pair `(ivaRateClassification, chargeProductTaxesSnapshot)`
 *   is the disambiguation; these buckets must stay distinct whenever each
 *   is represented by at least one snapshot-complete line.
 */

export const QUOTATION_IVA_CLASSIFICATIONS = [
  'IVA_16',
  'IVA_8',
  'IVA_0',
  'IVA_EXENTO',
  'NOT_TAXABLE',
] as const;

export type QuotationIvaClassification =
  (typeof QUOTATION_IVA_CLASSIFICATIONS)[number];

/**
 * The rate classifications storable on a `QuotationItem` snapshot —
 * exactly the Prisma `IvaRate` enum values. `NOT_TAXABLE` is excluded:
 * the persisted column keeps the parent product's raw classification and
 * the `chargeProductTaxesSnapshot` boolean carries the not-taxable intent.
 */
export type QuotationIvaRateClassification =
  | 'IVA_16'
  | 'IVA_8'
  | 'IVA_0'
  | 'IVA_EXENTO';

/**
 * Deterministic bucket order for `ivaBreakdown[]` responses. Buckets are
 * returned only when represented by at least one snapshot-complete line,
 * always sorted in this order.
 */
export const IVA_CLASSIFICATION_BUCKET_ORDER: ReadonlyArray<QuotationIvaClassification> =
  QUOTATION_IVA_CLASSIFICATIONS;

/** Integer percent per rate classification. Never a float multiplier. */
export const IVA_RATE_PERCENT: Record<QuotationIvaRateClassification, number> =
  {
    IVA_16: 16,
    IVA_8: 8,
    IVA_0: 0,
    IVA_EXENTO: 0,
  };

export function isQuotationIvaRateClassification(
  value: unknown,
): value is QuotationIvaRateClassification {
  return typeof value === 'string' && value in IVA_RATE_PERCENT;
}

/**
 * One entry of the quotation-level `ivaBreakdown[]` wire contract.
 * `amountCents` is exact integer addition over `includedIvaCents` of every
 * snapshot-complete line mapped to `classification` — no rounding happens
 * at aggregation time (rounding happens once per line at snapshot time).
 */
export interface QuotationIvaBreakdownEntry {
  classification: QuotationIvaClassification;
  amountCents: number;
}
