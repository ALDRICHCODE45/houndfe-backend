# Tasks — Preserve tenant transaction scope

One shared-Prisma work unit (proposal + design auto-fixed). Two evidence layers — unit + PostgreSQL integration — for a SINGLE production modification: start `runInTransaction()` from `createTenantScopedPrisma(this.prisma, this.cls)` so the CLS transaction slot holds a callback client whose tenant query extension state is non-empty.

Delivery is a confirmed feature-branch-chain: WU1 (service + unit) is the current child of `feat/protect-confirmed-sales-06-repository-snapshot-equality`; WU2 (PostgreSQL integration) branches from WU1; the corrected `protect-confirmed-sales` WU7 then branches from WU2. No `size:exception` is used, and no merge, push, or PR is part of this execution.

## Review Workload Forecast

| Field                                         | Value                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated changed lines (A+D, implementation) | ~410–615 (production 5–10 A in `tenant-prisma.service.ts` only; unit spec 150–220 A + 30–60 D in `tenant-prisma.service.spec.ts`; new integration spec 250–380 A; factory, allowlist, schema, sales consumers unchanged). |
| 400-line budget risk                          | Medium                                                                                                                                                                                                                    |
| Chained PRs recommended                       | Yes (WU1 ≤ 400 across its full forecast; WU2 ≤ 400 across its full forecast; the union trends above 400 only in the upper bound, so the chain keeps each PR within budget)                                                |
| Suggested split                               | WU1 current branch from WU6; WU2 child branch from WU1; corrected WU7 child branch from WU2. No push or PR in this execution.                                                                                             |
| Delivery strategy                             | ask-on-risk (resolved: feature-branch-chain selected; no `size:exception` is used)                                                                                                                                        |
| Chain strategy                                | feature-branch-chain (confirmed; each child is based on the immediately preceding local branch)                                                                                                                           |

```text
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Medium
```

Per-unit ranges (A+D, both ends counted for movement and replacement lines; each unit fits ≤ 400 by itself):

| Unit                                       | Prod A | Prod D | Test A  | Test D | Subtotal    |
| ------------------------------------------ | ------ | ------ | ------- | ------ | ----------- |
| WU1 — Service provenance + unit evidence   | 5–10   | 0–2    | 150–220 | 30–60  | 185–292     |
| WU2 — PostgreSQL service-bound integration | 0      | 0      | 250–380 | 0      | 250–380     |
| **Sum**                                    | 5–10   | 0–2    | 400–600 | 30–60  | **435–672** |

Per-PR budgets: WU1 alone is ≤ 400 across its full forecast; WU2 alone is ≤ 400 across its full forecast. The union trends above 400 only in the upper bound, so the feature-branch-chain keeps each PR within the 400-line review budget. No `size:exception` is used; the chain is the budget-true delivery mechanism.

## Scenario / Requirement Traceability

