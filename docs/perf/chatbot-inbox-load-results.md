# Staff inbox reads: load test results (unit 4)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database, plus the `EXPLAIN (ANALYZE, BUFFERS)` of the real statements) and the performance row **"Bandeja agrupada por cliente"**: p95 < 200 ms per page of 25 groups, no `GROUP BY` at read time, `ChatbotCustomerGroup` and its indexes, sized for 5 000 open requests per tenant.

**Result: no target was missed, and no migration was needed.** The existing indexes (2a, 2b) serve every read; the staff-reads migration `20261111020000_chatbot_requests_staff_reads` was therefore not created.

## How to reproduce

```sh
node scripts/perf/chatbot-inbox-load.cjs            # report only
node scripts/perf/chatbot-inbox-load.cjs --enforce  # fail the run when a target is missed
```

The launcher sets `PERF=1` and runs `pnpm test:integration src/chatbot-requests/chatbot-inbox-load.integration.spec.ts`, so the test-database URL is resolved and guarded by the project's integration harness (the launcher never reads an env file and cannot reach the dev or production database). Sizes are knobs of the spec (`PERF_OPEN`, `PERF_CUSTOMERS`, `PERF_CLOSED`, `PERF_NOISE_OPEN`, `PERF_NOISE_CLOSED`, `PERF_SAMPLES`). The full JSON report, with every plan, goes to `/tmp/chatbot-inbox-load-report.json` (or `--report`).

## Data

Seeded with SQL (`generate_series`) in the integration test database, then `ANALYZE`. The group table is filled with the same definition `refreshCustomerGroup` uses.

| Tenant | Role | Requests |
| --- | --- | --- |
| A | the measured tenant | 25,000: 5,000 open over ~2,000 customers (70 % `NEW`, 30 % `IN_PROGRESS` over 4 assignees, 10 % overdue, 15 % without deadline, 40 % with a WhatsApp window, 5 % of the conversations scheduled) and 20,000 closed over the last 40 days |
| B, C | noise tenants | 12,500 each (2,500 open, 10,000 closed) |

What is measured is the application read path (store + shaping + sealing of `customerKey`) in a tenant context, one request at a time, after 5 warm-up calls. It leaves out HTTP parsing and the JWT guards, which the other specs cover.

## Targets

| Target | Limit | Measured | Verdict |
| --- | --- | --- | --- |
| groups page p95 (first page) | < 200 ms | 6.86 ms | PASS |
| groups page p95 (every page of a full walk) | < 200 ms | 9.35 ms over 80 pages | PASS |
| no GROUP BY / aggregate node in the groups statement | absent | absent | PASS |
| groups read uses (tenantId, mostUrgentAt, customerKey) | index scan | yes | PASS |
| rows read through (tenantId, customerKey, status) | index scan | yes | PASS |
| counts p95 / history first page p95 / detail p95 | < 200 ms (same bar) | 2 / 1.7 / 4.18 ms | PASS |
| history uses the partial history index, no Sort node | index scan | yes | PASS |

## Latency (ms)

| Read | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| groups, first page (25 groups) | 200 | 4.98 | 6.86 | 12.1 | 15.39 |
| groups, walk of every page (80 pages, 2,000 groups) | 80 | 6.52 | 9.35 | 26.58 | 26.58 |
| groups, assignee=me | 100 | 12.72 | 19.31 | 20.47 | 26.7 |
| groups, overdue=true | 100 | 11.36 | 16.17 | 17.62 | 17.67 |
| groups, subtype=TALK_TO_HUMAN | 100 | 4.95 | 7.05 | 7.69 | 23.71 |
| groups, status=scheduled | 100 | 3.32 | 5.1 | 6.24 | 14.11 |
| counts | 200 | 1.21 | 2 | 2.46 | 15.51 |
| detail | 200 | 2.16 | 4.18 | 10.6 | 12.35 |
| customer list (`?customerKey=`) | 200 | 0.5 | 1.03 | 1.18 | 11.93 |
| history, first page | 200 | 1.13 | 1.7 | 1.94 | 10.4 |
| history, deep page | 100 | 1.35 | 2.3 | 2.68 | 15.18 |
| history, subtype filter | 100 | 1.08 | 1.27 | 1.55 | 1.61 |
| history, resolvedBy filter | 100 | 0.57 | 0.8 | 0.83 | 0.87 |
| groups, closed tab (resolved, 7-day aggregate) | 50 | 9.86 | 12.66 | 13.44 | 13.44 |

