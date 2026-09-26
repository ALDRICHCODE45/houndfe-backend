-- A nullable approval keeps legacy/POS sales unchanged. PostgreSQL treats
-- NULL values as distinct in the composite unique index, allowing many
-- no-shipping sales while consuming each tenant approval at most once.
ALTER TABLE "sales"
  ADD COLUMN "shippingChargeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "shippingApprovalId" TEXT,
  ADD COLUMN "shippingQuoteId" TEXT;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_shipping_charge_nonnegative"
  CHECK ("shippingChargeCents" >= 0),
  ADD CONSTRAINT "sales_shipping_charge_requires_approval"
  CHECK ("shippingChargeCents" = 0 OR "shippingApprovalId" IS NOT NULL),
  ADD CONSTRAINT "sales_shipping_approval_nonempty"
  CHECK ("shippingApprovalId" IS NULL OR length(trim("shippingApprovalId")) > 0);

CREATE UNIQUE INDEX "sales_tenant_shipping_approval_unique"
  ON "sales" ("tenantId", "shippingApprovalId");
