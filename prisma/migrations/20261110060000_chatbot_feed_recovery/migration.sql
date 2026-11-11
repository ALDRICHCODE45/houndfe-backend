-- human-intervention / unit 5, slice 5c (contract §3.3, §3.9): the recovery
-- route of the bot after 410 CURSOR_EXPIRED and the DEFERRED_HUMAN_SESSION
-- delivery outcome. No table and no column changes: a closed-set CHECK is
-- widened, one tiny partial index is replaced, and two partial indexes are
-- added.
--
-- 1. DEFERRED_HUMAN_SESSION (the conversation is in HUMAN mode and the bot
--    holds the delivery): a non-terminal outcome exactly like
--    DEFERRED_WINDOW_CLOSED. Both CHECKs of "chatbot_feed_items" are rebuilt
--    to know it (the old ones are a strict subset, so every existing row
--    passes), and the pending-deliveries partial index covers both deferrals.
-- 2. Recovery (`GET /chatbot-api/requests?status=open&updatedSince=`): keyset
--    pages by (updatedAt, id), one branch for the open requests and one for the
--    requests closed since the bot's last known instant, each an ordered index
--    range scan (no sort, no scan of the tenant's history).
--
-- Locks (the migration runs as one transaction):
--   * ALTER TABLE "chatbot_feed_items" (the CHECK swap) takes ACCESS EXCLUSIVE
--     and validates the new CHECKs with one scan of the table (up to ~200k rows
--     of retained feed: tens of milliseconds).
--   * CREATE/DROP INDEX on "chatbot_feed_items" and CREATE INDEX on
--     "chatbot_requests" take SHARE (block writes, not reads) while they build.
--     The feed deferral index holds only deferred items; the two request
--     indexes are built from one scan of the table.
-- `SET LOCAL lock_timeout` bounds the wait for those locks to 5 s, so on timeout
-- nothing is applied. Deploy note: deploy at low traffic. If it fails on lock
-- timeout, run
--   prisma migrate resolve --rolled-back 20261110060000_chatbot_feed_recovery
-- and redeploy. CREATE INDEX CONCURRENTLY cannot run inside Prisma's migration
-- transaction, which is why this is a short blocking build at low traffic.

SET LOCAL lock_timeout = '5s';

-- 1. The outcome set and the ack state.
ALTER TABLE "chatbot_feed_items"
  DROP CONSTRAINT "chatbot_feed_items_outcome_chk",
  DROP CONSTRAINT "chatbot_feed_items_ack_state_chk",
  ADD CONSTRAINT "chatbot_feed_items_outcome_chk" CHECK (
    "outcome" IS NULL OR "outcome" IN
      ('PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'DEFERRED_WINDOW_CLOSED',
       'DEFERRED_HUMAN_SESSION', 'STALE')
  ),
  -- A deferral is the only outcome without a terminal ack.
  ADD CONSTRAINT "chatbot_feed_items_ack_state_chk" CHECK (
    ("outcome" IS NULL AND "ackedAt" IS NULL AND "attemptId" IS NULL AND "evidenceHash" IS NULL)
    OR ("outcome" IS NOT NULL AND "attemptId" IS NOT NULL AND "evidenceHash" IS NOT NULL
        AND ("ackedAt" IS NULL) = ("outcome" IN ('DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION')))
  );

-- Pending deliveries (§4.5): the few items a bot holds, by conversation. The
-- old index only knew the window deferral.
DROP INDEX "chatbot_feed_items_deferred_idx";
CREATE INDEX "chatbot_feed_items_deferred_idx"
  ON "chatbot_feed_items" ("tenantId", "conversationRef", "cursor")
  WHERE "outcome" IN ('DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION') AND "ackedAt" IS NULL;

-- 2. Recovery pages, `ORDER BY "updatedAt", "id"` per tenant.
CREATE INDEX "chatbot_requests_open_recovery_idx"
  ON "chatbot_requests" ("tenantId", "updatedAt", "id")
  WHERE "status" IN ('NEW', 'IN_PROGRESS');

-- A request closed at or after an instant was last updated at or after it
-- (`updatedAt` >= `closedAt`), so the closed branch ranges on `updatedAt` too.
CREATE INDEX "chatbot_requests_closed_recovery_idx"
  ON "chatbot_requests" ("tenantId", "updatedAt", "id")
  WHERE "status" IN ('RESOLVED', 'CANCELLED');
