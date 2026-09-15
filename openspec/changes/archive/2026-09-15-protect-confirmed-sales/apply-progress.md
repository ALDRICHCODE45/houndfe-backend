# Apply Progress — Protect confirmed sales

## WU1 — Domain guards

- **Status:** WU1 completed; the change remains **not ready for verify**.
- **Completed persisted tasks:** WU1 RED, GREEN, TRIANGULATE, and REFACTOR are marked `[x]` in `tasks.md`.
- **Implementation:** made `Sale.ensureDraft()` public and made it the first statement of `addItem`, `updateItemQuantity`, `clearItems`, and `removeItem`.
- **Coverage:** table-driven rejection tests cover all eight operation/status combinations for CONFIRMED/CANCELED sales plus both empty non-DRAFT clear cases. Each verifies `SALE_NOT_DRAFT`, preserved item-array reference/length, and preserved existing item identity/quantity. Existing draft stacking and quantity tests remain green.
- **Files changed:**
  - `src/sales/domain/sale.entity.ts`
  - `src/sales/domain/sale.entity.spec.ts`
  - `openspec/changes/protect-confirmed-sales/tasks.md`
  - `openspec/changes/protect-confirmed-sales/apply-progress.md`
- **Deviation from design:** none. No service, repository, port, configuration, or test-runner changes.

## TDD Cycle Evidence

| Task            | Test file                              | Layer | Safety net     | RED                                                            | GREEN                                          | TRIANGULATE                                                                                        | REFACTOR                                                     |
| --------------- | -------------------------------------- | ----- | -------------- | -------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| WU1 RED         | `src/sales/domain/sale.entity.spec.ts` | Unit  | 111/111 passed | 10 new lifecycle cases failed as expected; 111 existing passed | 121/121 passed                                 | CONFIRMED and CANCELED cases exercise every mutation, including empty clear/reference preservation | No refactor needed; guards remain inline                     |
| WU1 GREEN       | `src/sales/domain/sale.entity.spec.ts` | Unit  | 111/111 passed | Covered by WU1 RED                                             | 121/121 passed after public guard + four calls | Confirmed all four mutation entry points and both lifecycles                                       | Inline implementation retained                               |
| WU1 TRIANGULATE | `src/sales/domain/sale.entity.spec.ts` | Unit  | 111/111 passed | Covered by WU1 RED                                             | 121/121 passed                                 | 121/121 passed in dedicated post-triangulation run                                                 | No behavior change                                           |
| WU1 REFACTOR    | `src/sales/domain/sale.entity.spec.ts` | Unit  | 111/111 passed | N/A                                                            | 121/121 passed                                 | Covered above                                                                                      | 121/121 passed in post-refactor run; no extraction warranted |

## Verification

