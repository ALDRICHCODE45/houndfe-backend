# Editorial definitions — isolated persistence

D1a adds company-wide families, typed definitions and family/definition bindings.
The binding owns `product`/`sellable`; one family cannot bind the same definition
with two owners. Definition types are text, boolean, number, single and multi.
SQL CHECK constraints enforce types/owners; restrictive foreign keys prevent
cascading deletion or identity changes through references. Prisma alone cannot
represent these CHECK constraints: use the reviewed migration, not schema push.

Codes are stable identities. This unit exposes no rename/delete/write API, loads
no vocabulary and does not make arbitrary administrative SQL safe. Existing
Category, Brand, Product and Variant data are not converted. Options, archive
state and numeric units follow in D1b; an authoritative reader follows in D2.
No DocumentAuthority provider, routes, UI, media or runtime wiring is activated.
Approved copying of archived options from Published belongs to future orchestration.

## Verification

Unit/artifact checks never connect to a database:

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath prisma/catalog-editorial-definitions-schema.spec.ts src/catalog-editorial/infrastructure/definitions-postgres-runner.spec.ts
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
