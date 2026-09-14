# Apply Progress — preserve-tenant-transaction-scope

Cumulative log. WU1 executed on branch `feat/protect-confirmed-sales-07a-tenant-transaction-scope`. WU2 not started (explicitly out of this run's scope).

## WU1 — Service provenance change + unit evidence (COMPLETE)

### Behavior-first TDD cycle (config tdd=false; TDD ran per parent instruction)

| #   | Step                                                                             | Evidence                                                                                                         |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Baseline (pre-change)                                                            | `pnpm test -- src/shared/prisma/tenant-prisma.service.spec.ts` → **4 passed / 4 total** (old combined-mock spec) |
| 2   | RED — new spec with distinct raw/extended mocks + mocked `tenant-prisma.factory` | `pnpm test -- src/shared/prisma/tenant-prisma.service.spec.ts` → **6 failed, 5 passed, 11 total**                |
| 3   | GREEN — production switch in `runInTransaction()`                                | same command → **11 passed / 11 total**                                                                          |
| 4   | Regression                                                                       | `pnpm test` → **237 suites passed, 3620 tests passed**                                                           |
| 5   | Build                                                                            | `pnpm build` (nest build) → exit 0                                                                               |
| 6   | Lint (touched files)                                                             | `npx eslint src/shared/prisma/tenant-prisma.service.ts src/shared/prisma/tenant-prisma.service.spec.ts` → clean  |

### New failing evidence (failed before the production change, pass after — 6 tests)

- `TenantPrismaService › starts the outer transaction on the tenant-extended root and exposes its ambient client` (R-EXT-ROOT, R-IDENTITY-OUTER; pins `extendedRoot.$transaction` ×1, `rawBase.$transaction` never called, `createTenantScopedPrisma` ×1)
- `TenantPrismaService › reuses the same transaction client for nested runInTransaction calls across one outer $transaction` (R-NESTED-1TX, R-IDENTITY-NESTED, R-NESTED-SLOT-OK; factory called exactly once across outer + nested)
- `TenantPrismaService.runInTransaction restoration › stores the ambient tx in CLS and restores the prior (undefined) slot on the success path` (R-RESTORE-OK; pre-change failure mode: CLS set observed `rawTx` instead of `extendedTx`)
- `... restoration › restores the prior CLS slot and rethrows the original error when work throws synchronously` (R-RESTORE-THROW)
- `... restoration › restores the prior CLS slot and propagates the rejection when work returns a rejected promise` (R-RESTORE-REJECT)
- `TenantPrismaService.runInTransaction nested failure › keeps the outer slot on the ambient tx after a nested throw, then restores the outer slot` (R-NESTED-SLOT-FAIL + outer propagation + final restore)

### New baseline coverage (pins invariants; passed before and after the change — 5 tests)

- `TenantPrismaService.getClient outside transaction › returns a tenant-extended client, not the raw PrismaService` (R-OUTSIDE-EXTENDED; also pins `createTenantScopedPrisma(this.prisma, this.cls)` argument identity)
- `TenantPrismaService.runInTransaction result/error forwarding › resolves to the exact value returned by work` (R-RESULT-FWD, `Symbol` sentinel by reference)
- `... forwarding › rethrows the exact error instance thrown by work` (R-ERROR-PROP, same `SentinelError` instance + message)
- `TenantPrismaService.isInTransaction › returns false when no CLS tx client is active` (pre-existing, retained)
- `TenantPrismaService.isInTransaction › returns true while inside runInTransaction` (pre-existing, retained as regression baseline)

### R-NO-EXTENDS-PROOF

No test asserts `'$extends' in tx`. Provenance is established by mock-factory indirection: the raw base and extended root are distinct objects with distinct `$transaction` mocks, and the callback tx identity (`extendedTx`) can only originate from the extended root's `$transaction`.

### Files changed

- `src/shared/prisma/tenant-prisma.service.ts` — 2 A / 1 D: `runInTransaction` now constructs `const extendedRoot = createTenantScopedPrisma(this.prisma, this.cls);` once and calls `extendedRoot.$transaction(async (tx) => {...})`. Prior-slot capture, nested early return (`if (previousClient) return work();`), `try`/`finally` CLS restoration, and error/rejection propagation untouched. `getClient()`, `isInTransaction()`, `getTenantId()`, type aliases unchanged.
- `src/shared/prisma/tenant-prisma.service.spec.ts` — rewritten per WU1 RED tasks: `jest.mock('./tenant-prisma.factory')`, distinct `rawBase` (working `$transaction` so pre-fix behavior stays exercisable) vs `extendedRoot` mocks, `SentinelError`, five new describe blocks; existing `isInTransaction` block retained as regression baseline.

### Authored line count (A+D)

`git diff --numstat` + untracked count (complete candidate, verified after the verifier-ordered SAFETY-comment removal): service **2 A / 1 D**; spec 212 A / 83 D; `tasks.md` 10 A / 10 D; untracked `apply-progress.md` 70 A / 0 D (this file, 70 lines). **Complete-candidate A+D = 388** (≤ 400 budget; no `size:exception`). Source diff is **2 A / 1 D** in `tenant-prisma.service.ts` (the single `runInTransaction` provenance switch). WU2 will be a separate child branch per the confirmed feature-branch-chain.

### Runtime harness

N/A for WU1 — unit-level boundary only; real PostgreSQL service-bound evidence is WU2 (`tenant-prisma.service.integration.spec.ts`, not created in this run).

### Rollback boundary

Revert the `runInTransaction` extended-root switch in `src/shared/prisma/tenant-prisma.service.ts` and the unit-spec changes in `src/shared/prisma/tenant-prisma.service.spec.ts`. Factory, allowlist, schema, consumers, and WU2 artifacts are untouched.

### Deviations / notes

- Test callbacks that only perform synchronous statements are non-`async` arrow functions returning `Promise.resolve()` to satisfy `@typescript-eslint/require-await`; semantics unchanged.
- `makeCls` now returns `{ cls, getSpy, setSpy }` so tests can pin CLS `set` calls (`toHaveBeenCalledWith('prismaTxClient', extendedTx)` / `toHaveBeenLastCalledWith('prismaTxClient', undefined)`) without the `unbound-method` lint error; the two `isInTransaction` baseline tests were minimally adapted to this helper. Assertions unchanged.
- pi-lens flags `tenant-prisma.service.ts` L11 (type-alias `Parameters<>` inference heuristic; real `tsc --noEmit` reports zero errors in this file) and L29 (pre-existing `as unknown as TenantPrismaClient` cast in `getClient()`, byte-identical to HEAD, covered by a pre-existing `eslint-disable` for the project rule). During apply a 3-line `SAFETY:` comment was added above the L29 cast; the independent verifier's exact correction then ordered its removal so `getClient()` is byte-identical to HEAD — removal was applied and verified by byte-level diff (`diff` of the `getClient()` region against `git show HEAD`). Both pi-lens findings remain pre-existing, unmodified, and outside WU1's single-production-change boundary; they are reported here instead of being "fixed" out of scope.
- No commits, pushes, PRs, or `sdd-attempt` acquire/settle calls were made (parent explicitly prohibited them; the pre-existing active attempt token `sha256:0b86a2…` was left untouched).

### Remaining tasks

- WU2 (9 unchecked tasks, lines 126–134 of `tasks.md`): new `src/shared/prisma/tenant-prisma.service.integration.spec.ts` — PostgreSQL service-bound isolation and persistence evidence (R-PG-\*). Requires `pnpm run test:db:up` + `.env.test`; child branch based on WU1.
- Downstream: WU7 dependency-line update in `protect-confirmed-sales` only after WU1 + WU2 land AND PostgreSQL evidence verifies (do not preempt).

## Structured status consumed

- `gentle-ai.sdd-status` v2 consumed from parent: change `preserve-tenant-transaction-scope`, `applyState: ready`, `mode: repo-local`, `allowedEditRoots: [workspace root]`. No `actionContext` warnings. Verify remains `blocked` until WU2 completes.

## WU2 — Real PostgreSQL service-bound integration evidence (COMPLETE; compacted)

New untracked `src/shared/prisma/tenant-prisma.service.integration.spec.ts` (**230 lines** after remediation compaction; originally 298). Production, factory, allowlist, schema, migrations, sales consumers, WU7/WU8 untouched. No commits/pushes/PRs; no settle (active attempt tokens `sha256:7c86d6…`, then `sha256:710694…` continued via acquire — parent owns settle).

- **RED (historical; detached worktree at `e44e49e`, WU1 parent, symlinked node_modules + copied `.env.test`):** `pnpm test:integration -- src/shared/prisma/tenant-prisma.service.integration.spec.ts` → 6 failed / 2 passed / 8 — proposal success criteria 1–6 fail on raw provenance exactly as predicted (R-PG-READ-OUTER, R-PG-UPDATE-P2025, R-PG-DELETE-P2025, R-PG-CREATE-OVERRIDE-OUTER, R-PG-NESTED-READ, R-PG-CREATE-OVERRIDE-NESTED); allowlist gate + own-tenant read are both-states baselines.
- **GREEN (b5bee5c):** 8/8 (~1.3 s), no code change needed — acceptance evidence for the WU1 switch, covering R-PG-READ-OUTER, the own-read baseline, R-PG-UPDATE-P2025/-UNCHANGED + R-PG-RELOAD-ROLLBACK, R-PG-DELETE-P2025/-UNCHANGED, R-PG-CREATE-OVERRIDE-OUTER/-NESTED + R-PG-RELOAD-COMMIT, R-PG-NESTED-READ, and the allowlist gate.
- **Harness:** `.env.test` (gitignored, `nest-practice-test:5433`), container reused, migrations 44/44; real service + factory + PostgreSQL per scenario; unscoped assertions via `integrationPrisma()`; harness `PrismaClient` grafted onto `PrismaService.prototype` (no behavior mocked); Map-backed CLS shim with `isSuperAdmin: false` pinned. At-WU2-time TRIANGULATE: tenant-isolation 7/7; `SKIP_DB_INTEGRATION=1 npx jest --config jest.config.js src/shared/prisma/` 16/16; unit config structurally excludes `*.integration.spec.ts`. Transaction cardinality is owned by WU1 U2's root call-count test — no row-count inference here.

## Bounded remediation — failed evidence sha256:2ad47c2a226ddc6afed4f49b46b4eacc24e06c523bfd951290f08b86cb142216 (supersedes the earlier remaining-task/status notes)

Parent-authorized; five prior blockers addressed; no service/factory/schema/migrations/sales/WU7/WU8/test-config/`.env.test` edits; no settle (parent verifies and settles with `--remediates-evidence-revision` on PASS only).

- **Spec:** raw-SQL and direct-consumer/background-poller clauses de-normativized (27 → 22 scenarios); retained as static non-goals forbidding runtime coverage for them.
- **WU7 gate:** `protect-confirmed-sales/tasks.md` WU7 `Depends on:` now names the prerequisite (WU1+WU2 verified AND locally committed before implementation) and states it is NOT yet satisfied.
- **P7:** nested scenario proves foreign read `null` + callback-client identity (nested `getClient()` === outer callback client) + unchanged A-owned reload; the Product row-count cardinality claim is removed; eight tests and all security assertions preserved.
- **Gates:** focused WU2 (8/8) + adjacent tenant-isolation (7/7) are the required gates; full integration is attribution only — known baseline failures are warnings, not candidate regressions; `.env.test` dotenv `override: true` defeats shell-only `SKIP_DB_INTEGRATION=1`, so skip proof must use effective config.
- **Commands:** focused WU2 0/**8 passed**; tenant-isolation 0/**7 passed**; WU1 unit 0/**11 passed**; `pnpm build` 0; `git diff --check` clean; full `pnpm test:integration` 1 (35–48 failed / 2 skipped, varying suites — attribution only); WU1-equivalent baseline 1 (5 failed suites, 45 failed / 2 skipped / 124 passed); one `P1001` transient (same class as prior C1) cleared on retry — diagnosed only, no Docker/`.env.test` change.
- **Attribution:** `git diff b5bee5c -- src prisma test package.json pnpm-lock.yaml jest.config.js jest.integration.config.js` is empty; `employees.batch-status`, `pdf-generation`, `category-brand-promo-targeting`, `promotions.batch-delete` (+ `variant-level-promo-targeting`) reproduce on the baseline; `buy-x-get-y` and `catalog-settings replace.rollback` fail only intermittently in serial candidate runs while the baseline spec differs — warnings, not candidate regressions.
- **Remediation A+D:** **316** complete candidate ≤ 330 before the final report, ≤ 400 report-inclusive; no `size:exception` — integration spec 230 A (untracked); this change's tasks 9 A / 9 D; apply-progress 21 A / 0 D (HEAD byte-identical + this appended section); `specs/shared-prisma/spec.md` 5 A / 40 D; downstream WU7 line 1 A / 1 D. Verify-report is excluded from the pre-report candidate and counted report-inclusive.
- **Pending:** fresh independent verification (parent-owned) over this candidate; WU2 local commit still required before `protect-confirmed-sales` WU7 unblocks.

## WU2 remediation continuation — candidate validation

- **Preservation / RED lineage:** re-read all selected artifacts and authorized candidate files; retained the inherited correction and stale FAIL report unchanged. Evidence remains bound to `sha256:2ad47c2a226ddc6afed4f49b46b4eacc24e06c523bfd951290f08b86cb142216` and its historical 6-failed/2-passed PostgreSQL RED.
- **GREEN:** exact focused unit command passed 11/11; exact focused PostgreSQL command passed 8/8. The separately executed runtime-harness slot also passed 8/8 against PostgreSQL with 44/44 migrations applied.
- **TRIANGULATE:** adjacent tenant-isolation passed 7/7; `pnpm build` exited 0; `git diff --check` was clean. `git status --short` preserved the four inherited tracked modifications plus the untracked stale report and WU2 integration spec.
- **REFACTOR / rollback:** no remaining gap or gratuitous correction was proven. The exact rollback inspection `git diff --check && git status --short` passed before this log append; rollback remains limited to any newly authorized correction, of which there was none.
- **Budget / authority:** `git diff --numstat` reported tracked 36 A / 50 D; with the 230-line untracked integration spec, the pre-log candidate was 316 A+D and report-inclusive 345 A+D. No production behavior, report, sales implementation, attempt state, delivery, or archive operation was changed.
