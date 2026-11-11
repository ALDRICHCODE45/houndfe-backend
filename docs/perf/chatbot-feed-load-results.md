# Bot feed and recovery: load test results (unit 5, slice 5c)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database, plus the `EXPLAIN (ANALYZE, BUFFERS)` of its queries; a missed target is reported with its measured numbers) and the performance row "Feed del bot" (< 1 s p95 from commit to the bot, an idle request uses no CPU, index `(tenantId, cursor)`, sized for 5 000 open requests and 200 000 messages per tenant). Model: `docs/chatbot-requests-model.md`, "Bot feed" and "Recovery route".

**Result: no target was missed.** Every contract target passes with a wide margin. One planner pathology was found and fixed while measuring (see "Finding: a quiet tenant walked its neighbours' rows"). The numbers below come from the final run on a local machine (caveat at the end).

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

Whole tables at measuring time: `chatbot_requests` 37,800 rows, `chatbot_feed_items` 340,004 rows. The "200 000 messages" of the sizing is the feed here (the conversation mirror, which holds the chat messages, is unit 9); a feed item is 8 bytes of cursor plus a JSON payload of about 300 bytes. Seeding took 15.41 s.

## Targets

| Target | Limit | Measured | |
| --- | --- | --- | --- |
| Commit → bot (long-poll returns) | p95 < 1 000 ms | p95 8.25 ms (p50 1.46, p99 11.17, n=400) | PASS |
| An idle request uses no CPU | < 50 CPU ms per second (5 % of a core) | 0.21 ms/s (baseline without polls 0.12 ms/s) | PASS |
| An idle request issues no queries | 0 | 0 (baseline 0) | PASS |
| An idle request holds no pool connection | `SELECT 1` on a 1-connection pool p95 < 100 ms with 50 polls waiting | p95 0.24 ms | PASS |
| An idle request opens no connection | none beyond the pool's one | 1 → 1 (busy 0); whole database 31 → 31 (informational) | PASS |
| Index `(tenantId, cursor)` serves the feed read | index scan where the tenant is a small share | yes / yes (quiet tenant C, from the start and at its own tail) | PASS |
| The feed read does not walk other tenants' rows | bounded buffers for a tenant idle among busy neighbours | "chatbot_feed_items_tenantId_cursor_idx", 0.024 ms, 8 buffers | PASS |
| Sizing | 5 000 open requests, 200 000 items per tenant | exactly that (tenant A), plus 340 000 rows in the table | PASS |

Informational (no contract target): the feed read, pending deliveries and the recovery pages (section below), and the enqueue throughput.

## (a) Commit → long-poll return

