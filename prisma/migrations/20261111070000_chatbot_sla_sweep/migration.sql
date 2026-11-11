-- human-intervention / unit 7c (contract §5.4: SLA sweep, milestones,
-- `request.overdue_notice`; §10.1 R11). Additive only: two partial UNIQUE
-- indexes, no table or column changes, no data rewrite.
--
-- 1. chatbot_feed_items: at most ONE `request.overdue_notice` per request. The
--    sweep inserts with ON CONFLICT DO NOTHING on this index, so two replicas,
--    a retry after a crash or a re-mark never feed the bot twice.
-- 2. chatbot_request_events: at most ONE SLA_MILESTONE event per
--    (request, clock, milestone, cycle). The event is the durable record that a
--    milestone was reached (the notifications that carry the same key are
--    purged at 90 days, the request and its events are kept forever), and the
--    sweep inserts with ON CONFLICT DO NOTHING, so a milestone is never
--    recorded, and therefore never notified, twice.
--
-- Safe on a populated database: nothing writes rows of these two kinds before
-- this unit (no `request.overdue_notice` feed item and no SLA_MILESTONE event
-- exists), so each index builds over zero matching rows and cannot fail on a
-- duplicate. CREATE INDEX takes a SHARE lock on the table for the build: reads
-- continue, writes wait. The feed table holds at most 30 days and the events
-- table is small and indexed per request, so each build takes milliseconds to
-- seconds. `SET LOCAL lock_timeout` bounds the wait for the lock to 5 s and
-- Prisma applies the file as one transaction, so on timeout nothing is
-- applied. IF NOT EXISTS makes a re-run harmless.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261111070000_chatbot_sla_sweep
-- and redeploy.

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_feed_items_overdue_notice_uq"
  ON "chatbot_feed_items" ("tenantId", "requestId")
  WHERE "type" = 'request.overdue_notice';

CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_request_events_sla_milestone_uq"
  ON "chatbot_request_events" (
    "tenantId", "requestId",
    (("data" ->> 'clock')), (("data" ->> 'milestone')), (("data" ->> 'cycle'))
  )
  WHERE "type" = 'SLA_MILESTONE';
