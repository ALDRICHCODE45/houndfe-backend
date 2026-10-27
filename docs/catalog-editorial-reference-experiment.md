# Editorial reference experiment: isolated SQL hypothesis

Covers S1/S3/S4/S5 of `odd/tasks/editorial-reference-sql-experiment.md` within T1.
The human grant is recorded in L2; target lifecycle belongs exclusively to the parent.
T1 claims no production integration, reference locks, D16/create/replay proof, or runtime readiness.

## Boundary

Every invocation inspects only full ID `c5a4f914265edb542ab7506905952314dff5228d5ebd7e8efa377f49e3ae38c8`
through local `unix:///var/run/docker.sock`, with a sanitized Docker environment and 5s timeout.
Admission checks exact name/image/running/labels, tmpfs 256 MiB, no binds/mounts/published
ports, nonprivileged bridge networking; only then derives the current IPv4 address.
Missing/malformed/drifted inspection denies all client construction and callbacks.
Prisma uses an explicit synthetic URL and disables generated-client dotenv paths using
the accepted private-media runner pattern. No application bootstrap or migration runs.
Each invocation owns one random `er_test_` schema and two independent single-connection
clients; cleanup drops only that schema and attempts both disconnects, including failures.
SQL statements have 3s timeout, locks 1s, idle transactions 3s; callbacks must remain bounded
and return clients idle (no open transactions). Cleanup errors propagate, never imply success.

## Focused validation

Resolve `node_bin=$(command -v node)` first. From this workspace, run:

```sh
env -i PATH=/usr/bin:/bin NODE_ENV=test FORCE_COLOR=0 EDITORIAL_REFERENCE_SMOKE=1 "$node_bin" node_modules/jest/bin/jest.js --config src/catalog-editorial/infrastructure/editorial-reference-experiment.config.cjs --runInBand
```

Omit `EDITORIAL_REFERENCE_SMOKE=1` for mock-only admission/lifecycle tests. Use a 30s outer
command bound; never automatically retry a timeout. The real smoke freshly admits each
invocation, verifies database/schema identity and different backend PIDs, shares a table
across clients, and verifies prior success/failure schemas absent through public SQL.
It proves neither a lock protocol nor global schema absence. Parent retains exact-target
removal/absence verification (S4/T3). T2 concurrency/cost/rollback witnesses remain pending.
Rollback boundary: remove only the four experiment runner/spec/config/doc files; no
production provider, dependency, route, database migration, or shared runtime changed.
Risk: item2 — isolation/admission remains a review boundary, not a reusable target grant.

## T2 first slice: protocol declared before SQL execution

Candidate (NOT accepted runtime design): READ COMMITTED; acquire source-table
`SHARE` locks in fixed order `private_media_assets`, then `variants`, BEFORE
Product `FOR UPDATE` or any reference observation. Hold them in the same transaction
through validation and any state/receipt write. SHARE conflicts with the ROW EXCLUSIVE
lock of INSERT/UPDATE/DELETE, including empty sets and tenant/product requalification.
Product row locks alone are the unsafe baseline, not phantom protection.
Real mappings: Product→products; Variant→variants (`productId` FK, independent
`tenantId`); media→private_media_assets. CRUD addVariant observes Product before its
transaction and inserts Variant first; product edit writes Product before variant
updates; removeVariant directly deletes Variant. Thus reversed operational order can
form a deadlock: Product-first CRUD versus source-table-first editorial work.
Definition locks remain ordered row FOR SHARE as in the accepted implementation.

Explicit global cost: SHARE blocks DML even for unrelated products/tenants. It does
not block reads and does not provide permanent integrity against later authorized
mutations. Tests observe blocking PID edges and granted/ungranted pg_locks, not elapsed
sleep alone. Candidate sessions use SET LOCAL lock_timeout=2000ms,
statement_timeout=2500ms, idle_in_transaction_session_timeout=3000ms. Deadlock detection
uses the server default (no global change). Both deadlock sessions use these local
bounds; blocking/release peers remain autocommit under the runner's 1s lock/3s statement
bounds. Separate 100ms lock and statement timeout witnesses assert exact SQLSTATEs.
Every experiment finishes by awaiting pending work and rolling back both clients;
cleanup failures must propagate to the runner, which drops the random owned schema.

This slice uses reduced source schemas with real qualification/FK shapes, NOT actual
core semantic fixtures. Synthetic state/receipt counters are rollback sentinels only,
not proof of core/D16 correctness. No production adapter or authority is modified.
Dependent slice (same integration spec, estimated +250–350 lines): transaction-bound
real SQL permission/reference provider and accepted PrismaCatalogEditorial invocation,
actual definition/state/create/save receipt fixtures, D16 archived same-assignment,
create active-only, replay permission/source rechecks and rejected-effect snapshots.
Do not import d16-create-fixture: it imports the retired runner and registers hooks.
T2/S2/S6 remain incomplete until that semantic slice and independent verification.

### First-slice observed evidence

RED: with only Product FOR UPDATE, the `delete to empty` protection assertion failed
(expected observed wait=true, received=false; 1 failed/8 skipped). The permanent
unsafe-baseline witness now asserts that deletion commits while Product stays locked.
GREEN: explicit SQL+smoke opt-in ran 39/39 tests (14 SQL witnesses + 25 T1), 3.476s.
Both source tables cover insert/delete/requalification and empty↔nonempty membership;
foreign-tenant/product variant insert and media delete wait on the editorial backend,
then each affects exactly one row after release. Granted ShareLock rows, blocking PID
edges, ungranted locks and wait_event_type=Lock are asserted. No fixed sleeps used.
The reversed-order witness observes exactly one 40P01 victim and one successful
statement; both transactions then roll back to the full pre-attempt snapshot.
Timeout witnesses observe 55P03 and 57014, then 25P02 for aborted transaction reuse;
rollback restores all synthetic state/receipt/source/Product snapshots. These adverse
witnesses PASS by observing a cost/failure, not by endorsing operational design.
Every case awaits pending statements, checks rollback settlement and peer idle state
before runner schema cleanup. T1 smoke independently checks prior owned schemas absent;
this is not target removal evidence. No security guard changed. Risk item4 remains:
SQL reduced-schema evidence is not actual core permission/D16/create/replay proof.

For the SQL slice add `EDITORIAL_REFERENCE_SQL=1` to the sterile command above; flags
are independent. Without either flag, SQL cases and smoke are skipped and no live
connection is expected. Scoped strict TS and CJS syntax checks pass. CJS project-service
lint remains the known configuration gap; no global configuration fix is authorized.
Rollback of this slice: remove the new integration spec and revert only this slice's
config/doc additions; retain the accepted T1 runner/spec and target lifecycle ownership.
