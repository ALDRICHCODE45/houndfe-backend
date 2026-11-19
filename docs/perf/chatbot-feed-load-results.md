# Bot feed and recovery: load test results (unit 5, slice 5c)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database, plus the `EXPLAIN (ANALYZE, BUFFERS)` of its queries; a missed target is reported with its measured numbers) and the performance row "Feed del bot" (< 1 s p95 from commit to the bot, an idle request uses no CPU, index `(tenantId, cursor)`, sized for 5 000 open requests and 200 000 messages per tenant). Model: `docs/chatbot-requests-model.md`, "Bot feed" and "Recovery route".

**Result: no target was missed.** Every contract target passes with a wide margin. Two planner pathologies of the feed read were found while measuring and fixed (see "Finding: the feed read walked other tenants' rows (fixed)"). The numbers below come from the final run on a local machine (caveat at the end).

## How to reproduce

```sh
node scripts/perf/chatbot-feed-load.cjs            # report only
node scripts/perf/chatbot-feed-load.cjs --enforce  # fail the run when a target is missed
```

The launcher sets `PERF=1` and runs `pnpm test:integration src/chatbot-requests/chatbot-feed-load.integration.spec.ts`, so the test-database URL is resolved and guarded by the project's integration harness (the script never reads an env file and cannot reach dev or production). The spec is skipped in every normal run. The JSON report, with every number and plan below, goes to `/tmp/chatbot-feed-load-report.json` (`--report <path>` to change it). Sizes are knobs (`PERF_OPEN`, `PERF_CLOSED`, `PERF_FEED_ITEMS`, `PERF_SAMPLES`, …): `scripts/perf/README-chatbot-feed.md`. The run takes about one minute.

## Data

Seeded with SQL (`generate_series`) in the integration test database, then `ANALYZE` (a fresh table has no statistics and autovacuum has not run). The tenants' feed items are inserted in 40 alternating slices, so their cursors interleave the way concurrent branches would.

| Tenant | Role | Requests | Feed items |
| --- | --- | --- | --- |
| A | the measured tenant | 25,000 (5,000 open, 20,000 closed over the last 40 days) | 200,000; 1,995 undelivered (the newest 1 000 never attempted, the rest deferred for either reason), the others `PROVIDER_ACCEPTED` |
| B | noise: a big neighbour | 12,500 | 100,000 |
| C | noise: a quiet tenant | 100 | 4 |
| D | noise: a mid-size tenant that went quiet early | 200 | 40 000, all written before the others finished |
| E | noise: a mid-share tenant with a gap | 400 | 60 000 (15 % of the feed rows): 50 000 in the first quarter, 10 000 in the last slice, so a bot that polls after its first block faces ~225 000 foreign rows |

Whole tables at measuring time: `chatbot_requests` 38,200 rows, `chatbot_feed_items` 400,004 rows. The "200 000 messages" of the sizing is the feed here (the conversation mirror, which holds the chat messages, is unit 9). Seeding took 15.08 s.

## Targets

| Target | Limit | Measured | |
| --- | --- | --- | --- |
| Commit → bot (long-poll returns) | p95 < 1 000 ms | p95 8.32 ms (p50 1.24, p99 9.92, n=400) | PASS |
| An idle request uses no CPU | < 50 CPU ms per second (5 % of a core) | 0.25 ms/s (baseline without polls 0.11 ms/s) | PASS |
| An idle request issues no queries | 0 | 0 (baseline 0) | PASS |
| An idle request holds no pool connection | `SELECT 1` on a 1-connection pool p95 < 100 ms with 50 polls waiting | p95 0.39 ms | PASS |
| An idle request opens no connection | none beyond the pool's one | 1 → 1 (busy 0); whole database 31 → 31 (informational) | PASS |
| Index `(tenantId, cursor)` serves the feed read | index scan for every tenant shape (A, B, C, D, E; start, middle, tail, after a gap) | yes / yes / yes / yes / yes / yes / yes | PASS |
| The feed read does not walk other tenants' rows | tenant E after a gap: under 100 buffers | 7 buffers, 0.038 ms (previous shape: chatbot_feed_items_pkey, 17899 buffers, 64.343 ms) | PASS |
| Sizing | 5 000 open requests, 200 000 items per tenant | exactly that (tenant A), plus 400,004 rows in the table | PASS |

Informational (no contract target): the feed read, pending deliveries and the recovery pages (section below), and the enqueue throughput.

## (a) Commit → long-poll return

