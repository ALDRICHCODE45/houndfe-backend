-- Partial refund settlements (partial-refund-settlements / rfs-1).
--
-- Additive, non-destructive foundation for the append-only settlement ledger:
--   1. `sale_refunds.settledCents` — derived counter of already-returned
--      money. NOT NULL with a DB-level DEFAULT 0, so every pre-existing
--      obligation stays valid without a bespoke historical backfill and
--      future inserts remain valid when the caller omits the field.
--   2. `sale_refund_settlements` — one immutable row per real money return.
--      `settledAt` is required and deliberately carries no DB default: it is
--      the client-supplied cash event date, never the migration time.
--
-- Ordering matches Prisma's generator (AlterTable, then CreateTable, then
-- indexes, then foreign keys).
--
-- Rollback: `DROP TABLE "sale_refund_settlements";` then
-- `ALTER TABLE "sale_refunds" DROP COLUMN "settledCents";`. Both statements
-- touch only objects introduced here.

-- AlterTable
ALTER TABLE "sale_refunds" ADD COLUMN     "settledCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sale_refund_settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleRefundId" TEXT NOT NULL,
    "settledByUserId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "method" "SalePaymentMethod" NOT NULL,
    "reference" TEXT,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_refund_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_refunds_tenantId_id_key" ON "sale_refunds"("tenantId", "id");

-- CreateIndex
-- Tenant-scoped refund lookup: every settlement read is driven by the
-- obligation id and must carry the tenant predicate.
CREATE INDEX "sale_refund_settlements_tenantId_saleRefundId_idx" ON "sale_refund_settlements"("tenantId", "saleRefundId");

-- CreateIndex
-- Event-time reads: cash analytics groups returns by the real return date.
CREATE INDEX "sale_refund_settlements_tenantId_settledAt_idx" ON "sale_refund_settlements"("tenantId", "settledAt");

-- AddForeignKey
ALTER TABLE "sale_refund_settlements" ADD CONSTRAINT "sale_refund_settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_refund_settlements" ADD CONSTRAINT "sale_refund_settlements_tenantId_saleRefundId_fkey" FOREIGN KEY ("tenantId", "saleRefundId") REFERENCES "sale_refunds"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull keeps the cash audit trail intact if the acting user is removed.
ALTER TABLE "sale_refund_settlements" ADD CONSTRAINT "sale_refund_settlements_settledByUserId_fkey" FOREIGN KEY ("settledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
