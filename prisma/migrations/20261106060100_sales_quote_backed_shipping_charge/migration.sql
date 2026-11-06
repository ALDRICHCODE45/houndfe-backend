-- shipping-zones / T7 (S8): a shipping charge is now justified either by the
-- deprecated per-charge human approval or by a verified backend quote
-- (sales.shippingQuoteRecordId). Exactly one of the two backs a charged sale.
ALTER TABLE "sales" DROP CONSTRAINT "sales_shipping_charge_requires_approval";

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_shipping_charge_requires_approval"
  CHECK (
    "shippingChargeCents" = 0
    OR "shippingApprovalId" IS NOT NULL
    OR "shippingQuoteRecordId" IS NOT NULL
  ),
  ADD CONSTRAINT "sales_shipping_approval_xor_quote"
  CHECK ("shippingApprovalId" IS NULL OR "shippingQuoteRecordId" IS NULL);