| Command                                                                                       | Result                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm exec jest --runInBand --runTestsByPath src/sales/domain/sale.entity.spec.ts` (baseline) | passed: 111/111                                            |
| same command (RED)                                                                            | expected failure: 10 new cases failed; 111 existing passed |
| same command (GREEN)                                                                          | passed: 121/121                                            |
| same command (after TRIANGULATE/REFACTOR)                                                     | passed: 121/121                                            |
| `pnpm build`                                                                                  | passed                                                     |

- Runtime harness: N/A — this WU changes only synchronous aggregate guards; no server or background process was launched.
- Rollback boundary: remove the WU1 visibility/guard lines and the new domain-guard test block only; no WU2+ behavior is included.

## WU2 — Service lifecycle guards, recompute guard, port wiring

- **Status:** implementation tasks completed and persisted; focused remediation evidence is complete, but the change remains not ready for final verify until WU3–WU8 are complete.
- **Completed persisted tasks:** all nine WU2 task lines are marked `[x]` in `tasks.md`.
- **Implementation:** added inline `ensureDraft()` guards after ownership for add, quantity update, clear, and delete; reordered remove to missing → ownership → lifecycle; guarded recomputation before discount clearing/evaluation. Added the unused-until-WU3 `saveDraftItems` port and a Prisma delegation stub. No WU3 save-routing switch or persistence gate was made.
- **Coverage:** table-driven CONFIRMED/CANCELED service rejection coverage asserts add/quantity checks precede product/stock dependencies, clear/remove preserve items, deletion avoids repository deletion, empty clear rejects, and the typed direct recompute probe preserves discount state without evaluating promotions. Baselines cover draft deletion, invalid quantity, ownership/missing contracts, and unblocked charge/cancel/payment specialized persistence paths.
- **Remediation coverage:** pins `clearItems` missing-sale and cross-tenant no-disclosure failures, wrong-owner precedence for `clearItems` and non-DRAFT `removeItem`, and exact `BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT')` for delete/recompute guards.
- **Files changed:** `src/sales/domain/sale.repository.ts`, `src/sales/sales.service.ts`, `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/sales.service.spec.ts`, and these OpenSpec artifacts.
- **Verification:** baseline `pnpm test -- src/sales/sales.service.spec.ts` passed 239/239; RED after test addition failed as expected with 7 new failures and 247 passes; GREEN/final refactor passed 254/254; `pnpm build` passed. `git diff --check` passed. Remediation focus `pnpm exec jest src/sales/sales.service.spec.ts --runInBand` passed 258/258.
- **TDD evidence:** config has `tdd: false`; WU2 nevertheless followed its explicit RED → GREEN → TRIANGULATE → REFACTOR sequence. Triangulation uses both lifecycle statuses and specialized workflow baselines; refactor retained inline guards and the narrow `RecomputeProbe` cast (`unknown`, never `any`).
- **Deviation from design:** none. The adapter remains a delegation stub as designed; persistence validation is reserved for WU5+.
- **Rollback boundary:** remove only WU2 port/stub, service guards, and service-guard test block; keep WU1 entity guards unchanged.

## WU3 — Draft-item persistence routing

- **Status:** completed; the change remains **not ready for final verify** until WU4–WU8 are complete.
- **Completed persisted tasks:** WU3 RED, GREEN, and REFACTOR are marked `[x]` in `tasks.md`.
- **Implementation:** `addItem`, `updateItemQuantity`, `clearItems` (including empty clears), and `removeItem` now call `saleRepo.saveDraftItems(sale)`. `deleteDraft` remains on `saleRepo.delete`.
- **Coverage:** R5.1/R5.2/R5.3/R5.4/R5.6 valid-DRAFT assertions require `saveDraftItems` and reject generic `save`. Existing draft-mutation regression tests that inspect persisted aggregates now observe `saveDraftItems`; Part B assertions for R5.5/R5.7/R5.8/R5.9/R5.10 remain unchanged.
- **Files changed:** `src/sales/sales.service.ts`, `src/sales/sales.service.spec.ts`, and these OpenSpec artifacts.
- **Deviation from design:** none. The adapter remains the WU2 delegation stub; repository persistence gating is reserved for WU5+.
- **Rollback boundary:** revert the four service routing calls and their matching `saveDraftItems` test assertions/observations; retain WU1/WU2 guards and port wiring.

### TDD Cycle Evidence

| Task     | Command                                                    | Result                                                                                                                          |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| RED      | `pnpm test -- src/sales/sales.service.spec.ts --runInBand` | expected failure: 6 routing assertions failed; 252 passed (258 total) because callers still used `save`.                        |
| GREEN    | `pnpm test -- src/sales/sales.service.spec.ts --runInBand` | passed: 258/258 after all four callers moved to `saveDraftItems`.                                                               |
| REFACTOR | same focused command                                       | Part A routing checks and dependent valid-draft persistence observations use `saveDraftItems`; Part B assertions are unchanged. |

### Verification

| Command                                                            | Result                                            |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| `pnpm test -- src/sales/sales.service.spec.ts --runInBand` (RED)   | expected failure: 6 failed, 252 passed, 258 total |
| `pnpm test -- src/sales/sales.service.spec.ts --runInBand` (GREEN) | passed: 258/258                                   |
| `pnpm build`                                                       | passed                                            |
| `git diff --check`                                                 | passed                                            |

