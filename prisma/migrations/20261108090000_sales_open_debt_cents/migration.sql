-- GET /sales debt sort + filter summary. Additive, no data rewrite.
--   openDebtCents: generated (STORED) open debt — 0 for CANCELED sales even
--   when the stored debtCents was kept (cancel only zeroes CREDIT debt).
--   Postgres computes it on every write; the application never writes it.

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "openDebtCents" INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN "status" = 'CANCELED' THEN 0 ELSE "debtCents" END) STORED;

-- CreateIndex
CREATE INDEX "sales_tenantId_openDebtCents_idx" ON "sales"("tenantId", "openDebtCents");
