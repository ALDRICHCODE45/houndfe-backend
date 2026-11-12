-- human-intervention / unit 10 (contract §2.2, §3.3, §3.8, §6.2): clarification
-- replies end to end. No table, column or row changes: one function body and
-- two partial UNIQUE indexes.
--
-- 1. Realtime. A staff reply closes the request (REPLIED: IN_PROGRESS ->
--    RESOLVED), so the deferred trigger of unit 8 now announces it as
--    'request.resolved', the same as a resolve. Same function, one more WHEN;
--    `REQUEST_EVENT_TO_REALTIME` (src/realtime/domain/realtime-events.ts) is the
--    twin and realtime-event-log.integration.spec.ts compares them for every
--    value of the enum. CREATE OR REPLACE keeps the existing trigger bound.
--
-- 2. `chatbot_requests_reply_id_uq`: the reply id lives in `resolution`
--    (`{action: 'REPLY', replyId, text}`, §3.6: kept after the conversation
--    purge). The mirror looks a `staffReplyId` up by it, and it is unique per
--    tenant, so one reply id names one request.
--
-- 3. `chatbot_feed_items_clarification_answer_uq`: at most ONE clarification
--    `request.answered` per request, ever (same last line of defense as the
--    overdue notice index of 20261111070000).
--
-- Safe on a populated database: nothing writes `resolution.replyId` or a
-- CLARIFICATION answer before this unit, so both indexes build over zero
-- matching rows and cannot fail on duplicates. CREATE INDEX takes a SHARE lock
-- on the table while it builds (writes wait; the build is milliseconds for the
-- few thousand rows involved); `SET LOCAL lock_timeout` bounds the wait to 5 s
-- and Prisma runs this file as one transaction, so on timeout nothing is
-- applied. Deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261112050000_clarification_replies
-- and redeploy.

SET LOCAL lock_timeout = '5s';

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

CREATE UNIQUE INDEX "chatbot_requests_reply_id_uq"
  ON "chatbot_requests" ("tenantId", (("resolution" ->> 'replyId')))
  WHERE ("resolution" ->> 'replyId') IS NOT NULL;

CREATE UNIQUE INDEX "chatbot_feed_items_clarification_answer_uq"
  ON "chatbot_feed_items" ("tenantId", "requestId")
  WHERE "type" = 'request.answered' AND ("payload" ->> 'kind') = 'CLARIFICATION';