Real Nest app over HTTP on localhost. A long-poll is waiting (checked on the service's waiting counter), a transaction enqueues a `request.cancelled` item through the production write path (`enqueueCancelled`: per-tenant advisory lock, insert, `pg_notify`) and commits; the latency is from the writer's commit acknowledgement to the moment the response with the item arrives (clamped at 0 if the bot saw it before the writer's acknowledgement: 0 of 200 parallel samples).

| ms | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| One enqueue at a time, a poll waiting | 200 | 1 | 1.54 | 2.22 | 7.96 |
| 10 parallel writers × 20 rounds, one reader looping on the feed | 200 | 2.93 | 9.34 | 10.49 | 13.04 |
| **All samples** | 400 | 1.24 | 8.32 | 9.92 | 13.04 |
| (upper bound: from the start of the transaction, sequential) | 200 | 3.87 | 5.52 | 7.63 | 33.02 |

The parallel run delivered all 200 items, in strictly ascending cursor order, none repeated: cursor order is commit order for a tenant.

## (b) Queries at size

Over HTTP through the real app: the bot guard (a `service_rate_buckets` write per request), the query and the serialization are all inside these numbers. 200 samples each; the feed read at random cursors across the 200 000 items.

| ms | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| Feed read, 50 items, random cursor | 200 | 3.84 | 5.36 | 6.15 | 10.18 |
| Feed read, 50 items, near the tail | 200 | 3.14 | 4.3 | 6.97 | 9.35 |
| Pending deliveries by `conversationRef` | 200 | 3.15 | 4.89 | 5.9 | 10.33 |
| Pending deliveries by `requestId` | 200 | 3.1 | 4.17 | 4.93 | 8.01 |
| Recovery page of 50, walking the 5,000 open requests | 100 | 4.39 | 5.24 | 9.12 | 10.54 |
| Recovery page of 50, `updatedSince` = 30 days ago (20,000 requests) | 400 | 4.35 | 6.27 | 10.02 | 17.28 |

Full recovery walks: the open set is 100 pages in 0.46 s; with `updatedSince` = 30 days ago (5,000 open plus the requests closed in that window) it is 400 pages in 1.91 s. Page cost is flat along the walk (open-only walk: first-decile mean 5.67 ms, last-decile 4.39 ms; `updatedSince` walk: 4.96 ms and 5.24 ms), which is the keyset behavior: no offset, no sort. Each page also runs the grouped undelivered-count probe (`undeliveredSummary`) next to the 5-per-request list; both are inside these numbers.

## (c) An idle long-poll is free

A second app instance whose Prisma pool has **one** connection (`connection_limit=1`) holds 50 waiting long-polls (25 credentials × the cap of 2).

| Measure | Value |
| --- | --- |
| Waiting long-polls | 50 |
| The app's pool connections on the server, before → while waiting (busy while waiting) | 1 → 1 (0) |
| Whole database connections, before → while waiting (informational) | 31 → 31 |
| `SELECT 1` through the 1-connection pool while all 50 wait (n=30) | p50 0.23 ms, p95 0.39 ms, max 0.69 ms |
| Statements the app issued during the idle windows (3 × 1.5 s) | 0 |
| Process CPU per second, polls waiting (median of 3 windows: 2.87, 0.25, 0.2) | 0.25 ms |
| Process CPU per second, no polls (windows: 131.52, 0.11, 0.07) | 0.11 ms (the median ignores a stray GC tick) |
| Slots freed after the clients hang up | yes |

The `NOTIFY` listener is a separate `pg` connection per replica, opened at the first poll and outside the Prisma pool (R7); it is already open in the "before" figure.

## (d) The per-tenant enqueue lock

Each writer loops on `enqueueCancelled` in its own transaction for 4 s. The transaction holds the tenant's advisory lock from the insert to the commit.

| Scenario | Enqueues | per second | transaction p50 / p95 / p99 (ms) | errors |
| --- | --- | --- | --- | --- |
| 1 writer, one tenant | 1,647 | 411.57 | 2.31 / 3.16 / 4.22 | 0 |
| 10 writers, ONE tenant (per-tenant lock contended) | 2,631 | 655.73 | 14.47 / 19.79 / 23.27 | 0 |
| 10 writers, 10 tenants (no lock contention) | 4,981 | 1243.9 | 7.57 / 12.3 / 15.14 | 0 |

Ten writers on one tenant are serialized by the lock to about 655.73 enqueues/s, against 1243.9/s when the writers belong to ten tenants: the lock costs roughly half of the parallel throughput and nothing else. The design load is about 60 inbound messages per minute per branch (one enqueue per second), so the lock has more than two orders of magnitude of headroom. No deadlock and no error in any scenario.

## Finding: the feed read walked other tenants' rows (fixed)

The feed read is `WHERE tenantId = $1 AND cursor > $2 ORDER BY cursor LIMIT n`. `cursor` is a global sequence and the primary key is `cursor` alone, so the primary key is also an ordered path for it, filtered by tenant. A planner that takes it reads every other tenant's rows between `after` and this tenant's next item. Two cases were measured:

| Case | Shape | Time | Buffers |
| --- | --- | --- | --- |
| Tenant D (40 000 items) idle behind 270 000 foreign rows, polling at its own tail | `tenantId = $1 AND cursor > $2` (slice 5b) | 77.7 ms | 21 852 (`Rows Removed by Filter: 270403`) |
| Same, with the range bounded by the tenant's own highest cursor (first attempt) | `… AND cursor <= head` | 0.02 ms (idle case fixed) | 7–8 |
| Tenant E (15 % of the table), next item behind a gap of 225 000 foreign rows | first attempt (`cursor <= head`) | 65.2 ms | 17 898 (`Rows Removed by Filter: 225003`) |
| Tenant E, same cursor | **current shape** | 0.03 ms | 7 |

The first attempt (a head-cursor bound) only helped a bot that is caught up; the gap case, where the planner still took the primary key, was found by the verifier and is why the shape was replaced. Fix (`prisma-chatbot-feed.store.ts`, no schema change): give the planner no primary-key path. The tenant is not compared with `=` (a constant would drop it from the ordering) and the range is two row comparisons ordered by the composite key:

```sql
WHERE ("tenantId", "cursor") > ($1, $after) AND ("tenantId", "cursor") <= ($1, 9223372036854775807)
ORDER BY "tenantId", "cursor" LIMIT 50
```

This is exactly `tenantId = $1 AND cursor > $after`; only `(tenantId, cursor)` can serve it without sorting the table, and both comparisons are `Index Cond` (see the plans below). A unit test pins the shape (`prisma-chatbot-feed.store.spec.ts`); the load test asserts the composite index and bounded buffers for tenant E, and prints the previous shape's plan next to it for comparison. The recovery route's `currentFeedCursor` uses a one-probe highest-cursor query forced onto the same index the same way (`tenantHeadCursor`).

## EXPLAIN (ANALYZE, BUFFERS)

The statements are captured from the Prisma query log of the real stores (the feed read, the pending list) or taken from the store's own SQL (recovery), with the parameters inlined, and run twice; the second (warm) run is shown. The tables were `ANALYZE`d but not vacuumed, so index-only scans show `Heap Fetches`. Local Docker PostgreSQL 17, `shared_buffers = 128MB`.

Highlights:

- **Feed read**, every tenant shape (A is 50 % of the feed rows, B 25 %, E 15 %, C and D small; start, middle, tail, idle, and after a gap): `Index Scan using "chatbot_feed_items_tenantId_cursor_idx"` with `Index Cond: ROW(tenantId, cursor) > ROW(…) AND ROW(tenantId, cursor) <= ROW(…)`, 3 to 13 buffers, 0.01 to 0.04 ms, no sort and no filter.
- **Feed read, tenant E after the gap, previous shape** (printed for comparison): `Index Scan using chatbot_feed_items_pkey` filtered by tenant, 65 ms and about 17 900 buffers.
- **Pending deliveries**: by `conversationRef` an `Index Scan using chatbot_feed_items_deferred_idx` (the partial index covers both deferrals), by `requestId` the `(tenantId, requestId)` index with a filter on the outcome and an 8-row sort; both under 0.03 ms.
- **Recovery** pages (open only, middle page, and with `updatedSince` = 30 days ago, first and middle page): `Index Scan using chatbot_requests_open_recovery_idx` and, for the closed branch, `chatbot_requests_closed_recovery_idx`, merged by a `Merge Append` under `Limit`; no `Sort` node, 6 to 11 buffers, 0.03 to 0.06 ms. The keyset position is an `Index Cond` on `ROW(updatedAt, id)`.
- **Undelivered items of 50 requests**: a nested loop over the 50 ids with one `(tenantId, requestId)` index probe each (550 buffers for the 50 probes, 0.3 ms).
- **Current feed cursor**: the `(tenantId, cursor)` head probe plus the retention row, 0.02 ms.

### feed read: readAfter(after=mid, limit 50)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('0b0f568b-dace-4f13-8da4-884080f99ffc', 3743375) AND ("tenantId", "cursor") <= ('0b0f568b-dace-4f13-8da4-884080f99ffc', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..68.11 rows=50 width=438) (actual time=0.008..0.024 rows=50 loops=1)
  Buffers: shared hit=8
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..135372.09 rows=100000 width=438) (actual time=0.008..0.021 rows=50 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('0b0f568b-dace-4f13-8da4-884080f99ffc'::text, 3743375)) AND (ROW("tenantId", cursor) <= ROW('0b0f568b-dace-4f13-8da4-884080f99ffc'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=8
Planning Time: 0.045 ms
Execution Time: 0.033 ms
```

### feed read: assertCursorRetained(after=mid)

```sql
SELECT "public"."chatbot_feed_retention"."tenantId", "public"."chatbot_feed_retention"."purgedThroughCursor" FROM "public"."chatbot_feed_retention" WHERE "public"."chatbot_feed_retention"."tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' LIMIT 1 OFFSET 0
```

```text
Limit  (cost=0.00..0.00 rows=1 width=40) (actual time=0.002..0.002 rows=0 loops=1)
  ->  Seq Scan on chatbot_feed_retention  (cost=0.00..0.00 rows=1 width=40) (actual time=0.001..0.001 rows=0 loops=1)
        Filter: ("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text)
Planning Time: 0.016 ms
Execution Time: 0.005 ms
```

### feed read: nearest-tail readAfter(after=max-10)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('0b0f568b-dace-4f13-8da4-884080f99ffc', 3943567) AND ("tenantId", "cursor") <= ('0b0f568b-dace-4f13-8da4-884080f99ffc', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..68.11 rows=50 width=438) (actual time=0.006..0.010 rows=10 loops=1)
  Buffers: shared hit=13
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..135372.09 rows=100000 width=438) (actual time=0.006..0.009 rows=10 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('0b0f568b-dace-4f13-8da4-884080f99ffc'::text, 3943567)) AND (ROW("tenantId", cursor) <= ROW('0b0f568b-dace-4f13-8da4-884080f99ffc'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=13
Planning Time: 0.043 ms
Execution Time: 0.017 ms
```

### pending-deliveries by conversationRef

```sql
SELECT "public"."chatbot_feed_items"."cursor", "public"."chatbot_feed_items"."deliveryId", "public"."chatbot_feed_items"."type", "public"."chatbot_feed_items"."requestId", "public"."chatbot_feed_items"."conversationRef", "public"."chatbot_feed_items"."payload", "public"."chatbot_feed_items"."outcome" FROM "public"."chatbot_feed_items" WHERE ("public"."chatbot_feed_items"."tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "public"."chatbot_feed_items"."conversationRef" = 'wa:525600019000' AND "public"."chatbot_feed_items"."outcome" IN ('DEFERRED_WINDOW_CLOSED','DEFERRED_HUMAN_SESSION') AND "public"."chatbot_feed_items"."ackedAt" IS NULL) ORDER BY "public"."chatbot_feed_items"."cursor" ASC LIMIT 50 OFFSET 0
```

```text
Limit  (cost=0.28..8.30 rows=1 width=403) (actual time=0.007..0.009 rows=8 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using chatbot_feed_items_deferred_idx on chatbot_feed_items  (cost=0.28..8.30 rows=1 width=403) (actual time=0.006..0.009 rows=8 loops=1)
        Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND ("conversationRef" = 'wa:525600019000'::text))
        Buffers: shared hit=10
Planning Time: 0.060 ms
Execution Time: 0.015 ms
```

### pending-deliveries by requestId

```sql
SELECT "public"."chatbot_feed_items"."cursor", "public"."chatbot_feed_items"."deliveryId", "public"."chatbot_feed_items"."type", "public"."chatbot_feed_items"."requestId", "public"."chatbot_feed_items"."conversationRef", "public"."chatbot_feed_items"."payload", "public"."chatbot_feed_items"."outcome" FROM "public"."chatbot_feed_items" WHERE ("public"."chatbot_feed_items"."tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "public"."chatbot_feed_items"."requestId" = 'c7b80dab-1210-4edd-a876-fce73f93b170' AND "public"."chatbot_feed_items"."outcome" IN ('DEFERRED_WINDOW_CLOSED','DEFERRED_HUMAN_SESSION') AND "public"."chatbot_feed_items"."ackedAt" IS NULL) ORDER BY "public"."chatbot_feed_items"."cursor" ASC LIMIT 50 OFFSET 0
```

```text
Limit  (cost=28.51..28.52 rows=1 width=403) (actual time=0.012..0.013 rows=8 loops=1)
  Buffers: shared hit=11
  ->  Sort  (cost=28.51..28.52 rows=1 width=403) (actual time=0.012..0.012 rows=8 loops=1)
        Sort Key: cursor
        Sort Method: quicksort  Memory: 29kB
        Buffers: shared hit=11
        ->  Index Scan using "chatbot_feed_items_tenantId_requestId_idx" on chatbot_feed_items  (cost=0.42..28.50 rows=1 width=403) (actual time=0.006..0.009 rows=8 loops=1)
              Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND ("requestId" = 'c7b80dab-1210-4edd-a876-fce73f93b170'::text))
              Filter: (("ackedAt" IS NULL) AND (outcome = ANY ('{DEFERRED_WINDOW_CLOSED,DEFERRED_HUMAN_SESSION}'::text[])))
              Buffers: shared hit=11
Planning Time: 0.060 ms
Execution Time: 0.019 ms
```

### recovery: first page, open only

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "status" IN ('NEW', 'IN_PROGRESS') ORDER BY "updatedAt", "id" LIMIT 51) ) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.28..32.53 rows=51 width=201) (actual time=0.006..0.021 rows=51 loops=1)
  Buffers: shared hit=4
  ->  Limit  (cost=0.28..32.53 rows=51 width=201) (actual time=0.005..0.018 rows=51 loops=1)
        Buffers: shared hit=4
        ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.28..3241.70 rows=5126 width=201) (actual time=0.005..0.015 rows=51 loops=1)
              Index Cond: ("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text)
              Buffers: shared hit=4
Planning:
  Buffers: shared hit=3
Planning Time: 0.122 ms
Execution Time: 0.028 ms
```

### recovery: middle page, open only

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "status" IN ('NEW', 'IN_PROGRESS') AND ("updatedAt", "id") > ('2026-10-29T21:21:52.084Z'::timestamp(3), 'f5455eec-bca9-4510-a7ab-cd14b979cc13') ORDER BY "updatedAt", "id" LIMIT 51) ) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.28..61.04 rows=51 width=201) (actual time=0.006..0.023 rows=51 loops=1)
  Buffers: shared hit=6
  ->  Limit  (cost=0.28..61.04 rows=51 width=201) (actual time=0.005..0.020 rows=51 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.28..2332.97 rows=1958 width=201) (actual time=0.005..0.017 rows=51 loops=1)
              Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND (ROW("updatedAt", id) > ROW('2026-10-29 21:21:52.084'::timestamp(3) without time zone, 'f5455eec-bca9-4510-a7ab-cd14b979cc13'::text)))
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=3
Planning Time: 0.131 ms
Execution Time: 0.032 ms
```

### recovery: first page, updatedSince = 30 days ago (open + closed branches)

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "status" IN ('NEW', 'IN_PROGRESS') ORDER BY "updatedAt", "id" LIMIT 51) UNION ALL ( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "status" IN ('RESOLVED', 'CANCELLED') AND "updatedAt" >= '2026-10-12T00:55:14.812Z'::timestamp(3) AND "closedAt" >= '2026-10-12T00:55:14.812Z'::timestamp(3) ORDER BY "updatedAt", "id" LIMIT 51)) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.70..34.92 rows=51 width=201) (actual time=0.011..0.032 rows=51 loops=1)
  Buffers: shared hit=9
  ->  Merge Append  (cost=0.70..69.14 rows=102 width=201) (actual time=0.010..0.029 rows=51 loops=1)
        Sort Key: chatbot_requests."updatedAt", chatbot_requests.id
        Buffers: shared hit=9
        ->  Limit  (cost=0.28..32.53 rows=51 width=201) (actual time=0.006..0.006 rows=1 loops=1)
              Buffers: shared hit=3
              ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.28..3241.70 rows=5126 width=201) (actual time=0.006..0.006 rows=1 loops=1)
                    Index Cond: ("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text)
                    Buffers: shared hit=3
        ->  Limit  (cost=0.41..35.58 rows=51 width=201) (actual time=0.004..0.019 rows=51 loops=1)
              Buffers: shared hit=6
              ->  Index Scan using chatbot_requests_closed_recovery_idx on chatbot_requests chatbot_requests_1  (cost=0.41..6579.41 rows=9542 width=201) (actual time=0.004..0.017 rows=51 loops=1)
                    Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND ("updatedAt" >= '2026-10-12 00:55:14.812'::timestamp(3) without time zone))
                    Filter: ("closedAt" >= '2026-10-12 00:55:14.812'::timestamp(3) without time zone)
                    Buffers: shared hit=6
