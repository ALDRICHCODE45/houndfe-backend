-- Transfer receipts review side (T2). Additive.
--   customerReason: customer-safe rejection text (rejectionReason stays internal).
--   purgedAt: set by the 5-year retention job after it deleted the stored
--   objects; the row and its amounts stay for accounting.

-- AlterTable
ALTER TABLE "receipt_evidences" ADD COLUMN "customerReason" TEXT,
ADD COLUMN "purgedAt" TIMESTAMP(3);

-- A purged receipt has neither a URL nor a storage key any more.
ALTER TABLE "receipt_evidences" DROP CONSTRAINT "receipt_evidences_media_source_check";
ALTER TABLE "receipt_evidences" ADD CONSTRAINT "receipt_evidences_media_source_check"
  CHECK ("mediaUrl" IS NOT NULL OR "storageKey" IS NOT NULL OR "purgedAt" IS NOT NULL);

-- CreateIndex (retention scan by upload age)
CREATE INDEX "receipt_evidences_createdAt_idx" ON "receipt_evidences"("createdAt");
