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
CATALOG_EDITORIAL_TEST_CONTAINER=256a679dca7808e9ceb3f4e3e6489a56a384b5faa0f836d178040ad302b9d372 pnpm exec jest --config src/catalog-editorial/infrastructure/isolated-postgres.config.cjs --runInBand --no-cache
```

The isolated runner refuses an absent/different container selection, verifies the
pinned name/image/isolation/database, keeps credentials in memory and leaves its
synthetic schemas for parent-owned container cleanup. Normal unit discovery skips
that DB spec unless explicitly selected by the container environment variable.

Create/receipts (B2), save/CAS (C), lifecycle transitions and complete anti-ABA or
concurrency proof remain pending. No retention/expiry/cleanup is implemented or
approved; no 24-hour claim applies. Future integration still needs authoritative
permissions, definitions, private assets, verified actor transport and routes.
C3.1 and integrated read/create/save remain open.

B1 rollback boundary: the new read contract/adapter/tests/runner and additive state
artifact, plus its Product inverse/composite unique declaration. No public consumer
or shared runtime helper changed. Once committed, B1's migration stays immutable;
B2 must use a separate additive artifact.