Planning:
  Buffers: shared hit=6
Planning Time: 0.253 ms
Execution Time: 0.044 ms
```

### recovery: middle page, updatedSince = 30 days ago

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "status" IN ('NEW', 'IN_PROGRESS') AND ("updatedAt", "id") > ('2026-10-22T00:57:45.032Z'::timestamp(3), 'c5e3b6fb-7756-41dc-8de5-4bc245e19f61') ORDER BY "updatedAt", "id" LIMIT 51) UNION ALL ( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "status" IN ('RESOLVED', 'CANCELLED') AND "updatedAt" >= '2026-10-12T00:55:14.812Z'::timestamp(3) AND "closedAt" >= '2026-10-12T00:55:14.812Z'::timestamp(3) AND ("updatedAt", "id") > ('2026-10-22T00:57:45.032Z'::timestamp(3), 'c5e3b6fb-7756-41dc-8de5-4bc245e19f61') ORDER BY "updatedAt", "id" LIMIT 51)) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.70..47.23 rows=51 width=201) (actual time=0.010..0.033 rows=51 loops=1)
  Buffers: shared hit=11
  ->  Merge Append  (cost=0.70..93.76 rows=102 width=201) (actual time=0.010..0.030 rows=51 loops=1)
        Sort Key: chatbot_requests."updatedAt", chatbot_requests.id
        Buffers: shared hit=11
        ->  Limit  (cost=0.28..48.45 rows=51 width=201) (actual time=0.006..0.010 rows=15 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.28..2808.08 rows=2973 width=201) (actual time=0.006..0.009 rows=15 loops=1)
                    Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND (ROW("updatedAt", id) > ROW('2026-10-22 00:57:45.032'::timestamp(3) without time zone, 'c5e3b6fb-7756-41dc-8de5-4bc245e19f61'::text)))
                    Buffers: shared hit=4
        ->  Limit  (cost=0.41..44.28 rows=51 width=201) (actual time=0.003..0.016 rows=37 loops=1)
              Buffers: shared hit=7
              ->  Index Scan using chatbot_requests_closed_recovery_idx on chatbot_requests chatbot_requests_1  (cost=0.41..4760.35 rows=5534 width=201) (actual time=0.003..0.014 rows=37 loops=1)
                    Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND ("updatedAt" >= '2026-10-12 00:55:14.812'::timestamp(3) without time zone) AND (ROW("updatedAt", id) > ROW('2026-10-22 00:57:45.032'::timestamp(3) without time zone, 'c5e3b6fb-7756-41dc-8de5-4bc245e19f61'::text)))
                    Filter: ("closedAt" >= '2026-10-12 00:55:14.812'::timestamp(3) without time zone)
                    Buffers: shared hit=7
Planning:
  Buffers: shared hit=6
Planning Time: 0.272 ms
Execution Time: 0.046 ms
```

