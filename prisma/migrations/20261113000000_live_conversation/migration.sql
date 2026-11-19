-- human-intervention / unit 11 (contract §4, §12.10, §12.15): the live
-- conversation. Additive: two new tables and one function body. No existing
-- table, column, row or index changes.
--
-- 1. "chatbot_live_sessions": one row per epoch (a conversation going to a
--    human). The partial unique index allows ONE non-ENDED session per
--    conversation, so two claims of the same chat cannot both start. The three
--    partial indexes serve the timeout sweep (STARTING 60 s, ENDING 10 min,
--    ACTIVE idle) with bounded, SKIP LOCKED batches.
-- 2. "chatbot_session_templates": the paid template, once per
--    (request, closed window) (§4.5).
-- 3. "conversation_messages_immutable": a staff message is born without a
--    wamid; the delivery outcome the bot reports assigns it ONCE, together
--    with the forward status move (QUEUED/DEFERRED -> SENT or UNKNOWN). Every
--    other column stays immutable; only STAFF-authored rows may take a wamid,
--    and a wamid never changes once set. The rest of the function is the body
--    of 20261112020000 unchanged.
--
-- Safe on a populated database: the two tables are new and empty (their FKs take
-- a brief SHARE ROW EXCLUSIVE lock on tenants, chatbot_requests and
-- chatbot_conversations; `SET LOCAL lock_timeout` bounds each wait to 5 s and
-- Prisma runs this file as one transaction, so on timeout nothing is applied).
-- Deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261113000000_live_conversation
-- and redeploy.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "chatbot_live_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "endReason" TEXT,
    "staffUserId" TEXT NOT NULL,
    "startSeq" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeAt" TIMESTAMP(3),
    "endingAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastStaffActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_live_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chatbot_live_sessions_state_check"
      CHECK ("state" IN ('STARTING', 'ACTIVE', 'ENDING', 'ENDED')),
    CONSTRAINT "chatbot_live_sessions_reason_check"
      CHECK ("endReason" IS NULL OR "endReason" IN ('FINISHED', 'FORCED', 'IDLE_TIMEOUT', 'START_TIMEOUT')),
    CONSTRAINT "chatbot_live_sessions_epoch_check" CHECK ("epoch" >= 1),
    -- ENDED has a time; ENDING and ENDED have a reason; STARTING and ACTIVE neither.
    CONSTRAINT "chatbot_live_sessions_ended_check"
      CHECK (("state" = 'ENDED') = ("endedAt" IS NOT NULL)),
    CONSTRAINT "chatbot_live_sessions_reason_state_check"
      CHECK (("state" IN ('ENDING', 'ENDED')) = ("endReason" IS NOT NULL))
);

CREATE TABLE "chatbot_session_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "windowClosedAt" TIMESTAMP(3) NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_session_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chatbot_live_sessions_tenantId_conversationId_epoch_key"
  ON "chatbot_live_sessions"("tenantId", "conversationId", "epoch");
CREATE UNIQUE INDEX "chatbot_live_sessions_tenantId_id_key"
  ON "chatbot_live_sessions"("tenantId", "id");
CREATE INDEX "chatbot_live_sessions_tenantId_requestId_epoch_idx"
  ON "chatbot_live_sessions"("tenantId", "requestId", "epoch" DESC);
CREATE UNIQUE INDEX "chatbot_session_templates_tenantId_requestId_windowClosedAt_key"
  ON "chatbot_session_templates"("tenantId", "requestId", "windowClosedAt");

-- One live (non-ENDED) session per conversation.
CREATE UNIQUE INDEX "chatbot_live_sessions_one_live_uq"
  ON "chatbot_live_sessions" ("tenantId", "conversationId") WHERE "state" <> 'ENDED';
-- Timeout sweep (STARTING 60 s, ENDING 10 min, ACTIVE idle 2 h).
CREATE INDEX "chatbot_live_sessions_starting_idx"
  ON "chatbot_live_sessions" ("startedAt") WHERE "state" = 'STARTING';
CREATE INDEX "chatbot_live_sessions_ending_idx"
  ON "chatbot_live_sessions" ("endingAt") WHERE "state" = 'ENDING';
CREATE INDEX "chatbot_live_sessions_active_idx"
  ON "chatbot_live_sessions" ("activeAt") WHERE "state" = 'ACTIVE';

ALTER TABLE "chatbot_live_sessions" ADD CONSTRAINT "chatbot_live_sessions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chatbot_live_sessions" ADD CONSTRAINT "chatbot_live_sessions_tenantId_requestId_fkey"
  FOREIGN KEY ("tenantId", "requestId") REFERENCES "chatbot_requests"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chatbot_live_sessions" ADD CONSTRAINT "chatbot_live_sessions_tenantId_conversationId_fkey"
  FOREIGN KEY ("tenantId", "conversationId") REFERENCES "chatbot_conversations"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chatbot_session_templates" ADD CONSTRAINT "chatbot_session_templates_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chatbot_session_templates" ADD CONSTRAINT "chatbot_session_templates_tenantId_requestId_fkey"
  FOREIGN KEY ("tenantId", "requestId") REFERENCES "chatbot_requests"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutability: a STAFF message takes its wamid once, with the status move.
CREATE OR REPLACE FUNCTION "conversation_messages_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Nested AND the tenant no longer exists: only the tenant cascade is
    -- exempt (kept from 20261112030000; a DELETE issued by another trigger
    -- while the tenant exists is still rejected).
    IF pg_trigger_depth() > 1
       AND NOT EXISTS (SELECT 1 FROM "tenants" WHERE "id" = OLD."tenantId") THEN
      RETURN OLD;
    END IF;
    IF coalesce(current_setting('houndfe.conversation_retention', true), '') = 'on'
       AND OLD."purgeAfter" < now() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'conversation_messages are immutable (DELETE rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (to_jsonb(NEW) - 'deliveryStatus') = (to_jsonb(OLD) - 'deliveryStatus')
     AND "conversation_delivery_can_advance"(OLD."deliveryStatus"::text, NEW."deliveryStatus"::text) THEN
    RETURN NEW;
  END IF;
  -- Unit 11: the wamid of a staff message, assigned once by the delivery outcome.
  IF OLD."waMessageId" IS NULL AND NEW."waMessageId" IS NOT NULL
     AND OLD."author" = 'STAFF' AND OLD."direction" = 'OUT'
     AND (to_jsonb(NEW) - 'deliveryStatus' - 'waMessageId')
       = (to_jsonb(OLD) - 'deliveryStatus' - 'waMessageId')
     AND "conversation_delivery_can_advance"(OLD."deliveryStatus"::text, NEW."deliveryStatus"::text) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'conversation_messages are immutable (UPDATE rejected)'
    USING ERRCODE = 'restrict_violation';
END;
$$;
