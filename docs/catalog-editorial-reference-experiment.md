# Editorial reference experiment: isolated SQL hypothesis

Records the completed T1–T3 experiment in `odd/tasks/editorial-reference-sql-experiment.md`.
The human grant is recorded in L2. The exact disposable target is now retired.
No production integration, operational lock adoption, or runtime readiness is claimed.

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

The following is the historical live invocation, not permission to recreate the retired
target. Future live execution requires separate authorization and a newly admitted target.
For database-free checks, omit both `EDITORIAL_REFERENCE_SMOKE` and `EDITORIAL_REFERENCE_SQL`.
Resolve `node_bin=$(command -v node)` first; the authorized live run used:

```sh
env -i PATH=/usr/bin:/bin NODE_ENV=test FORCE_COLOR=0 EDITORIAL_REFERENCE_SMOKE=1 "$node_bin" node_modules/jest/bin/jest.js --config src/catalog-editorial/infrastructure/editorial-reference-experiment.config.cjs --runInBand
```

Omit `EDITORIAL_REFERENCE_SMOKE=1` for mock-only admission/lifecycle tests. Use a 30s outer
command bound; never automatically retry a timeout. The real smoke freshly admits each
invocation, verifies database/schema identity and different backend PIDs, shares a table
across clients, and verifies prior success/failure schemas absent through public SQL.
It proves neither a lock protocol nor global schema absence. Exact-target removal/absence
verification (S4/T3) is recorded below. T2 passed parent and independent verification.
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
The semantic continuation is partitioned into foundation/create-boundary and dependent
D16/create-active-only/replay/source-failure/qualification/empty-metadata proof.
Foundation adds the real SQL authority/core composition described below; all ten
restored dependent cases are now exercised, including the latest replay clarification.
Do not import d16-create-fixture: it imports the retired runner and registers hooks.
T2/S2/S6 passed bounded independent verification; no runtime adoption.

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

## Real-core semantic composition (isolated experiment only)

The owned minimal schema includes actual definition/state/create/save receipt columns,
keys, checks and relevant FKs. Permission/member rows are synthetic; the accepted
PrismaEditorialAuthority reads them through real transaction-bound Prisma delegates.
Its test-only document provider reads variants/private_media_assets using parameterized
SQL with BOTH tenantId and productId, and reads real vocabulary through
PrismaEditorialDefinitions. No mocked authority or public media URL supplies access.

A test-only $transaction dispatch bridge invokes accepted PrismaCatalogEditorial
inside the same real READ COMMITTED transaction as permission/reference observation.
Source SHARE locks precede those observations; validation, state write and receipt
insert retain the transaction. A receipt-boundary observer detects the foreign media
DELETE waiting on that backend with an ungranted lock, then verifies release after
commit. Public read, exact create receipt/request, zero save receipts, retained media
IDs and unchanged other fixture-table snapshots are checked. This composes test seams;
production has NO such reference-authority/transaction composition from this work.
Local lock/statement bounds are 2s/2.5s, interactive transaction 2.8s/maxWait1s, inherited
idle timeout3s; peer autocommit retains runner1s/3s bounds. Pending work settles and
both clients roll back; peer idle is checked before runner schema cleanup.

Prior draft RED omitted source barriers and failed the receipt-boundary wait assertion.
The old draft 11-case GREEN was not treated as current evidence. After foundation
acceptance, all three fragments were hash/byte/newline verified and inserted exactly
before formatting, without changing foundation bytes. After the restored tests were
committed, the parent removed only `.tmp/editorial-reference-semantic-pending.json`,
first verifying its 9,488 bytes and SHA256
`6a2a760fcac3834e3fcab2b776acc76444f49b7b59509c4a2449d330b50632b1`.
It was preserved draft source, never frozen review transport. Restoration and strengthened
observations passed 11/11 focused cases; no pending cases were discarded.
Risk item4 remains: global blocking/deadlock costs are unaccepted; item2 remains governed
by unchanged T1 admission. No production security guard changed.
Snapshot identifier interpolation uses ONLY the closed semanticTables literal list;
the prior static “SQL injection risk” identifier diagnostic is a false positive for
this fixture, not a reason for a broad suppression. Restored failure injection/probes
now select complete SQL statements from a closed literal map, eliminating their dynamic
identifier warning without suppression. CJS service gap remains deferred. Rollback this
unit by reverting its committed helpers/tests and doc changes; preserve the foundation.

### Dependent semantic results

D16 initialize preserves archived Published `old` at the same sellable/variant binding,
then save preserves it with ARCHIVED_OPTION warning and revision2. Legacy create rejects
that archived option; new variant and changed owner assignments reject MALFORMED.
The owner case proves binding-mismatch rejection, not dynamic binding-mutation behavior.
Actual create/save receipts and public stored state are checked, not toy counters.
Historical create/save replays return revisions1/2 with empty documents after current
state reaches revision3 with a later document and its option is subsequently archived.
Replay leaves every fixture-table snapshot unchanged; removing the current update
permission makes both replays FORBIDDEN while read still returns current revision3.
This is per-attempt permission observation, NOT atomic revocation or historical=current.

All three source-column failures produce real 42703 probes and fail closed as FORBIDDEN
on create/save replay. SQL snapshots of all 16 fixture tables remain unchanged, including
all state/revisions/receipts/source/permission rows; public read still returns current
state. Four wrong-tenant/product variant/private-media IDs reject MALFORMED without any
persisted effect. Truly empty SQL references AND vocabulary allow a real empty create,
with exact public state/create receipt and all other table snapshots unchanged.
SQL deadlock/timeout rollback uses the separate reduced-schema sentinels; core semantic
rejection/replay uses actual tables. Neither proves a production concurrent adapter,
production read isolation, deadlock retry policy, or permanent post-commit integrity.

Current validation: explicit SQL+smoke flags pass 50/50 (14 SQL + 25 T1 + 11 core),
6.041s; default passes 24 with 26 skipped, 0.575s. Scoped strict TS, TS ESLint,
CJS syntax, narrow Prettier and diff checks pass. All ten restored cases are exercised;
independent verification also passed 50/50 (7.494s) and default 24/26 skipped (0.601s).
T2 is accepted within this experimental scope; T3 cleanup is complete.

## Retirement and decision boundary

After all SQL verification, the parent freshly matched the full container ID, exact name,
image and ownership labels, then removed only
`c5a4f914265edb542ab7506905952314dff5228d5ebd7e8efa377f49e3ae38c8`.
Post-removal inspection exited 1 with `No such container`; reachable-daemon exact-ID and
anchored-name filters both returned zero matches. The restored temporary fragment file
was also removed after hash and committed-source checks. No other target or runtime changed.
Do not reconnect, recreate, adopt, or replace this target under the expired experiment grant.

The experiment establishes evidence, not a deployable coordination policy. Source-table
SHARE locks affect unrelated tenants and can deadlock with existing Product-first writes.
Any production strategy needs a separate scope/tradeoff decision and appropriate proof;
this work activates no provider, write route, publication, or shared API restart.
