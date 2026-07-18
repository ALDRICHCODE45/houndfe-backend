```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:972e787c14b5b027444bd97540852c972c78eb6dce2311699f8e9eb8e6e4dc0b
verdict: pass
blockers: 0
critical_findings: 0
requirements: 16/16
scenarios: 29/39
test_command: pnpm run test
test_exit_code: 0
test_output_hash: sha256:49441920984f4326f855e64a3be2356b6f5d7a1a50485335f518d7161e83d458
build_command: pnpm run build
build_exit_code: 0
build_output_hash: sha256:9d14ccf55f5a8219f87e5d7b6f21ac7d6c7d779a0abe486fb561ee30026df898
```

# Verification Report

**Change**: hr-validation-notifications
**Version**: N/A (initial `employee-time-off` spec + new `time-off-notifications` + `notification-config` delta)
**Mode**: Strict TDD (runner `pnpm run test`, Jest 30)
**Branch**: `feat/hr-validation-notifications` (6 work-unit commits `bcadf4c..fb6b095`)
**Scenario tally**: 29 fully COMPLIANT · 10 PARTIAL (structural/declarative/cross-layer) · 0 UNTESTED · 0 FAILING (39 total)

> Scope of this report: independent **requirements + RUNTIME** verification, focused on the two gaps unit tests do not cover (live destructive migration, DI boot), plus full-suite regression and requirement traceability. The adversarial 4R review (`review-c2c5118ac182f7b3`) was already APPROVED with 0 blockers/critical; static + unit/integration coverage was already GREEN.

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total (work-unit slices) | 6 |
| Tasks complete | 6 |
| Tasks incomplete | 0 |

All 6 slices landed and committed on `feat/hr-validation-notifications`. Working tree pristine except the documented out-of-scope `.atl/skill-registry.md` (modified) and untracked `openspec/changes/hr-validation-notifications/`.

## Build & Tests Execution (independently re-run)

**Build**: ✅ Passed — `pnpm run build` (nest build), exit `0`
`build_output_hash = sha256:9d14ccf55f5a8219f87e5d7b6f21ac7d6c7d779a0abe486fb561ee30026df898`

**Tests**: ✅ 2040 passed / 0 failed / 0 skipped — `pnpm run test`, exit `0`
```
Test Suites: 161 passed, 161 total
Tests:       2040 passed, 2040 total
```
`test_output_hash = sha256:49441920984f4326f855e64a3be2356b6f5d7a1a50485335f518d7161e83d458`

**Coverage**: ➖ Not run as a gate (suite is mock-Prisma unit layer; coverage tool present via `test:cov` but not required by config).

---

## RUNTIME GAP 1 — Destructive migration applies live ✅ VERIFIED

Test DB: Postgres 17 container `nest-practice-test-db` on host **:5433** (`postgresql://admin:secreto@localhost:5433/nest-practice-test`). Targeting confirmed via Prisma preflight (`Datasource "db": … "nest-practice-test" … at "localhost:5433"`). Dev DB (:5432) baseline captured and re-checked untouched.

**Starting state was the exact prior schema** (ideal): before running, the test DB had `employees.userId` present, index `employees_tenantId_userId_key` + FK `employees_userId_fkey` present, and `NotificationActionKey` enum = `{LOW_STOCK}` only — i.e. neither new migration applied.

1. **`prisma migrate deploy`** (against real prior state) → exit `0`; applied `20260717000001_retire_employee_userid` then `20260717000002_add_time_off_requested`. Post-checks (direct `psql`):
   - `employees.userId` column → **gone**
   - index `employees_tenantId_userId_key` → **gone**
   - FK `employees_userId_fkey` → **gone**
   - `NotificationActionKey` enum → **`{LOW_STOCK, TIME_OFF_REQUESTED}`**
   - **Touches ONLY `employees`**: the other 4 `userId`-bearing tables (`notification_recipients`, `sale_payments`, `sales`, `tenant_memberships`) kept their `userId`; public table count unchanged at **53**.
   - Dev DB (:5432) `employees.userId` → **still present** (targeting proof; dev untouched).
