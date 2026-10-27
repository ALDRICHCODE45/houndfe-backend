# Editorial reference reader (U2a)

`readLockedEditorialReferences(tx, scope, selectedAssetIds)` is a standalone
internal primitive, not a provider or an authorization grant.

## Caller contract

- Caller already holds the tenant/product-qualified Product gate in **the same
  transaction**, before this read; retain it through validation and commit.
- Supply the union of asset IDs selected by the relevant captured documents.
  Duplicate IDs are accepted and deduplicated. Integration and document selector
  extraction belong to U2b; no factory/core signatures or runtime wiring change.
- Validate the captured documents against this reference snapshot and the
  separately selected vocabulary snapshot. No families are returned here.

## Observations and failures

Qualification and selected strings are copied before the first await. Variants
are read by both tenant and product, ordered by ID, without child-row locks.
Only selected, qualified private-media asset rows are read `ORDER BY id FOR
SHARE`. Parameters use Prisma SQL bindings; there are no table locks or writes.
An empty selection still issues a qualified asset query with `FALSE` membership.
Real empty results succeed; either SQL rejection propagates without fallback.
Missing requested positives remain missing so existing strict validation rejects
references to them. Invalid internal argument shapes reject before queries;
this does not establish a public error policy or replace document validation.

## Evidence and limits

Focused mocked tests cover qualification, ordering, binding, deduplication,
async caller mutation, empty observations, source rejection, missing positives,
and read-only effects. These are not SQL lock, concurrency, or rollback witnesses.
No storage/network operation, HTTP activation, or permanent postcommit integrity
is implied. S2/S4 are only primitive-level coverage; S5 remains offline-only.

Rollback boundary: remove this reader/spec/document and its single focused Jest
`testMatch` entry. Existing U1 authority/seam and U3 membership commits remain
intact. This primitive owns no transaction commit/rollback or persisted effects;
its caller must propagate rejection and manage the surrounding transaction.

## U2b2: opt-in coordinated composition

Pass `createCoordinatedEditorialWriteAuthority` as the fifth
`PrismaCatalogEditorial` constructor argument. This internal factory is not
registered in a module or HTTP transport.

Every transaction reaching authority resolution checks current capabilities and
the qualified Product gate before observing real Variant, asset and all five
vocabulary sources with empty selections. Source failure denies even empty
attempts; no asset/vocabulary rows are selected by these probes.

At existing validation boundaries, preparation collects recognizable media IDs
without replacing strict validation and locks only selected qualified assets.
Create and create-replay also read selected vocabulary and reuse the contextual
validator's code projection. Create's existing active-option check still rejects
archived new assignments. Stored save/initialize retain their existing selected
definitions and same-assignment conservation checks.

Offline public-core tests cover source failures, empty operations, nonempty
selection, missing assets, archived creation denial and nonempty archived-option
save replay. These are not PostgreSQL lock/rollback witnesses or a universal
replay guarantee. T4 still requires a new SQL target grant.

## Live evidence (U6)

The separately authorized disposable PostgreSQL run passed three real coordinated
`PrismaCatalogEditorial.create` cases (asset, option, late-failure rollback).
Each actor had its own admitted client. A raw transaction locked an existing empty
state row; the editorial transaction reached its later UPSERT and waited on that
backend, after acquiring its reference locks. Bounded `waitForLockWait` observations
then named the editorial backend in the selected writer's `pg_blocking_pids`.

- Selected private-asset DELETE and selected active-option archival UPDATE waited.
  The corresponding unrelated asset of the same Product / option of the same
  definition changed successfully before release, with persisted readbacks.
- After release, editorial committed cycle 2, draft and create receipt containing
  the validated selected asset/option. The selected DELETE / archival then
  **succeeded**, affecting one row; readbacks confirmed deletion / archival.
- For rollback, the gate committed a conflicting raw create receipt. Editorial's
  later receipt INSERT failed with Prisma P2010 / PostgreSQL 23505. Its state
  UPSERT rolled back to the exact empty baseline; only the raw gate receipt
  remained, with no editorial receipt or save receipt. The blocked asset DELETE
  proceeded successfully, proving reference-lock release on failure.

This proves these create paths and positive selected-row edges, not every save,
initialize, asset UPDATE or vocabulary mutation. It establishes no permanent
postcommit integrity, historical replay guarantee, byte availability or permission
revocation atomicity. External writers are outside the coordinated-writer protocol;
the raw writers here are adversarial probes, not a supported integration contract.
No production/module/HTTP activation or fixture/harness change is included.