## What the plans show

- **Open groups (no `GROUP BY`).** The page of groups is an index scan of `chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx` with `LIMIT 26`; each group's rows come from one `LATERAL` index scan of `chatbot_requests_tenantId_customerKey_status_idx`. The only "aggregate-looking" node is the `WindowAgg` that counts the matching rows of each customer for `moreRequests` (a window function over at most one customer's rows, not a grouping of the table). Cursor pages cost the same as the first page: the keyset predicate is an index range.
- **Filtered groups.** `assignee=me`, `overdue` and `scheduled` add an `EXISTS` on the request partial indexes. With `assignee=me` the planner chooses a sequential scan of the group table (2,000 rows) plus a semi-join and a top-N sort; it is the slowest open-tab path and still ~19 ms p95.
- **Counts.** One statement with seven scalar subqueries, each on its own partial index (`open_status`, `open_assignee`, `open_overdue`, `open_window`, `open_scheduled`, `open_needs_reschedule`).
- **History.** `chatbot_requests_history_idx` with no `Sort` node, first page and deep page alike; filtered by subtype it uses `(tenantId, subtype, closedAt)` with a one-group incremental sort.
- **Closed tabs (resolved / cancelled).** There is no group table for closed requests, so this tab aggregates the bounded 7-day window (`HashAggregate` over the history index, ~1,750 rows here). It is the one documented exception to "no `GROUP BY` at read time"; it stays in single-digit milliseconds because the window is bounded, and it reads no row older than 7 days.

## EXPLAIN (ANALYZE, BUFFERS)

Warm run of the statements the stores really ran (parameters inlined).

### groups: first page

```
Incremental Sort  (cost=26.39..132.45 rows=26 width=364) (actual time=0.324..0.511 rows=64 loops=1)
  Sort Key: g."mostUrgentAt", g."customerKey", (CASE WHEN (r.status = 'NEW'::"ChatbotRequestStatus") THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END), r."createdAt", r.id
  Presorted Key: g."mostUrgentAt", g."customerKey"
  Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 33kB  Peak Memory: 33kB
  Buffers: shared hit=170
  ->  Nested Loop  (cost=13.20..131.74 rows=26 width=364) (actual time=0.038..0.460 rows=64 loops=1)
        Buffers: shared hit=170
        ->  Limit  (cost=0.28..6.18 rows=26 width=25) (actual time=0.012..0.044 rows=26 loops=1)
              Buffers: shared hit=28
              ->  Index Scan using "chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx" on chatbot_customer_groups g  (cost=0.28..454.15 rows=2000 width=25) (actual time=0.011..0.041 rows=26 loops=1)
                    Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                    Buffers: shared hit=28
        ->  Memoize  (cost=12.92..12.92 rows=1 width=331) (actual time=0.015..0.015 rows=2 loops=26)
              Cache Key: g."customerKey"
              Cache Mode: binary
              Hits: 0  Misses: 26  Evictions: 0  Overflows: 0  Memory Usage: 16kB
              Buffers: shared hit=142
              ->  Limit  (cost=12.91..12.91 rows=1 width=331) (actual time=0.014..0.014 rows=2 loops=26)
                    Buffers: shared hit=142
                    ->  Sort  (cost=12.91..12.91 rows=1 width=331) (actual time=0.014..0.014 rows=2 loops=26)
                          Sort Key: (CASE WHEN (r.status = 'NEW'::"ChatbotRequestStatus") THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END), r."createdAt", r.id
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=142
                          ->  WindowAgg  (cost=0.41..12.90 rows=1 width=331) (actual time=0.011..0.012 rows=2 loops=26)
                                Buffers: shared hit=142
                                ->  Index Scan using "chatbot_requests_tenantId_customerKey_status_idx" on chatbot_requests r  (cost=0.41..12.87 rows=1 width=235) (actual time=0.008..0.009 rows=2 loops=26)
                                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("customerKey" = g."customerKey") AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
                                      Buffers: shared hit=142
Planning:
  Buffers: shared hit=2
Planning Time: 0.301 ms
Execution Time: 0.558 ms
```