2. **`prisma migrate reset --force --skip-seed`** (task's literal ask, full from-scratch replay) → replayed all **34** migrations incl. both new ones; post-reset `prisma migrate status` → **"Database schema is up to date!"**.
3. Bonus: the integration `globalSetup` later ran `migrate deploy` against the reset DB → **"No pending migrations to apply"** (idempotency confirmed).

Static confirmation: `20260717000001/migration.sql` contains only `ALTER TABLE "employees" DROP CONSTRAINT …` / `DROP INDEX "employees_tenantId_userId_key"` / `ALTER TABLE "employees" DROP COLUMN "userId"` — single-table. `20260717000002/migration.sql` is a standalone `ALTER TYPE … ADD VALUE IF NOT EXISTS 'TIME_OFF_REQUESTED'` (D4: outside a tx block, no PG ADD-VALUE-in-tx caveat).

## RUNTIME GAP 2 — DI boot / missing providers ✅ VERIFIED

No committed boot/e2e test exists (only `main.ts` calls `NestFactory.create(AppModule)`), so DI resolution was a genuine gap. A temporary boot smoke (`Test.createTestingModule({ imports: [AppModule] }).compile()` → `app.init()` → `app.close()`) ran against the test DB and **passed** (exit 0), proving:
- The **full AppModule DI graph resolves** — no "Nest can't resolve dependencies" errors — now that `HrTimeOffOutboxModule` (poller + dispatcher + 4 value providers) and top-level provider `HrTimeOffInngestRegistrar` are wired.
- Every `onModuleInit` ran: `PrismaService.$connect()` + **both** Inngest registrars registered their functions.
- **Shared `MAILER` token resolves for the new registrar**: `app.get(MAILER)` returned an object with a `send` function. `HrTimeOffInngestRegistrar` mirrors `LowStockInngestRegistrar` exactly (`InngestService`, `NOTIFICATION_CONFIG_REPOSITORY`, `USER_EMAIL_LOOKUP`, `MAILER`, `TenantRunnerService`, `ConfigService`) — all exported by AppModule imports (Inngest/NotificationConfig/StockAlerts/Mailer/Tenant/global Config). `InngestService` constructs an in-memory client only (no network at boot).

Temporary harness files (`src/app-boot.verify.integration.spec.ts`, `jest.bootsmoke.tmp.config.js`) were removed after the run; tree re-verified pristine.

## Regression — untouched employee flows ✅ VERIFIED

`employees.service.spec` + salary/position/documents/emergency-contacts specs re-run explicitly: **5 suites / 58 tests, exit 0**. Confirms spec scenario *"Removal preserves create / list / get / cancel / reactivate / salary / position / documents / emergency-contacts"*: `create` (ACTIVE + conflict), `findOne`/get (+ salary strip), `findAll`/list (+ pagination), `terminate` (+ reject already-terminated), `reactivate` (+ reject not-terminated), manager-cycle prevention, subordinates, manager-chain — all green.

---

## Spec Compliance Matrix (by requirement)

### Capability `employee-time-off` (9 req / 24 scenarios)
| Requirement | Covering evidence | Result |
|-------------|-------------------|--------|
| Request Time-Off Validation | `employee-time-off.service.spec` request(): PENDING+fields, `EmployeeNotFoundError`(404), `InvalidDateRange`(400) | ✅ COMPLIANT (403 → PARTIAL, guard) |
| Atomic Request writes TimeOff + Outbox | Slice-4 tests: gates-open→1 outbox row; outbox insert fails→both rolled back (`runInTransaction`) | ✅ COMPLIANT |
| Approve/Reject Review | review(): PENDING→APPROVED reviewer fields; non-PENDING→`InvalidTransition`(409); not-owned→404 | ✅ COMPLIANT (REJECTED + authority-not-recipients → PARTIAL) |
| Tenant-Wide Pending Approvals Inbox | `listPendingApprovals()`: all PENDING ordered `[startDate asc, id asc]`; **NO userId/managerId query**; SICK strip×2 | ✅ COMPLIANT (cross-tenant isolation → PARTIAL, tenant-scoped client) |
| Medical Reason Visibility | listForEmployee + inbox strip/keep SICK by `read:EmployeeTimeOffMedical` (+ CLS-driven) | ✅ COMPLIANT |
| Cancel Time-Off | cancel(): allow PENDING; reject started-APPROVED(409) | ✅ COMPLIANT (future-APPROVED allow → PARTIAL, triangulation) |
| List for Single Employee | listForEmployee scoped tests | ✅ COMPLIANT |
| Vacation Balance Unchanged | getVacationBalance: entitlement/used/pending/remaining | ✅ COMPLIANT |
| Employee.userId Retired | drift-spec: schema no column / no `@@unique` / no `User.employees`; destructive migration employees-only **+ LIVE runtime proof** | ✅ COMPLIANT |

### Capability `time-off-notifications` (6 req / 11 scenarios)
| Requirement | Covering evidence | Result |
|-------------|-------------------|--------|
| Emit is sibling to authority | Only request() calls publish (Slice-4 tests under request()); review/cancel paths never publish | ⚠️ PARTIAL (structural; no explicit negative assertion) |
| Emit gate (master AND action key) | Slice-4: all-open→outbox; master-off→row persists,no outbox; action-absent→row persists,no outbox | ✅ COMPLIANT |
| Delivery is durable | dispatcher.spec: AWAIT send before PUBLISHED, PENDING+backoff under maxRetries, FAILED at maxRetries; generic poller `NOT IN (...,'hr.timeoff.requested')` | ✅ COMPLIANT (generic-exclude) / ⚠️ PARTIAL (dedicated HR-poller claim — see WARNING) |
| Recipients resolved within tenant | `prisma-user-email-lookup.repository.spec`: cross-tenant→[], `isActive:true`, CLS tenantId gates WHERE; fn runs inside `runWithTenant(payload.tenantId)` | ✅ COMPLIANT |
| Idempotency key dedup | dispatcher.spec: idem `${tenantId}:${timeOffId}`, replay reuses same key | ✅ COMPLIANT |
| Empty/unresolved → no send | fn.spec: empty recipients→mailer never called; no active recipients→never called | ✅ COMPLIANT |

### Capability `notification-config` (1 req / 4 scenarios)
| Requirement | Covering evidence | Result |
|-------------|-------------------|--------|
| Registry accepts TIME_OFF_REQUESTED | drift-spec: BOTH keys in Prisma enum AND TS allowlist; service/repo: `UNKNOWN_ACTION_KEY` rejects & writes nothing; **+ LIVE enum proof** | ✅ COMPLIANT |

**Compliance summary**: 29/39 scenarios fully compliant with a passing dedicated test; 10 PARTIAL (guard-declarative / structural / cross-layer); **0 UNTESTED, 0 FAILING**.

---

## TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD evidence reported | ✅ | apply-progress documents RED→GREEN→REFACTOR per slice + tests-per-slice (narrative, not the canonical table) |
| All tasks have tests | ✅ | 6/6 slices carry new/updated specs |
| RED confirmed (tests exist) | ✅ | All covering spec files present on disk |
| GREEN confirmed (tests pass) | ✅ | Re-run at runtime: 8 change suites/77 tests + 5 regression suites/58 tests green |
| Triangulation adequate | ⚠️ | Strong on gates/idempotency/tenancy; light on REJECTED-review + future-APPROVED-cancel |
| Safety net for modified files | ✅ | Full 2040-suite green after modifications |

### Test Layer Distribution
| Layer | Tests | Notes |
|-------|-------|-------|
| Unit (mock Prisma) | 2040 (161 suites) | `pnpm run test` |
| Integration (real PG) | globalSetup migrate/seed + boot smoke | `.env.test` → :5433 |
| Runtime (this phase) | migrate deploy/reset + AppModule boot | live evidence for the 2 gaps |

### Assertion Quality
Scanned the change's specs (`employee-time-off.service`, `hr-time-off-outbox.dispatcher`, `time-off-notification.functions`, `low-stock-migration-drift`, `outbox-poller.service`): **0 banned/trivial patterns** (no tautologies, ghost loops, or smoke-only). 145 `expect()` assertions dominated by behavioral matchers — 34 interaction (`toHaveBeenCalledWith/Times`, incl. 11 meaningful `not.toHaveBeenCalled` negative gates), 7 `rejects.` error-path, 55 value (`toBe/toEqual/toContain/toMatchObject`). Runtime logs showed the real dispatcher backoff (2000ms→5160ms→FAILED@retry5) executing — tests drive real production code.
**Assertion quality**: ✅ All sampled assertions verify real behavior.

### Quality Metrics
**Type Checker**: ✅ `nest build` (tsc) exit 0. **Linter**: ➖ not run as a gate this phase.

---

## Issues Found

**CRITICAL**: None.

**WARNING**:
- **HR outbox poller has no dedicated spec.** `HrTimeOffOutboxPoller.claimBatch()` claims only `eventType = 'hr.timeoff.requested'` (poller.ts:111) and exposes a "public seam for the spec", but there is **no `hr-time-off-outbox.poller.spec.ts`** (its `low-stock-outbox.poller.spec.ts` sibling exists). The claim-side of `time-off-notifications › Delivery is durable › "Pipeline stages are claim-disjoint"` is verified only structurally (SQL predicate + DI boot), not by a runtime unit test. Non-blocking; recommend adding a claim spec mirroring the low-stock poller.

**SUGGESTION**:
- Authz-denial (403) scenarios for create/update/read rely on declarative `@RequirePermissions` (all decorators verified present on the controller) + the independently-tested `PermissionsGuard`; no endpoint-specific 403 test exists in this change. Consistent with the established codebase pattern.
- `time-off-notifications › Emit is sibling to authority` (review/cancel emit nothing) is structurally guaranteed (only `request()` publishes) but has no explicit negative assertion.
- Triangulation: add explicit REJECTED-review and future-dated-APPROVED cancel cases.
- Process: future apply reports could use the canonical "TDD Cycle Evidence" table rather than narrative TDD prose.

---

## Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 1 WARNING, 4 SUGGESTIONS.

Both runtime gaps are proven clean at runtime: the two-migration sequence (destructive `employees`-only drop + standalone `ALTER TYPE ADD VALUE`) applies cleanly both incrementally against the real prior schema and from a full `migrate reset` replay, touching only the `employees` table; and the full `AppModule` boots with every provider (incl. the shared `MAILER` for the new registrar) resolving. Build + full 2040-test suite green (independently re-run with hashes); regression flows intact. The single WARNING (missing dedicated HR-poller spec) and the SUGGESTIONS are non-blocking coverage-hardening items. **Change is ready to archive.**
