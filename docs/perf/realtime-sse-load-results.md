# Realtime SSE stream: load test results (unit 8)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database, plus the `EXPLAIN (ANALYZE, BUFFERS)` of its queries; a missed target is reported with its measured numbers) and the performance row "Reparto SSE" (< 1 s p95 from the commit to the browser, 200 connections per replica, a single `LISTEN` per replica, open connections hold no database connection and read in batches when a notice arrives, indexes `(tenantId, id)` and `(userId, id)`, retention 24 h). Model: `docs/chatbot-requests-model.md`, "Realtime stream".

**Result: no contract target was missed in the final run.** Two problems of the first runs were found while measuring and fixed (see "Findings"). **What this does not prove:** the behaviour behind the real Traefik/Swarm (R6 owner test, still pending) and a second replica (the hub is per replica by design; the cross-replica path is the same `NOTIFY`, covered by the log's integration spec, not by a two-process run).

## How to reproduce

```sh
PERF=1 pnpm test:integration src/realtime/realtime-stream-load.integration.spec.ts
PERF=1 PERF_ENFORCE=1 pnpm test:integration src/realtime/realtime-stream-load.integration.spec.ts   # fail on a missed target
```

The spec is skipped in every normal run. It goes through the project's integration harness, so the test-database URL is resolved and guarded there (nothing reads an env file; dev and production are unreachable). The JSON report with every number and plan below goes to `/tmp/realtime-sse-load-report.json` (`PERF_REPORT_PATH` to change it). Knobs: `PERF_STREAMS` (200), `PERF_EVENTS` (100), `PERF_BURST` (20), `PERF_IDLE_MS` (16000), `PERF_REPLAY_ROWS` (50000), `PERF_NOISE_ROWS` (100000). The run takes about 35 s.

## What runs

A Nest app on a real socket with the real guards (`ActiveUserGuard`, `PermissionsGuard`, `TenantContextGuard`; only the JWT signature check is replaced by a header reader), the real hub, log, shaper, access re-check, `LISTEN` connection and inbox row builders, against PostgreSQL. Clients are real HTTP connections (`node:http`), each one a distinct user with `read:ChatbotRequest` and `read:CustomerPhone`. Events come from the real staff commands (`claim` / `release`), so every event goes through the real deferred trigger. The hub is configured as in production (access check shared for 1 s per user).

**Caveat on the numbers:** the 200 clients run in the same process as the server and the same machine as PostgreSQL, so the latency includes the cost of parsing every frame 200 times (pessimistic for the server) and has no network (optimistic). Treat the numbers as a bound on server work, not as a promise for a WAN.

## Targets

| Target | Limit | Measured | |
| --- | --- | --- | --- |
| Commit → client, 200 streams (from the moment the command starts, so it includes the command's own transaction) | p95 < 1 000 ms | p95 50 ms (p50 36, p99 67, max 72, n = 20 000 = 100 events × 200 streams) | PASS |
| Burst: 20 commits in parallel to 200 streams | all delivered < 1 000 ms after the last commit | committed in 117 ms; every stream had all 20 frames 254 ms after the first commit (about 137 ms after the last commit); identical events in identical order on all 200 | PASS |
| Idle streams cause no database reads | 0 | 0 hub reads in 16 s with 200 streams open | PASS |
| Open streams hold no database connection | no new connection per stream | 4 → 7 for the first 20 streams (pool warm-up and the replica's one `LISTEN`) → 7 for all 200: **+0 for 180 more streams** | PASS |
| Idle CPU of the whole process with the streams open | < 50 CPU ms per second (5 % of a core) | 17 ms/s, includes 200 heartbeats and the test's own 200 clients | PASS |
| Every stream receives its heartbeat | ≥ 1 per 15 s | min 1 in 16 s | PASS |
| Replay after a short gap (reconnect, 200 events behind) with 50 000 events in the tenant and 100 000 in a neighbour | p95 < 100 ms | p95 0.73 ms | PASS |
| Indexes serve every read | no `Seq Scan` on `realtime_events` | index scans only, 5 of 5 shapes | PASS |
| Retention purge, one batch of 1 000 | bounded, no long lock | max 4.7 ms | PASS |

Other measurements: opening 200 streams took 0.82 s in total; memory 4.7 KiB of heap per stream (a rough number: no forced GC); the whole database ran 446 transactions during the 16 s idle window (other sessions; informational, the stream itself issued none).

### Query timings at size

Seeded with `generate_series` in the integration database and `ANALYZE`d (a fresh table has no statistics): tenant A has 50 000 events (40 000 broadcast request events, 10 000 personal notices over 100 users), a neighbour has 100 000, inserted in 10 interleaved slices so their ids interleave the way concurrent branches would. 30 timed runs per shape after one warm-up.

| Statement | p50 | p95 | Buffers |
| --- | --- | --- | --- |
| Replay, reconnect 200 events behind (a user's usual case) | 0.49 ms | 0.73 ms | 30 |
| Replay, 5 000 events behind, first page of 200 | 1.39 ms | 1.66 ms | 38 |
| Replay, from the start of the retained log, first page of 200 | 1.34 ms | 1.96 ms | 129 |
| Hub read, 50 new events | 0.49 ms | 0.54 ms | 6 |
| Hub read, nothing new (what an idle `NOTIFY` costs) | 0.30 ms | 0.33 ms | 3 |
| Tenant head (`max(id)`) | 0.27 ms | 0.38 ms | 4 |

## EXPLAIN (ANALYZE, BUFFERS) of the real statements

The replay is a merge of two index range scans (broadcast events through `(tenantId, id)`, the user's own through the partial `(tenantId, userId, id) WHERE userId IS NOT NULL`), each bounded by `LIMIT`; the hub read and the head are one index probe each. Final plans (ids and tenant replaced by the run's values):

```text
-- replay, reconnect 200 events behind
Limit  (actual time=0.177..0.178 rows=2)  Buffers: shared hit=30
  ->  Sort  (Sort Key: id; quicksort 25kB)
        ->  Append
              ->  Limit -> Index Scan using "realtime_events_tenantId_id_idx"
                    Index Cond: ROW(tenantId, id) > ROW(tenant, 901523) AND ROW(tenantId, id) <= ROW(tenant, 9223372036854775807)
                    Filter: userId IS NULL   (Rows Removed by Filter: 200)   Buffers: shared hit=11
              ->  Limit -> Index Scan using realtime_events_user_idx
                    Index Cond: ROW(tenantId, userId, id) > ROW(tenant, user, 901523) AND ... <= ROW(tenant, user, 9223372036854775807)   Buffers: shared hit=19
Execution Time: 0.203 ms

-- hub read, nothing new
Limit  (actual time=0.006..0.006 rows=0)  Buffers: shared hit=3
  ->  Index Scan using "realtime_events_tenantId_id_idx"
        Index Cond: ROW(tenantId, id) > ROW(tenant, 901723) AND ROW(tenantId, id) <= ROW(tenant, 9223372036854775807)
Execution Time: 0.014 ms

-- tenant head
Limit  (actual time=0.013..0.014 rows=1)  Buffers: shared hit=4
  ->  Index Only Scan Backward using "realtime_events_tenantId_id_idx"
        Index Cond: tenantId >= tenant AND tenantId <= tenant
Execution Time: 0.022 ms
```

The full plans of all six statements are in the JSON report (`queries.explains`).

## Findings (found by this test, fixed)

1. **The hub read and the tenant head walked other tenants' rows (fixed).** Written as `"tenantId" = $1 AND "id" > $2`, the planner walked the primary key from `$2` to the end of the table filtering by tenant (`realtime_events_pkey`, 204 buffers and 1.3 ms for "nothing new"; the head read 231 buffers), i.e. it reads every newer row of every neighbour: the same family as the bot feed's read (`docs/perf/chatbot-feed-load-results.md`). With the row comparison `("tenantId","id") > ($1,$2) AND ("tenantId","id") <= ($1, max)` and `ORDER BY "tenantId","id"` (and the closed-range form for the head) only the `(tenantId, id)` index can answer: 3 to 6 buffers whatever the neighbours wrote. The personal replay branch needs `"userId" IS NOT NULL` repeated, or the planner cannot prove that the partial index applies and falls back to a parallel sequential scan (2 615 buffers, 16 ms; seen in an intermediate run).
2. **The row of a batch was costed once per recipient (fixed).** The first burst run (20 commits to 200 streams) took 2.18 s: 4 000 frames spent 1.9 s in `shape`, because each frame recomputed `slaLevel` (it walks the business calendar) even though it does not depend on who reads. The level is now computed once per row per batch, and a frame costs 83 ms for the same 4 000 (the burst above: 254 ms). The fix is in `ChatbotRequestReadsService.loadEventRows`; the rest of each row (`allowedActions`, `deniedActions`, the phone) is per recipient on purpose.

## Cost of the trigger on the write paths that already existed

Every request event insert fires the deferred constraint trigger `chatbot_request_events_realtime` at commit (one per-tenant advisory lock, one `realtime_events` insert, one `pg_notify` per announced event). The verify of unit 8 asked what this adds to writes that existed before. `src/realtime/realtime-trigger-cost.integration.spec.ts` measures the same writes with and without the trigger.

```sh
PERF=1 pnpm test:integration src/realtime/realtime-trigger-cost.integration.spec.ts
```

**Method.** The test database, the project's integration harness (same URL guard as above). Two modes alternate (baseline, trigger, then trigger, baseline, …; 5 rounds) so a drifting machine hits both the same. The baseline disables only this trigger with `ALTER TABLE "chatbot_request_events" DISABLE TRIGGER "chatbot_request_events_realtime"` and the trigger mode enables it again; both are committed statements, not a transaction-scoped switch, because a transaction holding the table lock would block the very writers being measured (they use other connections). A `finally` and `afterAll` restore the trigger, the spec refuses to start if it is not enabled, and it asserts it is enabled at the end. One real `LISTEN` connection is open with a no-op handler (as on a replica), so `NOTIFY` has a listener but the hub does no work that competes with the writers. The real command service and stores (called directly, no HTTP layer) and the real SLA sweep store are used; the wrapped-resolve port is stubbed (its legacy use case is not the trigger's cost) and its human decision is created already resolved so the answer the resolve enqueues finds it. The spec asserts that the baseline wrote 0 `realtime_events` rows and the trigger mode wrote some (1 000 in the final run: it really fired, and only then).

**Result (one run, 5 rounds × 30 operations per mode, same machine as PostgreSQL, ms):**

| Write | n per mode | Baseline mean / p50 / p95 | With trigger mean / p50 / p95 | Extra (mean / p50 / p95) |
| --- | --- | --- | --- | --- |
| `claim`, sequential | 150 | 10.03 / 8.66 / 17.65 | 9.85 / 9.25 / 14.14 | −0.18 / +0.59 / −3.51 |
| `resolve` (after claim), sequential | 150 | 11.71 / 10.27 / 19.59 | 11.07 / 10.71 / 14.58 | −0.65 / +0.44 / −5.00 |
| SLA sweep batch of 100 milestones (100 events, 1 transaction) | 5 | 320.54 / 280.67 / 525.60 | 290.95 / 259.57 / 414.79 | −29.59 / −21.10 / −110.81 |
| 20 concurrent claims, 20 tenants: wall time per burst | 5 | 74.13 / 66.73 / 112.55 | 72.70 / 68.36 / 99.88 | −1.44 / +1.64 / −12.66 |
| 20 concurrent claims, 20 tenants: each claim | 100 | 62.93 / 56.24 / 93.11 | 63.28 / 59.49 / 86.65 | +0.34 / +3.24 / −6.47 |
| 20 concurrent claims, one tenant: wall time per burst | 5 | 75.90 / 68.04 / 106.88 | 69.38 / 64.19 / 92.65 | −6.52 / −3.85 / −14.23 |
| 20 concurrent claims, one tenant: each claim | 100 | 64.21 / 57.85 / 88.03 | 60.30 / 57.66 / 80.83 | −3.91 / −0.19 / −7.20 |

**Reading.** The trigger's cost is **below the noise of this measurement**: the differences are of both signs (the sweep batch and the claims with the trigger are even faster in the mean, which is machine noise), the largest consistent positive difference is +3.2 ms on the median of an individual claim inside a burst of 20 whose own latency is about 57 ms, and the sequential single-command medians differ by 0.4 to 0.6 ms. In particular: (a) a sweep batch of 100 events in one transaction takes the lock and the `NOTIFY` once at commit per tenant, not per row, and shows no extra time; (b) 20 concurrent claims across 20 tenants (`NOTIFY` serialization at commit is global in PostgreSQL) show no growth in wall time; (c) 20 concurrent claims inside one tenant (the per-tenant commit lock serializes the tail of each transaction) also show none. No contract target covers this, so it is reported, not asserted.

**What this does not prove.** The sample is small (5 sweep batches and 5 bursts per mode; the per-command samples are 100 to 150), so effects under about 2 ms on a single claim cannot be told apart from noise; the machine is not production hardware; no stream or other `LISTEN` client was working (a hub that reads on every `NOTIFY` is measured by the load test above, not here); the 20-concurrent burst is a short spike, not sustained load. The raw report is written to `/tmp/realtime-trigger-cost-report.json` (`PERF_REPORT_PATH`). Knobs: `PERF_ROUNDS` (5), `PERF_OPS` (30).

## Not measured

- Behind Traefik/Swarm (R6): the owner's test is pending; until it passes, the frontend keeps polling.
- Several replicas in separate processes, and a database failover (the `LISTEN` reconnect path is covered by the hub's unit spec and the shared listener's own spec).
- Sustained load beyond the burst (for example 10 commits per second for minutes), for the stream and for the trigger cost above. The per-tenant commit lock serializes only the tail of each transaction (the feed's lock was measured at 585 commits per second per tenant, `chatbot-feed-load-results.md`).
