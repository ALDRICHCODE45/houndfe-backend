# Scheduled conversations: load test results (unit 14)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §4.9 and §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database plus the `EXPLAIN (ANALYZE, BUFFERS)` of the real statements; a missed target is reported with its measured numbers). Technical detail: `docs/chatbot-requests-model.md` ("Scheduled conversations"), bot contract "Scheduled conversations (unit 14)", frontend handoff `docs/frontend-handoff/21-scheduled-conversations.md`.

**Result: after one query fix, every target passes.** The first run at scale found one real problem and two over-strict checks of mine:

- **Real, fixed (query change, no schema change):** the post-commit `needsReschedule` flag pass wrote one `realtime_events` row per round trip, so a batch of 200 flagged requests cost **133 ms p95** (target 100 ms) while holding 200 request rows locked. The events now go in one statement per batch: **37 ms p95**, the whole pass over 2,395 candidates fell from 1,337 ms to 402 ms.
- **Real, fixed (counter bug, no performance effect):** `ScheduleSweepStore.runBatch` counted every "solicitud nueva" notice twice in its result (`notices` was an outcome kind and was also incremented for `noticed`). The log line and the tick total were inflated (400 notices for 200 sent). The row writes were right; the spec's drain verdict caught it.
- **My checks, relaxed with evidence (no code change):** (a) the inbox counts statement contains the unit 4 `openGroups` subquery, a ~1 ms seq scan of the small groups table; (b) the last flag batch uses a bitmap scan of the primary key ANDed with the scheduled index (0.9 ms), not an ordered walk of the key. Both are explained below.