### recovery: undelivered items of 50 requests (LATERAL)

```sql
SELECT d."cursor", d."deliveryId"::text AS "deliveryId", d."type", d."requestId", d."conversationRef", d."payload", d."outcome" FROM unnest(ARRAY['f5455eec-bca9-4510-a7ab-cd14b979cc13','e2e2d421-cb2d-4a72-aaa3-7113432b93c2','d92652a4-0b3a-4ed9-a4f7-e102d3200191','59af862e-9b67-40c6-b036-798df2d7c1ac','061a8786-39d2-4a71-907a-72349deb86df','de54526e-d1fb-45ce-8f41-3de06c7cedd1','e026b8ce-a693-4b8d-a385-6b59083bdfa0','39da7c87-3aa5-47be-ad37-d5d717ee9bdf','3e4d11e4-54d3-4a72-9398-b4e4d9f49514','7877525c-5a42-4146-9181-ae327c0cf91f','592cde30-21a5-4094-91b2-17b676e1a1ec','831975f5-8fca-4cc6-8fc1-0a39d5e571c6','79808d9d-e782-4195-b2ce-7e8968fb9482','17c73b8f-e573-477a-a501-38e60761131f','8111f0f0-6c2d-4014-9750-b1347562d14d','065df5dc-d372-4488-87bb-0e22becf297a','4e5ca7b9-3448-45ea-a16d-e2ab0750dd1e','ff35be98-bd1b-4ed4-a945-06554456f1cb','50bc6154-f7e1-4657-aa93-d53dd82fa128','7299a067-4801-428e-a6c9-e1974c0acd90','9f7e502f-2fe1-4628-8ab7-1740da93391e','ae82e23c-8705-4944-81ad-18c84f747bd5','b1620381-a356-4b9c-81fe-eae1581c13fb','8084754c-8ed4-448c-b1a4-27827ca07485','68ffbdc6-ecdd-4d74-8657-572245a8e034','ba683d70-e5c4-4fcc-bc9b-357ba1c40f97','23ad4dc3-c87b-4159-828c-0aa59d1d7579','d77d80f0-0b62-483e-8187-7de346e3a69c','aa36b07a-25d3-4de2-b5a9-f52003d78053','331223bc-7e2f-42e6-be60-e796510dae8e','37a1066b-85db-4909-885d-3e7f0cd4fd8a','71359961-88c7-4b07-becc-89f557b07521','132d32fe-e6cd-482c-875f-dbb708020cc0','0ae58d34-8219-49eb-ad7e-474517e674f7','ab876609-6d08-48b1-bf8d-6a8ef9b305b3','86b9670c-cb25-444d-8576-8514d0ab2c62','42768c82-6528-412a-bf2f-d4b262a7ba17','c0ba4e15-f5c2-4c28-a84b-4b89a6fc59cc','9f1caee2-06e0-4e23-942a-6dc6e7fd0f97','f7f4ec27-2f4d-4d74-bf2b-b99d83c41f1b','27979ac4-f498-4b45-9468-47b255eb02b1','03f5d130-ed68-4db4-8590-d23a7c02f5bb','6628f60b-ee82-48f3-8e48-de5abcdb8cbf','0160cf9e-a0a5-4bd6-9a38-c4ba7dfa64db','d81a1783-d15a-4397-9edf-a0cef27cc4ea','be23b549-e3ed-4b12-896c-9aa6e9ef3b55','4402d258-0904-49ed-b59c-68d38d011dfb','e362d1e4-9462-4674-8932-0f95d4a3eb78','8f605c4a-26bb-4c84-9389-1de98ef97859','635a3e6a-cf19-4213-a305-7a6c5811802e']::text[]::text[]) AS r("id") CROSS JOIN LATERAL ( SELECT f."cursor", f."deliveryId", f."type", f."requestId", f."conversationRef", f."payload", f."outcome" FROM "chatbot_feed_items" f WHERE f."tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc' AND f."requestId" = r."id" AND f."ackedAt" IS NULL ORDER BY f."cursor" DESC LIMIT 5) AS d ORDER BY d."cursor"
```

