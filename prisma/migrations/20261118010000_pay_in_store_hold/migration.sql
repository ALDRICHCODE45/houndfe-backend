-- pay-in-store-pickup / T1 — counter-payment hold of bot PICKUP sales.
--
-- Additive only:
--   1. `SaleCancelReason` gains HOLD_EXPIRED, appended LAST. The new member is
--      not referenced anywhere in this file (PostgreSQL forbids using a value
--      added by ADD VALUE inside the same transaction); only the T2 expiry
--      sweep writes it, in a later deploy.
--   2. New enum `SalePaymentIntent` (IN_STORE).
--   3. `sales` hold columns: "paymentIntent", "holdExpiresAt",
--      "holdReminderAt" (nullable, no default) and "holdStage" SMALLINT
--      DEFAULT 0 / "holdVersion" INTEGER DEFAULT 0 (NOT NULL). Existing rows
--      keep "paymentIntent" / "holdExpiresAt" NULL: no CREDIT pickup sale is
--      put on a deadline (and later auto-cancelled) by this deploy.
--   4. Partial index "sales_hold_due_idx" on "holdExpiresAt" over the open
--      holds only (CONFIRMED, stage < 2, deadline set). The T2 sweep scans
--      it for both stages: the reminder is always exactly 3 h before the
--      deadline, so a reminder-due query can bound "holdExpiresAt" <=
--      now() + 3 h and stay on this index.
--
-- Locks: ADD COLUMN with no default or a constant default is metadata-only
-- (PostgreSQL 11+). CREATE INDEX (non-concurrent: Prisma runs the migration
-- in one transaction) holds a SHARE lock on "sales" while it scans the table;
-- the predicate matches no existing row, so the build is a single sequential
-- pass. `SET LOCAL lock_timeout` bounds every lock wait to 5 s so a
-- long-running transaction cannot stall the deploy behind a lock queue.
--
-- Rollback (manual): DROP INDEX "sales_hold_due_idx"; DROP the five columns;
-- DROP TYPE "SalePaymentIntent". PostgreSQL has no DROP VALUE; leaving
-- HOLD_EXPIRED in "SaleCancelReason" is harmless once no row uses it.
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "SaleCancelReason" ADD VALUE 'HOLD_EXPIRED';

-- CreateEnum
CREATE TYPE "SalePaymentIntent" AS ENUM ('IN_STORE');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "paymentIntent" "SalePaymentIntent",
ADD COLUMN "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN "holdReminderAt" TIMESTAMP(3),
ADD COLUMN "holdStage" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN "holdVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex (partial; not expressible in schema.prisma, the migration is
-- authoritative)
CREATE INDEX "sales_hold_due_idx" ON "sales"("holdExpiresAt")
  WHERE "status" = 'CONFIRMED' AND "holdStage" < 2 AND "holdExpiresAt" IS NOT NULL;
