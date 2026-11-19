-- human-intervention / S9 follow-up: make the inbox `counts.unassigned`
-- subquery index-only.
--
-- `unassigned` = open (`status IN ('NEW','IN_PROGRESS')`) AND `assigneeUserId IS
-- NULL`. The existing partial open index `chatbot_requests_open_status_idx`
-- `(tenantId, status)` does not carry the assignee, so that subquery had to
-- fetch every open row of the tenant from the heap to test the assignee, and
-- the planner's choice between a Bitmap Heap Scan and a Seq Scan hung on a
-- margin of ~10 cost units that moves with the table's physical size
-- (the S9 "index-backed" spec flipped to a Seq Scan with no change to the
-- statement). This partial index holds exactly the rows the subquery counts,
-- with the same predicate text as the query's OPEN fragment, so the count is an
-- Index Only Scan whatever the table size: O(unassigned rows of the tenant),
-- no heap access on a vacuumed table.
--
-- Only an index: no table, column or row changes. CREATE INDEX takes a SHARE
-- lock on "chatbot_requests" while it builds (writes wait; milliseconds for the
-- open rows involved, since the index is partial). `SET LOCAL lock_timeout`
-- bounds the wait to 5 s and Prisma runs this file as one transaction, so on
-- timeout nothing is applied. Deploy at low traffic. If it fails on lock
-- timeout, run
--   prisma migrate resolve --rolled-back 20261112060000_chatbot_requests_counts_index
-- and redeploy.

SET LOCAL lock_timeout = '5s';

CREATE INDEX "chatbot_requests_open_unassigned_idx"
  ON "chatbot_requests" ("tenantId")
  WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "assigneeUserId" IS NULL;