| Label                       | Scenario                                                                      | Unit |
| --------------------------- | ----------------------------------------------------------------------------- | ---- |
| R-EXT-ROOT                  | Outer `$transaction` invoked on the tenant-extended root                      | WU1  |
| R-NO-EXTENDS-PROOF          | Tests do not assert `'$extends' in tx` as proof of extension propagation      | WU1  |
| R-IDENTITY-OUTER            | `getClient()` inside outer `runInTransaction` returns the ambient `tx`        | WU1  |
| R-IDENTITY-NESTED           | `getClient()` inside nested `runInTransaction` returns the same `tx`          | WU1  |
| R-NESTED-1TX                | Nested `runInTransaction` opens exactly one `$transaction` across nested      | WU1  |
| R-NESTED-SLOT-OK            | Nested success leaves CLS slot on ambient `outerTx`                           | WU1  |
| R-NESTED-SLOT-FAIL          | Nested failure leaves CLS slot on ambient `outerTx`                           | WU1  |
| R-RESTORE-OK                | CLS slot restored to previous value on success path                           | WU1  |
| R-RESTORE-THROW             | CLS slot restored to previous value when `work` throws synchronously          | WU1  |
| R-RESTORE-REJECT            | CLS slot restored to previous value when `work` returns a rejected promise    | WU1  |
| R-OUTSIDE-EXTENDED          | `getClient()` outside a transaction returns the extended root, not raw Prisma | WU1  |
| R-RESULT-FWD                | `work` return value passes through unchanged                                  | WU1  |
| R-ERROR-PROP                | Original error / rejection from `work` propagates unchanged                   | WU1  |
| R-PG-READ-OUTER             | PostgreSQL outer tenant-scoped find returns `null` for foreign id             | WU2  |
| R-PG-UPDATE-P2025           | PostgreSQL cross-tenant update rejects with `P2025`                           | WU2  |
| R-PG-DELETE-P2025           | PostgreSQL cross-tenant delete rejects with `P2025`                           | WU2  |
| R-PG-UPDATE-UNCHANGED       | PostgreSQL cross-tenant update leaves A-owned row unchanged after rollback    | WU2  |
| R-PG-DELETE-UNCHANGED       | PostgreSQL cross-tenant delete leaves A-owned row unchanged after rollback    | WU2  |
| R-PG-CREATE-OVERRIDE-OUTER  | Outer `create` with foreign `tenantId` persists under CLS tenant              | WU2  |
| R-PG-CREATE-OVERRIDE-NESTED | Nested `create` with foreign `tenantId` persists under CLS tenant             | WU2  |
| R-PG-NESTED-READ            | Nested CLS path tenant-scoped find returns `null` for foreign id              | WU2  |
| R-PG-RELOAD-COMMIT          | Post-commit unscoped-fixture reload confirms tenant ownership                 | WU2  |
| R-PG-RELOAD-ROLLBACK        | Post-rollback unscoped-fixture reload confirms A-owned row unchanged          | WU2  |

Raw-SQL explicitness (`R-RAW-SQL-UNSCOPED`) and direct-consumer non-protection clauses are behavior-only; they require no code change in this PR and are documented in `spec.md` and `design.md`.

## Conventions

- **Test classification:** _regression baseline_ (passes before and after), _new failing evidence_ (fails before this unit, passes after), _gate-correctness baseline_ (passes only when the gate is implemented correctly; pins a positive property).
- Production change is a SINGLE-LINE switch in `runInTransaction` — replace `this.prisma.$transaction(...)` with `createTenantScopedPrisma(this.prisma, this.cls).$transaction(...)`. Preserve every existing branch (`previousClient` early return, CLS slot capture/restore, error propagation, nested reuse).
- `getClient()` and `isInTransaction()` remain UNCHANGED. The pre-existing conditional on `'$extends' in txClient` stays correct: normal Prisma ITX clients do not expose `$extends`, so they pass through as ambient `tx`. The cast type already in the codebase does not need to change.
- Factory `createTenantScopedPrisma`, allowlist `TENANT_SCOPED_MODELS`, schema, and migrations stay frozen.
- Sales repositories (`prisma-sale.repository.ts` and friends), WU7 implementation, and direct transaction consumers stay out of scope.
- Integration suite uses `SKIP_DB_INTEGRATION` and missing-`DATABASE_URL` guard identical to `src/shared/prisma/tenant-isolation.spec.ts`.
- Each unit must compile at completion; previous units' tests must stay green.
- Commands use Jest file-path focus only (no `--testNamePattern`); `pnpm build` covers TS compile.
- **Blocker note:** `protect-confirmed-sales` WU7 implementation MUST NOT start destructive persistence steps until both WU1 and WU2 land AND PostgreSQL evidence is verified. WU7's tasks already reference the prerequisite; the gate stays.

---

## WU1 — Service provenance change + unit evidence

