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

Right after deploying the 3a code (so every new row is already wrapped by the hooks) and **before** the inbox is announced or used by staff.

**Hard precondition: run the backfill to completion before anyone resolves requests through the common inbox route.** While wrappers are missing, a legacy resolve of an unwrapped row racing the backfill and a staff resolve of the request the backfill just created can form a lock cycle, and PostgreSQL aborts one of them (40P01). The aborted transaction rolls back cleanly and nothing is corrupted, but a staff member would see an error and have to retry (details: `docs/chatbot-requests-model.md`, lock rule 5). Once the backfill finished and `--check` is clean, the window is closed.

Running it before the 3a deploy leaves a gap: rows created between the run and the deploy would have no wrapper (a later run fixes it, because it is idempotent).

## How to run it in production

The script runs against the compiled app, from `/app` inside the API container. It needs `DATABASE_URL`, which the container already has.

```sh
# 1. Find the container (Docker Swarm task name starts with the service name)
C=$(sudo docker ps -q -f name=houndfe-system-backend)

# 2. Pre-check: the image must be built from the backfill commit (b0ebd3a7) or
#    later and contain the compiled core. `ls` must print the path, not an error.
sudo docker exec "$C" ls /app/dist/chatbot-requests/infrastructure/chatbot-request-backfill.js

# 3. Copy the script in (the image does not ship scripts/ops)
sudo docker exec "$C" mkdir -p /app/scripts/ops
sudo docker cp scripts/ops/backfill-chatbot-requests.cjs "$C":/app/scripts/ops/

# 4. Dry run (default): reads only
sudo docker exec -w /app "$C" node scripts/ops/backfill-chatbot-requests.cjs

# 5. Apply
sudo docker exec -w /app "$C" node scripts/ops/backfill-chatbot-requests.cjs --apply

# 6. Check the invariant (exit code 1 on any mismatch)
sudo docker exec -w /app "$C" node scripts/ops/backfill-chatbot-requests.cjs --check
```

If the pre-check fails, or the script stops with `FAILED OpsError`/`BUILD_MISSING`, the running image is older than the backfill commit: deploy a newer image first. `LOAD_FAILED` means the file exists but could not be loaded (a broken build).

**Exit codes:** `0` clean (a dry run or apply that finished, or `--check` with no mismatch), `1` `--check` found a mismatch, `2` the script crashed (bad arguments, missing or broken build, database error). A crash prints one line with the error class and the Prisma/PostgreSQL code (for example `FAILED PrismaClientKnownRequestError P2002` or `... 40P01`), never the raw message, and long digit runs are redacted. A 40P01 deadlock aborted one batch: re-run `--apply`; rows already committed are kept.

| Flag | Effect |
| --- | --- |
| *(none)* | Dry run: prints the plan, writes nothing |
| `--apply` | Writes |
| `--check` | Read-only §2.1 invariant check; cannot be combined with `--apply` |
| `--tenant <slug>` | Only that tenant |
| `--batch-size <n>` | Rows per transaction, 1 to 1000 (default 100) |

### Sequence: dry run → apply → check

1. **Dry run.** Per tenant and subtype it prints `would create N (open, resolved)`, the ambiguous customers, the rows skipped because they already have a wrapper, the rejected receipts left out, and the age in days of the oldest pending row per subtype (so unit 7 can size the SLA burst). Read it. Output has counts and ids only: no phone numbers, no customer text.
2. **Apply.** Same report with `created`. It is safe while the API is live (see below).
3. **Check.** `OK: 0 mismatches` is the target. It reports `MISSING_REQUEST` (an open legacy row without a request: run `--apply` again), `RESOLVED_UNWRAPPED` (a row resolved in the last 7 days without a request: run `--apply` again), `STATE_DISAGREES` (a request and its wrapped row disagree on open/resolved) and `GROUP_MISMATCH` (customer group count differs from the open requests; a phone key is masked to at most 4 digits). A single stray result under heavy traffic can be transient: re-run `--check` first.
4. **Re-run `--apply` or a dry run:** it must report `0 request(s) to create`. That is the idempotency proof.

Ambiguous customers (R1) are requests whose phone matched more than one `Customer`. They stay unlinked, flagged `ambiguousCustomer`, and staff links them by hand.

## Safe while the API is live

- One READ COMMITTED transaction per batch of 100, per tenant. No long locks. Only decisions of the chatbot source (`houndfe-chatbot`, as the legacy tray shows) are wrapped.
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

Measured on a local test database (300 pending decisions, three batches of 100): about 0.5 s in total. That is a local measurement; production was not measured. Cost scales with round trips: a batch runs a fixed handful of statements (zip locks, row lock, wrapper re-check, folio block, bulk insert of requests and events) plus a few statements per row: about 4 for the customer-group refresh of each open request, one customer lookup per zone requester and one sale lookup per receipt. At an assumed 2-5 ms per round trip that is on the order of seconds per batch of 100, so a tenant with a few hundred pending rows should finish in seconds and tens of thousands of rows in minutes; treat these as estimates and watch the first batches. The dry run reads in the same batches, so it takes a similar time. Each batch has a 60 s transaction timeout; if a slow database trips it, re-run with a smaller `--batch-size`, and the rows already written are kept.
