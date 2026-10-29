# Isolated editorial PostgreSQL proof

T3c S22/S24 delivery 1 supplies test-only PostgreSQL 16 lifecycle support. It does not implement the snapshot adapter, migrations, transport, or historical-data admission.

## Run explicitly

From the repository root (Docker must already be available):

```bash
RUN_EDITORIAL_POSTGRES_PROOF=1 node_modules/.bin/jest --config '{"rootDir":".","roots":["<rootDir>/src/catalog-editorial/infrastructure/test-support"],"testEnvironment":"node","transform":{"^.+\\.tsx?$":["ts-jest",{"diagnostics":false}]}}' --runInBand --no-cache --runTestsByPath src/catalog-editorial/infrastructure/test-support/editorial-vocabulary-postgres.integration.spec.ts
```

Without the opt-in variable, real tests are skipped and do not launch Docker. For deterministic tests, use the same command without the variable and with `editorial-vocabulary-postgres.spec.ts` instead. Inline configuration deliberately excludes repository ambient integration/database hooks.

## Safety and lifecycle

- UUID name and matching ownership label per invocation; cleanup addresses only its recorded container ID. A failed create is inspected by exact name and reclaimed only with its matching label.
- No host mounts, ports, database URL, Prisma connection, or inherited database environment. Data lives in tmpfs; networking is disabled. Docker may download `postgres:16`.
- Create timeout: 120 seconds; other commands: 10 seconds; readiness: at most 30 one-second commands separated by 100 ms. Loopback readiness excludes the image's temporary socket-only initialization server.
- `sql()` sends SQL on stdin to `docker exec -i ... psql -X -v ON_ERROR_STOP=1`. It is valid only during the callback; callers must await all work before returning.
- Success, callback failure, and setup failure all attempt removal and then verify absence. Cleanup failure rejects success; an original failure retains precedence, with `cleanupError` attached when possible.
- Process termination or daemon failure cannot guarantee cleanup. An ambiguous create whose ownership cannot be inspected is never removed speculatively. There is no broad cleanup or Docker-unavailable retry/escalation.

## Observed evidence

- Deterministic RED: 7 failures/2 passes against the stub; GREEN: 9 passes. Mock failure coverage includes startup/readiness exhaustion, partial creation, callback failure, cleanup failure, and surviving-container detection.
- First real SQL run exposed temporary-server readiness; loopback regression RED: 1 failure/8 passes, then GREEN: 9 passes.
- Real GREEN: table creation, insert/select and PostgreSQL 16 version check, plus forced post-start setup failure. Both containers were independently verified absent after cleanup; tests print their full IDs.
- Normal SQL container: `21793ea7d9bc35950fb66ec19afe4e617fe2e2a610cf64a7267e5b01b069116f`.
- Forced setup-failure container: `cc23fb7ff0b47d6477c8aa10181679d07ffec9e3ab8db74aec2febe109708377`.

## Next delivery

Implement the single-statement raw snapshot adapter and complete fixtures/preservation proof separately. These lifecycle checks prove neither loader coverage nor Prisma client decoding nor that current schema accepts historical simulated values.