- **Start:** `runInTransaction` in `src/shared/prisma/tenant-prisma.service.ts` calls `this.prisma.$transaction(async (tx) => {...})`, so the callback `tx` originates from the raw Prisma service. Unit spec `src/shared/prisma/tenant-prisma.service.spec.ts` uses ONE combined mock for `baseClient` whose `$extends` and `$transaction` belong to the same object, so it cannot pin provenance.
- **Finish:** `runInTransaction` constructs the extended root once and starts the outer transaction from it. The CLS slot still stores the ambient callback `tx`. `getClient()` and `isInTransaction()` remain unchanged. Unit spec uses distinct mocks for raw vs extended roots; new tests pin provenance, ambient identity, nesting (one `$transaction`), restoration on success/throw/rejection, outside-transaction extended access, result forwarding, and original-error propagation. Tests MUST NOT assert `'$extends' in tx`.
- **Depends on:** none.
- **Files:** `src/shared/prisma/tenant-prisma.service.ts`, `src/shared/prisma/tenant-prisma.service.spec.ts`.
- **Forecast:** Prod A 5–10 (one-line switch; possible local const for extended root), Prod D 0–2 (only if any conditional branch is touched), Test A 150–220, Test D 30–60. **Subtotal 185–292.**
- **Verify:** `pnpm test -- src/shared/prisma/tenant-prisma.service.spec.ts`; `pnpm build`.
- **Rollback:** revert the `runInTransaction` switch + unit spec changes. Factory and consumers are untouched.
- **Acceptance gate:** covers `R-EXT-ROOT`, `R-NO-EXTENDS-PROOF`, `R-IDENTITY-*`, `R-NESTED-*`, `R-RESTORE-*`, `R-OUTSIDE-EXTENDED`, `R-RESULT-FWD`, `R-ERROR-PROP`.

Tasks:

- [x] RED — in `src/shared/prisma/tenant-prisma.service.spec.ts` split the combined `baseClient` mock into TWO mocks (raw and extended). Mock the module `tenant-prisma.factory` so `createTenantScopedPrisma` returns the `extendedRoot`. Rewrite the existing `describe('TenantPrismaService', …)` block to:
  - assert `extendedRoot.$transaction` was called exactly once across outer + nested, and that no other client (`rawBase`) opened a transaction,
  - assert `getClient()` inside outer `runInTransaction` returns the ambient `tx` and is the same identity across the outer body,
  - keep the existing nested-call assertion but verify it uses ambient `outerTx` (not the extended root) inside the nested body,
  - never assert `'$extends' in tx` (gate-correctness baseline). New failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — add `describe('TenantPrismaService.runInTransaction restoration', …)` cases inside the same spec file: success path → prior `prismaTxClient` slot restored to `previousClient` (undefined in the default case); synchronous throw → slot restored, error re-thrown unchanged (use a `SentinelError` class unique to the spec); rejected promise → slot restored, rejection propagated via `await expect(...).rejects.toBe(sentinel)`. New failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — add `describe('TenantPrismaService.getClient outside transaction', …)`: with no ambient transaction, `getClient()` returns a tenant-extended client (not the raw `PrismaService`); assert identity vs `extendedRoot` produced by a fresh `createTenantScopedPrisma(this.prisma, this.cls)` for the same snapshot. Gate-correctness baseline. <!-- sdd-owner: implementation -->
