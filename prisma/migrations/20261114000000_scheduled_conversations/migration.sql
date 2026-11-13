-- Unit 14 (proposal §4.9, §10 row 14, §10.1 "Agenda"): scheduled conversations.
--
-- 1. "scheduled_slot_counters": one row per (tenant, block start) that was ever
--    booked. "booked" is written only by an atomic upsert that refuses to pass
--    the tenant's maxScheduledPerSlot, so two bookings for the last seat can
--    never both win (the row lock serializes them). The primary key serves the
--    slot listing (a range read).
-- 2. Four columns on "chatbot_requests" (all metadata-only: nullable or with a
--    constant default, PostgreSQL 11+):
--      "scheduleVersion"  monotonic per request (S20 6)
--      "scheduleStage"    0 reminder due, 1 "solicitud nueva" notice due, 2 done
--      "scheduleDueAt"    when the sweep must look at the row; NULL = nothing
-- 3. Two partial indexes on "chatbot_requests":
--      chatbot_requests_schedule_due_idx   the sweep reads ONLY due rows
--      chatbot_requests_open_scheduled_uq  one open scheduled request per
--                                           (customer key, subtype) (Q4/S19);
--                                           backstop of the application check
-- 4. One partial unique index on "chatbot_feed_items": a reminder exists once
--    per (request, scheduled time); a retry or a second sweep cannot repeat it.
-- 5. The realtime trigger now announces RESCHEDULED as 'request.updated' (the
--    inbox row changes: scheduledFor, needsReschedule). Same function as
--    20261112050000 plus one WHEN.
-- 6. The bot receipt kind is a closed set (CHECK of 20261110030000): it now
--    also allows RESCHEDULE (the bot's reschedule receipt, keyed by the raw
--    X-Idempotency-Key). Widening cannot fail validation, so the constraint is
--    added NOT VALID (no table scan under the exclusive lock) and validated
--    afterwards (SHARE UPDATE EXCLUSIVE only).
--
-- Existing rows have no scheduledFor, so nothing is scheduled or indexed by
-- the new indexes. Safe on a populated database; SET LOCAL lock_timeout bounds
-- each wait to 5 s and Prisma runs the file as one transaction. Idempotent
-- (IF NOT EXISTS / OR REPLACE) so `prisma migrate resolve --rolled-back
-- 20261114000000_scheduled_conversations` and a redeploy can run it again.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "scheduled_slot_counters" (
  "tenantId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "booked" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "scheduled_slot_counters_pkey" PRIMARY KEY ("tenantId", "startsAt"),
  CONSTRAINT "scheduled_slot_counters_booked_check" CHECK ("booked" >= 0),
  CONSTRAINT "scheduled_slot_counters_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "chatbot_requests"
  DROP CONSTRAINT IF EXISTS "chatbot_requests_schedule_stage_check",
  ADD COLUMN IF NOT EXISTS "scheduleVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scheduleStage" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scheduleDueAt" TIMESTAMP(3),
  ADD CONSTRAINT "chatbot_requests_schedule_stage_check"
    CHECK ("scheduleStage" IN (0, 1, 2));

CREATE INDEX IF NOT EXISTS "chatbot_requests_schedule_due_idx"
  ON "chatbot_requests" ("scheduleDueAt")
  WHERE "scheduleDueAt" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_requests_open_scheduled_uq"
  ON "chatbot_requests" ("tenantId", "customerKey", "subtype")
  WHERE "scheduledFor" IS NOT NULL AND "status" IN ('NEW', 'IN_PROGRESS');

CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_feed_items_scheduled_reminder_uq"
  ON "chatbot_feed_items" ("tenantId", "requestId", (("payload" ->> 'scheduleVersion')))
  WHERE "type" = 'conversation.scheduled_reminder';

ALTER TABLE "chatbot_bot_receipts"
  DROP CONSTRAINT IF EXISTS "chatbot_bot_receipts_kind_chk",
  ADD CONSTRAINT "chatbot_bot_receipts_kind_chk"
    CHECK ("kind" IN ('CREATE', 'CANCEL', 'RESCHEDULE')) NOT VALID;
ALTER TABLE "chatbot_bot_receipts" VALIDATE CONSTRAINT "chatbot_bot_receipts_kind_chk";

CREATE OR REPLACE FUNCTION "chatbot_request_events_realtime"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stream_type text;
BEGIN
  IF coalesce(NEW."data" ->> 'backfilled', '') = 'true' THEN
    RETURN NULL;
  END IF;
  stream_type := CASE NEW."type"::text
    WHEN 'CREATED' THEN 'request.created'
    WHEN 'CLAIMED' THEN 'request.claimed'
    WHEN 'RELEASED' THEN 'request.released'
    WHEN 'AUTO_RELEASED' THEN 'request.released'
    WHEN 'REASSIGNED' THEN 'request.reassigned'
    WHEN 'RESOLVED' THEN 'request.resolved'
    WHEN 'REPLIED' THEN 'request.resolved'
    WHEN 'CANCELLED' THEN 'request.cancelled'
    WHEN 'RESCHEDULED' THEN 'request.updated'
    WHEN 'MERGED' THEN CASE WHEN NEW."data" ->> 'role' = 'SOURCE'
                            THEN 'request.cancelled' END
    WHEN 'CUSTOMER_LINKED' THEN 'request.updated'
    WHEN 'SLA_MILESTONE' THEN CASE WHEN NEW."data" ->> 'milestone' = 'OVERDUE'
                                   THEN 'request.overdue' ELSE 'request.updated' END
    ELSE NULL
  END;
  IF stream_type IS NULL THEN
    RETURN NULL;
  END IF;
  -- Same key text as the application writer (realtimeLockKey).
  PERFORM pg_advisory_xact_lock(hashtextextended('realtime:' || NEW."tenantId", 0));
  INSERT INTO "realtime_events" ("tenantId", "userId", "type", "requestId", "payload")
  VALUES (NEW."tenantId", NULL, stream_type, NEW."requestId",
          jsonb_build_object('version', NEW."version", 'cause', NEW."type"::text));
  PERFORM pg_notify('realtime_events', NEW."tenantId");
  RETURN NULL;
END;
$$;
