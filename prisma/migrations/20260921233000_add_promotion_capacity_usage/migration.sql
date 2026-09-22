-- promotion-capacity-alerts / pca-1a — persistence foundation for promotion
-- product-unit capacity. Schema-only: no domain/service code writes here yet.
--
-- Additive and safe for populated databases:
--   `promotions.maxProductUnits` (nullable cap; NULL = unlimited, the value
--   every existing row already has) and `promotions.consumedProductUnits`
--   (NOT NULL DEFAULT 0 — the DB default IS the backfill, applied by PG11+
--   without a table rewrite, and future inserts stay valid).
--   `promotion_usages` holds one aggregate row per (tenant, sale, promotion);
--   full cancellation stamps `restoredAt` instead of deleting, so the counter
--   and the audit trail stay reconcilable.
--   `(tenantId, id)` composite uniqueness on `sales` and `promotions` lets the
--   usage FKs carry tenant ownership, so the DB — not the application — rejects
--   a cross-tenant usage row.
-- No historical backfill: capacity begins at feature deployment, so existing
-- sales are deliberately NOT converted into ledger rows.
--
-- Rollback (manual; only objects introduced by this migration):
--   ALTER TABLE "promotion_usages" DROP CONSTRAINT "promotion_usages_units_positive";
--   DROP TABLE "promotion_usages";
--   DROP INDEX "promotions_tenantId_id_key";
--   DROP INDEX "sales_tenantId_id_key";
--   ALTER TABLE "promotions" DROP CONSTRAINT "promotions_consumed_within_max_product_units";
--   ALTER TABLE "promotions" DROP CONSTRAINT "promotions_consumed_product_units_nonnegative";
--   ALTER TABLE "promotions" DROP CONSTRAINT "promotions_max_product_units_positive";
--   ALTER TABLE "promotions" DROP COLUMN "consumedProductUnits";
--   ALTER TABLE "promotions" DROP COLUMN "maxProductUnits";
-- Dropping "promotion_usages" also drops its own pkey, unique/index constraints
-- and FKs, so they need no separate statement above.

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "maxProductUnits" INTEGER;
ALTER TABLE "promotions" ADD COLUMN     "consumedProductUnits" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_id_key" ON "sales"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_tenantId_id_key" ON "promotions"("tenantId", "id");

-- CreateTable
CREATE TABLE "promotion_usages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One aggregate usage row per sale/promotion pair.
CREATE UNIQUE INDEX "promotion_usages_tenantId_saleId_promotionId_key" ON "promotion_usages"("tenantId", "saleId", "promotionId");

-- CreateIndex
-- Capacity reconciliation: sum active units per promotion.
CREATE INDEX "promotion_usages_tenantId_promotionId_restoredAt_idx" ON "promotion_usages"("tenantId", "promotionId", "restoredAt");

-- CreateIndex
-- Full-cancellation restore path: load every usage row of a sale.
CREATE INDEX "promotion_usages_tenantId_saleId_idx" ON "promotion_usages"("tenantId", "saleId");

-- CheckConstraint
-- Capacity invariants live in the database, not only in application code.
-- Existing rows pass trivially: maxProductUnits is NULL and consumed is 0.
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_max_product_units_positive"
    CHECK ("maxProductUnits" IS NULL OR "maxProductUnits" > 0);

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_consumed_product_units_nonnegative"
    CHECK ("consumedProductUnits" >= 0);

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_consumed_within_max_product_units"
    CHECK ("maxProductUnits" IS NULL OR "consumedProductUnits" <= "maxProductUnits");

ALTER TABLE "promotion_usages"
  ADD CONSTRAINT "promotion_usages_units_positive"
    CHECK ("units" > 0);

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "promotion_usages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Composite ownership: the referenced (tenantId, id) is unique per the indexes
-- above, so a usage row can never point at another tenant's sale.
ALTER TABLE "promotion_usages" ADD CONSTRAINT "promotion_usages_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "promotion_usages_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "promotions"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
