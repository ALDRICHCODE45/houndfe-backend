-- Transfer receipts retention (T3). Additive.
--   purgeAttempts / lastPurgeErrorAt: a row whose delete keeps failing is
--   retried once per run and scanned after the rows never tried, so it can
--   no longer starve newer due rows.

-- AlterTable
ALTER TABLE "receipt_evidences" ADD COLUMN "purgeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastPurgeErrorAt" TIMESTAMP(3);