- Runtime harness: N/A — no server or background process was launched; the parent owns the already-acquired WU3 attempt and settlement.

## Workload / action context

- Consumed authoritative status: `applyState: ready`, repo-local workspace, allowed root `/home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend`.
- Parent resolved the delivery path as `feature-branch-chain`; WU3 is the current uncommitted child-branch boundary (`feat/protect-confirmed-sales-03-save-routing`) based on clean commit `a470dc6`. No commit, push, PR, native acquire/settle/review, or WU4+ work occurred.
- The supplied authoritative status was `applyState: ready`, repo-local workspace, and the allowed root matched every edited file. No action-context warning applies.
- Parent owns the active attempt and settlement; no token or counter is recorded here.
- **Remediation correction:** the prior claim that 285 unsafe-`any` diagnostics blocked WU2 is withdrawn: no explicitly authorized diagnostic reproduced it. This remediation adds focused, behavior-pinning service evidence only; it does not authorize WU3.

## WU8 — atomic draft-delete guard (completed)

- **Status:** WU8 completed and committed as `feat(sales): protect atomic draft deletion` on commit `3d8701a` (branch `feat/protect-confirmed-sales-07b-tenant-transaction-integration`). All 39 task rows in `tasks.md` are reconciled `[x]`.
- **Origin — manual generic fallback:** this unit was executed through the manual generic fallback, not a native SDD apply attempt. Gentle AI issue #4610 makes the native v2 status contract unusable, and this record claims no native SDD apply attempt or native v2 status authority; #4610 remains the reason for the fallback.
- **Implementation:** `PrismaSaleRepository.delete(id)` now runs inside `TenantPrismaService.runInTransaction()`: tenant-qualified parameterized parent-sale `FOR UPDATE` lock, tenant-scoped `findUniqueOrThrow` rereading `{ id, tenantId, status, items }`, `SALE_NOT_DRAFT` rejection for non-DRAFT rows with no delete call, and `prisma.sale.delete({ where: { id } })` for eligible DRAFT rows inside the same transaction. Missing and cross-tenant cases surface Prisma `P2025` from the tenant-scoped `findUniqueOrThrow` before any delete attempt; the six specialized contracts keep their existing code paths unchanged.
- **Historical accepted evidence (recorded as accepted):** 197 unit tests PASS; 6 real PostgreSQL integration tests PASS; `pnpm build` PASS; `git diff --check` PASS; independent verification PASS; ordinary native review `review-c72d07af478f6c44` approved and acknowledged.
- **PostgreSQL integration evidence (separate tests):** lock-wait evidence (`delete waits for the tenant-qualified parent lock before proceeding`) and DRAFT cascade evidence (`deletes an eligible DRAFT and cascades persisted items`) are distinct tests; the suite also covers post-lock `CONFIRMED` transition rejection and ambient-transaction rollback for delete.
- **Budget:** commit `3d8701a` moves 291 additions + 80 deletions = 371 A+D across the three WU8 files, below the 400-line cap. The earlier planning decision that separated the 130 A+D planning slice from the 210–335 A+D implementation/test slice is preserved as history.
- **Implementation commit files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`, and `src/sales/infrastructure/prisma-sale.repository.protect-confirmed-sales.integration.spec.ts`. The later documentary reconciliation changes only `tasks.md` and this progress file outside commit `3d8701a`.
- **Rollback boundary:** revert the atomic `delete` guard and WU8 unit/integration evidence only; WU1–WU7 guards and gates remain intact.

## Task ledger (complete — WU1–WU8)

The task ledger is settled: all 39 task rows (WU1–WU8) are marked `[x]` in `tasks.md`, with the six WU8 rows reconciled to their committed behavior under commit `3d8701a`. The WU8 checklist rows previously duplicated in this ledger were removed once the completed record above superseded them; `tasks.md` remains the single authoritative checklist.

- Remaining: none — WU1–WU8 are complete; the accepted verification evidence is the historical record in the WU8 section above.

## WU4 — Repository projection refactor (completed)

- **Status:** completed; the overall change is **not ready for final verify** until WU5–WU8 are complete.
- **Completed persisted tasks:** WU4 RED, GREEN, and REFACTOR are marked `[x]` in `tasks.md` and mirrored in the task ledger above.
- **Resolution / implementation:** maintainer direction resolves enum handling: `toWriteRow(item, saleId, tenantId)` preserves the exact prior `Prisma.SaleItemCreateManyInput` projection, normalizing only `priceSource` and `rewardKind` to uppercase Prisma values while retaining lowercase `discountType`. `save` now maps items through `sale.items.map((i) => this.toWriteRow(i, sale.id, tenantId))`, so the aggregate ID—not a stale entity parent—is persisted. The existing `prisma.sale.update` / `prisma.sale.create` branch remains inline in `save`; no other helper or behavior changed.
- **TDD cycle evidence:**

  | Stage        | Command                                                                | Result                                                                                                |
  | ------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | RED baseline | `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts` | passed: 152/152 (1 suite); characterization pins all current payload fields, including `discountedAt` |
  | GREEN        | same focused command                                                   | passed: 152/152 (1 suite) after extraction                                                            |
  | REFACTOR     | same focused command                                                   | passed: 152/152 (1 suite); create/update branching remains inline                                     |

- **Verification:** `pnpm build` passed; `git diff --check` passed. Final diff against `b2a8d79`: 168 additions + 49 deletions = **217 A+D**, below the 400-line cap.
- **Known baseline diagnostics:** the maintainer explicitly authorized proceeding without changing the two missing-`userId` test fixtures and unused-helper hint outside this WU4 diff. No WU4-attributable diagnostic was introduced.
- **Files changed:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`, `openspec/changes/protect-confirmed-sales/tasks.md`, and this progress file.
- **Runtime harness:** N/A — WU4 is a repository projection refactor covered by unit tests; no server or background process was launched. The parent retained native-attempt ownership; no native attempt command ran here.
- **Rollback boundary:** remove `toWriteRow`, restore the former inline `save` mapper, and remove the characterization test plus WU4 task/progress entries; WU1–WU3 remain intact.
- **Workload / action context:** WU4 is the authorized feature-branch-chain slice and remains below the 400 A+D cap. Every edit is within the repo-local allowed root. No commit, push, PR, review, attempt, or WU5+ work occurred.
- **Remaining:** WU8 remains pending; see the six unchecked WU8 task lines in the task ledger above. WU5–WU7 are complete and reflected as `[x]` in `tasks.md`.

