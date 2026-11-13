-- Unit 14 follow-up (S19 Q6, FE request after testing unit 14): WHY a request
-- is flagged "needsReschedule".
--
--   "needsRescheduleReason"  CLOSED_DATE   the scheduled time falls on a closed
--                                          date of the tenant's settings
--                            HOURS_CHANGED the date is open but the time is
--                                          outside the (changed) open hours
--                            NULL          not flagged
--
-- It is written together with "needsReschedule" (the post-commit flag pass and
-- the schedule sweep backstop) and cleared together with it (a reschedule).
-- Rows flagged before this migration keep a NULL reason (the API reads it as
-- null; the next reschedule clears the flag as before).
--
-- Safe on a populated database: a nullable column without default is
-- metadata-only (PostgreSQL 11+). The CHECK allows NULL, so every existing row
-- satisfies it, but ADD CONSTRAINT still scans "chatbot_requests" under ACCESS
-- EXCLUSIVE inside Prisma's one-transaction migration (short at current
-- production sizes). `SET LOCAL lock_timeout` bounds each wait to 5 s.
-- Idempotent (IF NOT EXISTS / DROP IF EXISTS) so `prisma migrate resolve
-- --rolled-back 20261114020000_needs_reschedule_reason` and a redeploy can run
-- it again.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "chatbot_requests"
  DROP CONSTRAINT IF EXISTS "chatbot_requests_needs_reschedule_reason_check",
  ADD COLUMN IF NOT EXISTS "needsRescheduleReason" TEXT,
  ADD CONSTRAINT "chatbot_requests_needs_reschedule_reason_check"
    CHECK ("needsRescheduleReason" IN ('CLOSED_DATE', 'HOURS_CHANGED'));
