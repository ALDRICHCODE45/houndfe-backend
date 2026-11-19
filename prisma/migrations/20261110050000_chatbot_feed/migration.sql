-- human-intervention / unit 5, slice 5b (contract §3.3, §10.1 R7): the bot feed
-- ("chatbot_feed_items") and the retention watermark behind 410 CURSOR_EXPIRED
-- ("chatbot_feed_retention"). Additive only: two new, empty tables.
--
-- Locks:
--   * The tenant FKs take a brief SHARE ROW EXCLUSIVE lock on "tenants" and the
--     feed's (tenantId, requestId) FK takes one on "chatbot_requests" until the
--     migration commits. Validation scans empty tables, so each lasts
--     milliseconds, but it must wait for open transactions on those tables.
-- `SET LOCAL lock_timeout` bounds that wait to 5 s, and Prisma runs this file as
-- one transaction, so on timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261110050000_chatbot_feed
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "chatbot_feed_items" (
    "cursor" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deliveryId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "conversationRef" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "attemptId" TEXT,
    "evidenceHash" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,

    CONSTRAINT "chatbot_feed_items_pkey" PRIMARY KEY ("cursor")
);

-- CreateTable
CREATE TABLE "chatbot_feed_retention" (
    "tenantId" TEXT NOT NULL,
    "purgedThroughCursor" BIGINT NOT NULL,

    CONSTRAINT "chatbot_feed_retention_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "chatbot_feed_items_deliveryId_key" ON "chatbot_feed_items"("deliveryId");

-- CreateIndex: the feed read, `WHERE tenantId = $1 AND cursor > $2 ORDER BY cursor`.
CREATE INDEX "chatbot_feed_items_tenantId_cursor_idx" ON "chatbot_feed_items"("tenantId", "cursor");

-- CreateIndex
CREATE INDEX "chatbot_feed_items_tenantId_requestId_idx" ON "chatbot_feed_items"("tenantId", "requestId");

-- CreateIndex: the retention purge.
CREATE INDEX "chatbot_feed_items_createdAt_idx" ON "chatbot_feed_items"("createdAt");

-- AddForeignKey
ALTER TABLE "chatbot_feed_items" ADD CONSTRAINT "chatbot_feed_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_feed_items" ADD CONSTRAINT "chatbot_feed_items_tenantId_requestId_fkey" FOREIGN KEY ("tenantId", "requestId") REFERENCES "chatbot_requests"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_feed_retention" ADD CONSTRAINT "chatbot_feed_retention_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pending deliveries (§4.5): the few items a bot deferred because the 24 h
-- window was closed, by conversation.
CREATE INDEX "chatbot_feed_items_deferred_idx"
  ON "chatbot_feed_items" ("tenantId", "conversationRef", "cursor")
  WHERE "outcome" = 'DEFERRED_WINDOW_CLOSED' AND "ackedAt" IS NULL;

-- The outcome set is closed; a terminal outcome (ackedAt) is never the
-- deferral, and any outcome carries the attempt identity it was recorded under.
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_outcome_chk" CHECK (
    "outcome" IS NULL OR "outcome" IN
      ('PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'DEFERRED_WINDOW_CLOSED', 'STALE')
  ),
  ADD CONSTRAINT "chatbot_feed_items_ack_state_chk" CHECK (
    ("outcome" IS NULL AND "ackedAt" IS NULL AND "attemptId" IS NULL AND "evidenceHash" IS NULL)
    OR ("outcome" IS NOT NULL AND "attemptId" IS NOT NULL AND "evidenceHash" IS NOT NULL
        AND ("ackedAt" IS NULL) = ("outcome" = 'DEFERRED_WINDOW_CLOSED'))
  );
