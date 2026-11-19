# Chatbot feed and recovery load test

Reproducible load test of the bot feed (long-poll, pending deliveries, delivery outcome) and the recovery route, required by contract §10.1 ("Cómo se demuestra") and the performance row "Feed del bot". Results and plans: `docs/perf/chatbot-feed-load-results.md`.

```sh
node scripts/perf/chatbot-feed-load.cjs [--enforce] [--report <path>]
```

- It runs `src/chatbot-requests/chatbot-feed-load.integration.spec.ts` through `pnpm test:integration` with `PERF=1`. The integration harness resolves and guards the **test** database URL (the `.env.test` / shell-URL rules of `jest.integration.config.js`); the script reads no env file and never touches dev or production. Without `PERF=1` the spec is skipped, so normal `pnpm test:integration` runs ignore it.
- `--enforce` makes the run fail when a target is missed (`PERF_ENFORCE=1`). By default targets are reported, not asserted.
- The report (every number and every `EXPLAIN (ANALYZE, BUFFERS)` plan) is printed and written to `--report`, default `/tmp/chatbot-feed-load-report.json`.
- It seeds about 340 000 feed items and 38 000 requests for synthetic tenants (it deletes them when it ends), so it takes about a minute. The test database is shared by every integration spec: do not run two integration runs at once.

## What it measures

| | |
| --- | --- |
| (a) | Commit → long-poll return latency over 200 sequential and 200 parallel enqueues, through the production write path (`enqueueCancelled`). |
| (b) | Feed read, pending deliveries and recovery pages at size (HTTP), and `EXPLAIN (ANALYZE, BUFFERS)` of the real statements for several tenant shapes. |
| (c) | 50 idle long-polls on a one-connection Prisma pool: pool free, no new server connection, no queries, no CPU. |
| (d) | Throughput of the per-tenant enqueue lock with 10 parallel writers (one tenant against ten tenants). |

## Knobs (environment variables of the spec)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PERF_OPEN` | 5000 | Open requests of the measured tenant A |
| `PERF_CLOSED` | 20000 | Closed requests of A (closed over the last 40 days) |
| `PERF_FEED_ITEMS` | 200000 | Feed items of A |
| `PERF_NOISE_OPEN`, `PERF_NOISE_CLOSED`, `PERF_NOISE_FEED_ITEMS` | 2500, 10000, 100000 | The big neighbour B |
| `PERF_SAMPLES` | 200 | Sequential commit → bot samples |
| `PERF_PARALLEL_ROUNDS`, `PERF_PARALLEL_WIDTH` | 20, 10 | Parallel samples = rounds × width |
| `PERF_IDLE_POLLS` | 50 | Idle long-polls (two per credential) |
| `PERF_WRITER_SECONDS` | 4 | Duration of each enqueue-lock scenario |
| `PERF_CPU_WINDOWS` | 3 | CPU windows of 1.5 s per phase of (c) |
| `PERF_REPORT_PATH` | `/tmp/chatbot-feed-load-report.json` | Where the report goes (`--report`) |

A quick smoke run: `PERF_OPEN=300 PERF_CLOSED=1000 PERF_FEED_ITEMS=5000 PERF_NOISE_OPEN=50 PERF_NOISE_CLOSED=100 PERF_NOISE_FEED_ITEMS=1000 PERF_SAMPLES=20 PERF_PARALLEL_ROUNDS=3 PERF_IDLE_POLLS=10 PERF_WRITER_SECONDS=1 node scripts/perf/chatbot-feed-load.cjs`. At that size the planner picks other plans than at full size, so only the full run counts as evidence.

## Honest limits

The load generator, the Nest app, the writers and the database share one machine, and the first three share one Node process: latencies are conservative, not a production forecast. The CPU figure is the whole test process. The tables are analyzed, not vacuumed.
