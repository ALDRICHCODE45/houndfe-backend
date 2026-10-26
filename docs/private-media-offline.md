# Offline private media

The approved scope is an internal private-media flow, separate from legacy public files. It does not activate HTTP, configure a real Space, or establish production readiness.

## Isolated PostgreSQL proof

Use only the explicitly authorized disposable target recorded in `odd/tasks/private-media-offline.md`. Readiness alone does not prove persistence constraints.

```sh
NODE_BIN="$(command -v node)"
env -i PATH=/usr/bin:/bin NODE_ENV=test FORCE_COLOR=0 "$NODE_BIN" \
  node_modules/jest/bin/jest.js --config src/private-media/infrastructure/private-media-postgres.config.cjs --runInBand
```

The clean child receives only the explicitly supplied non-secret test environment; dependencies must not inherit host credentials or configuration. Prisma dotenv loading must also be disabled.

The dedicated harness must admit the pinned container identity and isolation settings before constructing clients. It uses explicit synthetic connection settings, not `.env`, ambient database URLs, or the application's integration setup. Each invocation owns a fresh schema and two independent clients; cleanup is limited to that schema.

A retired or mismatched target must fail closed. Never replace its ID or reconnect to an existing database to make tests pass. Container creation and exact-ID removal belong to the separately authorized lifecycle, not the test helper.

## Private asset persistence

`PrivateMediaAsset` links an opaque asset ID and internal storage key to a tenant-qualified Product, separately from `FileObject` and `ProductImage`. `PrivateMediaMetadata` omits the storage key; neither shape adds a public URL.

- The composite Product foreign key rejects missing and cross-tenant links; storage keys are globally unique.
- Required metadata permits exactly `image/jpeg`, `image/png`, or `image/webp`, with an integer size from 1 through 10,485,760 bytes. SQL CHECK constraints live in the additive migration.
- Linked Product deletion is restricted; a Product without private assets remains deletable under this constraint. This cut adds no asset deletion or garbage collection API.

Run schema alignment and actual SQL constraint tests only against the admitted disposable target:

```sh
NODE_BIN="$(command -v node)"
env -i PATH=/usr/bin:/bin NODE_ENV=test FORCE_COLOR=0 "$NODE_BIN" \
  node_modules/jest/bin/jest.js --config src/private-media/infrastructure/private-media-schema.config.cjs --runInBand
```

These tests apply the new migration to a minimal synthetic schema, not to a deployment database. They do not validate decoded image content or the full application schema with Prisma's schema engine.

## Evidence boundaries

- SDK transport tests must remain simulated; no DigitalOcean request is authorized.
- Harness lifecycle and asset metadata constraint checks are separate suites. Neither establishes current application authorization or storage privacy.
- Real private upload, authorized retrieval, anonymous denial and destination policy verification remain pending until a concrete Space is configured and separately authorized.
