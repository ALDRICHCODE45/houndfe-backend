-- Transfer receipts uploaded by the chatbot and stored privately (T1).
-- Additive: existing rows keep their mediaUrl and declaredAmountCents; new
-- private uploads carry storage metadata instead of a URL.

-- CreateEnum
CREATE TYPE "ReceiptPreviewStatus" AS ENUM ('READY', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "receipt_evidences" ALTER COLUMN "mediaUrl" DROP NOT NULL,
ALTER COLUMN "declaredAmountCents" DROP NOT NULL,
ADD COLUMN "extracted" JSONB,
ADD COLUMN "storageKey" TEXT,
ADD COLUMN "mimeType" TEXT,
ADD COLUMN "sizeBytes" INTEGER,
ADD COLUMN "sha256" TEXT,
ADD COLUMN "previewKey" TEXT,
ADD COLUMN "previewMimeType" TEXT,
ADD COLUMN "previewStatus" "ReceiptPreviewStatus",
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "mismatch" JSONB;

-- Every receipt points at evidence: a legacy URL or a private object.
ALTER TABLE "receipt_evidences" ADD CONSTRAINT "receipt_evidences_media_source_check"
  CHECK ("mediaUrl" IS NOT NULL OR "storageKey" IS NOT NULL);

-- CreateIndex (NULL keys stay distinct, so legacy rows never collide)
CREATE UNIQUE INDEX "receipt_evidences_tenantId_saleId_idempotencyKey_key" ON "receipt_evidences"("tenantId", "saleId", "idempotencyKey");
