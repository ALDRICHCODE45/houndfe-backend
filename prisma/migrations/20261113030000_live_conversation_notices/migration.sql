-- Unit 11 (T11d, proposal §4.6, §5.1): the live conversation notices
-- ("el cliente escribió" and "sin contestar en 5 / 15 min").
--
-- Two small columns on "chatbot_live_sessions" keep the sweep's notice phase
-- durable and shared by replicas, with no in-memory state:
--   "customerNoticeAt"  the customer message (its instant) the notices were last
--                       issued for; a newer customer message starts over;
--   "unansweredLevel"   the unanswered notice already issued for that message:
--                       0 = none, 5 = attendee notified, 15 = reassigners too.
-- Both are only written by the sweep. No table, no index and no trigger change:
-- the phase reads ACTIVE sessions (a handful per tenant) through the existing
-- "chatbot_live_sessions_active_idx" partial index.
--
-- Safe on a populated database: a nullable column and a constant default are
-- metadata-only (PostgreSQL 11+), the CHECK scans one small table, and
-- `SET LOCAL lock_timeout` bounds each wait to 5 s. Idempotent (IF NOT EXISTS /
-- DROP IF EXISTS) so `prisma migrate resolve --rolled-back
-- 20261113030000_live_conversation_notices` and a redeploy can run it again.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "chatbot_live_sessions"
  DROP CONSTRAINT IF EXISTS "chatbot_live_sessions_unanswered_level_check",
  ADD COLUMN IF NOT EXISTS "customerNoticeAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "unansweredLevel" SMALLINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "chatbot_live_sessions_unanswered_level_check"
    CHECK ("unansweredLevel" IN (0, 5, 15));
