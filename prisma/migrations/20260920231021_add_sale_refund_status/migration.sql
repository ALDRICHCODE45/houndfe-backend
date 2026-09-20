-- Pending refund obligations (pending-refund-obligations / prf-1).
--
-- A `SaleRefund` row records the obligation to return paid money; it has
-- never carried an explicit lifecycle. This migration is fully additive and
-- makes that obligation explicit as PENDING.
--
-- The column is NOT NULL with a DB-level DEFAULT, so every pre-existing
-- `sale_refunds` row becomes PENDING without bespoke backfill logic, and the
-- default keeps future inserts valid even when the caller omits the field.
-- Reversible via `ALTER TABLE "sale_refunds" DROP COLUMN "status";`
-- followed by `DROP TYPE "SaleRefundStatus";`.

-- CreateEnum
CREATE TYPE "SaleRefundStatus" AS ENUM ('PENDING');

-- AlterTable
ALTER TABLE "sale_refunds" ADD COLUMN     "status" "SaleRefundStatus" NOT NULL DEFAULT 'PENDING';
