# Agent instructions

## Running tests

Always run tests through the project's test scripts (`pnpm test`, `make test`, etc.), never by invoking the runner binary directly (`npx vitest`, `go test`, `pytest`), so the machine-wide `run-tests` queue applies. Subagents run only the tests related to the files they changed (for example `vitest related`, `jest --findRelatedTests`, `go test ./changed/pkg/...`, `pytest path/to/test`), passing them through the project script. Only the main agent runs the full suite, once, before finishing. If you see `[run-tests] waiting`, the suite is queued, not hung: wait for it and do not kill or retry it.

In this repository (Jest):

| Purpose | Command |
| --- | --- |
| Offline unit suite (full) | `pnpm test` |
| Focused unit tests | `pnpm test src/path/to/file.spec.ts` or `pnpm test --findRelatedTests src/path/to/changed.ts` |
| PostgreSQL integration specs | `pnpm test:integration src/path/to/file.integration.spec.ts` |
| Live specs (operator-owned binding) | `pnpm test:live <path>` |
| Coverage | `pnpm test:cov` |

`pnpm test:watch` and `pnpm test:debug` are interactive and are not routed through the queue; do not use them from agents.
