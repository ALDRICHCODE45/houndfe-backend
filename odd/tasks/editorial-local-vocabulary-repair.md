# Local editorial vocabulary repair

Follow-up to T56 in `editorial-production-vocabulary.md`; root development database only.
Deliver bounded work units; preserve unrelated CORS and isolated habitat changes.

## Specs

S1. Human authorization: "1. adelante con tu recomendacion, solo recuerda que nada de lo que tengamos en esta base de datos son datos reales, no importa si los borramos todos, no hay necesidad de tener "miedo" a perder datos."
S2. Approved contract remains S35 and the existing production manifest; no dual-contract runtime fallback.

## Tasks

- L1 [done] S1–S2 — inline: pure canonical storage projection, identities, tests/docs; commit 3f24151, 259 authored lines; focused9/full12589/build/lint passed; native assessment unavailable.
- L2 [done] S1–S2 — inline after L1: bounded transactional vocabulary installer with pending starter normalization; implementation written; malformed-hash checks RED3 then GREEN3, TS lint/format passed. Owned-restoration job96 passed all five lifecycle scenarios (six TAP tests including parent): before-image rejection, default rollback, injected mid-write rollback, commit/public readback and stale reapply rejection. Documentation, broader checks and independent verification remain pending. Human authorized up to 550 authored lines for this unit (including tests/docs/tracking), then return to 400. Legacy state retirement remains a separate operation.
- L3 [done] S1–S2 — parent operation: full backup/isolated restore job94 passed; job95 confirmed archive SHA256 and identical counts/fingerprints in all 14 editorial tables; source unchanged. Artifact `.tmp/vocabulary-backup-6kgp1juf/`; owned restore `editorial_restore_c706f786859f23f5` retained.
- L4 [pending] S1–S2 — parent after L2/L3: apply and authenticate vocabulary/state/context; read-only dependency challenge mvyic5e7-2a-drx4 completed; parent confirmed four affected rows/four invalid slots, zero valid siblings, 23 scoped receipts, five live FKs and zero custom triggers. Cycle retention and a fresh-client maintenance boundary are required before scoped retirement; no production deployment.

## Log

- Human selected `allow_installer_unit_550`: "Allow up to 550 lines for this unit"; "Keep installation, rollback/conflict tests and operating instructions together. This exception applies only to this unit; later units return to 400 lines. No publishing or review consent is implied."

- Original request: "1. adelante con tu recomendacion, solo recuerda que nada de lo que tengamos en esta base de datos son datos reales, no importa si los borramos todos, no hay necesidad de tener "miedo" a perder datos."
- Read-only explorer mvyhubhw-29-q6ct found no complete canonical loader in inspected paths. Existing pending policies permit same-contract starter normalization; do not infer saved documents are recognizable.
- Parent confirmed stored-row materializers and snapshot shape; pure planner is not an executable apply batch. L1 will not merge existing metadata or connect to a database: callers supply complete compatible identities, and later apply must preserve customizations separately.
- Backup tools available inside PostgreSQL17 container, not on host. Full backup and isolated restoration subsequently completed (L3); source database remains unchanged. Habitat independent execution remains separately unavailable; CORS34-line delta remains uncommitted.

- L1 evidence: RED9 failures with inert projection, then GREEN9; initial lint reported two unused destructurings, corrected with explicit fields; final focused/lint/format/diff checks exit0. LSP no TypeScript errors, four auxiliary hints/warnings. Full offline suite job92 passed (12589 tests, 58 skipped, 502 suites, exit0); isolated TypeScript build job93 passed (exit0, 22s). Build output stays under `.tmp/vocabulary-repair-proof/`, not live `dist`.
- L1 Risk: none (new pure internal helper; no existing callers, shared implementation changes or database writes). No differential check applicable. Rollback boundary: only the new rows helper/spec and its documentation. Functional checks complete. Initial native assessment unavailable because unrelated untracked files need declaration; no native approval claimed. Delivered as 3f241519a923d1a93e678ef155ecb2f46e6aa4d2. Committed-only assessment also unavailable for the untracked-declaration reason; no native approval.

- L2 current files: `prisma/editorial-production-vocabulary-install.ts`, its `.spec.ts`, and `scripts/editorial-vocabulary-install.test.cjs`. Installer executed only against owned restored database `editorial_restore_c706f786859f23f5`; it now contains the installed vocabulary. Source database unchanged. CJS TypeScript project-service coverage is unsupported; explicit Node syntax check and JavaScript ESLint recommended rules passed without altering project configuration. Lifecycle evidence: `.tmp/vocabulary-repair-proof/install-lifecycle.log` (job96 exit0, six tests passed). No lifecycle RED was observed; those tests were authored after implementation.
- L2 Risk: item 4 (transaction locking and atomic maintenance); independent verification remains required. No source database mutations, legacy retirement, authenticated 200 or editor readiness established. FE seq33 was explicitly told runtime is not ready.

- Continuation: operating instructions added in `docs/catalog-editorial-production-install.md`; source/test/doc total 430 lines before tracking. Full offline suite and isolated build job97 passed: 12592 tests, 58 skipped, 503 suites, build exit0. LSP found no TypeScript errors (eight auxiliary hints/warnings). ASSESS escalated item4 and requires independent verification; native assessment remains unavailable due untracked declaration. Independent verifier mvyksn7c-2b-woxr is running after final parent checks. It is scoped to this new installer, with owned scratch dependencies and direct Jest execution; no worker database maintenance or source-target application. FE notified: source database unchanged, no readiness.

- L2 closure: independent verifier mvyksn7c-2b-woxr found no blocking findings for S1–S2. Owned scratch offline execution passed 12 tests/two suites and CJS syntax; PostgreSQL lifecycle log reviewed, not independently executed. Concurrent lock contention/timeouts not rehearsed. Parent repeated focused12/syntax/diff checks successfully. Source application, state retirement and browser proof remain L4, not covered by this closure. Commit pending in this work unit; 550-line exception ends with L2.
