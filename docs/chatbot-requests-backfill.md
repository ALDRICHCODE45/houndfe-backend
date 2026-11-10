# Chatbot requests: one-time backfill

Human-intervention unit 3, slice 3b. Contract: `docs/proposals/human-intervention-backend-proposal.md` §2.4, §10.1 R1 and R9. Model and lock rules: `docs/chatbot-requests-model.md`.

The 3a code wraps every **new** legacy request (restock, expiration, delivery zone, transfer receipt) in a `ChatbotRequest`. Rows created before that deploy have no wrapper, so the inbox would not show them. This script creates the missing wrappers once. It is an ops script (`scripts/ops/backfill-chatbot-requests.cjs`), not a SQL migration, because it uses `canonicalPhone`, the R1 customer linking and the 3a request builder, and because it can be re-run safely.

## What it does

For each tenant, and only for rows that have no wrapping request:

| Legacy row | Becomes |
| --- | --- |
| `HumanDecision` (RESTOCK, EXPIRATION) `PENDING` | `NEW` request, `customerKey = unknown:<id>` |
| `DeliveryZoneRequest` `PENDING` (waiting on a validation) | `NEW` request, `customerKey` from the phone, R1 link or `ambiguousCustomer` |
| `ReceiptEvidence` `PENDING` | `NEW` request, customer from `Sale.customerId` |
| Any of the above `RESOLVED`/`CONFIRMED` in the **last 7 days** | `RESOLVED` request with `resolvedAt` copied (and the actor, when the row keeps one) |

Not wrapped, by design:

- Rows resolved more than 7 days ago. They stay in the old screens (§2.4).
- Zone requesters born resolved by an existing zone: they never waited for a human, and the 3a hook skips them too.
- **Rejected receipts.** The old reject path stores no date, so they cannot be placed in the 7-day window. The dry run prints how many of the last 7 days were left out.

Requests keep the wrapped row's `createdAt`, get a folio from the tenant counter, and one audit event each: `CREATED` by `SYSTEM` with `data.backfilled = true`. SLA deadlines stay empty (unit 7 computes them).

## When to run it

Right after deploying the 3a code (so every new row is already wrapped by the hooks) and **before** announcing the inbox to staff. Running it earlier than the deploy leaves a gap: rows created between the run and the deploy would have no wrapper (a later run fixes it, because it is idempotent).

## How to run it in production

The script runs against the compiled app, from `/app` inside the API container. It needs `DATABASE_URL`, which the container already has.

```sh
# 1. Find the container (Docker Swarm task name starts with the service name)
CID=$(docker ps -q -f name=houndfe-system-backend)

# 2. Copy the script in (the image does not ship scripts/ops)
docker exec "$CID" mkdir -p /app/scripts/ops
docker cp scripts/ops/backfill-chatbot-requests.cjs "$CID":/app/scripts/ops/

# 3. Dry run (default): reads only
docker exec -w /app "$CID" node scripts/ops/backfill-chatbot-requests.cjs

# 4. Apply
docker exec -w /app "$CID" node scripts/ops/backfill-chatbot-requests.cjs --apply

# 5. Check the invariant (exit code 1 on any mismatch)
docker exec -w /app "$CID" node scripts/ops/backfill-chatbot-requests.cjs --check
```

If `docker ps -q` prints more than one id, use the one that is running on this node, or limit the run with `--tenant <slug>`.

| Flag | Effect |
| --- | --- |
| *(none)* | Dry run: prints the plan, writes nothing |
| `--apply` | Writes |
| `--check` | Read-only §2.1 invariant check; cannot be combined with `--apply` |
| `--tenant <slug>` | Only that tenant |
| `--batch-size <n>` | Rows per transaction, 1 to 1000 (default 100) |

### Sequence: dry run → apply → check

1. **Dry run.** Per tenant and subtype it prints `would create N (open, resolved)`, the ambiguous customers, the rows skipped because they already have a wrapper, and the rejected receipts left out. Read it. Output has counts and ids only: no phone numbers, no customer text.
2. **Apply.** Same report with `created`. It is safe while the API is live (see below).
3. **Check.** `OK: 0 mismatches` is the target. It reports `MISSING_REQUEST` (an open legacy row without a request: run `--apply` again), `STATE_DISAGREES` (a request and its wrapped row disagree on open/resolved) and `GROUP_MISMATCH` (customer group count differs from the open requests; the customer key is masked). A single stray result under heavy traffic can be transient: re-run `--check` first.
4. **Re-run `--apply` or a dry run:** it must report `0 request(s) to create`. That is the idempotency proof.

Ambiguous customers (R1) are requests whose phone matched more than one `Customer`. They stay unlinked, flagged `ambiguousCustomer`, and staff links them by hand.

## Safe while the API is live

- One READ COMMITTED transaction per batch of 100, per tenant. No long locks.
- Lock order follows `docs/chatbot-requests-model.md`: postal-code advisory locks first (zones), then the wrapped rows `FOR UPDATE` (id order), then the folio block, then the request rows, then the customer groups. The wrapped row is re-read and re-checked under the lock, so a legacy resolve or a 3a hook that got there first is respected.
- `ON CONFLICT DO NOTHING` on the unique wrapped FK is the last net: a concurrent hook, legacy route or second backfill can never produce two wrappers for one row. A row skipped this way is printed as "skipped under lock".
- A batch holds the postal-code lock of its zone rows for its duration (tens of milliseconds), so a bot intake for that postal code waits briefly.

## Roll back

**Apply is one-way.** The wrappers cannot be deleted: the trigger `chatbot_requests_keep_forever` rejects a direct `DELETE` (requests are kept forever, D4), and the events table is append-only. That is acceptable because:

- The backfill changes no legacy row. `human_decisions`, `delivery_zone_requests` and `receipt_evidences` are untouched, and the old screens and routes keep working (S4).
- A wrapper is only an additional row, equal to what the 3a hook writes for new requests. Nothing reads it until the inbox is announced.
- A wrongly wrapped row cannot exist by construction: only unwrapped rows in a qualifying state are written, re-checked under lock.

If something is wrong with the data a wrapper holds, fix it with the normal commands (a staff cancel with a reason, or a legacy resolve, which closes the wrapper) rather than by deleting. Only a full tenant deletion removes them (cascade).

## Expected runtime

Measured on a local test database (300 pending decisions, three batches of 100): about 0.5 s, roughly 1.5 ms per row. Zone requesters cost one extra customer lookup each and receipts one sale lookup each, and a production database adds network latency per statement (about 10 statements per row). Plan for a few minutes at most for tens of thousands of rows; a tenant with a few hundred pending rows finishes in seconds. The dry run reads in the same batches, so it takes about as long as the apply. Each batch has a 60 s transaction timeout; if a slow database trips it, re-run with a smaller `--batch-size`, and the rows already written are kept.
