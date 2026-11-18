-- quotation-sale-conversion / T1 — quotation ↔ POS draft sale link.
--
-- Additive only:
--   1. `QuotationStatus` gains CONVERTED_TO_SALE, appended LAST so every
--      existing row and the column default (DRAFT) keep their value. The new
--      member is not referenced anywhere in this file (PostgreSQL forbids
--      using a value added by ADD VALUE inside the same transaction).
--   2. `quotations.convertedSaleId` (nullable, UNIQUE) + `convertedAt`
--      (nullable). Existing rows stay NULL; there is no backfill.
--   3. FK `convertedSaleId → sales.id ON DELETE SET NULL`: discarding the
--      draft sale never blocks the POS delete path; the quotation keeps
--      CONVERTED_TO_SALE with a NULL link (convertible again).
--
-- Why the link lives on `quotations` (not `sales.sourceQuotationId`): the
-- status flip and the link are written in ONE row update guarded by a row
-- lock + compare-and-set, so the quotation row is the single concurrency
-- anchor, and the hot `sales` table is not rewritten or indexed. Sale reads
-- resolve the back-relation through the unique index.
--
-- Locks: ADD COLUMN (nullable, no default) is metadata-only; the UNIQUE index
-- and the FK need brief ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE locks on
-- "quotations" and a SHARE ROW EXCLUSIVE lock on "sales" while the (all-NULL)
-- column is validated. `SET LOCAL lock_timeout` bounds every wait to 5 s so a
-- long-running transaction cannot stall the deploy behind a lock queue.
--
-- Rollback (manual): DROP the FK, the index and both columns. PostgreSQL has
-- no DROP VALUE; leaving CONVERTED_TO_SALE in the enum is harmless once no
-- row uses it (recreate the type only if it must disappear).
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "QuotationStatus" ADD VALUE 'CONVERTED_TO_SALE';

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN "convertedSaleId" TEXT,
ADD COLUMN "convertedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "quotations_convertedSaleId_key" ON "quotations"("convertedSaleId");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_convertedSaleId_fkey" FOREIGN KEY ("convertedSaleId") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;
