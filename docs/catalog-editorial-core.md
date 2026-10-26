# Catalog editorial core — unactivated

This is a callable internal contract, **not a deployable API**. No route,
controller, module registration, permission subject or effective grant exists.
Integration and C3.1 remain pending.

## Closed document validation (first review slice)

`domain/document.ts` defines nullable `commercialTitle`, `description` and
`familyCode`, ordered private asset IDs, and explicit product/sellable values.
The five value types are text, boolean, finite number with an accepted unit
(including explicit null only when allowed), single code and multiple codes.
Unknown keys, unknown definitions, wrong ownership, types, codes, units and
references fail with `MALFORMED`. Duplicate bindings and references are rejected.
Missing attribute values are allowed: this is not publish completeness checking.

`validateDocument` needs a tenant/product-qualified authoritative snapshot;
there are no runtime fixture definitions. The future core must check that
snapshot's qualification, current membership/capability and Product access
before reads, writes **and receipt replay**. The validator alone is not an
access-control boundary. Definitions, private media and permission authority
integrations are still missing; existing public upload paths are not assets.

Validation never reads or changes `Product.name`, POS data or public catalog
consumers. `emptyDocument()` starts incomplete with no copied operational name.

Focused check (no database or environment loading):

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath src/catalog-editorial/domain/document.spec.ts
```

## Authorized persistent read (B1)

`PrismaCatalogEditorial(prisma, authority).read({ actorId, tenantId, productId })`
implements the internal `CatalogEditorialCore` read contract. The required
integration port must resolve an active actor, current tenant membership and
explicit Product-scoped read capability on every call. Null/unavailable/denied
or differently qualified snapshots fail closed before Product/state lookup.
No production authority provider or verified actor transport is wired yet.

The adapter uses tenant-qualified parameterized Prisma queries in a repeatable-read
transaction. Missing Products fail `NOT_FOUND`; authorized Products without state
return `{ cycle: null, draft: null, published: null }` without creating anything.
Persisted cycles survive absent Drafts. Reads project Draft/Published independently
and never copy operational names, modify Products, or write revisions/receipts.
Stored documents belong to the validated editorial persistence contract; read does
not run publish completeness checks or revalidate against changing definitions.

The additive migration declares a unique tenant/Product state, composite Product
FK and positive cycle/consistent nullable revision-document checks. It has only
been exercised on synthetic prerequisite Product tables in a fresh schema within
the exact authorized disposable PostgreSQL instance—not an existing database or
full application migration history. No Prisma CLI/client generation is needed:
the adapter uses Prisma's parameterized SQL API. The runner explicitly disables
Prisma 6 generated-client dotenv paths and never uses ambient database URLs.

```sh
pnpm exec jest --config jest.config.js --runInBand --no-cache --runTestsByPath prisma/catalog-editorial-schema.spec.ts src/catalog-editorial/infrastructure/catalog-editorial-core.spec.ts
CATALOG_EDITORIAL_TEST_CONTAINER=2c90b3e3bdd23cdc367d95c68cf7ba30e169b6e552d96287558cf33d3aa2ab8c pnpm exec jest --config src/catalog-editorial/infrastructure/isolated-postgres.config.cjs --runInBand --no-cache
```

The isolated runner refuses an absent/different container selection, verifies the
pinned name/image/isolation/database, keeps credentials in memory and leaves its
synthetic schemas for parent-owned container cleanup. Normal unit discovery skips
that DB spec unless explicitly selected by the container environment variable.

Lifecycle transitions remain pending. No retention/expiry/cleanup is implemented or
approved; no 24-hour claim applies. Future integration still needs authoritative
permissions, definitions, private assets, verified actor transport and routes.
C3.1 and integrated read/create/save remain open.

B1 rollback boundary: the new read contract/adapter/tests/runner and additive state
artifact, plus its Product inverse/composite unique declaration. No public consumer
or shared runtime helper changed. Once committed, B1's migration stays immutable;
B2 must use a separate additive artifact.

## Atomic create (B2)

`create(context, { expectedCycle, idempotencyKey, document })` uses a separate,
required create-authority port (third constructor argument). Missing authority
fails closed; read capability never implies create. Every attempt, including
replay, resolves active membership, explicit create capability and tenant/Product
qualified definitions/private asset authority, then reuses `validateDocument`.
The request is captured before awaiting; incomplete content is accepted.

A tenant-qualified Product row lock serializes initially absent state and receipts
under read-committed isolation. Expected cycle is null only for untouched state;
otherwise it must equal the durable consumed cycle. An active Draft conflicts.
Creation increments cycle, starts revision 1 and captures Published's revision as
base without modifying Published or any operational Product fields.

The separate additive receipt migration stores request/result atomically with the
Draft. Keys are scoped to tenant, Product, actor and create operation (dedicated
table). JSONB request equality ignores object-key order but preserves array order.
Changed content/cycle under the same key conflicts. A matching receipt returns the
original result, not current state; it never recreates a consumed Draft. Rejected
attempts leave state, receipts and counters unchanged. Receipts have no expiry.

PostgreSQL tests cover duplicate/competing transactions, rollback on receipt
failure, scoped keys, replay authorization/reference revocation and consumed-cycle
anti-ABA. Consumed states are synthetic fixtures, not publish/discard endpoints.
The replacement runner pins the authorized ID/name and checks Docker 29's empty
Mounts plus exact tmpfs configuration, no binds/mounts/ports and actual tmpfs.
B2 rollback boundary: create port/method/tests and receipt schema/migration only;
retain B1 state/read. No transport, authority provider or public activation exists.

## Atomic save (C)

`save(context, { expectedCycle, expectedRevision, idempotencyKey, document })`
requires a separate fourth constructor port with explicit `canSave`; no inherited grants.
Current membership, scope and document references are checked before every replay.
Under the same Product lock, cycle/revision CAS must update exactly one active Draft.
Success increments revision once, preserving cycle, base, Published and operational fields.
Separate save receipts scope keys by tenant/Product/actor/operation, never create keys.
Replay compares both expectations and content, returns the original result and never writes.
Receipt failure rolls back the update; overflow/stale/consumed states reject unchanged.
C rollback: remove save port/method/tests and additive save receipt artifact; retain A/B1/B2.
