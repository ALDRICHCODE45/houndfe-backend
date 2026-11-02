# Local editorial vocabulary repair

Follow-up to T56 in `editorial-production-vocabulary.md`; root development database only.
Deliver bounded work units; preserve unrelated CORS and isolated habitat changes.

## Specs

S1. Human authorization: "1. adelante con tu recomendacion, solo recuerda que nada de lo que tengamos en esta base de datos son datos reales, no importa si los borramos todos, no hay necesidad de tener "miedo" a perder datos."
S2. Approved contract remains S35 and the existing production manifest; no dual-contract runtime fallback.

## Tasks

- L1 [in_progress] S1–S2 — inline: pure canonical storage projection, explicit identities, round-trip tests and documentation; commit pending; forecast 280–390 lines including tracking.
- L2 [pending] S1–S2 — inline after L1: bounded transactional local apply with pending starter normalization and isolated functional proof; scope/line forecast after L1.
- L3 [pending] S1–S2 — parent operation: verify local target, recoverable backup and isolated restoration, apply, then authenticated vocabulary/state/context checks; no production deployment.

## Log

- Original request: "1. adelante con tu recomendacion, solo recuerda que nada de lo que tengamos en esta base de datos son datos reales, no importa si los borramos todos, no hay necesidad de tener "miedo" a perder datos."
- Read-only explorer mvyhubhw-29-q6ct found no complete canonical loader in inspected paths. Existing pending policies permit same-contract starter normalization; do not infer saved documents are recognizable.
- Parent confirmed stored-row materializers and snapshot shape; pure planner is not an executable apply batch. L1 will not merge existing metadata or connect to a database: callers supply complete compatible identities, and later apply must preserve customizations separately.
- Backup tools available inside PostgreSQL17 container, not on host. No backup or database mutation has occurred. Habitat independent execution remains separately unavailable; CORS34-line delta remains uncommitted.

- L1 evidence: RED9 failures with inert projection, then GREEN9; initial lint reported two unused destructurings, corrected with explicit fields; final focused/lint/format/diff checks exit0. LSP no TypeScript errors, four auxiliary hints/warnings. Full offline suite job92 passed (12589 tests, 58 skipped, 502 suites, exit0); isolated TypeScript build job93 passed (exit0, 22s). Build output stays under `.tmp/vocabulary-repair-proof/`, not live `dist`.
- L1 Risk: none (new pure internal helper; no existing callers, shared implementation changes or database writes). No differential check applicable. Rollback boundary: only the new rows helper/spec and its documentation. Functional checks complete. Initial native assessment unavailable because unrelated untracked files need declaration; no native approval claimed. Commit pending, followed by committed-only assessment.
