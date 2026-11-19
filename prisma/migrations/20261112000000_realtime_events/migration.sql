-- human-intervention / unit 8 (contract §5.3, §10.1 R5/R6/R7): the durable,
-- tenant-scoped realtime log ("realtime_events") behind `GET /realtime/stream`,
-- its retention watermark ("realtime_event_retention") and the DEFERRED
-- constraint trigger that writes request events in the same transaction as the
-- audit event that causes them. Additive only: two new, empty tables, one
-- function and one trigger. No existing row, column or index changes.
--
-- Why a deferred trigger: every code path that changes a request appends a row
-- to "chatbot_request_events" (commands, bot intake, the wrappers, relations,
-- the SLA sweep, and the paths of units 9-11). The trigger fires at COMMIT, so
--   * the realtime event commits or rolls back together with the change (a
--     rolled-back savepoint announces nothing), with no producer able to
--     forget it;
--   * the per-tenant advisory lock it takes ("realtime:<tenantId>", the same
--     key the application writer uses) is the LAST lock of the transaction, so
--     it cannot take part in a lock cycle, and it is held only for the commit.
--     Within one tenant id order is commit order, so a reader that saw id N
--     never skips an id below N. The SLA sweep (the only multi-tenant writer)
--     already inserts its events in ascending tenant order.
-- The mapping audit type -> stream type is implemented twice on purpose:
-- `REQUEST_EVENT_TO_REALTIME` (src/realtime/domain/realtime-events.ts) and this
-- function; realtime-event-log.integration.spec.ts compares them for every
-- value of the enum. Backfilled events (data.backfilled = true) are not
-- announced: they are history, not changes.
--
-- Safe on a populated database:
--   * New tables only; nothing is rewritten and no existing row is touched.
--   * The two tenant FKs take a brief SHARE ROW EXCLUSIVE lock on "tenants"
--     (the tables are empty, so each lasts milliseconds) and the trigger takes a
--     brief SHARE ROW EXCLUSIVE lock on "chatbot_request_events" while it is
--     created. `SET LOCAL lock_timeout` bounds each wait to 5 s, and Prisma runs
--     this file as one transaction, so on timeout nothing is applied.
--   * From the moment the trigger exists, each transaction that appends a
--     (non-backfilled) request event also inserts one small row at commit.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261112000000_realtime_events
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "realtime_events" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "requestId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realtime_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "realtime_event_retention" (
    "tenantId" TEXT NOT NULL,
    "purgedThroughId" BIGINT NOT NULL,

    CONSTRAINT "realtime_event_retention_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex: the hub read and the broadcast half of a replay,
-- `WHERE tenantId = $1 AND id > $2 ORDER BY id`.
CREATE INDEX "realtime_events_tenantId_id_idx" ON "realtime_events"("tenantId", "id");

-- CreateIndex: the personal half of a replay (notifications of one user).
CREATE INDEX "realtime_events_user_idx"
  ON "realtime_events" ("tenantId", "userId", "id") WHERE "userId" IS NOT NULL;

-- CreateIndex: the retention purge.
CREATE INDEX "realtime_events_createdAt_idx" ON "realtime_events"("createdAt");

-- AddForeignKey
ALTER TABLE "realtime_events" ADD CONSTRAINT "realtime_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_event_retention" ADD CONSTRAINT "realtime_event_retention_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Request events: one stream event per announced audit event, at commit.
CREATE FUNCTION "chatbot_request_events_realtime"() RETURNS trigger
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

CREATE CONSTRAINT TRIGGER "chatbot_request_events_realtime"
  AFTER INSERT ON "chatbot_request_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "chatbot_request_events_realtime"();