Real Nest app over HTTP on localhost. A long-poll is waiting (checked on the service's waiting counter), a transaction enqueues a `request.cancelled` item through the production write path (`enqueueCancelled`: per-tenant advisory lock, insert, `pg_notify`) and commits; the latency is from the writer's commit acknowledgement to the moment the response with the item arrives (clamped at 0 if the bot saw it before the writer's acknowledgement: 0 of 200 parallel samples).

| ms | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| One enqueue at a time, a poll waiting | 200 | 1.2 | 1.66 | 1.97 | 8.25 |
| 10 parallel writers × 20 rounds, one reader looping on the feed | 200 | 3.14 | 9.29 | 12.67 | 17.22 |
| **All samples** | 400 | 1.46 | 8.25 | 11.17 | 17.22 |
| (upper bound: from the start of the transaction, sequential) | 200 | 4.21 | 6.12 | 7.05 | 34.45 |

The parallel run delivered all 200 items, in strictly ascending cursor order, none repeated: cursor order is commit order for a tenant.

## (b) Queries at size

Over HTTP through the real app: the bot guard (a `service_rate_buckets` write per request), the query and the serialization are all inside these numbers. 200 samples each; the feed read at random cursors across the 200 000 items.

| ms | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| Feed read, 50 items, random cursor | 200 | 4.19 | 5.31 | 7.19 | 10.5 |
| Feed read, 50 items, near the tail | 200 | 3.43 | 5.05 | 6.3 | 13.61 |
| Pending deliveries by `conversationRef` | 200 | 3.36 | 5.61 | 8 | 10.2 |
| Pending deliveries by `requestId` | 200 | 3.29 | 4.73 | 6.01 | 9.92 |
| Recovery page of 50, walking the 5,000 open requests | 100 | 5.1 | 6.93 | 12.17 | 12.72 |
| Recovery page of 50, `updatedSince` = 30 days ago (20,000 requests) | 400 | 6.55 | 9.92 | 12.16 | 18.05 |

Full recovery walks: the open set is 100 pages in 0.55 s; with `updatedSince` = 30 days ago (5,000 open plus the requests closed in that window) it is 400 pages in 2.82 s. Page cost is flat along the walk (open-only walk: first-decile mean 5.87 ms, last-decile 5.55 ms; `updatedSince` walk: 6.29 ms and 6.59 ms), which is the keyset behavior: no offset, no sort.

## (c) An idle long-poll is free

A second app instance whose Prisma pool has **one** connection (`connection_limit=1`) holds 50 waiting long-polls (25 credentials × the cap of 2).

| Measure | Value |
| --- | --- |
| Waiting long-polls | 50 |
| The app's pool connections on the server, before → while waiting (busy while waiting) | 1 → 1 (0) |
| Whole database connections, before → while waiting (informational) | 31 → 31 |
| `SELECT 1` through the 1-connection pool while all 50 wait (n=30) | p50 0.17 ms, p95 0.24 ms, max 0.37 ms |
| Statements the app issued during the idle windows (3 × 1.5 s) | 0 |
| Process CPU per second, polls waiting (median of 3 windows: 0.23, 0.21, 0.18) | 0.21 ms |
| Process CPU per second, no polls (windows: 97.25, 0.12, 0.06) | 0.12 ms (the median ignores a stray GC tick) |
| Slots freed after the clients hang up | yes |

The `NOTIFY` listener is a separate `pg` connection per replica, opened at the first poll and outside the Prisma pool (R7); it is already open in the "before" figure.

## (d) The per-tenant enqueue lock

Each writer loops on `enqueueCancelled` in its own transaction for 4 s. The transaction holds the tenant's advisory lock from the insert to the commit.

| Scenario | Enqueues | per second | transaction p50 / p95 / p99 (ms) | errors |
| --- | --- | --- | --- | --- |
| 1 writer, one tenant | 1,421 | 355.14 | 2.66 / 3.74 / 5.43 | 0 |
| 10 writers, ONE tenant (per-tenant lock contended) | 2,348 | 584.63 | 15.99 / 23.26 / 26.9 | 0 |
| 10 writers, 10 tenants (no lock contention) | 4,584 | 1144.72 | 8.18 / 13.72 / 16.15 | 0 |

Ten writers on one tenant are serialized by the lock to about 584.63 enqueues/s, against 1144.72/s when the writers belong to ten tenants: the lock costs roughly half of the parallel throughput and nothing else. The design load is about 60 inbound messages per minute per branch (one enqueue per second), so the lock has more than two orders of magnitude of headroom. No deadlock and no error in any scenario.

## Finding: a quiet tenant walked its neighbours' rows (fixed)

The feed read is `WHERE tenantId = $1 AND cursor > $2 ORDER BY cursor LIMIT n`. `cursor` is a global sequence, so the primary key (`cursor`) is also an ordered path for it, with a filter on the tenant. Where a tenant is a small share of the table the planner uses `(tenantId, cursor)` (tenant C below). Where it is a big share it preferred the primary key in the runs before the fix, which is fine while the tenant's own rows are near `after`, but **tenant D (40 000 items, quiet while 270 000 rows were written by the others) was read at 77.7 ms and 21 852 buffers per poll**: the plan walked every newer row of every other tenant looking for D's (`Rows Removed by Filter: 270403`). A first attempt to bound the range with `max(cursor) WHERE tenantId = $1` moved the same walk into the `max()` (78 ms, the planner walks the primary key backwards), so it was measured and discarded.

Fix (`prisma-chatbot-feed.store.ts`, no schema change): bound the range by the tenant's own highest cursor, read through `(tenantId, cursor)`. Written as a closed range (`tenantId >= $1 AND tenantId <= $1 ORDER BY tenantId DESC, cursor DESC LIMIT 1`) the tenant column is no longer a constant for the planner, so only `(tenantId, cursor)` can answer it: one index probe (4 to 5 buffers). `cursor <= head` costs nothing (a row above it is not visible to the statement anyway) and makes the range empty for a bot that is caught up. Result for tenant D: **0.02 ms and 7 to 8 buffers** (the plan is now an index scan on `(tenantId, cursor)` or, in other runs, the primary key over an empty range). The recovery route's `currentFeedCursor` uses the same probe.

Remaining caveat (reasoned, not measured): for a big tenant whose bot is far behind and whose backlog is spread thinly among other tenants' rows, the primary-key range is the tenant's own backlog span, which can contain neighbours' rows. That is bounded by the 30-day retention and is the price of keeping `cursor` a global sequence; making `(tenantId, cursor)` the primary key would remove it and is not proposed here (it is a non-additive migration).

## EXPLAIN (ANALYZE, BUFFERS)

The statements are captured from the Prisma query log of the real stores (the feed read, the pending list) or taken from the store's own SQL (recovery), with the parameters inlined, and run twice; the second (warm) run is shown. The tables were `ANALYZE`d but not vacuumed, so index-only scans show `Heap Fetches`. Local Docker PostgreSQL 17, `shared_buffers = 128MB`.

Highlights:

- **Feed read**, every tenant in this run (A is 62 % of the feed rows, B 29 %, C and D small): `Index Scan using "chatbot_feed_items_tenantId_cursor_idx"` with `tenantId = $1 AND cursor > $2 AND cursor <= head`, 0.02 to 0.05 ms and 8 to 14 buffers (0 rows at the tail costs 8 buffers); the head probe is an `Index Only Scan Backward` on the same index (4 to 5 buffers). In earlier runs of the same script the planner took the primary key with a tenant filter for the two big tenants (`chatbot_feed_items_pkey`, the same bounded range, 12 buffers, 0.04 ms): the choice moves with the sampled statistics, and the head bound keeps both plans bounded.
- **Pending deliveries**: by `conversationRef` an `Index Scan using chatbot_feed_items_deferred_idx` (the partial index now covers both deferrals), by `requestId` the `(tenantId, requestId)` index with a filter on the outcome and an 8-row sort; both under 0.03 ms.
- **Recovery** pages (open only, middle page, and with `updatedSince` = 30 days ago, first and middle page): `Index Scan using chatbot_requests_open_recovery_idx` and, for the closed branch, `chatbot_requests_closed_recovery_idx`, merged by a `Merge Append` under `Limit`; no `Sort` node, 6 to 11 buffers, 0.03 to 0.06 ms. The keyset position is an `Index Cond` on `ROW(updatedAt, id)`.
- **Undelivered items of 50 requests**: a nested loop over the 50 ids with one `(tenantId, requestId)` index probe each, 550 buffers for the 50 probes, 0.29 ms.
- **Current feed cursor**: the `(tenantId, cursor)` head probe plus the retention row, 0.02 ms.

### feed read: readAfter(after=mid, limit 50)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "cursor" > 2185160 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "tenantId" <= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=1.43..179.05 rows=50 width=401) (actual time=0.024..0.042 rows=50 loops=1)
  Buffers: shared hit=14
  InitPlan 1
    ->  Limit  (cost=0.42..1.01 rows=1 width=45) (actual time=0.014..0.014 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..117314.38 rows=200645 width=45) (actual time=0.013..0.013 rows=1 loops=1)
                Index Cond: (("tenantId" >= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("tenantId" <= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..3563.47 rows=1003 width=401) (actual time=0.023..0.038 rows=50 loops=1)
        Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND (cursor > 2185160) AND (cursor <= (InitPlan 1).col1))
        Buffers: shared hit=14
Planning Time: 0.098 ms
Execution Time: 0.054 ms
```

### feed read: assertCursorRetained(after=mid)

```sql
SELECT "public"."chatbot_feed_retention"."tenantId", "public"."chatbot_feed_retention"."purgedThroughCursor" FROM "public"."chatbot_feed_retention" WHERE "public"."chatbot_feed_retention"."tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' LIMIT 1 OFFSET 0
```

```text
Limit  (cost=0.00..1.00 rows=1 width=40) (actual time=0.003..0.004 rows=0 loops=1)
  Buffers: shared hit=1
  ->  Seq Scan on chatbot_feed_retention  (cost=0.00..1.00 rows=1 width=40) (actual time=0.003..0.003 rows=0 loops=1)
        Filter: ("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text)
        Buffers: shared hit=1
Planning Time: 0.021 ms
Execution Time: 0.008 ms
```

### feed read: nearest-tail readAfter(after=max-10)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "cursor" > 2355352 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "tenantId" <= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=1.43..179.05 rows=50 width=401) (actual time=0.014..0.019 rows=10 loops=1)
  Buffers: shared hit=18
  InitPlan 1
    ->  Limit  (cost=0.42..1.01 rows=1 width=45) (actual time=0.009..0.009 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..117314.38 rows=200645 width=45) (actual time=0.008..0.008 rows=1 loops=1)
                Index Cond: (("tenantId" >= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("tenantId" <= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..3563.47 rows=1003 width=401) (actual time=0.014..0.018 rows=10 loops=1)
        Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND (cursor > 2355352) AND (cursor <= (InitPlan 1).col1))
        Buffers: shared hit=18
Planning:
  Buffers: shared hit=5
Planning Time: 0.097 ms
Execution Time: 0.028 ms
```

### pending-deliveries by conversationRef

```sql
SELECT "public"."chatbot_feed_items"."cursor", "public"."chatbot_feed_items"."deliveryId", "public"."chatbot_feed_items"."type", "public"."chatbot_feed_items"."requestId", "public"."chatbot_feed_items"."conversationRef", "public"."chatbot_feed_items"."payload", "public"."chatbot_feed_items"."outcome" FROM "public"."chatbot_feed_items" WHERE ("public"."chatbot_feed_items"."tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "public"."chatbot_feed_items"."conversationRef" = 'wa:525600019000' AND "public"."chatbot_feed_items"."outcome" IN ('DEFERRED_WINDOW_CLOSED','DEFERRED_HUMAN_SESSION') AND "public"."chatbot_feed_items"."ackedAt" IS NULL) ORDER BY "public"."chatbot_feed_items"."cursor" ASC LIMIT 50 OFFSET 0
```

```text
Limit  (cost=0.28..8.30 rows=1 width=403) (actual time=0.008..0.012 rows=8 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using chatbot_feed_items_deferred_idx on chatbot_feed_items  (cost=0.28..8.30 rows=1 width=403) (actual time=0.007..0.011 rows=8 loops=1)
        Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("conversationRef" = 'wa:525600019000'::text))
        Buffers: shared hit=10
Planning Time: 0.067 ms
Execution Time: 0.018 ms
```

### pending-deliveries by requestId

```sql
SELECT "public"."chatbot_feed_items"."cursor", "public"."chatbot_feed_items"."deliveryId", "public"."chatbot_feed_items"."type", "public"."chatbot_feed_items"."requestId", "public"."chatbot_feed_items"."conversationRef", "public"."chatbot_feed_items"."payload", "public"."chatbot_feed_items"."outcome" FROM "public"."chatbot_feed_items" WHERE ("public"."chatbot_feed_items"."tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "public"."chatbot_feed_items"."requestId" = '79dec612-5eab-4dd1-8fbc-f5b8568e9fc3' AND "public"."chatbot_feed_items"."outcome" IN ('DEFERRED_WINDOW_CLOSED','DEFERRED_HUMAN_SESSION') AND "public"."chatbot_feed_items"."ackedAt" IS NULL) ORDER BY "public"."chatbot_feed_items"."cursor" ASC LIMIT 50 OFFSET 0
```

```text
Limit  (cost=22.29..22.29 rows=1 width=403) (actual time=0.016..0.017 rows=8 loops=1)
  Buffers: shared hit=11
  ->  Sort  (cost=22.29..22.29 rows=1 width=403) (actual time=0.015..0.016 rows=8 loops=1)
        Sort Key: cursor
        Sort Method: quicksort  Memory: 29kB
        Buffers: shared hit=11
        ->  Index Scan using "chatbot_feed_items_tenantId_requestId_idx" on chatbot_feed_items  (cost=0.42..22.28 rows=1 width=403) (actual time=0.008..0.012 rows=8 loops=1)
              Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("requestId" = '79dec612-5eab-4dd1-8fbc-f5b8568e9fc3'::text))
              Filter: (("ackedAt" IS NULL) AND (outcome = ANY ('{DEFERRED_WINDOW_CLOSED,DEFERRED_HUMAN_SESSION}'::text[])))
              Buffers: shared hit=11
Planning Time: 0.068 ms
Execution Time: 0.023 ms
```

### recovery: first page, open only

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "status" IN ('NEW', 'IN_PROGRESS') ORDER BY "updatedAt", "id" LIMIT 51) ) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.41..111.81 rows=51 width=201) (actual time=0.007..0.024 rows=51 loops=1)
  Buffers: shared hit=6
  ->  Limit  (cost=0.41..111.81 rows=51 width=201) (actual time=0.007..0.021 rows=51 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.41..10913.02 rows=4996 width=201) (actual time=0.007..0.018 rows=51 loops=1)
              Index Cond: ("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text)
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=3
Planning Time: 0.139 ms
Execution Time: 0.033 ms
```

### recovery: middle page, open only

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "status" IN ('NEW', 'IN_PROGRESS') AND ("updatedAt", "id") > ('2026-10-29T20:56:02.417Z'::timestamp(3), '1b16d69c-bdde-4c05-bc90-dcea5c82591d') ORDER BY "updatedAt", "id" LIMIT 51) ) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.41..154.02 rows=51 width=201) (actual time=0.015..0.032 rows=51 loops=1)
  Buffers: shared hit=7
  ->  Limit  (cost=0.41..154.02 rows=51 width=201) (actual time=0.015..0.029 rows=51 loops=1)
        Buffers: shared hit=7
        ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.41..5684.02 rows=1887 width=201) (actual time=0.015..0.026 rows=51 loops=1)
              Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND (ROW("updatedAt", id) > ROW('2026-10-29 20:56:02.417'::timestamp(3) without time zone, '1b16d69c-bdde-4c05-bc90-dcea5c82591d'::text)))
              Buffers: shared hit=7
Planning:
  Buffers: shared hit=3
Planning Time: 0.151 ms
Execution Time: 0.042 ms
```

### recovery: first page, updatedSince = 30 days ago (open + closed branches)

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "status" IN ('NEW', 'IN_PROGRESS') ORDER BY "updatedAt", "id" LIMIT 51) UNION ALL ( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "status" IN ('RESOLVED', 'CANCELLED') AND "updatedAt" >= '2026-10-12T00:29:26.940Z'::timestamp(3) AND "closedAt" >= '2026-10-12T00:29:26.940Z'::timestamp(3) ORDER BY "updatedAt", "id" LIMIT 51)) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.83..95.95 rows=51 width=201) (actual time=0.012..0.035 rows=51 loops=1)
  Buffers: shared hit=11
  ->  Merge Append  (cost=0.83..191.07 rows=102 width=201) (actual time=0.012..0.032 rows=51 loops=1)
        Sort Key: chatbot_requests."updatedAt", chatbot_requests.id
        Buffers: shared hit=11
        ->  Limit  (cost=0.41..111.81 rows=51 width=201) (actual time=0.007..0.007 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.41..10913.02 rows=4996 width=201) (actual time=0.007..0.007 rows=1 loops=1)
                    Index Cond: ("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text)
                    Buffers: shared hit=4
        ->  Limit  (cost=0.41..78.24 rows=51 width=201) (actual time=0.005..0.021 rows=51 loops=1)
              Buffers: shared hit=7
              ->  Index Scan using chatbot_requests_closed_recovery_idx on chatbot_requests chatbot_requests_1  (cost=0.41..14769.20 rows=9678 width=201) (actual time=0.004..0.018 rows=51 loops=1)
                    Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("updatedAt" >= '2026-10-12 00:29:26.94'::timestamp(3) without time zone))
                    Filter: ("closedAt" >= '2026-10-12 00:29:26.94'::timestamp(3) without time zone)
                    Buffers: shared hit=7
