-- pdf-a4-redesign T6 (S4): per-tenant consecutive cash-closing folio.
-- Additive only: a new counter table, no backfill and no rewrite of the
-- folios already stored in "cash_closings" (those keep their UUID-shaped
-- value; the unique ("tenantId", "folio") index is untouched).
--
-- Rollback (manual, only before any closing used the counter):
--   DROP TABLE "cash_closing_folio_counters";

-- CreateTable
CREATE TABLE "cash_closing_folio_counters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_closing_folio_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_closing_folio_counters_tenantId_key" ON "cash_closing_folio_counters"("tenantId");

-- AddForeignKey
ALTER TABLE "cash_closing_folio_counters" ADD CONSTRAINT "cash_closing_folio_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
