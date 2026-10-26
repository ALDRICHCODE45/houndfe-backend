# Catalog editorial core — unactivated

This is a callable internal contract, **not a deployable API**. No route,
controller or module registration exists. A callable Prisma capability/read
authority is available but is not registered in runtime wiring. Verified transport,
document-authority integration and C3.1 remain pending.

Current internal `save`, legacy `create` archive restrictions, and explicit
`initialize(context, {expectedCycle, idempotencyKey})` are documented in
[catalog-editorial-d16.md](catalog-editorial-d16.md). Initialization derives only
persisted Published or empty content and uses the guarded create-authority port.
The historical slices below retain their original evidence and rollback boundaries.

## Permission provisioning (P1)

`src/catalog-editorial/domain/editorial-permissions.ts` exports
`EDITORIAL_PERMISSIONS.read` (`read:ProductEditorialDraft`) and
`EDITORIAL_PERMISSIONS.update` (`update:ProductEditorialDraft`), plus the exact
row-matching `isEditorialPermission` predicate. Only these two identities are
registered. The standalone seed uses this predicate to skip their automatic
SuperAdmin grants; all other autogrants and Manager/Cashier lists stay unchanged.
Bootstrap upserts the rows but still links only `manage:all`. Neither path removes
existing grants. These checks are mocked/in-memory, not real seed/DB execution.

Provisioning is **not effective authorization**. Global CASL still expands wildcard
permissions; do not enable editorial UI with generic `userCan`. P1 alone does not
provide capability enforcement. Definitions/private-media DocumentAuthority
providers, verified transport and integrated writes remain pending. P1 rollback
removes these two registry rows, helper, exclusion and their tests/docs, without
deleting DB grants.

## Current capability/read authority (P2a; internal only)

`infrastructure/prisma-editorial-authority.ts` exports `PrismaEditorialAuthority`
and `EditorialCapabilitySnapshot`. Construct with the root Prisma client:
`const authority = new PrismaEditorialAuthority(prisma)`, then explicitly pass it
to `new PrismaCatalogEditorial(prisma, authority)` for the existing read port.
Nothing registers this wiring automatically. `resolve(context: EditorialContext)`
returns `Promise<EditorialCapabilitySnapshot | null>`; the snapshot contains only
`actorId`, `tenantId`, `productId`, `activeMember`, `canRead`, `canCreate`, `canSave`.

Each resolution copies scope before awaiting and freshly queries `User.isActive`,
current tenant membership roles/permission rows and tenant-qualified Product.
Missing/inactive/misqualified/unavailable dependencies return null. Membership
without grants returns a qualified snapshot with all capabilities false. Exact
`read:ProductEditorialDraft` enables `canRead`; `canCreate`/`canSave` require both
current explicit read and update (P2b human-approved disclosure policy). Update
alone never implies read or executable writes. Roles union; wildcard/manage grants
and caller admin/authority flags never qualify. This is editorial scope, not generic
operational Product auth.

The snapshot is a current-resolution observation, not a reusable authorization
lease, HTTP DTO, verified JWT/transport context or DocumentAuthority. Callers must
supply trusted principal scope internally; body IDs/flags are not authenticated by
this class. Subsequent calls revalidate revocation; sequential queries do not
promise atomic in-flight revocation. Resolving capabilities alone invokes no
definitions/media provider and does not establish write/document authority.

Evidence is mocked/in-memory only, including read-through-core revalidation; no
fresh PostgreSQL proof or public activation. P2a rollback removes this adapter,
its tests and this documentation, retaining P1 identities and existing core ports.

## Guarded create/save ports (P2b; internal only)

The same adapter exports `EditorialDocumentAuthorityProvider` with
`resolve(context: EditorialContext): Promise<DocumentAuthority | null>`.
A genuinely authoritative implementation must supply current tenant/Product
qualified definitions, variants and private asset references. No production
implementation, private-media bytes access or definition source is supplied here.

Explicit integration wiring (not runtime registration):

```ts
const authority = new PrismaEditorialAuthority(
  prisma,
  documentAuthorityProvider,
);
const core = new PrismaCatalogEditorial(
  prisma,
  authority,
  authority.createAuthority,
  authority.saveAuthority,
);
```

`createAuthority: EditorialCreateAuthority` and `saveAuthority: EditorialSaveAuthority`
freshly resolve active membership/Product and **both explicit read+update** before
each attempt/replay. Missing/null/unavailable/misqualified document providers deny.
Scope is copied before awaiting and provider results are deep-cloned before
qualification checks, isolating provider-owned objects and allowlists. The existing
core validates current document references before receipts; success/replay may
return full Draft/Published content only after these checks. Revoking either
permission denies before receipt/state/write access. Capability flags alone do not
mean the provider exists or that a write API is usable.

Raw core ports remain trusted injected authorities: arbitrary custom write ports
can bypass the adapter's read+update policy. Production integration must inject
these guarded adapters, never expose caller-selected authority or use raw core as
an HTTP security boundary. Transport, real definitions/private-media providers,
media-byte authorization and runtime wiring remain separate gates. New evidence
is mocked/in-memory, not fresh PostgreSQL execution. P2b rollback removes write
ports/provider contract/tests and reverts its derived-capability policy change;
P1/P2a remain independent historical units.

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
access-control boundary. Definitions, private media and runtime authority wiring
are still missing; existing public upload paths are not assets.

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
The P2a authority can now supply this port explicitly; no verified actor transport
or production runtime wiring exists yet.

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
Draft. Keys are scoped to tenant, Product and actor in the create receipt table.
D16 initialization shares this key namespace with operation-tagged request JSON;
cross-method reuse conflicts. Legacy request JSON remains unchanged.
JSONB request equality ignores object-key order but preserves array order.
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