```text
Sort  (cost=1628.12..1628.24 rows=50 width=419) (actual time=0.236..0.236 rows=0 loops=1)
  Sort Key: f.cursor
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=550
  ->  Nested Loop  (cost=32.51..1626.70 rows=50 width=419) (actual time=0.235..0.236 rows=0 loops=1)
        Buffers: shared hit=550
        ->  Function Scan on unnest r  (cost=0.00..0.50 rows=50 width=32) (actual time=0.003..0.006 rows=50 loops=1)
        ->  Limit  (cost=32.50..32.51 rows=1 width=403) (actual time=0.004..0.004 rows=0 loops=50)
              Buffers: shared hit=550
              ->  Sort  (cost=32.50..32.51 rows=1 width=403) (actual time=0.004..0.004 rows=0 loops=50)
                    Sort Key: f.cursor DESC
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=550
                    ->  Index Scan using "chatbot_feed_items_tenantId_requestId_idx" on chatbot_feed_items f  (cost=0.42..32.49 rows=1 width=403) (actual time=0.004..0.004 rows=0 loops=50)
                          Index Cond: (("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND ("requestId" = r.id))
                          Filter: ("ackedAt" IS NULL)
                          Rows Removed by Filter: 8
                          Buffers: shared hit=550
Planning Time: 0.066 ms
Execution Time: 0.246 ms
```