## WU5 — Repository intent gates (completed)

- **Status:** completed; the overall change remains **not ready for final verify** until WU6–WU8 are complete.
- **Completed persisted tasks:** all six WU5 task lines (RED, GREEN, TRIANGULATE, REFACTOR) are marked `[x]` in `tasks.md`; WU6–WU8 remain unchecked.
- **Implementation:** added private `writeImpl(sale, intent)` and routed `save` through `GENERIC` and `saveDraftItems` through `DRAFT`. Its first operation is a tenant-scoped `findUnique` selecting only `{ id, status }`; it rejects missing DRAFT intent with `EntityNotFoundError`, requires both persisted and incoming DRAFT for DRAFT intent, and rejects forged incoming DRAFT against existing non-DRAFT GENERIC rows before every write. Existing generic creation and non-DRAFT-to-non-DRAFT writes retain the prior inline create/update, item replacement through `toWriteRow`, and promotion-junction reconciliation. Persisted items remain unloaded; WU7 owns snapshot comparison.
- **RED evidence:** baseline `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts` passed **152/152**; after RED tests it failed as expected: **8 failed, 156 passed, 164 total**.
- **GREEN / TRIANGULATE / REFACTOR evidence:** the focused command passed **164/164** after `writeImpl`. The passing matrix covers both directions of the DRAFT status gate, missing DRAFT intent with no create, forged GENERIC DRAFT with zero writes, legitimate GENERIC create/update, and promotion veto/opt-in/applied reconciliation for both intents. Corrective rerun: a typed test-only tenant-scoped client holds a persisted `{ id, status: 'DRAFT', tenantId: 'tenant-2' }` row, injects the current `tenant-1` into the lookup, returns `null` on the tenant mismatch, then proves DRAFT intent throws `EntityNotFoundError` with zero `create`/`update`/item writes. The create/update branch remains inline in `writeImpl`; no helper or persisted-item load was added.
- **Verification:** corrective rerun `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts` passed **164/164**; `pnpm build` passed; `git diff --check` passed. Final `git diff --stat` / `--numstat`: **269 additions, 10 deletions = 279 A+D**, below the 400-line WU5 budget.
- **Resolved diagnostic authorization:** maintainer explicitly classified the reported 708 Pi Lens diagnostics as pre-existing and out of scope for WU5. The only new formatter warning introduced during GREEN was corrected immediately. No new focused-test, build, or type failure remains.
- **Files changed:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`, `openspec/changes/protect-confirmed-sales/tasks.md`, `openspec/changes/protect-confirmed-sales/apply-progress.md`.
- **Rollback boundary:** remove `writeImpl`, restore the WU2 `saveDraftItems → save` delegation, and remove the WU5 test block/import and WU5 artifact updates; WU1–WU4 remain intact.
- **Action context / workload:** consumed `applyState: ready`, repo-local allowed root, the parent-approved resumed attempt, and the `feature-branch-chain` WU5 boundary. No acquire, settle, reset, rescope, commit, push, PR, schema, dependency, API contract, or WU6–WU8 work occurred. Runtime harness: N/A — this repository unit has no server/background boundary.

### TDD Cycle Evidence

| Stage        | Command                                                                | Result                                                                      |
| ------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| RED baseline | `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts` | passed: 152/152                                                             |
| RED          | same command                                                           | expected failure: 8 failed, 156 passed, 164 total                           |
| GREEN        | same command                                                           | passed: 164/164 after `writeImpl`                                           |
| TRIANGULATE  | same passing focused run                                               | promotion junctions for both intents and tenant-isolation missing path pass |
| REFACTOR     | same passing focused run                                               | inline create/update retained; no new helper or persisted-item load         |

## WU6 — Repository snapshot equality helper (completed)

- **Status:** completed; helper intentionally unwired (`writeImpl` keeps the WU5 gate; WU7 wires it and removes the constructor anchor). Not ready for final verify until WU7–WU8; all four WU6 task lines marked `[x]`.
- **Implementation:** module-private `PrismaSaleItemRow` (payload-derived; exactly the 24 save-projection columns, audit-only `createdAt`/`updatedAt` excluded) and `PersistedItemSnapshot` (same schema, `discountedAt` ISO-normalized); private `toPersistedRow` (spread + Date→ISO) and `snapshotItemsEqual(incoming, persisted, saleId, tenantId)` — incoming via `toWriteRow`, persisted via `toPersistedRow`, identity-keyed by `id`, exact cardinality (incl. duplicate-id guard), per-column compare over the row-derived keyset, null/date/enum parity, no reference shortcut, no BigInt handling, no public API change.
- **Tests:** 31 WU6 tests — `snapshotItemsEqual — pure comparison` (equivalent independent snapshots, enum canonicalization ± for `priceSource`/`rewardKind`, null-vs-null parity, Date/ISO/persisted-Date parity, shuffled-order identity keying, missing/extra/disjoint/duplicate ids, 23-column parametrized mismatch) and `— independent-snapshot mutable-bypass` (incoming-only mutation true→false→true, persisted snapshot byte-identical). Access via `SnapshotCompareProbe` + `snapshotCompare(repo, …)` cast through `unknown` — no `as any`.
- **Evidence:** baseline 164/164; RED 36 failed/164 passed (all `TypeError: … not a function`); GREEN 200/200; REFACTOR 195/195; corrective duplicate-ID RED 1 failed/194 passed, then GREEN 195/195; `pnpm build` passed; `git diff --check` passed.
- **Budget:** final numstat after authorized compaction and duplicate-ID correction: **12 progress A + 4/4 tasks A/D + 266 spec A + 106 prod A + 1 prod D = 393 A+D** (≤ 400 cap; was 423 pre-compaction; provider-required reset completed, correction settlement remains parent-owned).
- **Deviation (one):** TS6133 gate on the intentionally unwired private helper → behavior-neutral constructor anchor `void this.snapshotItemsEqual;` (WU7 removes it when wiring). No other deviations.
- **Diagnostics:** zero WU6-introduced — stash-verified vs HEAD (prod eslint 285=285, spec 748→747, tsc `noUnusedLocals` 4=4); remaining diagnostics are the pre-existing `as any` fixture baseline, maintainer-authorized out of scope (WU2/WU4/WU5 precedent).
- **Files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`, `openspec/changes/protect-confirmed-sales/tasks.md`, this file.
- **Rollback:** remove the two types, both helpers, the anchor line, the probe adapter, and the two describe blocks; `writeImpl` and WU1–WU5 intact. Runtime harness: N/A (pure helper). Remaining: WU7 ×3 + WU8 ×6 unchecked; no WU7 work in this unit.