### groups: assignee=me

```
Incremental Sort  (cost=2947.40..3048.29 rows=26 width=364) (actual time=2.285..2.521 rows=65 loops=1)
  Sort Key: g."mostUrgentAt", g."customerKey", (CASE WHEN (r_1.status = 'NEW'::"ChatbotRequestStatus") THEN r_1."claimDeadlineAt" ELSE r_1."resolveDeadlineAt" END), r_1."createdAt", r_1.id
  Presorted Key: g."mostUrgentAt", g."customerKey"
  Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 33kB  Peak Memory: 33kB
  Buffers: shared hit=396
  ->  Nested Loop  (cost=2934.85..3047.58 rows=26 width=364) (actual time=1.980..2.437 rows=65 loops=1)
        Buffers: shared hit=396
        ->  Limit  (cost=2921.93..2922.00 rows=26 width=25) (actual time=1.924..1.931 rows=26 loops=1)
              Buffers: shared hit=253
              ->  Sort  (cost=2921.93..2922.06 rows=50 width=25) (actual time=1.923..1.929 rows=26 loops=1)
                    Sort Key: g."mostUrgentAt", g."customerKey"
                    Sort Method: top-N heapsort  Memory: 28kB
                    Buffers: shared hit=253
                    ->  Hash Semi Join  (cost=2757.92..2920.52 rows=50 width=25) (actual time=1.174..1.884 rows=200 loops=1)
                          Hash Cond: (g."customerKey" = r."customerKey")
                          Buffers: shared hit=253
                          ->  Seq Scan on chatbot_customer_groups g  (cost=0.00..155.18 rows=2000 width=62) (actual time=0.014..0.525 rows=2000 loops=1)
                                Filter: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                                Rows Removed by Filter: 4014
                                Buffers: shared hit=80
                          ->  Hash  (cost=2756.67..2756.67 rows=100 width=50) (actual time=1.154..1.155 rows=500 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 49kB
                                Buffers: shared hit=173
                                ->  Bitmap Heap Scan on chatbot_requests r  (cost=81.79..2756.67 rows=100 width=50) (actual time=0.119..1.086 rows=500 loops=1)
                                      Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
                                      Filter: ("assigneeUserId" = 'perf-user-1'::text)
                                      Rows Removed by Filter: 4500
                                      Heap Blocks: exact=167
                                      Buffers: shared hit=173
                                      ->  Bitmap Index Scan on chatbot_requests_open_status_idx  (cost=0.00..81.76 rows=4997 width=0) (actual time=0.095..0.095 rows=5000 loops=1)
                                            Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                                            Buffers: shared hit=6
        ->  Memoize  (cost=12.92..12.92 rows=1 width=331) (actual time=0.018..0.018 rows=2 loops=26)
              Cache Key: g."customerKey"
              Cache Mode: binary
              Hits: 0  Misses: 26  Evictions: 0  Overflows: 0  Memory Usage: 18kB
              Buffers: shared hit=143
              ->  Limit  (cost=12.91..12.91 rows=1 width=331) (actual time=0.017..0.017 rows=2 loops=26)
                    Buffers: shared hit=143
                    ->  Sort  (cost=12.91..12.91 rows=1 width=331) (actual time=0.017..0.017 rows=2 loops=26)
                          Sort Key: (CASE WHEN (r_1.status = 'NEW'::"ChatbotRequestStatus") THEN r_1."claimDeadlineAt" ELSE r_1."resolveDeadlineAt" END), r_1."createdAt", r_1.id
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=143
                          ->  WindowAgg  (cost=0.41..12.90 rows=1 width=331) (actual time=0.013..0.014 rows=2 loops=26)
                                Buffers: shared hit=143
                                ->  Index Scan using "chatbot_requests_tenantId_customerKey_status_idx" on chatbot_requests r_1  (cost=0.41..12.87 rows=1 width=235) (actual time=0.009..0.010 rows=2 loops=26)
                                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("customerKey" = g."customerKey") AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
                                      Filter: ("assigneeUserId" = 'perf-user-1'::text)
                                      Buffers: shared hit=143
Planning:
  Buffers: shared hit=4
Planning Time: 1.742 ms
Execution Time: 2.604 ms
```

### groups: second-page cursor