Planning:
  Buffers: shared hit=6
Planning Time: 0.277 ms
Execution Time: 0.050 ms
```

### recovery: middle page, updatedSince = 30 days ago

```sql
SELECT * FROM (( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "status" IN ('NEW', 'IN_PROGRESS') AND ("updatedAt", "id") > ('2026-10-22T00:31:55.415Z'::timestamp(3), '726e8dd4-eb47-49fa-97b8-c49e3b030176') ORDER BY "updatedAt", "id" LIMIT 51) UNION ALL ( SELECT "id", "folio", "kind", "subtype", "status", "conversationRef", "humanDecisionId", "deliveryZoneRequestId", "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt", "updatedAt", "closedAt" FROM "chatbot_requests" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "status" IN ('RESOLVED', 'CANCELLED') AND "updatedAt" >= '2026-10-12T00:29:26.940Z'::timestamp(3) AND "closedAt" >= '2026-10-12T00:29:26.940Z'::timestamp(3) AND ("updatedAt", "id") > ('2026-10-22T00:31:55.415Z'::timestamp(3), '726e8dd4-eb47-49fa-97b8-c49e3b030176') ORDER BY "updatedAt", "id" LIMIT 51)) AS page ORDER BY "updatedAt", "id" LIMIT 51
```

```text
Limit  (cost=0.83..129.00 rows=51 width=201) (actual time=0.015..0.039 rows=51 loops=1)
  Buffers: shared hit=10
  ->  Merge Append  (cost=0.83..257.17 rows=102 width=201) (actual time=0.015..0.036 rows=51 loops=1)
        Sort Key: chatbot_requests."updatedAt", chatbot_requests.id
        Buffers: shared hit=10
        ->  Limit  (cost=0.41..137.11 rows=51 width=201) (actual time=0.009..0.013 rows=15 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using chatbot_requests_open_recovery_idx on chatbot_requests  (cost=0.41..7744.44 rows=2889 width=201) (actual time=0.009..0.012 rows=15 loops=1)
                    Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND (ROW("updatedAt", id) > ROW('2026-10-22 00:31:55.415'::timestamp(3) without time zone, '726e8dd4-eb47-49fa-97b8-c49e3b030176'::text)))
                    Buffers: shared hit=4
        ->  Limit  (cost=0.41..119.03 rows=51 width=201) (actual time=0.006..0.019 rows=37 loops=1)
              Buffers: shared hit=6
              ->  Index Scan using chatbot_requests_closed_recovery_idx on chatbot_requests chatbot_requests_1  (cost=0.41..13013.41 rows=5595 width=201) (actual time=0.006..0.017 rows=37 loops=1)
                    Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("updatedAt" >= '2026-10-12 00:29:26.94'::timestamp(3) without time zone) AND (ROW("updatedAt", id) > ROW('2026-10-22 00:31:55.415'::timestamp(3) without time zone, '726e8dd4-eb47-49fa-97b8-c49e3b030176'::text)))
                    Filter: ("closedAt" >= '2026-10-12 00:29:26.94'::timestamp(3) without time zone)
                    Buffers: shared hit=6