- [x] RED — add `describe('TenantPrismaService.runInTransaction result/error forwarding', …)`: `work` returns a sentinel value (`Symbol('result')` or unique object) → resolved value equals the sentinel by reference; `work` throws a `SentinelError('boom')` → re-thrown with the SAME `SentinelError` instance identity and message. New failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — add the nested-failure slot-leaves-ambient case: outer CLS holds `outerTx`; nested `runInTransaction` throws; after the throw, `getClient()` returns `outerTx` (not raw) and `isInTransaction()` is still `true`; outer `runInTransaction` propagates the throw and CLS is restored to `undefined`. New failing evidence. <!-- sdd-owner: implementation -->
- [x] GREEN — in `src/shared/prisma/tenant-prisma.service.ts`, change `runInTransaction` to construct `const extendedRoot = createTenantScopedPrisma(this.prisma, this.cls);` once and call `extendedRoot.$transaction(async (tx) => {...})`. Preserve: prior-slot capture, early nested return, `try`/`finally` CLS restoration, original error / rejection propagation. Use the existing `PrismaTransactionClient` type alias already declared at the top of the file; do not add new type declarations. All WU1 RED tests turn green. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE — assert that the mock factory `createTenantScopedPrisma` is called EXACTLY once for the outer transaction (not on every callback) — `expect(createTenantScopedPrismaSpy).toHaveBeenCalledTimes(1)`. Pre-existing `isInTransaction` describe block stays green; pin that block as regression baseline. <!-- sdd-owner: implementation -->
- [x] REFACTOR — production switch stays inline; no helper function, no static field, no traceability comment. Test file keeps existing imports; new describe blocks sit alongside the existing ones. <!-- sdd-owner: implementation -->

---

## WU2 — Real PostgreSQL service-bound integration evidence

- **Start:** WU1 complete. `src/shared/prisma/tenant-prisma.service.ts` now starts the outer transaction from the extended root. Factory behavior at the Prisma boundary is already proven by `src/shared/prisma/tenant-isolation.spec.ts`. There is no service-bound integration spec for the transaction path; this is the missing acceptance evidence.
- **Finish:** new `src/shared/prisma/tenant-prisma.service.integration.spec.ts` proves the service transaction path against the Prisma 6.19.2 PostgreSQL test DB. Uses `integrationPrisma()` for the unscoped fixture, `resetAndSeedBaseline()` for cleanup, a stateful CLS shim (`get`/`set` backed by a map), pinned tenants A/B, and an A-owned tenant-scoped Product. Coverage per `design.md`:
  1. outer tenant-scoped `findUnique` of A-owned id under CLS B → `null`,
  2. cross-tenant `update` of A-owned id under CLS B → `P2025`, unscoped reload after rollback confirms unchanged state,
  3. cross-tenant `delete` of A-owned id under CLS B → `P2025`, unscoped reload after rollback confirms unchanged state,
  4. outer `create` with foreign `tenantId` under CLS B → persists as CLS B, unscoped reload confirms no row under A and ownership under B,
  5. nested CLS path repeats a tenant-scoped find and confirms `null`,
  6. nested CLS path repeats a `create` with foreign `tenantId` and confirms persistence under CLS B after commit.
- **Depends on:** WU1; `SKIP_DB_INTEGRATION` and `DATABASE_URL` guards identical to `tenant-isolation.spec.ts`; `pnpm run test:db:up` available; integration Jest config picks up `*.integration.spec.ts` via the existing matcher.
- **Files:** `src/shared/prisma/tenant-prisma.service.integration.spec.ts` (new).
- **Forecast:** Prod A 0, Prod D 0, Test A 250–380, Test D 0. **Subtotal 250–380.**
- **Verify:** `pnpm test:integration -- src/shared/prisma/tenant-prisma.service.integration.spec.ts`; `pnpm build`. Run alongside `pnpm test:integration -- tenant-isolation.spec.ts` to confirm no regression.
- **Rollback:** delete the new file. WU1 changes remain in place; WU1 evidence still satisfies the unit requirement.
- **Acceptance gate:** WU2 satisfies the proposal's success criteria 1–6 and unblocks `protect-confirmed-sales` WU7 destructive persistence steps.

Tasks:

- [x] RED — create `src/shared/prisma/tenant-prisma.service.integration.spec.ts` with the standard guard header copied from `src/shared/prisma/tenant-isolation.spec.ts`: `SKIP_INTEGRATION` from `process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL`; `describeIfDb` switching to `describe.skip`; pinned tenant A/B UUIDs (`00000000-0000-0000-0000-0000000000aa`, `00000000-0000-0000-0000-0000000000bb`); `integrationPrisma`, `resetAndSeedBaseline`, `disconnectIntegrationPrisma` imports; one mutable `clsStore` object plus a stateful CLS shim with `get`/`set` backed by a `Map<keyof TenantClsStore | string, unknown>`. Reuse `TENANT_SCOPED_MODELS` to assert `Product` is allowlisted for the read scenarios (gate-correctness baseline). New file. <!-- sdd-owner: implementation -->
- [x] RED — write the outer-read scenario under `describe('TenantPrismaService.runInTransaction outer tenant-scoped read', …)`: seed an A-owned Product via `integrationPrisma().product.create({ ... })` inside `beforeEach`; set `clsStore.tenantId = tenantBId`; call `await tenantPrisma.runInTransaction(async () => { const found = await tenantPrisma.getClient().product.findUnique({ where: { id } }); expect(found).toBeNull(); });`. New failing evidence (passes only if the extended-root transaction propagates tenant predicates to the callback `tx`). <!-- sdd-owner: implementation -->
- [x] RED — write the cross-tenant update and delete scenarios under `describe('TenantPrismaService.runInTransaction cross-tenant mutations reject', …)`: under CLS B, `getClient().product.update({ where: { id }, data: ... })` rejects with `PrismaClientKnownRequestError` whose `code === 'P2025'`; same for `delete`; after the rollback, `integrationPrisma().product.findUnique({ where: { id } })` returns the original row with original `tenantId` and `name`. New failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — write the outer-create attribution scenario under `describe('TenantPrismaService.runInTransaction create forces CLS tenantId', …)`: under CLS B, `getClient().product.create({ data: { name: 'forced', tenantId: tenantAId } })` resolves; after commit, `integrationPrisma().product.findUnique({ where: { id } })` returns the row with `tenantId === tenantBId`; assert NO row exists under tenant A via `integrationPrisma().product.findMany({ where: { tenantId: tenantAId, name: 'forced' } })`. New failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — keep the nested CLS PostgreSQL scenario focused on tenant-scoped reads and callback-client identity; do not infer transaction cardinality from unchanged row counts. Exact one-transaction evidence remains owned by WU1's root `$transaction` call-count test (U2). Fulfilled: P7 asserts nested foreign read `null`, nested `getClient()` identity vs the outer callback client, and unchanged A-owned state after commit; the Product row-count cardinality claim is removed. <!-- sdd-owner: implementation -->
- [x] RED — write the nested-create scenario under `describe('TenantPrismaService.runInTransaction nested create forces CLS tenantId', …)`: nested `runInTransaction` performs `getClient().product.create({ data: { name: 'nested', tenantId: tenantAId } })`; after outer commit, unscoped fixture reload confirms ownership under tenant B. New failing evidence. <!-- sdd-owner: implementation -->
- [x] GREEN — run the integration suite. All scenarios pass without additional code changes; WU2 evidence is acceptance evidence, not implementation work. If any scenario fails, root-cause must point to either (a) a regression in the production change (revert WU1) or (b) fixture/cleanup deficiency in the spec (fix WU2). <-- deliverables-only --> <!-- sdd-owner: implementation -->
- [x] TRIANGULATE — start/check the dedicated test DB; rerun the focused WU2 and adjacent tenant-isolation suites (both required gates); attribute full-suite failures against the WU1 parent WITHOUT treating known baseline failures as candidate regressions (attribution evidence only). Prove the skip guard through the EFFECTIVE config: shell-only `SKIP_DB_INTEGRATION=1` is defeated because the shared dotenv load uses `override: true` so `.env.test`'s `SKIP_DB_INTEGRATION=0` replaces the shell flag — skip proof must read effective config, and unit-config exclusion never enters `describe.skip`. Align spec non-goals with static documentation and record this prerequisite in WU7 before verification. <!-- sdd-owner: implementation -->
- [x] REFACTOR — keep the CLS shim local, remove assertion overclaims (no Product row-count cardinality proof), and compact WU2 plus its bookkeeping to <= 330 A+D before the final report (<= 400 report-inclusive) without weakening the eight PostgreSQL tests. No `size:exception` is used. <!-- sdd-owner: implementation -->