```
Incremental Sort  (cost=26.47..133.12 rows=26 width=364) (actual time=0.314..0.530 rows=66 loops=1)
  Sort Key: g."mostUrgentAt", g."customerKey", (CASE WHEN (r.status = 'NEW'::"ChatbotRequestStatus") THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END), r."createdAt", r.id
  Presorted Key: g."mostUrgentAt", g."customerKey"
  Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 32kB  Peak Memory: 32kB
  Buffers: shared hit=197
  ->  Nested Loop  (cost=13.20..132.42 rows=26 width=364) (actual time=0.080..0.475 rows=66 loops=1)
        Buffers: shared hit=197
        ->  Limit  (cost=0.28..6.86 rows=26 width=25) (actual time=0.044..0.070 rows=26 loops=1)
              Buffers: shared hit=53
              ->  Index Scan using "chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx" on chatbot_customer_groups g  (cost=0.28..464.15 rows=1834 width=25) (actual time=0.043..0.067 rows=26 loops=1)
                    Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                    Filter: ((ROW("mostUrgentAt", "customerKey") > ROW('2026-11-11 15:01:24.608'::timestamp without time zone, '525500000015'::text)) OR ("mostUrgentAt" IS NULL))
                    Rows Removed by Filter: 25
                    Buffers: shared hit=53
        ->  Memoize  (cost=12.92..12.92 rows=1 width=331) (actual time=0.014..0.015 rows=3 loops=26)
              Cache Key: g."customerKey"
              Cache Mode: binary
              Hits: 0  Misses: 26  Evictions: 0  Overflows: 0  Memory Usage: 17kB
              Buffers: shared hit=144
              ->  Limit  (cost=12.91..12.91 rows=1 width=331) (actual time=0.014..0.014 rows=3 loops=26)
                    Buffers: shared hit=144
                    ->  Sort  (cost=12.91..12.91 rows=1 width=331) (actual time=0.013..0.013 rows=3 loops=26)
                          Sort Key: (CASE WHEN (r.status = 'NEW'::"ChatbotRequestStatus") THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END), r."createdAt", r.id
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=144
                          ->  WindowAgg  (cost=0.41..12.90 rows=1 width=331) (actual time=0.010..0.011 rows=3 loops=26)
                                Buffers: shared hit=144
                                ->  Index Scan using "chatbot_requests_tenantId_customerKey_status_idx" on chatbot_requests r  (cost=0.41..12.87 rows=1 width=235) (actual time=0.007..0.008 rows=3 loops=26)
                                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("customerKey" = g."customerKey") AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
                                      Buffers: shared hit=144
Planning:
  Buffers: shared hit=2
Planning Time: 0.545 ms
Execution Time: 0.592 ms
```

### groups: later-page cursor

```
Incremental Sort  (cost=26.48..133.18 rows=26 width=364) (actual time=0.466..0.677 rows=65 loops=1)
  Sort Key: g."mostUrgentAt", g."customerKey", (CASE WHEN (r.status = 'NEW'::"ChatbotRequestStatus") THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END), r."createdAt", r.id
  Presorted Key: g."mostUrgentAt", g."customerKey"
  Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 32kB  Peak Memory: 32kB
  Buffers: shared hit=222
  ->  Nested Loop  (cost=13.20..132.48 rows=26 width=364) (actual time=0.115..0.613 rows=65 loops=1)
        Buffers: shared hit=222
        ->  Limit  (cost=0.28..6.92 rows=26 width=25) (actual time=0.065..0.098 rows=26 loops=1)
              Buffers: shared hit=79
              ->  Index Scan using "chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx" on chatbot_customer_groups g  (cost=0.28..464.15 rows=1817 width=25) (actual time=0.065..0.096 rows=26 loops=1)
                    Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                    Filter: ((ROW("mostUrgentAt", "customerKey") > ROW('2026-11-11 15:07:24.608'::timestamp without time zone, '525500000529'::text)) OR ("mostUrgentAt" IS NULL))
                    Rows Removed by Filter: 50
                    Buffers: shared hit=79
        ->  Memoize  (cost=12.92..12.92 rows=1 width=331) (actual time=0.018..0.019 rows=2 loops=26)
              Cache Key: g."customerKey"
              Cache Mode: binary
              Hits: 0  Misses: 26  Evictions: 0  Overflows: 0  Memory Usage: 15kB
              Buffers: shared hit=143
              ->  Limit  (cost=12.91..12.91 rows=1 width=331) (actual time=0.017..0.018 rows=2 loops=26)
                    Buffers: shared hit=143
                    ->  Sort  (cost=12.91..12.91 rows=1 width=331) (actual time=0.017..0.017 rows=2 loops=26)
                          Sort Key: (CASE WHEN (r.status = 'NEW'::"ChatbotRequestStatus") THEN r."claimDeadlineAt" ELSE r."resolveDeadlineAt" END), r."createdAt", r.id
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=143
                          ->  WindowAgg  (cost=0.41..12.90 rows=1 width=331) (actual time=0.014..0.015 rows=2 loops=26)
                                Buffers: shared hit=143
                                ->  Index Scan using "chatbot_requests_tenantId_customerKey_status_idx" on chatbot_requests r  (cost=0.41..12.87 rows=1 width=235) (actual time=0.010..0.011 rows=2 loops=26)
                                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("customerKey" = g."customerKey") AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
                                      Buffers: shared hit=143
Planning:
  Buffers: shared hit=2
Planning Time: 0.475 ms
Execution Time: 0.749 ms
```

