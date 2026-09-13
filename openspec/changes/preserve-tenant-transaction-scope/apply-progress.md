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
