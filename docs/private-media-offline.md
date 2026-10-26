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

## Evidence boundaries

- SDK transport tests must remain simulated; no DigitalOcean request is authorized.
- Harness lifecycle checks are not private-asset FK/CHECK or application-authorization proof; those require their own subsequent tests.
- Real private upload, authorized retrieval, anonymous denial and destination policy verification remain pending until a concrete Space is configured and separately authorized.