No migration was needed: the migration `20261114010000_scheduled_conversations_perf` was therefore **not created**. The indexes of migrations `20261114000000_scheduled_conversations` and `20261110000000_chatbot_requests` already serve every statement at this size (the slot counters' primary key, `chatbot_requests_schedule_due_idx`, `chatbot_requests_open_scheduled_idx`, `chatbot_requests_open_scheduled_uq`, the customer groups index).

## How to reproduce

```sh
PERF=1 pnpm test:integration src/chatbot-requests/scheduled-conversations-load.integration.spec.ts
# optional: PERF_REPORT_PATH=/tmp/my-report.json (default /tmp/scheduled-conversations-load-report.json)
```

The spec is skipped in every normal run (it needs `PERF=1`), runs inside the project's integration harness (which resolves and guards the test-database URL, so it cannot reach dev or production) and takes about 75 seconds (seeding ~8 s). Sizes are knobs: `PERF_PLAIN`, `PERF_SCHEDULED`, `PERF_DUE`, `PERF_CLOSED`, `PERF_HISTORY`, `PERF_CUSTOMERS`, `PERF_MSGS`, `PERF_NOISE_PLAIN/SCHEDULED/DUE/CLOSED/HISTORY`, `PERF_SPARSE_PLAIN/SCHEDULED/CLOSED`, `PERF_SAMPLES`. The JSON report (every number and every plan) is written **before** the targets are asserted, so a failing run still leaves its numbers. Targets are asserted, not only reported.

## Data

Seeded with SQL (`generate_series`) in the integration test database, then `ANALYZE`. The branch is open around the clock (so the real clock never decides a measurement), scheduling is on, blocks are 30 minutes, 3 are offered, and `maxScheduledPerSlot` is **2** so that a quarter of the blocks are full.

| Tenant | Role                                                    | Requests                                                                                                                                                                                                                                                                                                   | Slot counters                   |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| A      | the measured tenant                                     | 20,700: 3,000 plain open (30 % in progress), **2,500 open scheduled** over six weeks of blocks (a permutation of the blocks: 1 or 2 per block), 100 with the reminder due, 100 with the notice due, 15,000 closed, 2,000 closed that had a schedule (resolved or cancelled); ~2,000 customers, 2,000 chats | 2,700 rows, **484 full blocks** |
| B, C   | noise (the sweep and the flag pass see the whole table) | 12,550 each: 1,500 plain open, 1,500 scheduled, 50 + 50 due, 8,000 closed, 1,000 closed scheduled                                                                                                                                                                                                          | filled the same way             |
| S      | sparse: the Agendadas tab's worst case                  | 3,030: 3,000 plain open, **30 scheduled**                                                                                                                                                                                                                                                                  | 30 rows                         |

Whole tables at measuring time: `chatbot_requests` 52,988 (5,930 open scheduled in all tenants; tenant A has 5,700 open, of them 2,700 scheduled), `scheduled_slot_counters` 5,446, `chatbot_conversations` 9,800, `conversation_messages` 98,000 (10 per chat). Tenant A's group table, folio counter and settings are consistent with the rows (the counters are the `count(*)` of the booked rows per block, which is what `reserveSeat` keeps).

What is measured: the real controllers, guards (the bot guard writes a `service_rate_buckets` row per request), stores and serialization **over HTTP** on localhost, one request at a time. Reads: 5 warm-up calls, then 200 samples. Commands: every call changes state, so each call is unique (5 unmeasured warm-ups first; the untimed preparation, such as asking the slots route for the block to book, is not part of the number). Staff authentication is a stub guard with the real permission metadata. The sweep is driven through `runBatch(now)` and `tick(now)` with the seed's frozen clock; the flag pass with a fixed `now`.

## Targets

§10.1 has a row for the Agenda listing (p95 < 100 ms), the grouped inbox (p95 < 200 ms per page) and the time sweep (< 50 ms per tick). **It has no row for booking, replay, reschedule, cancel, one sweep candidate or one flag batch. Those use the 100 ms bar of the Agenda row, derived (the same choice unit 11 made).** That choice is mine, not the proposal's, and S20 point 2 only asks that the create p95 be measured; the owner may want another bar. Every number is far under it.

| Target                                                                        | Limit                            | Measured (final run)                                                                                                   |                 |
| ----------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| Bot slots listing, p95 (§10.1 Agenda)                                         | < 100 ms                         | 10.97 ms                                                                                                               | PASS            |
| Staff slots picker, p95 (§10.1 Agenda)                                        | < 100 ms                         | 7.30 ms                                                                                                                | PASS            |
| **Booking create**, p95 (derived; S20 2)                                      | < 100 ms                         | **18.76 ms**                                                                                                           | PASS            |
| Same-key 2xx replay of the create, p95 (derived; S20 2)                       | < 100 ms                         | 5.68 ms                                                                                                                | PASS            |
| `409 SLOT_UNAVAILABLE` on a full block, p95 (derived)                         | < 100 ms                         | 13.62 ms                                                                                                               | PASS            |
| Bot reschedule / its same-key replay, p95 (derived)                           | < 100 ms                         | 17.03 / 6.16 ms                                                                                                        | PASS            |
| Staff reschedule, p95 (derived)                                               | < 100 ms                         | 15.47 ms                                                                                                               | PASS            |
| Bot cancel / staff cancel, p95 (derived)                                      | < 100 ms                         | 12.23 / 13.45 ms                                                                                                       | PASS            |
| No block over its cap after 600 mutations                                     | 0 overbooked                     | 0; seats in the counters = open scheduled requests (2,495 = 2,495)                                                     | PASS            |
| Inbox first page: open / Agendadas / sparse Agendadas, p95 (§10.1)            | < 200 ms                         | 21.39 / 19.64 / 17.73 ms                                                                                               | PASS            |
| Inbox Agendadas, every page of a full walk, p95 (§10.1)                       | < 200 ms                         | 19.81 ms over 100 pages (2,495 groups, 2,495 rows with `scheduledFor`, each customer once)                             | PASS            |
| Inbox counts (with `scheduled`) / detail / customer list / sparse counts, p95 | < 200 ms                         | 16.24 / 9.99 / 4.53 / 5.38 ms; `counts.scheduled` equals the table (2,495)                                             | PASS            |
| Sweep drains every due reminder and notice, nothing fails                     | 200 + 200, 0                     | 200 reminders, 200 notices, 0 failed, 0 due left (before the fix: 400 notices reported)                                | PASS            |
| Sweep, one candidate (own transaction), p95 (derived)                         | < 100 ms                         | 5.67 ms (reminders 5.93, notices 5.05)                                                                                 | PASS            |
| Sweep, a tick with nothing due, p95 (§10.1 "Barrido de tiempos")              | < 50 ms                          | 0.30 ms                                                                                                                | PASS            |
| Flag pass flags exactly the times outside the new hours                       | 1,779 of 2,395                   | 1,779 flagged, the second pass 0, `counts.needsReschedule` 1,779                                                       | PASS            |
| Flag pass, one batch of 200 (own transaction), p95 (derived)                  | < 100 ms                         | **37.14 ms** first pass (12 batches, 402 ms in all); 20.85 ms second pass (4 batches, 62 ms); was 133.28 ms / 1,337 ms | PASS (was FAIL) |
| Flag pass of the sparse tenant (30 scheduled rows), total (derived)           | < 100 ms                         | 17 of 17 flagged in 7.13 ms                                                                                            | PASS            |
| Plans: the slots counter read, the sweep candidates, the flag pass, the inbox | indexes, no seq scan of requests | yes (see below)                                                                                                        | PASS            |

### One batch of the sweep

One full batch is 100 candidates, each in its own transaction (4.2 ms mean): **377-461 ms** for a batch (4 batches). That is not a §10.1 number (the 50 ms bar is for a tick with nothing due) and has no target here; it is reported because a tick runs at most 5 batches (`MAX_BATCHES_PER_TICK`), so a backlog of 500 due rows costs about 2 s of one tick, spread over its 100 independent short transactions (no lock is held across candidates). The per-candidate p95 of 5.67 ms is the asserted number.

## Latency (ms)

| Read / command                                | n   | p50   | p95   | p99   | max   |
| --------------------------------------------- | --- | ----- | ----- | ----- | ----- |
| bot slots listing                             | 200 | 8.57  | 10.97 | 13.12 | 13.58 |
| staff slots picker                            | 200 | 5.66  | 7.30  | 9.67  | 12.16 |
| booking create                                | 200 | 14.64 | 18.76 | 20.04 | 21.61 |
| booking replay (same key, 200)                | 200 | 4.54  | 5.68  | 6.42  | 11.01 |
| booking 409 `SLOT_UNAVAILABLE` (full block)   | 100 | 11.37 | 13.62 | 17.16 | 17.31 |
| bot reschedule                                | 200 | 13.03 | 17.03 | 21.79 | 29.28 |
| bot reschedule replay                         | 100 | 4.65  | 6.16  | 7.14  | 10.23 |
| staff reschedule                              | 200 | 13.04 | 15.47 | 18.08 | 18.90 |
| bot cancel                                    | 200 | 9.96  | 12.23 | 16.11 | 17.06 |
| staff cancel                                  | 200 | 10.14 | 13.45 | 16.50 | 18.26 |
| inbox groups, open, first page (25 groups)    | 200 | 17.87 | 21.39 | 23.13 | 23.62 |
| inbox groups, Agendadas, first page           | 200 | 16.21 | 19.64 | 22.72 | 23.61 |
| inbox groups, Agendadas, walk (100 pages)     | 100 | 15.40 | 19.81 | 21.90 | 22.18 |
| inbox counts                                  | 200 | 12.36 | 16.24 | 17.92 | 23.60 |
| inbox detail of a scheduled request           | 200 | 6.04  | 9.99  | 13.48 | 24.86 |
| inbox customer list, `status=scheduled`       | 200 | 2.71  | 4.53  | 6.71  | 10.46 |
| sparse tenant, Agendadas first page           | 200 | 14.31 | 17.73 | 19.93 | 20.64 |
| sparse tenant, counts                         | 200 | 3.84  | 5.38  | 8.05  | 10.12 |
| sweep, one candidate (400 across both stages) | 400 | 4.09  | 5.67  | 7.12  | 10.98 |
| sweep, a tick with nothing due (30 samples)   | 30  | 0.24  | 0.30  | 0.30  | 0.30  |

The booking create is the heaviest command (a customer lock, the limits count, the seat upsert, the folio, the insert, the audit event, the group refresh), at 14.6 ms median. Its same-key replay is a receipt lookup by key (4.5 ms median, dominated by the bot guard's rate bucket write).

## The needsReschedule pass: before and after

Same data, same spec. The hours of tenant A shrink to Monday-Friday 09:00-18:00 plus a closed date 10 days ahead (`version` bumped, as a settings `PUT` does); 1,779 of the 2,395 open future `NEW` scheduled requests fall outside the new hours. "Before" is commit `1db41bc4`, "after" the working tree.

|                                     | Before                                 | After                                               |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------- |
| First pass, one batch of 200, p95   | **133.28 ms** (mean 111.37, min 96.90) | **37.14 ms** (mean 33.48, min 29.65)                |
| First pass, 12 batches, total       | 1,336.72 ms                            | 401.99 ms                                           |
| Second pass (nothing left to flag)  | 4 batches, 53.55 ms (p95 17.20)        | 4 batches, 62.24 ms (p95 20.85): same, within noise |
| Sparse tenant (30 scheduled), total | 19.41 ms                               | 7.13 ms                                             |
| Flagged                             | 1,779 (= the SQL expectation)          | 1,779 (= the SQL expectation)                       |

The candidate query was never the problem (2-3 ms a batch, below). The cost was `emitRealtimeEvents`, which runs one `INSERT ... RETURNING` per flagged request (200 round trips inside a transaction that holds the 200 request rows `FOR UPDATE`). `flagBatch` now inserts the batch's events in one statement (`INSERT ... SELECT FROM unnest(ids, versions)`), with the same advisory lock key, the same `NOTIFY` and the same event rows (`request.updated`, `{version, cause: NEEDS_RESCHEDULE}`, in id order), so the order guarantee of `realtime-event-writes.ts` is unchanged. Nothing else moved: the existing integration spec for the flag (event payload, version bump, no feed item, no audit event) passes unchanged.

## EXPLAIN (ANALYZE, BUFFERS)

Warm run of the statements the stores really ran (parameters inlined), on the data above. The complete plans of the final run are in the JSON report (`explain`); the excerpts keep the nodes that matter.

### Slots counter read (`readFullBlocks`, the next 14 days)

```text
Bitmap Heap Scan on scheduled_slot_counters  (actual time=0.081..0.215 rows=513 loops=1)
  Recheck Cond: (tenantId = '…' AND startsAt >= '…' AND startsAt < '…')
  Filter: (booked >= 2)
  Rows Removed by Filter: 158
  Buffers: shared hit=16
  ->  Bitmap Index Scan on scheduled_slot_counters_pkey  (actual time=0.067..0.067 rows=678 loops=1)
        Index Cond: (tenantId = '…' AND startsAt >= '…' AND startsAt < '…')
Execution Time: 0.248 ms
```

A range read of the counter's primary key `(tenantId, startsAt)`: 678 blocks in the horizon, 513 returned full (tenant A has 484 full blocks in all six weeks, plus those the run's own bookings filled). 16 buffers. This is the whole cost of "is this block free" for the listing; the booking itself is the single `INSERT ... ON CONFLICT ... WHERE booked < max` on the same key.

### Sweep candidates

Before the drain (400 due rows among 5,725 with a due instant):

```text
Limit  (actual time=0.353..0.362 rows=100)
  -> Sort (Sort Key: scheduleDueAt, id; top-N heapsort)
       -> Bitmap Heap Scan on chatbot_requests r  (rows=400)
            -> Bitmap Index Scan on chatbot_requests_schedule_due_idx   (Index Cond: scheduleDueAt <= now, rows=400)
Execution Time: 0.393 ms
```

Steady state (nothing due): the same index returns 0 rows, `Execution Time: 0.018 ms`, 3 buffers. The partial index holds only rows with a due instant, and it is read by range up to `now`; the 5,325 booked-but-not-due rows cost nothing except being in the index.

### Flag pass (`needsReschedule`)

First batch of tenant A (2,395 candidates; 200 returned):

```text
Limit  (actual time=2.440..2.572 rows=200)
  -> LockRows
       -> Sort (Sort Key: id; quicksort)
            -> Bitmap Heap Scan on chatbot_requests r  (rows=2395)
                 Filter: (NOT needsReschedule AND id > '' AND status = 'NEW')
                 -> Bitmap Index Scan on chatbot_requests_open_scheduled_idx   (tenantId = '…' AND scheduledFor > now, rows=2968)
Execution Time: 2.600 ms
```

A later batch: 2.26 ms (`Rows Removed by Filter: 600`: the `id >` keyset). The last batch: 1.00 ms in the final run, the scheduled index alone with `Rows Removed by Filter: 2,200`; in the first run the planner instead ANDed that index with a bitmap scan of the primary key for `id > …` (0.87 ms). Both are bounded by the tenant's open scheduled rows (2,968 index entries), never by the table. Sparse tenant, first batch: 0.08 ms.

A bitmap scan of the primary key is not the shape the check rejects. The check fails an **ordered walk** of the key (`Index Scan using chatbot_requests_pkey`, every tenant's rows in id order) or a seq scan; the first run's "bad node" was that harmless bitmap node, and the assertion now says so.

The cost grows with the tenant's open scheduled rows (one sort of at most that many ids per batch, 2.6 ms at 2,395), not with closed history or other tenants. No new index: a partial `(tenantId, id) WHERE status = 'NEW' AND scheduledFor IS NOT NULL AND NOT needsReschedule` would turn the sort into an ordered scan, and would only pay off for a tenant with tens of thousands of open scheduled rows at once (a batch of 200 would need to sort them all: ~50 ms at 25,000).

### Inbox, Agendadas tab (`status=scheduled`)

Dense tenant (2,495 scheduled customers, first page of 25 groups):

```text
Incremental Sort  (actual time=1.453..1.458 rows=26)
  -> Nested Loop Semi Join
       -> Index Scan using "chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx" on chatbot_customer_groups g   (rows=48)
       -> Index Only Scan using chatbot_requests_open_scheduled_uq on chatbot_requests r   (loops=48)
            Index Cond: (tenantId = '…' AND customerKey = g.customerKey)
  SubPlan 1 (overdueCount)  -> Index Scan using "chatbot_requests_tenantId_customerKey_status_idx"   (loops=26)
  Memoize -> Index Scan using chatbot_requests_open_scheduled_uq on chatbot_requests r_1   (the group's scheduled rows, loops=26)
Execution Time: 1.558 ms
```

The `EXISTS (scheduledFor IS NOT NULL)` of a filtered tab is served by the partial unique index `chatbot_requests_open_scheduled_uq` `(tenantId, customerKey, subtype) WHERE scheduledFor IS NOT NULL AND status IN (NEW, IN_PROGRESS)` (index-only: 26 heap fetches), and the group's rows by the same index. 0 sequential scans of `chatbot_requests`.

Sparse tenant (30 scheduled customers among 1,500 groups): the planner chooses a hash semi-join: `Index Only Scan using chatbot_requests_open_scheduled_uq` returns the 30 scheduled customers, hashed, and probes `chatbot_customer_groups` with a **seq scan of the 9,424-row groups table** (130 buffers, ~1 ms, 1.79 ms in all). That is cost-based and right at this table size. To prove the index plan exists the spec also explains the same statement with `SET LOCAL enable_seqscan = off`: it walks `chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx` (1,204 groups) in 3.53 ms. In production the groups table holds every tenant's open customers, so the planner's own statistics move it to the index plan as the table grows; the worst case measured here (30 scheduled among 1,500) is 17.73 ms p95 over HTTP.

### Inbox counts (`counts.scheduled`, `counts.needsReschedule`)

The `scheduled` subquery is an `Index Only Scan using chatbot_requests_open_scheduled_idx` (2,495 rows, 2,226 buffers because 2,340 heap fetches: the table was just changed by the run's 600 mutations and not yet vacuumed; the visibility map catches up). `needsReschedule` uses `chatbot_requests_open_needs_reschedule_idx` (1 buffer). The statement as a whole is 4.35 ms. It also contains the unit 4 `openGroups` subquery (`count(*)` of the tenant's groups): a seq scan of the groups table (130 buffers, ~1 ms) that unit 4 shipped; it is reported, not asserted, and is not a unit 14 statement.

## Notes and what this does not prove

- **One machine, not production hardware.** One tenant at a time on a local PostgreSQL, one connection per request, no Traefik, no second replica. The numbers show the shape (indexes used, no scan that grows with other tenants' rows, due work never starved); they are not capacity numbers.
- **Parameters are inlined for EXPLAIN.** Statistics are fresh (`ANALYZE` after the seed), so plans are the ones a warm production table would choose, not the ones a generic prepared plan would.
- **Seed realism.** 2,500 open scheduled requests in one tenant (half of the open requests) is deliberately heavy; a branch normally has tens to hundreds. The six-week spread and the 484 full blocks make `readFullBlocks` return hundreds of rows instead of a handful. The noise tenants make the sweep and flag queries share the table with 3,000 other scheduled rows. Messages are 10 per chat (unit 11 measured the 200,000-message inbox).
- **Not covered:** two sweep replicas at once (R11 is covered by the unit 14 integration spec, not by this load test), a real bot at the other end (the end-to-end proof is a separate gate), a settings `PUT` racing live bookings under load (the flag pass skips locked rows and the sweep backstop catches them: covered by the integration spec, not timed here), and the realtime delivery of the 1,779 `request.updated` events to open SSE connections (unit 8 measured delivery; a burst this size is one batch of 200 events per commit).
- **Cleanup.** The spec creates its tenants (cascade-deleted in `afterAll`) and one user, and leaves no rows behind.