### recovery: current feed cursor

```sql
SELECT GREATEST( COALESCE(( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= '0b0f568b-dace-4f13-8da4-884080f99ffc' AND "tenantId" <= '0b0f568b-dace-4f13-8da4-884080f99ffc' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1), 0), COALESCE((SELECT "purgedThroughCursor" FROM "chatbot_feed_retention" WHERE "tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'), 0)) AS "cursor"
```

```text
Result  (cost=0.96..0.98 rows=1 width=8) (actual time=0.010..0.010 rows=1 loops=1)
  Buffers: shared hit=5
  InitPlan 1
    ->  Limit  (cost=0.42..0.96 rows=1 width=45) (actual time=0.008..0.008 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..108277.08 rows=200267 width=45) (actual time=0.007..0.007 rows=1 loops=1)
                Index Cond: (("tenantId" >= '0b0f568b-dace-4f13-8da4-884080f99ffc'::text) AND ("tenantId" <= '0b0f568b-dace-4f13-8da4-884080f99ffc'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  InitPlan 2
    ->  Seq Scan on chatbot_feed_retention  (cost=0.00..0.00 rows=1 width=8) (actual time=0.001..0.001 rows=0 loops=1)
          Filter: ("tenantId" = '0b0f568b-dace-4f13-8da4-884080f99ffc'::text)
Planning Time: 0.057 ms
Execution Time: 0.026 ms
```