Planning:
  Buffers: shared hit=6
Planning Time: 0.315 ms
Execution Time: 0.056 ms
```

### recovery: undelivered items of 50 requests (LATERAL)

```sql
SELECT d."cursor", d."deliveryId"::text AS "deliveryId", d."type", d."requestId", d."conversationRef", d."payload", d."outcome" FROM unnest(ARRAY['1b16d69c-bdde-4c05-bc90-dcea5c82591d','63017067-48a2-455e-9595-bde1c460ddaf','9df6fd29-14fe-4f6e-883a-602f0a91e7d1','fd8dcbea-4c46-41ba-b197-705e92c9b769','f6ccf1e5-d2c4-4d08-98e5-21f012fd4abe','16875776-f039-432f-93b3-b71bd75fb030','507c2b53-3015-413b-9b89-fa89d3b1d521','05572710-b998-4b06-a0bd-ed1bb9179aba','04939a83-618b-458e-9416-c91ab0c950e3','5e664d16-4091-496d-81c7-c6a85ba911ca','1a5ad0bc-052d-4663-9925-083d05b5794f','08952dce-b0e2-4b91-a3d7-107cbb4fef83','6820d6c3-44f2-4b9d-8fb0-3bb8bce4f8f6','30604a64-4300-4b4b-8c3f-5564a70ae91c','6ab0686f-8800-46a5-9514-5fd7af14ba0e','0b5a15e3-ea59-4493-8798-b73c355fe352','ebd00768-ca74-4bf5-b8f4-26ad635b9885','5487651c-c453-4ab2-b3d0-05c43fd6a5d2','f0fd6449-7a8a-4709-81ad-a9fc6cb6866d','710daba5-d5c7-4d7e-9f46-b6d5159dc98e','20e440cf-9f8f-486e-93ad-f7a0bc9b0078','7336219c-e754-4766-bd68-947933eb9dba','bc9dd27c-319c-429d-a3ea-4b51195f8ecd','3d5135be-9dc4-4305-b8c1-28a59751f878','1b43039f-1028-4483-a6ad-88896de09123','614a79d2-3033-4ddf-abe4-2c6afd0e9ee8','365f8dc1-1228-4b94-950b-cf792ab6d341','a64d1b4c-7531-4e72-838c-29fa1f6df617','ae6350c8-8b77-45a8-b422-ece84b52a047','368d48c1-87ac-446d-997b-1e866295f544','57e186e7-ab1e-4901-9b04-4020e765a6fe','8b76b37f-6977-4e67-aebb-996d0ab2a73e','d72765c4-af43-4a12-8031-1f50c21ae8ab','d4d76d7e-c50f-44b2-a05e-ab284e79874e','ed913676-ce84-42c6-9bc3-c9a73b98ba4a','69d8cd71-ad18-4397-a8cb-4be87112afae','fa233891-1d7e-4505-9bb7-f029d69044f5','a7b832b6-d1b8-417e-9563-a368f4e129a3','f61f4739-58e8-4c64-8dc0-6c9b7d5d3d61','1ae6e746-3210-4b3a-95de-30d6da85e2bb','8a3ab84e-b37a-446b-9efb-972d3f7deb11','7abf5fbf-a96e-4139-be01-4435118577b8','49a9433b-1cf9-4e91-8458-e57f6f174ee9','6852aa9e-cac9-48df-bdb7-30074323222c','d5708cbb-a130-4b44-a5f7-238f86e8ae80','1fb497bc-5bf6-4a34-b863-638e34c499df','b7529c46-9c91-483a-bdbf-75a9941a94b4','5f9173d9-d32d-4ef8-8c95-cfdfc7568ba4','1ffffba9-b1ca-42a9-89a9-3b218a0b1f64','6e003b27-90e1-4732-a210-59a800e7b1e7']::text[]::text[]) AS r("id") CROSS JOIN LATERAL ( SELECT f."cursor", f."deliveryId", f."type", f."requestId", f."conversationRef", f."payload", f."outcome" FROM "chatbot_feed_items" f WHERE f."tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND f."requestId" = r."id" AND f."ackedAt" IS NULL ORDER BY f."cursor" DESC LIMIT 5) AS d ORDER BY d."cursor"
```

```text
Sort  (cost=1289.48..1289.60 rows=50 width=419) (actual time=0.277..0.278 rows=0 loops=1)
  Sort Key: f.cursor
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=550
  ->  Nested Loop  (cost=25.73..1288.07 rows=50 width=419) (actual time=0.276..0.276 rows=0 loops=1)
        Buffers: shared hit=550
        ->  Function Scan on unnest r  (cost=0.00..0.50 rows=50 width=32) (actual time=0.003..0.006 rows=50 loops=1)
        ->  Limit  (cost=25.73..25.74 rows=1 width=403) (actual time=0.005..0.005 rows=0 loops=50)
              Buffers: shared hit=550
              ->  Sort  (cost=25.73..25.74 rows=1 width=403) (actual time=0.005..0.005 rows=0 loops=50)
                    Sort Key: f.cursor DESC
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=550
                    ->  Index Scan using "chatbot_feed_items_tenantId_requestId_idx" on chatbot_feed_items f  (cost=0.42..25.72 rows=1 width=403) (actual time=0.005..0.005 rows=0 loops=50)
                          Index Cond: (("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("requestId" = r.id))
                          Filter: ("ackedAt" IS NULL)
                          Rows Removed by Filter: 8
                          Buffers: shared hit=550
Planning Time: 0.080 ms
Execution Time: 0.289 ms
```

### recovery: current feed cursor

```sql
SELECT GREATEST( COALESCE(( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' AND "tenantId" <= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1), 0), COALESCE((SELECT "purgedThroughCursor" FROM "chatbot_feed_retention" WHERE "tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'), 0)) AS "cursor"
```

```text
Result  (cost=2.01..2.02 rows=1 width=8) (actual time=0.014..0.014 rows=1 loops=1)
  Buffers: shared hit=6
  InitPlan 1
    ->  Limit  (cost=0.42..1.01 rows=1 width=45) (actual time=0.010..0.010 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..117314.38 rows=200645 width=45) (actual time=0.009..0.010 rows=1 loops=1)
                Index Cond: (("tenantId" >= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text) AND ("tenantId" <= 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  InitPlan 2
    ->  Seq Scan on chatbot_feed_retention  (cost=0.00..1.00 rows=1 width=8) (actual time=0.003..0.003 rows=0 loops=1)
          Filter: ("tenantId" = 'eb2c9784-9a4c-4faf-8e2d-a95991b8c916'::text)
          Buffers: shared hit=1
Planning Time: 0.062 ms
Execution Time: 0.022 ms
```

### feed read, big neighbour tenant B: readAfter(after=mid)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = '5ff7807b-828c-4241-8f39-36a3aff198a7' AND "cursor" > 2187460 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= '5ff7807b-828c-4241-8f39-36a3aff198a7' AND "tenantId" <= '5ff7807b-828c-4241-8f39-36a3aff198a7' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=1.88..180.92 rows=50 width=401) (actual time=0.020..0.037 rows=50 loops=1)
  Buffers: shared hit=14
  InitPlan 1
    ->  Limit  (cost=0.42..1.45 rows=1 width=45) (actual time=0.012..0.012 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..103517.07 rows=100476 width=45) (actual time=0.012..0.012 rows=1 loops=1)
                Index Cond: (("tenantId" >= '5ff7807b-828c-4241-8f39-36a3aff198a7'::text) AND ("tenantId" <= '5ff7807b-828c-4241-8f39-36a3aff198a7'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..1797.98 rows=502 width=401) (actual time=0.020..0.034 rows=50 loops=1)
        Index Cond: (("tenantId" = '5ff7807b-828c-4241-8f39-36a3aff198a7'::text) AND (cursor > 2187460) AND (cursor <= (InitPlan 1).col1))
        Buffers: shared hit=14
Planning Time: 0.090 ms
Execution Time: 0.048 ms
```

### feed read, quiet tenant C: readAfter(after=0)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = 'f4b1a50c-ee6e-4077-9974-6993f5c93513' AND "cursor" > 0 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= 'f4b1a50c-ee6e-4077-9974-6993f5c93513' AND "tenantId" <= 'f4b1a50c-ee6e-4077-9974-6993f5c93513' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=8.86..16.33 rows=1 width=401) (actual time=0.009..0.012 rows=4 loops=1)
  Buffers: shared hit=12
  InitPlan 1
    ->  Limit  (cost=0.42..8.44 rows=1 width=45) (actual time=0.004..0.005 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..8.44 rows=1 width=45) (actual time=0.004..0.004 rows=1 loops=1)
                Index Cond: (("tenantId" >= 'f4b1a50c-ee6e-4077-9974-6993f5c93513'::text) AND ("tenantId" <= 'f4b1a50c-ee6e-4077-9974-6993f5c93513'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..7.89 rows=1 width=401) (actual time=0.009..0.011 rows=4 loops=1)
        Index Cond: (("tenantId" = 'f4b1a50c-ee6e-4077-9974-6993f5c93513'::text) AND (cursor > 0) AND (cursor <= (InitPlan 1).col1))
        Buffers: shared hit=12
Planning:
  Buffers: shared hit=5
Planning Time: 0.092 ms
Execution Time: 0.020 ms
```

### feed read, quiet tenant C: poll at its own tail (after=its max, others keep writing)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = 'f4b1a50c-ee6e-4077-9974-6993f5c93513' AND "cursor" > 2287462 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= 'f4b1a50c-ee6e-4077-9974-6993f5c93513' AND "tenantId" <= 'f4b1a50c-ee6e-4077-9974-6993f5c93513' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=8.86..16.33 rows=1 width=401) (actual time=0.009..0.009 rows=0 loops=1)
  Buffers: shared hit=8
  InitPlan 1
    ->  Limit  (cost=0.42..8.44 rows=1 width=45) (actual time=0.005..0.006 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..8.44 rows=1 width=45) (actual time=0.005..0.005 rows=1 loops=1)
                Index Cond: (("tenantId" >= 'f4b1a50c-ee6e-4077-9974-6993f5c93513'::text) AND ("tenantId" <= 'f4b1a50c-ee6e-4077-9974-6993f5c93513'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..7.89 rows=1 width=401) (actual time=0.009..0.009 rows=0 loops=1)
        Index Cond: (("tenantId" = 'f4b1a50c-ee6e-4077-9974-6993f5c93513'::text) AND (cursor > 2287462) AND (cursor <= (InitPlan 1).col1))
        Buffers: shared hit=8
Planning Time: 0.081 ms
Execution Time: 0.018 ms
```

### feed read, stalled tenant D (40k items, none for a long time): poll at its own tail (after=its max)

```sql
SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId", "conversationRef", "payload" FROM "chatbot_feed_items" WHERE "tenantId" = '7ca18609-0acb-48ac-8bff-d0fced599fe0' AND "cursor" > 2084959 AND "cursor" <= ( SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" >= '7ca18609-0acb-48ac-8bff-d0fced599fe0' AND "tenantId" <= '7ca18609-0acb-48ac-8bff-d0fced599fe0' ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1) ORDER BY "cursor" LIMIT 50
```

```text
Limit  (cost=2.36..182.62 rows=50 width=401) (actual time=0.015..0.015 rows=0 loops=1)
  Buffers: shared hit=8
  InitPlan 1
    ->  Limit  (cost=0.42..1.94 rows=1 width=45) (actual time=0.010..0.011 rows=1 loops=1)
          Buffers: shared hit=5
          ->  Index Only Scan Backward using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items chatbot_feed_items_1  (cost=0.42..60329.07 rows=39745 width=45) (actual time=0.010..0.010 rows=1 loops=1)
                Index Cond: (("tenantId" >= '7ca18609-0acb-48ac-8bff-d0fced599fe0'::text) AND ("tenantId" <= '7ca18609-0acb-48ac-8bff-d0fced599fe0'::text))
                Heap Fetches: 1
                Buffers: shared hit=5
  ->  Index Scan using "chatbot_feed_items_tenantId_cursor_idx" on chatbot_feed_items  (cost=0.42..717.84 rows=199 width=401) (actual time=0.014..0.014 rows=0 loops=1)
        Index Cond: (("tenantId" = '7ca18609-0acb-48ac-8bff-d0fced599fe0'::text) AND (cursor > 2084959) AND (cursor <= (InitPlan 1).col1))
        Buffers: shared hit=8
Planning Time: 0.090 ms
Execution Time: 0.024 ms
```

## Caveats

- **Machine.** AMD Ryzen 7 5700G with Radeon Graphics x16, 31.2 GB, Node v24.14.1, PostgreSQL 17.9 (Debian 17.9-1.pgdg13+1) on x86_64-pc-linux-gnu in a local Docker container (`shared_buffers = 128MB`). The load generator, the Nest app, the writers and the database share one machine, and the app, the writers and the client share one Node process, so latencies include event-loop contention (conservative) and say nothing about the production VPS. Treat the numbers as the shape of the costs and the proof of the plans, not as a production forecast.
- **Run to run.** The first complete runs of the same script gave a p95 commit → bot of 8.2 to 11.1 ms and a feed read p95 of 5 to 12 ms; the conclusions do not change between runs.
- **Not in these numbers:** concurrent staff traffic on the same tables, the customer-group maintenance (not on these paths), a vacuumed table (index-only scans would avoid their heap fetches), more than one replica (the 2-poll cap is per replica) and a real network between the bot and the backend.
- **Messages.** The 200 000 "messages per tenant" are feed items here; the conversation mirror (unit 9) has its own targets.
- **Idle CPU** is the whole Jest process (app, client, writers); a stray GC tick shows in a single window, which is why the median of three windows is used and every window is printed.