## WU7 — Atomic repository snapshot gate correction

- **Status:** implementation and required WU7 verification complete; WU8 remains untouched and the change is not ready for final verify until WU8 is separately completed.
- **Completed persisted tasks:** WU7 RED, GREEN, TRIANGULATE, and REFACTOR remain visibly checked in `tasks.md`; WU8 task rows remain unchecked.
- **Correction:** renamed the integration spec to `src/sales/infrastructure/prisma-sale.repository.protect-confirmed-sales.integration.spec.ts`; the old `.atomic.integration.spec.ts` path no longer exists. Removed callback indentation churn by keeping `writeImpl` at base indentation and wrapping both `save` and `saveDraftItems` in `TenantPrismaService.runInTransaction`. Simplified lock-result handling without changing the tenant-qualified parameterized parent `FOR UPDATE`, post-lock status/item rereads, pre-write comparison, all writes, or final ambient-transaction reload.
- **Integration evidence:** the real repository `save` entrypoint competes with a held parent lock; the test polls `pg_stat_activity` and `pg_blocking_pids` under a bounded deadline, releases in `finally`, and asserts committed post-lock state is reread. Rollback uses `repository.save` inside an ambient `TenantPrismaService` transaction, then asserts the write is absent. `afterEach` and `afterAll` reset the dedicated test database; no dev database or Compose lifecycle command was used.
- **Files changed:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`, `src/sales/infrastructure/prisma-sale.repository.protect-confirmed-sales.integration.spec.ts`, and corrected WU7 wording in `design.md`, `specs/sales/spec.md`, `tasks.md`.
- **Verification:** focused repository Jest `195/195`; domain Jest `121/121`; sales service Jest `258/258`; full unit Jest `237 suites, 3620 tests`; `pnpm build` passed; `git diff --check` passed; dedicated integration command passed `2/2` against PostgreSQL `localhost:5433` after migrations/seed completed.
- **Budget:** complete Git-visible candidate is **281 A+D**: tracked `123 A+D` plus the renamed untracked integration spec's `158` lines. This is below the 400-line limit; WU8 remains outside the candidate.
- **Deviation from design:** none. The lock claim remains limited to repository writers honoring the parent lock; generic stale-write prevention is not claimed.
- **Runtime / cleanup:** all commands completed synchronously; no server, background process, test database up/down, Compose up/down, volume removal, commit, push, or PR operation occurred.
- **Final verification correction:** final complete Git-visible budget is **281 A+D** before this evidence-only adjustment; parent reran the focused PostgreSQL suite and got **2/2 PASS** after a transient P1001 that a read-only incident check found unattributed, with the container healthy and no lifecycle action; path drift is resolved; WU8 remains untouched. The corrected complete candidate is **282 A+D**, still ≤400.
- **Remaining:** WU8 remains the exact set of six unchecked implementation task lines in `tasks.md`; final `sdd-verify` is not recommended from this WU7-only apply.