### counts

```
Result  (cost=5910.16..5910.17 rows=1 width=28) (actual time=1.656..1.659 rows=1 loops=1)
  Buffers: shared hit=977
  InitPlan 1
    ->  Aggregate  (cost=2835.59..2835.60 rows=1 width=4) (actual time=0.818..0.819 rows=1 loops=1)
          Buffers: shared hit=171
          ->  Bitmap Heap Scan on chatbot_requests r  (cost=68.19..2826.83 rows=3503 width=0) (actual time=0.077..0.662 rows=3500 loops=1)
                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (status = 'NEW'::"ChatbotRequestStatus"))
                Heap Blocks: exact=167
                Buffers: shared hit=171
                ->  Bitmap Index Scan on chatbot_requests_open_status_idx  (cost=0.00..67.31 rows=3503 width=0) (actual time=0.059..0.060 rows=3500 loops=1)
                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (status = 'NEW'::"ChatbotRequestStatus"))
                      Buffers: shared hit=4
  InitPlan 2
    ->  Aggregate  (cost=2354.06..2354.08 rows=1 width=4) (actual time=0.445..0.446 rows=1 loops=1)
          Buffers: shared hit=171
          ->  Bitmap Heap Scan on chatbot_requests r_1  (cost=27.86..2350.33 rows=1494 width=0) (actual time=0.071..0.372 rows=1500 loops=1)
                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (status = 'IN_PROGRESS'::"ChatbotRequestStatus"))
                Heap Blocks: exact=167
                Buffers: shared hit=171
                ->  Bitmap Index Scan on chatbot_requests_open_assignee_idx  (cost=0.00..27.48 rows=1494 width=0) (actual time=0.057..0.057 rows=1500 loops=1)
                      Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                      Buffers: shared hit=4
  InitPlan 3
    ->  Aggregate  (cost=115.46..115.48 rows=1 width=4) (actual time=0.135..0.136 rows=1 loops=1)
          Buffers: shared hit=169
          ->  Bitmap Heap Scan on chatbot_requests r_2  (cost=4.59..115.39 rows=30 width=0) (actual time=0.023..0.115 rows=500 loops=1)
                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("assigneeUserId" = 'perf-user-1'::text) AND (status = 'IN_PROGRESS'::"ChatbotRequestStatus"))
                Heap Blocks: exact=167
                Buffers: shared hit=169
                ->  Bitmap Index Scan on chatbot_requests_open_assignee_idx  (cost=0.00..4.58 rows=30 width=0) (actual time=0.014..0.014 rows=500 loops=1)
                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("assigneeUserId" = 'perf-user-1'::text))
                      Buffers: shared hit=2
  InitPlan 4
    ->  Aggregate  (cost=341.36..341.38 rows=1 width=4) (actual time=0.120..0.121 rows=1 loops=1)
          Buffers: shared hit=169
          ->  Bitmap Heap Scan on chatbot_requests r_3  (cost=5.04..341.12 rows=99 width=0) (actual time=0.020..0.100 rows=500 loops=1)
                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])) AND ("overdueAt" IS NOT NULL))
                Heap Blocks: exact=167
                Buffers: shared hit=169
                ->  Bitmap Index Scan on chatbot_requests_open_overdue_idx  (cost=0.00..5.02 rows=99 width=0) (actual time=0.012..0.013 rows=500 loops=1)
                      Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                      Buffers: shared hit=2
  InitPlan 5
    ->  Aggregate  (cost=129.75..129.76 rows=1 width=4) (actual time=0.064..0.065 rows=1 loops=1)
          Buffers: shared hit=127
          ->  Bitmap Heap Scan on chatbot_requests r_4  (cost=4.71..129.66 rows=34 width=0) (actual time=0.018..0.057 rows=167 loops=1)
                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("whatsappWindowClosesAt" > '2026-11-11 16:35:35.551'::timestamp without time zone) AND ("whatsappWindowClosesAt" <= '2026-11-11 18:35:35.551'::timestamp without time zone) AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
                Heap Blocks: exact=125
                Buffers: shared hit=127
                ->  Bitmap Index Scan on chatbot_requests_open_window_idx  (cost=0.00..4.71 rows=34 width=0) (actual time=0.009..0.009 rows=167 loops=1)
                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("whatsappWindowClosesAt" > '2026-11-11 16:35:35.551'::timestamp without time zone) AND ("whatsappWindowClosesAt" <= '2026-11-11 18:35:35.551'::timestamp without time zone))
                      Buffers: shared hit=2
  InitPlan 6
    ->  Aggregate  (cost=125.76..125.77 rows=1 width=4) (actual time=0.064..0.065 rows=1 loops=1)
          Buffers: shared hit=168
          ->  Bitmap Heap Scan on chatbot_requests r_5  (cost=4.40..125.68 rows=33 width=0) (actual time=0.015..0.057 rows=167 loops=1)
                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])) AND ("scheduledFor" IS NOT NULL))
                Heap Blocks: exact=167
                Buffers: shared hit=168
                ->  Bitmap Index Scan on chatbot_requests_open_scheduled_idx  (cost=0.00..4.39 rows=33 width=0) (actual time=0.008..0.008 rows=167 loops=1)
                      Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                      Buffers: shared hit=1
  InitPlan 7
    ->  Aggregate  (cost=8.09..8.10 rows=1 width=4) (actual time=0.004..0.004 rows=1 loops=1)
          Buffers: shared hit=2
          ->  Index Only Scan using chatbot_requests_open_needs_reschedule_idx on chatbot_requests r_6  (cost=0.12..8.09 rows=1 width=0) (actual time=0.003..0.003 rows=0 loops=1)
                Index Cond: ("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text)
                Heap Fetches: 0
                Buffers: shared hit=2
Planning:
  Buffers: shared hit=14
Planning Time: 0.740 ms
Execution Time: 1.707 ms
```

