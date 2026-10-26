# Editorial definitions — isolated persistence

D1a adds company-wide families, typed definitions and family/definition bindings.
The binding owns `product`/`sellable`; one family cannot bind the same definition
with two owners. Definition types are text, boolean, number, single and multi.
SQL CHECK constraints enforce types/owners; restrictive foreign keys prevent
cascading deletion or identity changes through references. Prisma alone cannot
represent these CHECK constraints: use the reviewed migration, not schema push.

Codes are stable identities. This unit exposes no rename/delete/write API, loads
no vocabulary and does not make arbitrary administrative SQL safe. Existing
Category, Brand, Product and Variant data are not converted. D1b adds options
with `archivedAt`, and explicit nullable/named numeric units. D2 adds an internal
read-only source of the persisted company-wide catalogue.

Options use stable `(definitionId, code)` identities; archived rows remain stored
and reserve their codes. Only options have archive state. Composite definition/type
FKs and child CHECK constraints reject options for non-selection definitions,
units for non-numeric definitions, incompatible parent type updates and cascading
deletions. PostgreSQL **15+** is required: `UNIQUE NULLS NOT DISTINCT` permits
one null unit per definition and rejects a second, without sentinel collisions.
Prisma's nullable unique declaration cannot express that SQL detail; schema push
is not an equivalent deployment path. Empty tables mean no authorized vocabulary
has been loaded, not an editor-ready source. No current write API deletes/reuses
codes; administrative SQL outside this boundary is not protected by that policy.

These constraints do not implement D16 preservation against an authorized Draft
baseline, nor archived Published-to-Draft copying or publication eligibility.
No DocumentAuthority provider, routes, UI, media or runtime wiring is activated.
Approved copying of archived options from Published belongs to future orchestration.

## Internal authoritative reader

`PrismaEditorialDefinitions` in `infrastructure/prisma-editorial-definitions.ts`
accepts an explicitly injected Prisma query client. `read()` returns
`Promise<EditorialDefinitionsSnapshot>` (exported from
`domain/editorial-definitions.ts`): families with identity/code and
`{ definitionId, owner }` bindings, plus typed definitions with identity/code.
Number definitions include allowed `units` (including explicit null); selection
definitions include `{ code, archived }` options, including archived rows.
Unbound definitions, empty families and empty child collections remain visible.
Families/definitions/options are ordered by code, bindings by definition identity,
and units null-first then by code, using the database collation.

The single read-only SQL statement observes related data in one database snapshot.
Each call queries again; no cache/lease is implied. An observed empty database
returns `{ families: [], definitions: [] }`; connection/query failures reject,
never become empty success. There is no vocabulary fallback or automatic loading.
The snapshot is not an active-code allowlist, HTTP DTO or Product/tenant-qualified
DocumentAuthority. Callers must not wire it straight into draft validation: D16
needs authorized persisted-baseline provenance, and private-media/variant scope,
transport and current permissions remain separate integration requirements.

Tests use only PostgreSQL 16 in the authorized disposable instance. This does not
prove deployment PostgreSQL compatibility: verify PostgreSQL >=15 and reviewed
migration application before any future activation, without probing a real DB now.

## Verification

Unit/artifact checks never connect to a database:

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath prisma/catalog-editorial-definitions-schema.spec.ts src/catalog-editorial/infrastructure/definitions-postgres-runner.spec.ts src/catalog-editorial/infrastructure/prisma-editorial-definitions.spec.ts
```

The separate live suite requires the exact currently authorized disposable target:

```sh
CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER=<authorized-exact-ID> pnpm exec jest --config src/catalog-editorial/infrastructure/definitions-postgres.config.cjs --runInBand
```

The runner pins ID/name/image/database, validates tmpfs/no mounts/no published
ports, disables generated-client dotenv loading and creates a unique test schema.
It applies only definition artifacts and synthetic test records, never existing
migrations or seeds. A missing/wrong/removed target fails, without ambient fallback.
The historical core runner remains unchanged. After cleanup a future run needs a
new explicit disposable-target authorization and reviewed pin update, not a dev DB.

Rollback boundary: remove only these definition artifacts, models, dedicated tests,
runner/config and this documentation before production application. No existing DB
was migrated; no destructive production rollback command is supplied.
