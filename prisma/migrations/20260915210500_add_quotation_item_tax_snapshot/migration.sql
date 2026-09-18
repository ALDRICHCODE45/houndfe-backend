-- Add parent-product IVA snapshot columns to quotation items.
-- Additive-only: three nullable columns, no defaults, no indexes, no data
-- updates. Existing rows remain NULL — there is no backfill, by design
-- (invariant d: historic SENT/EXPIRED rows are never rewritten).
-- `NOT_TAXABLE` is never stored: `ivaRateClassification` keeps the parent
-- product's raw IvaRate value while `chargeProductTaxesSnapshot = false`
-- carries the not-taxable intent.
-- "quotations"."taxRate" is intentionally untouched (deprecated, kept).

-- AlterTable
ALTER TABLE "quotation_items" ADD COLUMN     "taxableBaseCents" INTEGER;
ALTER TABLE "quotation_items" ADD COLUMN     "ivaRateClassification" "IvaRate";
ALTER TABLE "quotation_items" ADD COLUMN     "chargeProductTaxesSnapshot" BOOLEAN;