### feed read, big neighbour tenant B: readAfter(after=mid)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('150d968f-f9c4-4501-bb9f-ca1fb505a78e', 3740675) AND ("tenantId", "cursor") <= ('150d968f-f9c4-4501-bb9f-ca1fb505a78e', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..88.39 rows=50 width=438) (actual time=0.007..0.023 rows=50 loops=1)
  Buffers: shared hit=9
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..132156.47 rows=75113 width=438) (actual time=0.006..0.020 rows=50 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('150d968f-f9c4-4501-bb9f-ca1fb505a78e'::text, 3740675)) AND (ROW("tenantId", cursor) <= ROW('150d968f-f9c4-4501-bb9f-ca1fb505a78e'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=9
Planning Time: 0.042 ms
Execution Time: 0.031 ms
```

### feed read, quiet tenant C: readAfter(after=0)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('796d4273-bacc-4d56-aa00-46a5e969c84d', 0) AND ("tenantId", "cursor") <= ('796d4273-bacc-4d56-aa00-46a5e969c84d', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..88.39 rows=50 width=438) (actual time=0.006..0.008 rows=4 loops=1)
  Buffers: shared hit=7
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..132156.47 rows=75113 width=438) (actual time=0.006..0.007 rows=4 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('796d4273-bacc-4d56-aa00-46a5e969c84d'::text, 0)) AND (ROW("tenantId", cursor) <= ROW('796d4273-bacc-4d56-aa00-46a5e969c84d'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=7
Planning Time: 0.041 ms
Execution Time: 0.015 ms
```

### feed read, quiet tenant C: poll at its own tail (after=its max, others keep writing)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('796d4273-bacc-4d56-aa00-46a5e969c84d', 3865677) AND ("tenantId", "cursor") <= ('796d4273-bacc-4d56-aa00-46a5e969c84d', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..88.39 rows=50 width=438) (actual time=0.004..0.005 rows=0 loops=1)
  Buffers: shared hit=3
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..132156.47 rows=75113 width=438) (actual time=0.004..0.004 rows=0 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('796d4273-bacc-4d56-aa00-46a5e969c84d'::text, 3865677)) AND (ROW("tenantId", cursor) <= ROW('796d4273-bacc-4d56-aa00-46a5e969c84d'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=3
Planning Time: 0.046 ms
Execution Time: 0.011 ms
```

### feed read, stalled tenant D (40k items, none for a long time): poll at its own tail (after=its max)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('c35fb9e1-a1b9-4d0b-a28d-c055b2c52386', 3633174) AND ("tenantId", "cursor") <= ('c35fb9e1-a1b9-4d0b-a28d-c055b2c52386', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..8.44 rows=1 width=438) (actual time=0.004..0.005 rows=0 loops=1)
  Buffers: shared hit=3
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..8.44 rows=1 width=438) (actual time=0.004..0.004 rows=0 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('c35fb9e1-a1b9-4d0b-a28d-c055b2c52386'::text, 3633174)) AND (ROW("tenantId", cursor) <= ROW('c35fb9e1-a1b9-4d0b-a28d-c055b2c52386'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=3
Planning Time: 0.048 ms
Execution Time: 0.012 ms
```

### feed read, mid-share tenant E after a gap of foreign rows: readAfter(after = end of its first block)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE ("tenantId", "cursor") > ('869bce47-ce90-470c-a2aa-e4d47647ff37', 3708174) AND ("tenantId", "cursor") <= ('869bce47-ce90-470c-a2aa-e4d47647ff37', '9223372036854775807') ORDER BY "tenantId", "cursor" LIMIT 50
```

```text
Limit  (cost=0.42..131.97 rows=50 width=438) (actual time=0.010..0.029 rows=50 loops=1)
  Buffers: shared hit=7
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..96027.75 rows=36500 width=438) (actual time=0.009..0.025 rows=50 loops=1)
        Index Cond: ((ROW("tenantId", cursor) > ROW('869bce47-ce90-470c-a2aa-e4d47647ff37'::text, 3708174)) AND (ROW("tenantId", cursor) <= ROW('869bce47-ce90-470c-a2aa-e4d47647ff37'::text, '9223372036854775807'::bigint)))
        Buffers: shared hit=7
Planning Time: 0.050 ms
Execution Time: 0.038 ms
```

### feed read, tenant E after the gap, PREVIOUS shape (tenantId = $1 AND cursor > $2 AND cursor <= head): for comparison only

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = '869bce47-ce90-470c-a2aa-e4d47647ff37' AND "cursor" > 3708174 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= '869bce47-ce90-470c-a2aa-e4d47647ff37' AND "tenantId" <= '869bce47-ce90-470c-a2aa-e4d47647ff37' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=2.35..44.54 rows=50 width=401) (actual time=64.293..64.317 rows=50 loops=1)
  Buffers: shared hit=8 read=17891
  InitPlan 1
    ->  Limit  (cost=0.42..1.93 rows=1 width=45) (actual time=0.026..0.027 rows=1 loops=1)
          Buffers: shared hit=4 read=1
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..89570.30 rows=59600 width=45) (actual time=0.026..0.026 rows=1 loops=1)
                Index Cond: (("tenantId" >= '869bce47-ce90-470c-a2aa-e4d47647ff37'::text) AND ("tenantId" <= '869bce47-ce90-470c-a2aa-e4d47647ff37'::text))
                Heap Fetches: 1
                Buffers: shared hit=4 read=1
  ->  Index Scan using chatbot_feed_items_pkey on chatbot_feed_items  (cost=0.42..251.91 rows=298 width=401) (actual time=64.292..64.311 rows=50 loops=1)
        Index Cond: ((cursor > 3708174) AND (cursor <= (InitPlan 1).col1))
        Filter: ("tenantId" = '869bce47-ce90-470c-a2aa-e4d47647ff37'::text)
        Rows Removed by Filter: 225003
        Buffers: shared hit=8 read=17891
Planning Time: 0.155 ms
Execution Time: 64.343 ms
```

## Caveats

- **Machine.** AMD Ryzen 7 5700G with Radeon Graphics x16, 31.2 GB, Node v24.14.1, PostgreSQL 17.9 (Debian 17.9-1.pgdg13+1) on x86_64-pc-linux-gnu in a local Docker container (`shared_buffers = 128MB`). The load generator, the Nest app, the writers and the database share one machine, and the app, the writers and the client share one Node process, so latencies include event-loop contention (conservative) and say nothing about the production VPS. Treat the numbers as the shape of the costs and the proof of the plans, not as a production forecast.
- **Run to run.** Complete runs of the same script gave a p95 commit → bot of 7.7 to 11.1 ms and a feed read p95 of 4.7 to 12 ms; the conclusions do not change between runs.
- **Not in these numbers:** concurrent staff traffic on the same tables, the customer-group maintenance (not on these paths), a vacuumed table (index-only scans would avoid their heap fetches), more than one replica (the 2-poll cap is per replica) and a real network between the bot and the backend.
- **Messages.** The 200 000 "messages per tenant" are feed items here; the conversation mirror (unit 9) has its own targets.
- **Idle CPU** is the whole Jest process (app, client, writers); a stray GC tick shows in a single window, which is why the median of three windows is used and every window is printed.