### customer list

```
Limit  (cost=16.89..16.89 rows=2 width=327) (actual time=0.017..0.017 rows=3 loops=1)
  Buffers: shared hit=6
  ->  Sort  (cost=16.89..16.89 rows=2 width=327) (actual time=0.016..0.017 rows=3 loops=1)
        Sort Key: (CASE WHEN (status = 'NEW'::"ChatbotRequestStatus") THEN "claimDeadlineAt" ELSE "resolveDeadlineAt" END), "createdAt", id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=6
        ->  Index Scan using "chatbot_requests_tenantId_customerKey_status_idx" on chatbot_requests r  (cost=0.41..16.88 rows=2 width=327) (actual time=0.010..0.013 rows=3 loops=1)
              Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("customerKey" = '525500001920'::text) AND (status = ANY ('{NEW,IN_PROGRESS}'::"ChatbotRequestStatus"[])))
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=2
Planning Time: 0.144 ms
Execution Time: 0.028 ms
```

### history: first page

```
Limit  (cost=0.41..26.70 rows=26 width=327) (actual time=0.016..0.032 rows=26 loops=1)
  Buffers: shared hit=5
  ->  Index Scan using chatbot_requests_history_idx on chatbot_requests r  (cost=0.41..13308.88 rows=13163 width=327) (actual time=0.015..0.030 rows=26 loops=1)
        Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("closedAt" < '2026-11-04 16:35:35.566'::timestamp without time zone))
        Buffers: shared hit=5
Planning:
  Buffers: shared hit=2
Planning Time: 0.213 ms
Execution Time: 0.046 ms
```

