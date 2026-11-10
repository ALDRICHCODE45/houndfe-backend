-- human-intervention / unit 5, slice 5a (contract §3.2, §3.4, §10.1 R2): the
-- bot's DB-backed route budget, per-credential budget overrides and the bot
-- idempotency receipts. Additive only.
--
-- Locks:
--   * "service_rate_buckets" and "chatbot_bot_receipts" are new, empty tables.
--     The receipts FK to "tenants" takes a SHARE ROW EXCLUSIVE lock on
--     "tenants" until the migration commits.
--   * ADD COLUMN "rateLimits" (nullable, no default) is a catalog-only change
--     but takes a brief ACCESS EXCLUSIVE lock on "service_credentials", which
--     every bot request reads; it queues behind open transactions that touched
--     that table.
-- `SET LOCAL lock_timeout` bounds both waits to 5 s, and Prisma runs this file
-- as one transaction, so on timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261110030000_chatbot_request_bot_intake
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "service_credentials" ADD COLUMN "rateLimits" JSONB;

-- CreateTable
CREATE TABLE "service_rate_buckets" (
    "credentialId" TEXT NOT NULL,
    "routeClass" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_rate_buckets_pkey" PRIMARY KEY ("credentialId","routeClass")
);

-- CreateIndex
CREATE INDEX "service_rate_buckets_windowStart_idx" ON "service_rate_buckets"("windowStart");

-- CreateTable
CREATE TABLE "chatbot_bot_receipts" (
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "requestId" TEXT,
    "responseSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_bot_receipts_pkey" PRIMARY KEY ("tenantId","kind","idempotencyKey")
);

-- CreateIndex
CREATE INDEX "chatbot_bot_receipts_tenantId_createdAt_idx" ON "chatbot_bot_receipts"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "chatbot_bot_receipts" ADD CONSTRAINT "chatbot_bot_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The receipt kind is a closed set.
ALTER TABLE "chatbot_bot_receipts"
  ADD CONSTRAINT "chatbot_bot_receipts_kind_chk" CHECK ("kind" IN ('CREATE', 'CANCEL'));
