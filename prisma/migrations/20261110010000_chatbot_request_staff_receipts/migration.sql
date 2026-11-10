-- human-intervention / unit 2, slice 2b (contract §6.5, §12.12): staff command
-- idempotency receipts, one row per (tenant, actor, Idempotency-Key). Additive
-- only: one new table.
--
-- Locks: the CREATE TABLE/INDEX target an empty new table. The FK takes a
-- SHARE ROW EXCLUSIVE lock on "tenants" until the migration commits; it waits
-- behind (and queues writers behind) open transactions on "tenants".
-- `SET LOCAL lock_timeout` bounds that wait to 5 s, and Prisma runs this file
-- as one transaction, so on timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261110010000_chatbot_request_staff_receipts
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "staff_command_receipts" (
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "responseSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_command_receipts_pkey" PRIMARY KEY ("tenantId","actorId","idempotencyKey")
);

-- CreateIndex
CREATE INDEX "staff_command_receipts_tenantId_createdAt_idx" ON "staff_command_receipts"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "staff_command_receipts" ADD CONSTRAINT "staff_command_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
