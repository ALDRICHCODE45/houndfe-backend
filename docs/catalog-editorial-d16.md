# Contextual D16 validation — internal and unactivated

`validateContextualDocument` in `domain/contextual-document.ts` composes the
unchanged strict `validateDocument` with archived-option conservation. Inputs are
an unknown candidate, current qualified reference authority (tenant/Product,
variants and private asset IDs), an `EditorialDefinitionsSnapshot`, and a trusted
baseline document or null. It returns a detached document and typed warnings.

The baseline is an internal trust boundary: this pure function cannot establish
persisted provenance, authorization, freshness, CAS or locking. Integration must
obtain it from the authorized locked Draft, Published or matched successful receipt,
never from the request. Existing core consumers are not connected in E1.

Archived options are retained only in the same family/definition/owner/variant
assignment already present in the baseline. Stable, non-reused codes resolve to
current persisted identities. New, reintroduced and moved archived assignments
fail with `MALFORMED`; labels are not option codes. Multi-selection preservation
uses per-option membership: reorder/removal/active replacement remain valid.
Missing current definitions/options and revoked variant/media references still
fail. No conservation policy is inferred for archived families, definitions or media.

Each retained archived assignment yields `ArchivedOptionWarning`:
`{ code: 'ARCHIVED_OPTION', familyId, definitionId, owner, variantId, optionCode }`.
Warnings follow candidate value/option order. Removing or replacing the archived
assignment removes its warning. Incomplete documents remain valid capture data.
The temporary all-code projection is private to strict validation and never
returned as an assignment allowlist; contextual checks must succeed first.

## Verification and boundaries

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath src/catalog-editorial/domain/contextual-document.spec.ts src/catalog-editorial/domain/document.spec.ts
```

E1 tests are pure/synthetic; they do not prove stored baseline provenance or
concurrency. E2 adds transaction-bound integration and deterministic two-connection
proof. E3 adds explicit Published/empty initialization without reinterpreting
`create(document)`. No schema, vocabulary load, media provider, route, UI,
publication or runtime registration is added here. The real private-media authority
remains an independent gate; no empty asset list is a substitute.

Rollback boundary for E1: remove only the new contextual validator, its tests and
this document; the original validator and consumers are unchanged.

## Disposable two-client prerequisite (E2)

`infrastructure/d16-postgres-runner.ts` admits only the newly authorized container
`f764e05bf359e64cb912d5c3d56c11c4803ea5b6f8bd611091cbe2f35a68fb7b`, named
`catalog-d16-01a1764b-1793012714`, database `catalog_d16_isolated`.
It checks exact identity, local image, nonprivileged bridge, no published ports,
labels, volumes or binds, and tmpfs metadata plus the actual data filesystem.
Credentials come only from that target and are never logged; generated-client
`.env` paths are disabled. There is no ambient database fallback.

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath src/catalog-editorial/infrastructure/d16-postgres-runner.spec.ts
CATALOG_EDITORIAL_D16_TEST_CONTAINER=f764e05bf359e64cb912d5c3d56c11c4803ea5b6f8bd611091cbe2f35a68fb7b pnpm exec jest --config src/catalog-editorial/infrastructure/d16-postgres.config.cjs --runInBand
```

Each invocation creates one random synthetic schema with a minimal Product table
and the five existing editorial migration artifacts. Two independent single-connection
clients share that schema; `close()` disconnects both, not the container.
Tests prove distinct backend sessions, shared committed state, rollback visibility
and installed empty editorial artifacts. They do not yet prove save/initialize
locks, production schema compatibility, authorization or private-media access.
After authorized work, remove only the exact container ID above and confirm absence.
These commands must then fail closed; never repoint or revive historical runners.

## Existing regression contracts on the new target

```sh
CATALOG_EDITORIAL_D16_TEST_CONTAINER=f764e05bf359e64cb912d5c3d56c11c4803ea5b6f8bd611091cbe2f35a68fb7b pnpm exec jest --config src/catalog-editorial/infrastructure/d16-regression.config.cjs --runInBand
```

This dedicated config reuses the existing read/create/save contracts. The save
Published-preservation fixture now uses a valid document; corruption denial has
its own D16 test. The config maps
only its relative runner import to `d16-regression-adapter.ts`; the retired runner
is never loaded or executed. The legacy environment variable is set only to enable
that suite's presence gate; the D16 runner still admits its exact new target.
The adapter disconnects the unused second client; existing hooks close the first.
Failure disconnects both and propagates without fallback. This proves historical
behavior on synthetic PostgreSQL, not contextual save/replay or archive locking.
Run this command only while the authorized new target exists; no fallback applies.

## Scoped vocabulary locks

`readLockedEditorialDefinitions(tx, documents)` accepts a transaction and unknown
JSON documents. It captures data descriptors before awaiting, rejecting accessors
and unsupported values without invoking them. It decodes reference selectors;
full validation still belongs to `validateContextualDocument`. Callers must capture
once and use the same stable documents for observation and validation.

The helper resolves and locks families, definitions, exact bindings, selected
options and numeric units with parameterized `FOR SHARE` queries in table/PK order.
Null units require a real row; empty multi values require no option rows.
Missing positives reject. Its restricted snapshot contains only locked rows:
no unlocked global read, cross-product bindings, or active-option-only filter.
Locks remain until the caller transaction ends. Save now uses this helper inside
its write transaction; the global reader and legacy create/read implementations
remain unchanged. Explicit initialization is still pending.

The D16 PostgreSQL command above also runs scoped observation tests: selected
archival waits, an unselected option progresses, and an earlier writer's committed
archive status is observed. Barriers inspect PostgreSQL blocking PIDs, not sleeps.
This proves current membership, not historical identity across administrative
code reuse/deletion/reinsertion. Deterministic ordering is not a guarantee against
arbitrary writer deadlocks; errors abort rather than falling back to unlocked data.
No atomic external authorization or private-media revocation guarantee is added.

## Atomic contextual save and replay

`save(context, request)` still requires current qualified write authority, including
explicit read+update through the authority adapter and a real document provider.
It locks the scoped Product before reading the Draft or matching a persisted receipt.
The request cannot supply a baseline. A fresh save uses only the persisted Draft;
a historical replay uses only the successful result of the exactly matching
actor/tenant/Product/key/request receipt, before CAS and without any writes.

Both paths validate persisted metadata and every returned document against current
references and locked vocabulary. Receipt cycle, resulting revision and Draft
content must agree with the request. Malformed or revoked persisted content is
not disclosed. Conservation does not turn a receipt into an authorization grant.
Fresh save retains atomic CAS/update/receipt insertion and does not touch operational
Product fields. Locks cover the state write and receipt insertion until commit.

`EditorialReadResult.warnings` is optional and present only when the returned Draft
retains archived options. Warnings are recomputed against current vocabulary on
replay; historical content/revisions are not replaced with the current Draft.
Authority is observed per attempt, not locked across external permission/media
revocation. This internal implementation adds no HTTP/UI registration or private
media provider. E3 initialization and legacy-create archive integration remain pending.
