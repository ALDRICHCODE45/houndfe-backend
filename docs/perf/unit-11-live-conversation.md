# Live conversation: load test results (unit 11)

Contract: `docs/proposals/human-intervention-backend-proposal.md` §10.1 ("Cómo se demuestra": a reproducible load test with synthetic data on the test database plus the `EXPLAIN (ANALYZE, BUFFERS)` of the real statements; a missed target is reported with its measured numbers). Technical detail: `docs/chatbot-requests-model.md` ("Live conversation"), bot contract "Live conversation (unit 11)", frontend handoff `docs/frontend-handoff/20-live-conversation.md`.

**Result: after one query fix, every target passes.** The first run at scale found a real problem in the live session sweep (below): its candidate query read the whole sessions table in `(tenantId, id)` order, it handed the batch not-due sessions ahead of due ones (so due sessions were never swept), and a tick with nothing to do cost 279 ms against a 50 ms target. The inbox, the bulk state read, `session-ack` and the staff message needed no change and no index. The migration `20261113040000_live_conversation_perf` was therefore **not created**: the partial indexes of unit 11 already serve every statement once the sweep query is written to use them.

## How to reproduce

```sh
PERF=1 pnpm test:integration src/chatbot-requests/live-conversation-load.integration.spec.ts
# optional: PERF_REPORT_PATH=/tmp/my-report.json (default /tmp/live-conversation-load-report.json)
```

The spec is skipped in every normal run (it needs `PERF=1`), runs inside the project's integration harness (which resolves and guards the test-database URL, so it cannot reach dev or production) and takes about one minute (seeding ~35-45 s). Sizes are knobs: `PERF_OPEN`, `PERF_CUSTOMERS`, `PERF_CLOSED`, `PERF_LIVE`, `PERF_MSGS`, `PERF_NOISE_OPEN`, `PERF_NOISE_CLOSED`, `PERF_NOISE_LIVE`, `PERF_SAMPLES`. The JSON report (every number and every plan) is written **before** the targets are asserted, so a failing run still leaves its numbers. Targets are asserted (not only reported).

## Data

Seeded with SQL (`generate_series`) in the integration test database, then `ANALYZE`. The inbox volumes are the ones of the unit 4 inbox document (`chatbot-inbox-load-results.md`); the message volume is the §10.1 sizing (200 000 messages per tenant).

