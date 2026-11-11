-- human-intervention / unit 7b (contract §5.2: 90-day retention of
-- `notifications`; §10.1 R11). Additive only: one index, no table or column
-- changes.
--
-- Why: every existing index of "notifications" leads with ("tenantId",
-- "userId"), so the retention purge (oldest rows strictly before the cutoff,
-- across tenants, in batches of 1 000) would scan the whole table. This index
-- serves `WHERE "createdAt" < $cutoff ORDER BY "createdAt" LIMIT n FOR UPDATE
-- SKIP LOCKED` with one range probe.
--
-- Safe on a populated database: CREATE INDEX takes a SHARE lock (reads
-- continue, writes to "notifications" wait) for the time of the build. The
-- table holds at most 90 days of in-app notices, so the build takes
-- milliseconds to seconds. `SET LOCAL lock_timeout` bounds the wait for the
-- lock itself to 5 s, and Prisma applies the file as one transaction, so on
-- timeout nothing is applied. IF NOT EXISTS makes a re-run harmless.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261111060000_notification_retention
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications"("createdAt");