---

## Out of scope (explicit non-goals — do NOT add tasks)

- Prisma schema changes, migrations, `TENANT_SCOPED_MODELS` allowlist changes, schema/index/backfill work.
- Sales repository changes (`src/sales/infrastructure/prisma-sale.repository.ts` and friends) — owned by `protect-confirmed-sales`.
- WU7 implementation, downstream task execution, or unblocking the WU7 gate from this file.
- Direct `getClient().$transaction(...)` consumers — characterized in `design.md` as a follow-up only if their behavior is in question.
- Raw `PrismaService.$transaction(...)` consumers and background pollers.
- Raw-SQL protection work — `design.md` documents that raw SQL remains the caller's responsibility.
- Branch / PR creation, commits, pushes.
- Child subagents, runtime harness execution, RDD receipts, delivery-gate tasks.

## Downstream coordination

- After WU1 + WU2 land and PostgreSQL evidence verifies, update `openspec/changes/protect-confirmed-sales/tasks.md` WU7 dependency line to reflect "prerequisite verified". Do not preemptively do this from tasks.md.
- Proposal success criteria 1–6 must remain the verification checklist at apply-time; do NOT promote WU7 to unblocked from this file.

## Final verification (future, do not execute during tasks)

**Per-work-unit gates — WU1 (verify before creating the WU2 child branch):**

- `pnpm test -- src/shared/prisma/tenant-prisma.service.spec.ts` (WU1 unit evidence)
- `pnpm test` (full unit suite; no regression in `tenant-prisma.factory.spec.ts` or other co-located unit specs)
- `pnpm build` (TS compile)
- Re-read `design.md` "Architecture Decisions" and "Data Flow" against the landed change — confirm `getClient()` conditional branch was preserved and the `try`/`finally` CLS restoration is still present.
- Manual walkthrough of `R-EXT-ROOT`, `R-NO-EXTENDS-PROOF`, `R-IDENTITY-*`, `R-NESTED-*`, `R-RESTORE-*`, `R-OUTSIDE-EXTENDED`, `R-RESULT-FWD`, `R-ERROR-PROP` (verification step, not a current claim).

**Per-work-unit gates — WU2 (verify on the child branch based directly on WU1):**

- `pnpm test:integration -- src/shared/prisma/tenant-prisma.service.integration.spec.ts` (WU2 PostgreSQL evidence; requires `pnpm run test:db:up` + `.env.test`)
- `pnpm test:integration -- tenant-isolation.spec.ts` (no regression in the existing factory isolation suite)
- `pnpm test:integration` (full integration suite)
- `pnpm build` (TS compile; verifies the new spec type-checks against the rest of the codebase)
- Re-load WU1's landed change and confirm WU2 evidence runs against the production-extended-root, not raw `PrismaService.$transaction`.
- Manual walkthrough of `R-PG-READ-OUTER`, `R-PG-UPDATE-P2025`, `R-PG-DELETE-P2025`, `R-PG-UPDATE-UNCHANGED`, `R-PG-DELETE-UNCHANGED`, `R-PG-CREATE-OVERRIDE-OUTER`, `R-PG-CREATE-OVERRIDE-NESTED`, `R-PG-NESTED-READ`, `R-PG-RELOAD-COMMIT`, `R-PG-RELOAD-ROLLBACK` (verification step, not a current claim).
- After WU2 is committed locally AND PostgreSQL evidence verifies: update `openspec/changes/protect-confirmed-sales/tasks.md` WU7 dependency line to reflect "prerequisite verified" before rebuilding WU7 as the next child branch.
