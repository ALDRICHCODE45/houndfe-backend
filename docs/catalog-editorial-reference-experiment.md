# Editorial reference experiment: T1 harness only

Covers S1/S3/S4/S5 of `odd/tasks/editorial-reference-sql-experiment.md` within T1.
The human grant is recorded in L2; target lifecycle belongs exclusively to the parent.
No production integration, reference locks, D16/create/replay proof, or runtime readiness is claimed.

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

Resolve `node_bin=$(command -v node)` first. From this workspace, run:

```sh
env -i PATH=/usr/bin:/bin NODE_ENV=test FORCE_COLOR=0 EDITORIAL_REFERENCE_SMOKE=1 "$node_bin" node_modules/jest/bin/jest.js --config src/catalog-editorial/infrastructure/editorial-reference-experiment.config.cjs --runInBand
```

Omit `EDITORIAL_REFERENCE_SMOKE=1` for mock-only admission/lifecycle tests. Use a 30s outer
command bound; never automatically retry a timeout. The real smoke freshly admits each
invocation, verifies database/schema identity and different backend PIDs, shares a table
across clients, and verifies prior success/failure schemas absent through public SQL.
It proves neither a lock protocol nor global schema absence. Parent retains exact-target
removal/absence verification (S4/T3). T2 concurrency/cost/rollback witnesses remain pending.
Rollback boundary: remove only the four experiment runner/spec/config/doc files; no
production provider, dependency, route, database migration, or shared runtime changed.
Risk: item2 — isolation/admission remains a review boundary, not a reusable target grant.
