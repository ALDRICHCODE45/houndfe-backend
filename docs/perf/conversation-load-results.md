# Conversation mirror: load test results (unit 9)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database, plus the `EXPLAIN (ANALYZE, BUFFERS)` of its queries; a missed target is reported with its measured numbers) and the performance rows **"Conversación paginada"** (p95 < 100 ms per 50 messages; `unique (conversationId, seq)`; sized for 200 000 messages per tenant) and **"Purga de 12 meses"** (batches of 1 000 without blocking writes; index `(purgeAfter)`). Model: `docs/chatbot-requests-model.md`, "Conversation mirror and media".

**Result: no target was missed.** Numbers come from one run on a local machine (caveat at the end).

## How to reproduce

```sh
PERF=1 pnpm test:integration src/conversations/conversation-load.integration.spec.ts
PERF=1 PERF_ENFORCE=1 pnpm test:integration src/conversations/conversation-load.integration.spec.ts   # fail when a target is missed
```

The spec is skipped in every normal run (`PERF=1` turns it on). It goes through the project's integration harness, so the test-database URL is resolved and guarded there (it cannot reach dev or production). The JSON report, with every number and plan below, is written to `/tmp/conversation-load-report.json` (`PERF_REPORT_PATH` to change it). Sizes are knobs: `PERF_HOT_CHAT`, `PERF_CHATS`, `PERF_PER_CHAT`, `PERF_NOISE`, `PERF_DUE`, `PERF_SAMPLES`, `PERF_PURGE_BATCHES`. The run takes about 20 seconds.

## Data

Seeded with SQL (`generate_series`), then `ANALYZE`. Seeding took 10.5 s.

| Tenant | Role | Chats | Messages |
| --- | --- | --- | --- |
| A | the measured tenant | 401 (one "hot" chat of 20 000, 400 of 450) | 200 000 (+ what the ingest samples add) |
| B | noise: a big neighbour | 1 | 60 000 |
| D | the purge's due rows (all `purgeAfter` in the past) | 30 | 30 000 |

`conversation_messages` held about 290 000 rows at measuring time. The staff read goes through HTTP (the real controller, service, store and views; the staff identity is a header stub, the bot goes through the real `ServiceAuthGuard` and the PostgreSQL route budgets).

## Targets

| Target | Limit | Measured | |
| --- | --- | --- | --- |
| Page of 50 messages, latest | p95 < 100 ms | p95 5.92 ms (p50 3.95, p99 9.13, n=200) | PASS |
| Page of 50, older pages at random depth of a 20 000-message chat | p95 < 100 ms | p95 4.59 ms (p50 3.81, p99 8.92) | PASS |
| Page of 50, polling with `after` | p95 < 100 ms | p95 5.64 ms (p50 3.90, p99 10.57) | PASS |
| Page read uses `unique (conversationId, seq)` | index scan on `conversation_messages_conversationId_seq_key` | yes (see plan) | PASS |
| Purge batch of 1 000 does not block writes | p95 of bot writes during the purge < 3x the baseline (+ 25 ms) | writes p95 13.90 ms during vs 9.93 ms without; purge batch p50 12.06 ms, p95 18 ms | PASS |
| Purge due scan uses index `(purgeAfter)` | index scan on `conversation_messages_purgeAfter_idx` | yes (see plan) | PASS |

Informational (no contract target): the bot batch of 50 new messages into the big table: p50 25.73 ms, p95 31.54 ms, p99 34.36 ms (n=100). A replayed batch of 50 duplicates: p50 5.14 ms, p95 6.00 ms. Five chats ingesting at once (batches of 10): p95 19.22 ms. The purge removed exactly 1 000 messages in each of 10 batches (10 000 rows, the trigger firing per row).

## EXPLAIN (ANALYZE, BUFFERS)

Page read (messages before `seq` 10 000 of the hot chat, the statement Prisma issues for `?before=`):

```text
Limit  (cost=0.42..138.94 rows=51 width=79) (actual time=0.023..0.037 rows=51 loops=1)
  Buffers: shared hit=8
  ->  Index Scan Backward using "conversation_messages_conversationId_seq_key" on conversation_messages
        Index Cond: (("conversationId" = '…'::text) AND (seq < '10000'::bigint))
        Filter: ("tenantId" = '…'::text)
Execution Time: 0.047 ms
```

Purge due scan (`WHERE "purgeAfter" < now() ORDER BY "purgeAfter", "id" LIMIT 1000 FOR UPDATE SKIP LOCKED`):

```text
Limit  (actual time=0.301..1.036 rows=1000 loops=1)  Buffers: shared hit=3064
  ->  LockRows
        ->  Incremental Sort  Sort Key: "purgeAfter", id  Presorted Key: "purgeAfter"
              ->  Index Scan using "conversation_messages_purgeAfter_idx" on conversation_messages
                    Index Cond: ("purgeAfter" < now())
Execution Time: 1.076 ms
```

## What these numbers do not cover

- One machine (16 cores, 34 GB, PostgreSQL on localhost), one process: no network between the app and the database, no second replica. The 2-replica safety of the purge and of the ingest is proven by `conversation-retention.integration.spec.ts` (two purges at once delete each row once; a row another connection holds is skipped) and `conversation-mirror.integration.spec.ts` (eight concurrent batches get gapless `seq`), not by this load test.
- The file purge is measured with a fake storage (no Spaces latency): in production the cost of a batch is dominated by up to 100 network deletes, which is why the claim holds no transaction open during them (lease columns) and why a failed delete never blocks the others.
- The realtime fan-out of `conversation.message` reuses the unit 8 hub (`docs/perf/realtime-sse-load-results.md`); this unit adds one batched query per delivery batch (messages, files, staff names) and was not load-tested on its own.