| Tenant | Role                                             | Requests                                                                                                                     | Chats / messages                            | Sessions                                                                                                                                            |
| ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | the measured tenant                              | 25,000: 5,000 open (4,820 still open after the live states below) over ~2,000 customers, 20,000 closed over the last 40 days | 4,000 chats, 200,000 messages (50 per chat) | 13,454 ENDED (history, ~3 epochs per chat; 10 % of the live requests also have an earlier reverted epoch), **240 STARTING, 780 ACTIVE, 180 ENDING** |
| B, C   | noise (the sweep's candidate queries are global) | 12,500 each                                                                                                                  | 4,000 chats, 200,000 messages each          | 13,454 ENDED + 240 / 780 / 180 live, **both together** (600 live conversation requests each)                                                        |

Whole tables at measuring time: `chatbot_live_sessions` 29,308 rows, `chatbot_requests` 50,058, `chatbot_conversations` 12,000, `conversation_messages` 600,000. Tenant A has 1,200 chats in `HUMAN` mode.

The live sessions of every tenant are spread over every state, including the awkward ones:

- **STARTING:** 25 % overdue (start deadline passed), the rest not due yet.
- **ENDING:** one third overdue (more than 10 min), the rest not due.
- **ACTIVE:** idle (8 %: nothing from the customer for 2 h 30 min), long-running with a customer who is still writing (15 %: active for 3 h, last customer message 10 min ago), waiting under 5 min and already noticed (12 %), waiting 6 min (4 %, the level-5 notice is due), waiting 16 min (2 %, the level-15 notice is due), a customer message not yet noticed (3 %), normal (56 %).

Due at the start of the sweep stage (all three tenants): 120 STARTING, 120 ENDING, 96 idle ACTIVE, 144 notices.

What is measured: the real controllers, guards (the bot guard writes a `service_rate_buckets` row per request), stores and serialization **over HTTP** on localhost, one request at a time after 5 warm-up calls. Authentication of staff routes is a stub guard with the real permission metadata (as the other integration specs do). The sweep is driven through `tick(now)` with the seed's frozen clock.

## Targets

| Target                                                                                              | Limit                            | Measured (final run)                                                                                            |                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Inbox groups page with `liveSession` fields, p95 (§10.1)                                            | < 200 ms                         | first page 20.45 ms; every page of a full walk (80 pages, 2,000 groups, 1,020 rows with `liveSession`) 27.69 ms | PASS                                                 |
| Inbox counts / detail of a live request / customer list, p95 (§10.1 bar)                            | < 200 ms                         | 11.61 / 8.63 / 3.27 ms                                                                                          | PASS                                                 |
| Inbox `liveSession` subqueries use `(tenantId, requestId, epoch DESC)`, no seq scan of the sessions | index scan, 0 seq scans          | yes, 0 (groups page and detail)                                                                                 | PASS                                                 |
| Bulk `GET /chatbot-api/conversations/state?mode=HUMAN` page of 100, p95 (derived)                   | < 100 ms                         | first page 5.52 ms; walk of 12 pages 5.62 ms; page of 500 10.32 ms                                              | PASS                                                 |
| Bulk read returns every `HUMAN` chat exactly once                                                   | 1,200                            | 1,200                                                                                                           | PASS                                                 |
| Bulk read order comes from `chatbot_conversations_human_idx`                                        | index scan, no sort of the chats | yes                                                                                                             | PASS                                                 |
| `session-ack` STARTED / ENDED / replay / 409 `STALE_EPOCH`, p95 (derived)                           | < 100 ms                         | 8.55 / 9.24 / 6.40 / 6.86 ms                                                                                    | PASS                                                 |
| Staff message, p95 (derived)                                                                        | < 100 ms                         | 300 distinct sessions 8.95 ms; 40 in a row to one session 7.39 ms                                               | PASS                                                 |
| Sweep drains every due session (start, ENDING, idle, notices)                                       | 0 left                           | 0 left after 2 ticks                                                                                            | PASS (was 75 / 70 / 58 / 97 left after 3 ticks)      |
| Sweep, one candidate (own transaction), p95, slowest phase (derived)                                | < 100 ms                         | 12.11 ms                                                                                                        | PASS                                                 |
| Sweep, a tick with nothing due, p95 (§10.1 "Barrido de tiempos")                                    | < 50 ms                          | 22.85 ms                                                                                                        | PASS (was 278.73 ms)                                 |
| Sweep candidate queries use the partial indexes, no seq scan of the sessions                        | index scan, 0 seq scans          | yes, 0 (start / ENDING / idle and notices, before and after the drain)                                          | PASS (was the `(tenantId, id)` index walked in full) |

**Which targets are derived.** §10.1 gives the live conversation no row of its own. The explicit rows that apply are the grouped inbox (p95 < 200 ms per page, which now includes the `liveSession` fields), the time sweep ("less than 50 ms per tick with 5 000 open") and the paged conversation (p95 < 100 ms per 50 messages). Single-row commands (`session-ack`, the staff message), one page of the bulk read and one sweep candidate use the 100 ms bar of the paged conversation. That choice is mine, not the proposal's: the owner may want a different bar. The numbers are one order of magnitude under it.

## Latency (ms)

| Read / command                                      | n   | p50   | p95   | p99   | max   |
| --------------------------------------------------- | --- | ----- | ----- | ----- | ----- |
| inbox groups, first page (25 groups)                | 200 | 17.31 | 20.45 | 22.1  | 29.13 |
| inbox groups, full walk (80 pages)                  | 80  | 22.38 | 27.69 | 31.46 | 31.46 |
| inbox counts                                        | 200 | 9.46  | 11.61 | 12.36 | 13.9  |
| inbox detail of a live request                      | 200 | 5.19  | 8.63  | 10.17 | 14.26 |
| inbox customer list                                 | 200 | 2.05  | 3.27  | 3.95  | 7.36  |
| bulk state, 100 per page, first page                | 200 | 3.86  | 5.52  | 7.86  | 10.74 |
| bulk state, 500 per page                            | 100 | 7.8   | 10.32 | 10.75 | 13.31 |
| bulk state, walk (12 pages)                         | 12  | 4.19  | 5.62  | 5.62  | 5.62  |
| session-ack STARTED (STARTING → ACTIVE)             | 180 | 6.95  | 8.55  | 16.04 | 18.24 |
| session-ack ENDED (ENDING → ENDED)                  | 120 | 7.14  | 9.24  | 13.4  | 18.85 |
| session-ack replay                                  | 180 | 4.81  | 6.4   | 10.68 | 10.72 |
| session-ack 409 `STALE_EPOCH`                       | 100 | 4.5   | 6.86  | 6.99  | 11.15 |
| staff message, distinct sessions                    | 300 | 6.67  | 8.95  | 12.65 | 13.47 |
| staff message, same session                         | 40  | 6.39  | 7.39  | 13.84 | 13.84 |
| staff message, 10 attendees at once (informational) | 100 | 31.59 | 43.11 | 50.04 | 53.8  |

The inbox numbers are the unit 4 ones plus the cost of the live fields: groups p95 was 6.9-9.4 ms in the unit 4 document on a smaller table set and is 20-28 ms here, with 600,000 messages and 29,000 sessions in the database and `unreadCustomerMessages` counted per row; the `liveSession` subqueries themselves are index lookups on the newest epoch (0.003-0.011 ms per row in the plans). The 10-at-once row has no target: ten staff messages through one tenant queue behind the per-chat and per-request row locks and the per-tenant feed lock, so their latency adds up (about 4 ms each).

## Sweep: before and after

Same data, same spec. "Before" is commit `948a6013`, "after" the working tree with the changed candidate queries.

|                                                                                     | Before                                                                                                              | After                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Due at the start                                                                    | 120 STARTING, 120 ENDING, 96 idle, 144 notices                                                                      | same                                                       |
| Left due after the drain loop (up to 40 ticks, stops when a tick makes no progress) | 75 STARTING, 70 ENDING, 58 idle, 97 notices, after 3 ticks                                                          | **0**, after 2 ticks                                       |
| Tick 1 (336 sessions swept + 100 notices)                                           | 1,615 ms, 500 candidates of which 371 skipped                                                                       | 2,530 ms, 336 candidates, 0 skipped                        |
| Tick with nothing due, p95 (25 samples)                                             | **278.73 ms** (100 not-due candidates, one transaction each, in the session batch and 100 more in the notice phase) | **22.85 ms**, 0 candidates                                 |
| Session candidate query, execution                                                  | 1.9 ms with a due-heavy table; 3.4 ms when nothing was due (11,639 rows removed by the filter)                      | 5.1 ms with a due-heavy table; 4.7 ms when nothing was due |
| Notice candidate query, execution                                                   | 3.9 ms (100 rows after 609 rows read in `(tenantId, id)` order)                                                     | 4.7 ms with a due-heavy table; 4.0 ms when nothing was due |

Tick 1 is longer after the fix only because it actually does the work: every due session is processed instead of being starved (the first run processed 129 sessions + 47 notices in its tick 1 and stopped).

Per candidate (each in its own transaction, ms; "after" run):

| Phase                                    | n   | p50  | p95   | p99   | max   |
| ---------------------------------------- | --- | ---- | ----- | ----- | ----- |
| START_TIMEOUT revert (`REVERT_START`)    | 120 | 9.17 | 12.11 | 16.15 | 22.49 |
| ENDING → ENDED (`MARK_ENDED`)            | 120 | 3.33 | 4.0   | 5.61  | 6.21  |
| idle end (`IDLE_END`)                    | 96  | 6.7  | 9.59  | 22.72 | 22.72 |
| notice (customer wrote / 5 min / 15 min) | 144 | 2.11 | 2.64  | 4.02  | 6.44  |

### Finding: the sweep candidate queries were unbounded and starved due sessions (fixed)

`LiveSessionSweepStore.runBatch` selected candidates with one `WHERE` made of four `OR`ed branches and `ORDER BY tenantId, id LIMIT 100`; `runNoticeBatch` did the same over ACTIVE sessions with a join to the chat. Three problems showed at this size:

1. **The plan was an in-order walk of the whole table.** With the `OR` and the `ORDER BY ... LIMIT`, the planner read `chatbot_live_sessions_tenantId_id_key` in order and filtered every row (`Rows Removed by Filter: 11,639` for a result of 100; with nothing due it reads the whole 29,000-row table every 10 s). None of the unit 11 partial indexes was used.
2. **Not-due candidates filled the batch.** The idle branch was `state = 'ACTIVE' AND activeAt <= now - 2 h`, which also matches every long-running session whose customer is still writing (the rule under the lock then says "not due" and skips it, every tick, forever). The notice query kept every waiting session as a candidate until its 15-min level was written. Candidates were ordered by `(tenantId, id)`, so with a few hundred of them the first 100 had no due session, the scheduler stopped on "all skipped" and the due ones behind them were never swept: 75 STARTING reverts, 70 ENDING and 58 idle ends, and 97 notices stayed pending after the first three ticks, and would have stayed.
3. **A tick with nothing to do cost 279 ms**: 100 skipped transactions in the session batch and 100 in the notice phase (about 1.3 ms each), against the 50 ms target.

The fix is in the queries only (no schema change):

- `runBatch`: one `SELECT` per state, `UNION ALL`ed, each on its own partial index: STARTING with `startDeadlineAt` (`chatbot_live_sessions_starting_deadline_idx`), STARTING without a snapshot (`..._starting_idx`), ENDING (`..._ending_idx`), ACTIVE (`..._active_idx`). The ACTIVE branch joins the chat and also requires `lastCustomerMessageAt IS NULL OR <= now - 2 h`, the same condition `dueSessionAction` applies under the lock, so only due sessions are candidates. Then `ORDER BY tenantId, id LIMIT 100` over the (small) due set.
- `runNoticeBatch`: the candidate is due only when the customer's message has not been announced yet, or the 5-min level has elapsed and was not sent, or the 15-min level has elapsed and was not sent (the rule `notify` applies under the lock).

The decision under the lock is unchanged, so a session that moved in between is still skipped. Replicas still use `FOR UPDATE SKIP LOCKED` per candidate and keep no cursor.

## EXPLAIN (ANALYZE, BUFFERS)

Warm run of the statements the stores really ran (parameters inlined), on the data above. The complete plans of the final run are in the JSON report (`explain`); the excerpts keep the nodes that matter.

### Inbox groups, first page (`liveSession` subqueries)

The statement is the unit 4 page statement plus the unit 11 columns (`liveSessionState`, `liveHandoffEpoch`, `liveLastStaffActivityAt`, `liveStartedAt`, `liveActiveAt`, `liveLastCustomerMessageAt`). Each is a correlated scalar subquery guarded by `CASE WHEN r.kind = 'CONVERSATION'`, so only conversation rows run it:

```text
Limit  (actual time=0.020..0.186 rows=26 loops=1)
  -> Index Scan using "chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx" on chatbot_customer_groups g
  ...
  SubPlan 7  (unread customer messages)
    -> Index Scan using "chatbot_conversations_tenantId_conversationRef_key" on chatbot_conversations cv   (loops=59)
    -> Index Scan using conversation_messages_customer_seq_idx on conversation_messages cm                  (loops=59)
  SubPlan 8  (liveSessionState)
    -> Limit
       -> Index Scan using "chatbot_live_sessions_tenantId_requestId_epoch_idx" on chatbot_live_sessions s  (actual time=0.003 loops=38)
  SubPlan 9..: the same index, one per field
```

Every `liveSession` field reads `chatbot_live_sessions` through `chatbot_live_sessions_tenantId_requestId_epoch_idx` (`ORDER BY epoch DESC LIMIT 1`, one row), 0 sequential scans. The detail statement shows the same index for each field (`SubPlan 7`, `9`, `10`, ...), 0.004-0.011 ms per field.

### Bulk state, a later page (`conversationRef > cursor`)

```text
Limit  (actual time=0.018..0.598 rows=101 loops=1)
  -> Nested Loop Left Join
       -> Nested Loop Left Join
            -> Index Scan using chatbot_conversations_human_idx on chatbot_conversations c   (rows=101)
                 Index Cond: (tenantId = '…' AND conversationRef > 'wa:525500000667')
            -> Limit -> Sort (Sort Key: s.epoch DESC, one row) -> Index Scan using chatbot_live_sessions_one_live_uq on chatbot_live_sessions s   (loops=101)
       -> Index Scan using "chatbot_requests_tenantId_id_key" on chatbot_requests r   (loops=101)
Execution Time: 0.616 ms
```

The page order is the index order (the partial index `chatbot_conversations_human_idx (tenantId, conversationRef) WHERE mode = 'HUMAN'`), cursor pages cost the same as the first. The only `Sort` is the one-row `ORDER BY epoch DESC LIMIT 1` inside the per-chat lateral, over the one non-ended session the unique partial index returns.

### Sweep candidates (after the fix)

Session phase, due-heavy table (120 + 120 + 96 due):

```text
Limit  (actual time=4.013..5.039 rows=100)
  -> Gather Merge -> Sort (Sort Key: tenantId, id; top-N heapsort)
       -> Parallel Append
            -> Hash Join (sessions of the ACTIVE branch with their chat)
                 -> Bitmap Heap Scan on chatbot_live_sessions s
                      -> Bitmap Index Scan on chatbot_live_sessions_active_idx   (activeAt <= idle cut)
                 -> Hash -> Seq Scan on chatbot_conversations c  (9,580 rows)
            -> Bitmap Index Scan on chatbot_live_sessions_starting_idx            (startedAt <= start cut, legacy rows)
            -> Bitmap Index Scan on chatbot_live_sessions_ending_idx
            -> Index Scan using chatbot_live_sessions_starting_deadline_idx
Execution Time: 5.080 ms      (steady state, nothing due: 4.717 ms)
```

Notice phase: `Bitmap Index Scan on chatbot_live_sessions_active_idx` (1,752 ACTIVE sessions) hash-joined to the chats and filtered by the due rule: 4.740 ms with 144 due, 4.031 ms with none.

### Before the fix (for comparison)

```text
Limit  (actual time=0.082..3.431 rows=100)
  -> Index Scan using "chatbot_live_sessions_tenantId_id_key" on chatbot_live_sessions s
       Filter: (state = 'STARTING' AND startDeadlineAt <= …) OR (… ) OR (state = 'ENDING' …) OR (state = 'ACTIVE' AND activeAt <= …)
       Rows Removed by Filter: 11639
       Buffers: shared hit=11924
```

## Notes and what this does not prove

- **The `chatbot_conversations` hash join.** In both sweep queries the planner hash-joins the ACTIVE sessions to the whole `chatbot_conversations` table (a `Seq Scan` of 12,000 chats, ~1.5 ms). That is cost-based: with this many ACTIVE sessions (a few thousand across three tenants) it beats thousands of index lookups, and the node scales with the chats table, not with the sessions table. With a much larger chats table the planner is expected to switch to index lookups on the primary key (the cost of the scan grows, the outer side does not), but that was **not measured**; the sizing here is 12,000 chats on the whole platform. If a production database shows this scan growing, the next step is a join order that starts from the due sessions and looks the chat up by primary key, or a partial index on `(lastCustomerMessageAt)`.
- **The session batch has a parallel plan** (`Gather Merge`) on this machine. A parallel worker start costs more than the query on a small result; it is the planner's choice and the 50 ms bar is met with it.
- **One machine, not production hardware.** One tenant at a time on a local PostgreSQL, a single connection per request, no Traefik, no second replica. The numbers show the shape (indexes used, no scan that grows with other tenants' rows, due work is never starved); they are not capacity numbers.
- **Not covered:** the sweep with two replicas running at once (R11 is covered by the unit 7 and unit 11 integration specs, not by this load test), media sends (the upload goes to object storage, which is faked here), the template command (rare, one row), and the real bot at the other end (the end-to-end proof with the chatbot is a separate gate, §10).
- **Seed realism.** 780 ACTIVE and 420 STARTING/ENDING sessions in one tenant is deliberately heavy (a tenant's attendees working at once); the history (13,454 ended sessions) is what a year of use would add. The noise tenants carry the same shape so the global sweep queries see 2,000 live sessions, not 1,200.
