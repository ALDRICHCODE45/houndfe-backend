-- AlterTable
ALTER TABLE "sale_payments"
ADD COLUMN "reference" TEXT;

-- Backfill existing metadata reference values
UPDATE "sale_payments"
SET "reference" = NULLIF("metadataJson"->>'reference', '')
WHERE "metadataJson" IS NOT NULL
  AND "reference" IS NULL;
