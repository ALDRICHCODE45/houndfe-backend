-- Additive receipt review schema foundation.
ALTER TABLE "receipt_evidences" ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "customers" ADD COLUMN "isTrusted" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "receipt_evidences_tenantId_status_idx" ON "receipt_evidences"("tenantId", "status");

ALTER TABLE "receipt_evidences"
  ADD CONSTRAINT "receipt_evidences_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