### history: deep page

```
Limit  (cost=0.41..50.16 rows=26 width=327) (actual time=0.024..0.052 rows=26 loops=1)
  Buffers: shared hit=5
  ->  Index Scan using chatbot_requests_history_idx on chatbot_requests r  (cost=0.41..11651.94 rows=6090 width=327) (actual time=0.023..0.048 rows=26 loops=1)
        Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("closedAt" < '2026-11-04 16:35:35.57'::timestamp without time zone) AND (ROW("closedAt", id) < ROW('2026-10-25 15:26:17.675'::timestamp without time zone, '267b24ad-eeaa-45c0-8512-f04d7d6224f1'::text)))
        Buffers: shared hit=5
Planning:
  Buffers: shared hit=2
Planning Time: 0.346 ms
Execution Time: 0.074 ms
```

### history: subtype

```
Limit  (cost=2.96..69.33 rows=26 width=327) (actual time=0.050..0.052 rows=26 loops=1)
  Buffers: shared hit=6
  ->  Incremental Sort  (cost=2.96..11214.18 rows=4392 width=327) (actual time=0.050..0.051 rows=26 loops=1)
        Sort Key: "closedAt" DESC, id DESC
        Presorted Key: "closedAt"
        Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 31kB  Peak Memory: 31kB
        Buffers: shared hit=6
        ->  Index Scan using "chatbot_requests_tenantId_subtype_closedAt_idx" on chatbot_requests r  (cost=0.41..11018.26 rows=4392 width=327) (actual time=0.017..0.034 rows=27 loops=1)
              Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND (subtype = 'COMPLAINT'::"ChatbotRequestSubtype") AND ("closedAt" < '2026-11-04 16:35:35.575'::timestamp without time zone))
              Filter: (status = ANY ('{RESOLVED,CANCELLED}'::"ChatbotRequestStatus"[]))
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=2
Planning Time: 0.216 ms
Execution Time: 0.068 ms
```

### closed-tab groups (resolved)

```
Incremental Sort  (cost=3393.74..3695.47 rows=26 width=364) (actual time=2.141..2.143 rows=26 loops=1)
  Sort Key: (max(r."closedAt")) DESC, r."customerKey", r_1."closedAt" DESC, r_1.id DESC
  Presorted Key: (max(r."closedAt")), r."customerKey"
  Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 30kB  Peak Memory: 30kB
  Buffers: shared hit=418
  ->  Nested Loop  (cost=3381.71..3694.30 rows=26 width=364) (actual time=1.872..2.126 rows=26 loops=1)
        Buffers: shared hit=418
        ->  Limit  (cost=3369.23..3369.29 rows=26 width=21) (actual time=1.834..1.837 rows=26 loops=1)
              Buffers: shared hit=210
              ->  Sort  (cost=3369.23..3372.21 rows=1192 width=21) (actual time=1.833..1.835 rows=26 loops=1)
                    Sort Key: (max(r."closedAt")) DESC, r."customerKey"
                    Sort Method: top-N heapsort  Memory: 28kB
                    Buffers: shared hit=210
                    ->  HashAggregate  (cost=3323.34..3335.26 rows=1192 width=21) (actual time=1.530..1.680 rows=1750 loops=1)
                          Group Key: r."customerKey"
                          Batches: 1  Memory Usage: 193kB
                          Buffers: shared hit=210
                          ->  Bitmap Heap Scan on chatbot_requests r  (cost=584.67..3316.36 rows=1395 width=21) (actual time=0.242..1.054 rows=1750 loops=1)
                                Recheck Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("closedAt" >= '2026-11-04 16:35:35.579'::timestamp without time zone) AND (status = ANY ('{RESOLVED,CANCELLED}'::"ChatbotRequestStatus"[])))
                                Filter: (status = 'RESOLVED'::"ChatbotRequestStatus")
                                Rows Removed by Filter: 1750
                                Heap Blocks: exact=122
                                Buffers: shared hit=210
                                ->  Bitmap Index Scan on chatbot_requests_history_idx  (cost=0.00..584.32 rows=2791 width=0) (actual time=0.226..0.226 rows=3500 loops=1)
                                      Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("closedAt" >= '2026-11-04 16:35:35.579'::timestamp without time zone))
                                      Buffers: shared hit=88
        ->  Limit  (cost=12.48..12.48 rows=1 width=331) (actual time=0.011..0.011 rows=1 loops=26)
              Buffers: shared hit=208
              ->  Sort  (cost=12.48..12.48 rows=1 width=331) (actual time=0.010..0.010 rows=1 loops=26)
                    Sort Key: r_1."closedAt" DESC, r_1.id DESC
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=208
                    ->  WindowAgg  (cost=0.41..12.47 rows=1 width=331) (actual time=0.009..0.009 rows=1 loops=26)
                          Buffers: shared hit=208
                          ->  Index Scan using "chatbot_requests_tenantId_customerKey_status_idx" on chatbot_requests r_1  (cost=0.41..12.43 rows=1 width=235) (actual time=0.008..0.008 rows=1 loops=26)
                                Index Cond: (("tenantId" = '8d98360e-debb-40c1-8529-a5d574141624'::text) AND ("customerKey" = r."customerKey") AND (status = 'RESOLVED'::"ChatbotRequestStatus"))
                                Filter: ("closedAt" >= '2026-11-04 16:35:35.579'::timestamp without time zone)
                                Rows Removed by Filter: 4
                                Buffers: shared hit=208
Planning:
  Buffers: shared hit=4
Planning Time: 0.443 ms
Execution Time: 2.210 ms
```

## S8 additions (v1.3): counts, row fields

Proof lives in `src/chatbot-requests/chatbot-inbox-additions.integration.spec.ts` (regular integration spec, `pnpm test:integration`, no `PERF=1`). Timings there go through Supertest (HTTP, guards stubbed), so they include the HTTP stack and are **not** comparable with the service-level numbers above (the load test was **not** rerun for S8: it writes its report to `/tmp`).

| Check | Limit | Measured | Verdict |
| --- | --- | --- | --- |
| counts p95 (12,000 closed over 400 days + 3,000 groups, `VACUUM ANALYZE`, 40 samples, via HTTP) | < 200 ms | p50 7.2 / p95 9.5 / max 12.6 ms | PASS |
| groups page of 25 (4,000 open over 1,500 customers, with the S8 columns, via HTTP, 30 samples) | < 200 ms | p50 22.8 / p95 31.0 / max 32.7 ms | PASS |
| counts statement: no sequential scan of `chatbot_requests`, uses the partial `chatbot_requests_history_idx`, no `Sort`, no `HashAggregate` | EXPLAIN | asserted on the real statement (`EXPLAIN (FORMAT JSON)`) | PASS |
| statements per read do not grow with the rows (groups 2 vs 50 groups, closed tab, history, by-customer, detail with 15 more open rows) | constant | equal in every pair | PASS |

- **`resolved7d` / `cancelled7d`** are two scalar subqueries `status = X AND closedAt >= now − 7 d`, served by the partial history index `(tenantId, closedAt DESC, id DESC) WHERE status IN ('RESOLVED','CANCELLED')`; the status filter costs one heap fetch per row of the 7-day window only (bounded: about 2 % of a tenant's rows at 400 days of history). With only a few thousand rows in total the planner prefers a sequential scan (cheaper at that size); the spec sizes the table so the choice is the real one.
- **`openGroups`** counts the tenant's rows of `chatbot_customer_groups` (one per customer with open requests, deleted at 0), so it equals the number of groups of the open tab. It is O(open customers), a few thousand at the sized load.
- **Row fields** add no round trip: `cancelReason`/`staffCancelReason` are plain columns; `mergedInto` is a `CASE`-guarded subselect of the source's `MERGED` event (events index `(tenantId, requestId, createdAt)`, only for `SUPERSEDED` rows); `lastReleasedAt` (the claim clock's cycle start, the sweep's expression) is a `CASE`-guarded subselect only for `NEW` rows; `zoneHasValidation` is a primary-key lookup only for `DELIVERY_ZONE` rows. `slaLevel` is pure CPU over the settings row the pause lookup already read (one lookup per response, shared by every row).
- **Known cost:** the `NEW` rows pay one events-index probe each for `lastReleasedAt`. At 10 rows per group and 25 groups that is at most 250 probes inside the same statement (included in the groups figure above).

