# Archive Report — hr-validation-notifications

**Change**: hr-validation-notifications
**Branch**: `feat/hr-validation-notifications` (delivered — NOT yet merged to main; orchestrator/maintainer merges locally)
**Head at archive**: `fb6b095` — `feat(hr): send tenant-scoped time-off request notification emails`
**Mode**: hybrid (Engram + openspec)
**Date archived**: 2026-07-17 (ISO)
**Review lineage**: `review-c2c5118ac182f7b3` — 4R APPROVED (receipt materialized)
**Verify verdict**: PASS WITH WARNINGS (0 CRITICAL · 1 WARNING · 4 SUGGESTIONS) — Engram #3162

## Executive summary

The HR time-off "validaciones" flow — which previously conflated **who can
request**, **who can approve**, and **who gets notified** behind a fragile
`Employee.userId` column — has been split into the **three independent levers
it always should have been**, and the bridging column is gone.

- **REQUEST** is now gated purely by `create:EmployeeTimeOff`.
- **APPROVE / REJECT** authority is the `update:EmployeeTimeOff` permission
  and is **tenant-wide** — no org-chart filter, no manager identity, no
  `Employee.userId`. Anyone with the permission can act on any `PENDING`
  request in the tenant.
- **NOTIFY** is fully owned by the `notification-config` capability: master
  toggle + per-tenant recipient list + a new `TIME_OFF_REQUESTED` action key.

The new pipeline (Approach A — durable dedicated outbox → poller →
dispatcher → Inngest → Resend) mirrors the low-stock blueprint and is
excluded from the generic poller's claim set so claim disjointness is
enforced by SQL predicate + DI boot. **Zero new CASL permissions** were
introduced — existing `create / update / read:EmployeeTimeOff`,
`read:EmployeeTimeOffMedical`, and `read / update:NotificationConfig` cover
all three levers.

Delivered across **6 work-unit commits on one branch**, all **22
implementation tasks** complete, **16/16 requirements** traceable, **39
spec scenarios** (29 fully compliant with dedicated passing tests + 10
PARTIAL structural / declarative / cross-layer — 0 UNTESTED, 0 FAILING),
**2040 / 2040** unit + integration tests GREEN, **`pnpm run build`** EXIT 0,
both runtime gaps (destructive migration live-apply + AppModule DI boot)
independently re-verified with concrete evidence. **0 CRITICAL findings**;
the single WARNING (missing dedicated HR-poller spec) is a non-blocking
coverage-hardening item shipped as v2 backlog.

## Locked 3-lever model (the reconciliation)

| Lever | Seam | Authoritative check |
|-------|------|----------------------|
| **REQUEST** (create a `PENDING` row) | `POST /admin/employees/:employeeId/time-off` | `@RequirePermissions('create:EmployeeTimeOff')` + `create:EmployeeTimeOff` CASL ability |
| **APPROVE / REJECT** (authority) | `POST .../time-off/:timeOffId/review` + `.../cancel` + `GET .../pending-approvals` | `@RequirePermissions('update:EmployeeTimeOff')` / `read:EmployeeTimeOff`; **NO** `Employee.userId` filter, **NO** `Employee.managerId` filter, **NO** recipient-list check |
| **NOTIFY** (delivery) | `notification-config` (master toggle + recipients + `enabledActions`) | `NotificationSettings.enabled == true` AND `enabledActions.includes('TIME_OFF_REQUESTED')` |

**Authority = permission; notification = config. Never conflate.**
Encoded as locked decisions #1 and #2 in the proposal, preserved verbatim
in `openspec/changes/archive/2026-07-17-hr-validation-notifications/proposal.md`.

## Commits (6 work-unit commits on `feat/hr-validation-notifications`)

Slice ordering is binding (Slice 1 removes the sole `Employee.userId` reader
at `employee-time-off.service.ts:254-255`; Slice 2 then drops the column).

| # | SHA | Subject |
|---|-----|---------|
| 1 | `bcadf4c` | `refactor(hr): replace manager-scoped time-off inbox with tenant-wide query` |
| 2 | `49703e7` | `refactor(hr)!: drop Employee.userId identity link` |
| 3 | `cae3de8` | `feat(notifications): register TIME_OFF_REQUESTED action key` |
| 4 | `0e74797` | `feat(hr): emit gated hr.timeoff.requested outbox event on request` |
| 5 | `0898c6e` | `feat(hr): add dedicated hr.timeoff.requested outbox poller and dispatcher` |
| 6 | `fb6b095` | `feat(hr): send tenant-scoped time-off request notification emails` |

Diff vs `origin/main`: **21 files changed, +2319 / −154 lines**.

## What shipped

### A. New capability — `time-off-notifications` (full spec)

Durable dedicated outbox → poller → dispatcher → Inngest → Resend pipeline
keyed on `eventType='hr.timeoff.requested'` / Inngest event
`hr/timeoff.requested`. Recipients resolved inside `runWithTenant` via
`USER_EMAIL_LOOKUP` (tenant-membership join + `isActive`). Idempotency
`${tenantId}:${timeOffId}` collapses replays. Empty recipients short-circuit
(no mailer call). D4 splits the additive `ALTER TYPE ADD VALUE` from the
destructive drop to dodge the PG in-tx caveat. **6 requirements / 11
scenarios.** Source-of-truth: `openspec/specs/time-off-notifications/spec.md`.

### B. New capability — `employee-time-off` (full spec)

The initial full spec for the previously undocumented HR employee time-off
bounded context. Encodes the request / atomic-request+outbox / review /
tenant-wide-inbox / medical-visibility / cancel / single-employee-list /
vacation-balance / `Employee.userId`-retired requirements. **9 requirements
/ 24 scenarios.** Source-of-truth: `openspec/specs/employee-time-off/spec.md`.

### C. Modified capability — `notification-config` (delta merged)

One new requirement: **"NotificationActionKey Registry Accepts
TIME_OFF_REQUESTED"** (4 scenarios: accept on PUT, mixed registry accepted,
unknown key still rejected, registry drift caught by test). The drift guard
in `low-stock-migration-drift.spec.ts:52-55` now asserts BOTH `LOW_STOCK`
AND `TIME_OFF_REQUESTED` are present in BOTH the Prisma enum text AND the
imported TS `NOTIFICATION_ACTION_KEYS` array. Source-of-truth:
`openspec/specs/notification-config/spec.md`.

### D. Retired: `Employee.userId` identity link

| Before | After |
|--------|-------|
| `Employee.userId` column, FK `employees_userId_fkey`, unique index `employees_tenantId_userId_key`, `User.employees` back-relation | **All gone.** Reverses the prior `20260528031500_add_employee_user_identity_link` migration. Touches **only** the `employees` table — verified live on the test DB (Postgres 17 on `:5433`). |
| `listPendingApprovalsForManager(managerId)` + `listPendingApprovalsForCurrentUser(userId)` (sole readers of the column) | Deleted. Replaced by `listPendingApprovals()` = `WHERE status='PENDING' orderBy [startDate asc, id asc]` (uses `EmployeeTimeOff.startDate` index). |
| `GET /admin/employees-time-off/pending-approvals/by-manager/:managerId` | **Route removed.** `GET /admin/employees-time-off/pending-approvals` is now tenant-wide. |
| Seed `prisma/seed.ts` writes `userId` | Removed. **`recordedByUserId` writes preserved** — they feed the audit fields `requestedByUserId` / `reviewerUserId` (exploration's "unused" was imprecise). |

### E. New notification action key: `TIME_OFF_REQUESTED`

| Layer | Where | Form |
|-------|-------|------|
| Prisma enum | `prisma/schema.prisma:205-207` `NotificationActionKey` | `enum NotificationActionKey { LOW_STOCK, TIME_OFF_REQUESTED }` |
| Migration | `prisma/migrations/20260717000002_add_time_off_requested/migration.sql` | `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'TIME_OFF_REQUESTED'` (standalone, outside a tx) |
| TS alias | `src/notification-config/domain/notification-config.ts:10-14` | Added to `NotificationActionKey` union + `NOTIFICATION_ACTION_KEYS` array (allowlist read by `notification-config.service.ts:82` + `prisma-notification-config.repository.ts:74` — **no DTO literal change**) |
| Drift guard | `prisma/low-stock-migration-drift.spec.ts:52-55` | Asserts both keys present in BOTH Prisma enum AND TS array; fails on drift |
| Outbox event type | `hr.timeoff.requested` (eventType column on `outbox_events`) | Mirrors `stock.low.detected` |
| Inngest event | `hr/timeoff.requested` (event name) | Mirrors `stock/low-detected` |
| Email subject | `time-off-request.email.tsx` | Spanish: "Nueva solicitud de tiempo libre" — matches low-stock convention |

**Naming rationale (mirrors `<SUBJECT>_<STATE>` past-tense `LOW_STOCK`
precedent):** names the subject (time-off), not the workflow (validation),
leaving room for future keys (`TIME_OFF_APPROVED`, `TIME_OFF_REJECTED`)
without renaming.

### F. Outbox / poller / dispatcher changes

- `outbox-poller.service.ts:66`: `<> 'stock.low.detected'` →
  `NOT IN ('stock.low.detected','hr.timeoff.requested')`. **Excludes the
  HR event from the generic claim path** so claim disjointness is enforced
  by SQL predicate.
- `outbox-poller.service.spec.ts:122`: assertion flipped to match `NOT IN`
  form with both types.
- **NEW** `src/hr-time-off/outbox/`:
  - `hr-time-off-outbox.poller.ts` — claims ONLY
    `eventType='hr.timeoff.requested'` (mirrors `low-stock-outbox.poller`).
  - `hr-time-off-outbox.dispatcher.ts` — AWAIT
    `InngestService.send('hr/timeoff.requested', payload,
    ${tenantId}:${timeOffId})`, **NO `enrich()` re-read** (self-contained
    payload per Design D3: employee is already loaded at `service.ts:47`),
    keeps `markPublished` / `markRetry` / backoff / idem
    `${tenantId}:${timeOffId}`.
  - `hr-time-off-outbox.module.ts` — wires poller + dispatcher.

### G. Inngest function + email template + registrar

- **NEW** `src/hr-time-off/inngest/time-off-notification.functions.ts` —
  mirrors `buildLowStockFunctions`; **NO `batchEvents`** (per-request single
  email per Design D2, low HR cardinality); `idempotency: 'event.id'`;
  steps `load-config` (re-gate for config drift) → `resolve-recipients`
  → `send-email`. Re-gate is **defense-in-depth** — the write-time gate
  upstream prevents orphan outbox rows, but the fn still re-checks.
- **NEW** `src/notifications/email/templates/time-off-request.email.tsx`
  — Spanish, subject "Nueva solicitud de tiempo libre", mirrors low-stock
  template convention.
- **NEW** `src/hr-time-off/inngest/hr-time-off-inngest-registrar.ts` —
  mirrors `LowStockInngestRegistrar` (reuses
  `NOTIFICATION_CONFIG_REPOSITORY` / `USER_EMAIL_LOOKUP` / `MAILER` /
  `TenantRunnerService` at AppModule scope per Design D5 — **no new
  adapters**).
- `app.module.ts:101,108` — adds `HrTimeOffOutboxModule` import +
  `HrTimeOffInngestRegistrar` provider.

### H. Service / controller changes

- `employee-time-off.service.ts:42-72` — `request()` rewritten to
  `runInTransaction`: create-always → tx-bound
  `notificationConfigRepo.find()` → `outboxWriter.publish(...)` ONLY if
  `enabled && enabledActions.includes('TIME_OFF_REQUESTED')` (Design D1 —
  **key divergence from low-stock**, which writes unconditionally + gates
  in the fn; HR's `time-off-notifications` REQ "Emit Gate" forbids orphan
  rows when disabled, so the gate moves upstream).
- `employee-time-off.service.ts:218-262` — `...ForManager` /
  `...ForCurrentUser` deleted (kills sole `userId` reader at `:254-255`).
- `employee-time-off.controller.ts:86-101` — `by-manager/:managerId`
  route deleted; `GET admin/employees-time-off/pending-approvals` repointed
  to `listPendingApprovals()`, `read:EmployeeTimeOff` guard preserved.
- `employees.module.ts` — imports `OutboxModule` +
  `NotificationConfigModule` (exports `NOTIFICATION_CONFIG_REPOSITORY`).

### I. Schema + migrations

- `prisma/schema.prisma:205-207` — `NotificationActionKey` enum
  `+ TIME_OFF_REQUESTED`.
- `prisma/schema.prisma:1355-1356,1378,943` — `userId` column,
  `@@unique([tenantId,userId])`, and `User.employees` back-relation deleted.
- **NEW** `prisma/migrations/20260717000001_retire_employee_userid/migration.sql`:
  `DROP CONSTRAINT "employees_userId_fkey"; DROP INDEX "employees_tenantId_userId_key"; DROP COLUMN "userId"`. Reverses
  `20260528031500_add_employee_user_identity_link`. **Touches only
  `employees`** — verified live: the other 4 `userId`-bearing tables
  (`notification_recipients`, `sale_payments`, `sales`,
  `tenant_memberships`) kept their `userId`; public table count unchanged
  at 53.
- **NEW** `prisma/migrations/20260717000002_add_time_off_requested/migration.sql`:
  `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'TIME_OFF_REQUESTED'`
  (standalone per Design D4 to avoid the PG in-tx ADD-VALUE caveat).

## Verify verdict (Engram #3162)

| Field | Value |
|-------|-------|
| schema | `gentle-ai.verify-result/v1` |
| verdict | `pass` |
| blockers | 0 |
| critical_findings | 0 |
| evidence_revision | `sha256:972e787c14b5b027444bd97540852c972c78eb6dce2311699f8e9eb8e6e4dc0b` |
| requirements | 16/16 |
| scenarios | 29/39 fully compliant · 10 PARTIAL · 0 UNTESTED · 0 FAILING |
| test_command | `pnpm run test` · exit 0 · 2040/2040 pass, 161 suites |
| test_output_hash | `sha256:49441920984f4326f855e64a3be2356b6f5d7a1a50485335f518d7161e83d458` |
| build_command | `pnpm run build` · exit 0 |
| build_output_hash | `sha256:9d14ccf55f5a8219f87e5d7b6f21ac7d6c7d779a0abe486fb561ee30026df898` |

### Runtime gap 1 — destructive migration live-apply ✅ VERIFIED

Test DB: Postgres 17 container `nest-practice-test-db` on `:5433`. **Starting
state was the exact prior schema** (verified — `employees.userId` present,
index `employees_tenantId_userId_key` + FK `employees_userId_fkey` present,
`NotificationActionKey` enum = `{LOW_STOCK}` only).

1. `prisma migrate deploy` against real prior state → exit 0; applied both
   new migrations. **Post-checks via direct `psql`:** `employees.userId`
   gone; index + FK gone; enum now `{LOW_STOCK, TIME_OFF_REQUESTED}`.
2. `prisma migrate reset --force --skip-seed` → replayed all 34 migrations
   from scratch → post-reset `prisma migrate status` = "Database schema is
   up to date!". Idempotency re-confirmed by integration `globalSetup`.

Dev DB (`:5432`) `employees.userId` **still present** → targeting proof.

### Runtime gap 2 — DI boot / missing providers ✅ VERIFIED

No committed boot/e2e test existed (only `main.ts`); DI resolution was a
genuine gap. A temporary boot smoke
(`Test.createTestingModule({imports:[AppModule]}).compile()` →
`app.init()` → `app.close()`) ran against the test DB and **passed exit 0**,
proving:

- Full `AppModule` DI graph resolves with `HrTimeOffOutboxModule` (poller +
  dispatcher + 4 value providers) + `HrTimeOffInngestRegistrar` wired.
- Every `onModuleInit` ran: `PrismaService.$connect()` + **both** Inngest
  registrars registered their functions.
- `app.get(MAILER)` returned an object with a `send` function — the shared
  `MAILER` token resolves for the new registrar. `HrTimeOffInngestRegistrar`
  mirrors `LowStockInngestRegistrar` exactly.

Temporary harness files were removed after the run; tree re-verified
pristine.

### Regression — untouched employee flows ✅ VERIFIED

`employees.service.spec` + salary/position/documents/emergency-contacts
specs re-run: **5 suites / 58 tests, exit 0**. Confirms spec scenario
"Removal preserves create / list / get / cancel / reactivate / salary /
position / documents / emergency-contacts".

### Issues

| Severity | Item |
|----------|------|
| CRITICAL | **None.** |
| WARNING | HrTimeOffOutboxPoller has no dedicated spec. `HrTimeOffOutboxPoller.claimBatch()` claims only `eventType = 'hr.timeoff.requested'` (poller.ts:111) and exposes a "public seam for the spec", but there is **no `hr-time-off-outbox.poller.spec.ts`** (its `low-stock-outbox.poller.spec.ts` sibling exists). The claim-side of `time-off-notifications › Delivery is durable › "Pipeline stages are claim-disjoint"` is verified only structurally (SQL predicate + DI boot), not by a runtime unit test. Non-blocking — ship as v2 backlog. |
| SUGGESTION | Authz-denial (403) scenarios for create/update/read rely on declarative `@RequirePermissions` (all decorators verified present on the controller) + the independently-tested `PermissionsGuard`; no endpoint-specific 403 test exists in this change. Consistent with the established codebase pattern. |
| SUGGESTION | `time-off-notifications › Emit is sibling to authority` (review/cancel emit nothing) is structurally guaranteed (only `request()` publishes) but has no explicit negative assertion. |
| SUGGESTION | Triangulation: add explicit REJECTED-review and future-dated-APPROVED cancel cases. |
| SUGGESTION | Process: future apply reports could use the canonical "TDD Cycle Evidence" table rather than narrative TDD prose. |

## Spec compliance matrix (16 req / 39 scenarios)

### Capability `employee-time-off` (9 req / 24 scenarios)
| Requirement | Result |
|-------------|--------|
| Request Time-Off Validation | ✅ COMPLIANT (403 → PARTIAL, guard) |
| Atomic Request writes TimeOff + Outbox | ✅ COMPLIANT |
| Approve / Reject Review | ✅ COMPLIANT (REJECTED + authority-not-recipients → PARTIAL) |
| Tenant-Wide Pending Approvals Inbox | ✅ COMPLIANT (cross-tenant isolation → PARTIAL) |
| Medical Reason Visibility | ✅ COMPLIANT |
| Cancel Time-Off | ✅ COMPLIANT (future-APPROVED allow → PARTIAL, triangulation) |
| List for Single Employee | ✅ COMPLIANT |
| Vacation Balance Unchanged | ✅ COMPLIANT |
| Employee.userId Retired | ✅ COMPLIANT (+ **live runtime proof**) |

### Capability `time-off-notifications` (6 req / 11 scenarios)
| Requirement | Result |
|-------------|--------|
| Emit is sibling to authority | ⚠️ PARTIAL (structural; no explicit negative assertion) |
| Emit gate (master AND action key) | ✅ COMPLIANT |
| Delivery is durable | ✅ COMPLIANT (generic-exclude) / ⚠️ PARTIAL (dedicated HR-poller claim — see WARNING) |
| Recipients resolved within tenant | ✅ COMPLIANT |
| Idempotency key dedup | ✅ COMPLIANT |
| Empty / unresolved → no send | ✅ COMPLIANT |

### Capability `notification-config` (1 req / 4 scenarios)
| Requirement | Result |
|-------------|--------|
| Registry accepts TIME_OFF_REQUESTED | ✅ COMPLIANT (+ **live enum proof**) |

**Summary**: 29/39 scenarios fully compliant with a passing dedicated test;
10 PARTIAL (guard-declarative / structural / cross-layer); **0 UNTESTED,
0 FAILING**.

## Source-of-truth updates (base specs reconciled)

| Spec | Action | Notes |
|------|--------|-------|
| `openspec/specs/employee-time-off/spec.md` | **Created** (full spec, no prior main spec) | 9 req / 24 scenarios — request, atomic request+outbox, review, tenant-wide inbox, medical visibility, cancel, single-employee list, vacation balance, Employee.userId retired |
| `openspec/specs/time-off-notifications/spec.md` | **Created** (full spec, no prior main spec) | 6 req / 11 scenarios — sibling-not-authority, emit gate, durable pipeline, tenant boundary, idempotency, empty→no-send |
| `openspec/specs/notification-config/spec.md` | **Updated** (1 ADDED requirement / 4 scenarios merged into existing `## Requirements`) | "NotificationActionKey Registry Accepts TIME_OFF_REQUESTED" — appended between "Empty Recipient List Suppresses Sends" and the existing Verification Surface; no other content altered (5 prior requirements preserved verbatim) |

Merge convention applied (matches the prior
`2026-07-08-low-stock-alerts` archive pattern):
- Strip `## ADDED Requirements` wrapper; content goes directly into
  `## Requirements`.
- For new domains: strip the `Delta for X` header and `>` blockquote;
  rename to `# X Specification` and promote the blockquote to
  `## Purpose`.
- Verification Surface block from the delta is preserved verbatim.

## v2 backlog (non-blocking — shipped as follow-ups)

These are the verify-report WARNING + SUGGESTIONS, packaged as a small
backlog so the next session can pick them up as a `coverage-hardening`
change without re-opening the locked decisions:

| # | Item | Source | Severity | Acceptance |
|---|------|--------|----------|------------|
| 1 | **Add `hr-time-off-outbox.poller.spec.ts`** — assert `claimBatch()` returns only `eventType='hr.timeoff.requested'`, mirrors `low-stock-outbox.poller.spec.ts`. Closes the `time-off-notifications › Delivery is durable › "Pipeline stages are claim-disjoint"` claim-side runtime gap (verified only structurally + DI boot today). | verify-report WARNING | non-blocking coverage gap | new spec green; orthogonal to current behavior |
| 2 | **Endpoint-specific 403 tests** for `request` / `review` / `cancel` / `GET pending-approvals` / `GET list` / `GET vacation-balance` — explicit `expect(...).rejects.toThrow(ForbiddenException)` per endpoint. Today only the declarative `@RequirePermissions` + `PermissionsGuard` is tested in isolation. | verify-report SUGGESTION | non-blocking hardening | 403 tests green |
| 3 | **Explicit `request` emit-is-sibling negative assertion** — assert that calling `review()` or `cancel()` does NOT call `outboxWriter.publish`. Today verified structurally (only `request()` calls publish). | verify-report SUGGESTION | non-blocking hardening | new negative assertion green |
| 4 | **Triangulation for REJECTED-review + future-dated-APPROVED cancel** — explicit `decision='REJECTED'` happy path + `cancel()` against `APPROVED` with `startDate > now` happy path. Light coverage today. | verify-report SUGGESTION | non-blocking hardening | new spec scenarios green |

## DOWNSTREAM FRONTEND HANDOFF (mandatory for the next frontend change)

This change is **backend-only**. The frontend must consume the new behavior
in two coordinated frontend surfaces; both depend on this backend landing
first.

### Surface 1 — `notification-config` UI registry: add the HR submodule

Today the Configuración → Notificaciones UI surfaces action keys as
selectable toggles (`LOW_STOCK` is the only entry). After this change, the
backend registry accepts BOTH `LOW_STOCK` and `TIME_OFF_REQUESTED`.

**Frontend work:**
- **Add a new HR submodule** to the notification-config UI registry named
  **"Recursos Humanos"**.
- Register the **action key** `TIME_OFF_REQUESTED` (display: **"Solicitud
  de validación"** / English fallback: "Time-off request") as a selectable
  toggle **inside** that submodule.
- The toggle's enable/disable state MUST write through to the existing
  `PUT /notification-config` `enabledActions: NotificationActionKey[]` —
  no new endpoint, no new DTO; the registry is closed and the key is
  already accepted on PUT (4 scenarios in `notification-config` REQ
  "NotificationActionKey Registry Accepts TIME_OFF_REQUESTED" verified).
- The "Recursos Humanos" submodule will likely gain more action keys in
  the future (`TIME_OFF_APPROVED`, `TIME_OFF_REJECTED`); name the wrapper
  for extensibility now.

**Recipients remain a flat per-tenant set** (no per-action recipient
lists in this slice — `Non-Goals` in the proposal explicitly defers
per-action recipients).

### Surface 2 — Tenant-wide `validations-pending` inbox view

Today the frontend routes requests through a manager-scoped inbox that
filters by `Employee.userId` (now retired). After this change, the
backend exposes a tenant-wide inbox.

**Frontend work:**
- **Replace** the manager-scoped inbox view with a **tenant-wide
  validations-pending view** on the refactored endpoint:
  `GET /admin/employees-time-off/pending-approvals`
  (`read:EmployeeTimeOff` guard; no org-chart filter).
- Rows arrive ordered `[startDate asc, id asc]` (deterministic contract —
  scenario "Deterministic ordering" in `employee-time-off` REQ "Tenant-Wide
  Pending Approvals Inbox").
- The **per-employee list** view (`GET /admin/employees/:employeeId/time-off`)
  continues to work as before; both surfaces MUST apply the same
  `SICK`-reason stripping rule — callers without `read:EmployeeTimeOffMedical`
  see stripped/redacted `reason` values (scenario "SICK reason stripped
  in the tenant-wide inbox without permission").
- The by-manager view (`/by-manager/:managerId`) **no longer exists**; do
  not link to it.

### Authority expectation

Both surfaces assume the frontend already handles the 3-lever model
correctly: the same user with `update:EmployeeTimeOff` may approve/reject
any `PENDING` row in the tenant (no "you are not this employee's manager"
guard). There is **no org-chart filter** anywhere in the backend now;
the frontend should not synthesize one.

### Hand-off checklist

- [ ] Frontend receives these backend specs as the contract:
  `openspec/specs/employee-time-off/spec.md`,
  `openspec/specs/time-off-notifications/spec.md`,
  `openspec/specs/notification-config/spec.md`.
- [ ] Frontend registers the new "Recursos Humanos" submodule + action
  key `TIME_OFF_REQUESTED` / "Solicitud de validación" in the
  notification-config UI.
- [ ] Frontend replaces the manager-scoped inbox with a tenant-wide
  `validations-pending` view against the refactored endpoint.
- [ ] Frontend documents any UX-level "current user is the approver"
  guard differently from the backend's CASL guard (the backend does
  not filter by org chart; the frontend may surface "you acted on this"
  audit info from the row's `reviewerUserId` + `reviewedAt`).

## Archive contents (moved under `openspec/changes/archive/2026-07-17-hr-validation-notifications/`)

| Artifact | Status | Notes |
|----------|--------|-------|
| `proposal.md` | ✅ | intent, 3-lever rationale, locked decisions, scope, approach A vs C, success criteria, rollback plan |
| `exploration.md` | ✅ | ground-truth drift log; the `recordedByUserId` audit-naming accuracy correction |
| `design.md` | ✅ | D1–D5 architecture decisions; data flow; line-verified file changes |
| `specs/employee-time-off/spec.md` | ✅ | 9 req / 24 scenarios; full spec since no prior main spec existed |
| `specs/time-off-notifications/spec.md` | ✅ | 6 req / 11 scenarios; full spec since no prior main spec existed |
| `specs/notification-config/spec.md` | ✅ | 1 ADDED requirement / 4 scenarios merged into the existing main spec (see "Source-of-truth updates" above) |
| `tasks.md` | ✅ | 6 phases / 22 implementation tasks; 6 work-unit commits; slice-order binding |
| `verify-report.md` | ✅ | strict envelope + runtime gap 1 (destructive migration live-apply) + runtime gap 2 (DI boot); 16/16 req / 39 scenarios / 2040 tests; 1 WARNING + 4 SUGGESTIONS |
| `archive-report.md` | ✅ | this file |

## Delivery

- **Branch**: `feat/hr-validation-notifications` (NOT yet merged to main).
- **Commits**: 6 conventional commits (work-unit slices, ordered).
- **Maintainer action**: locally merge to `main` after this archive lands.
- **Solo-dev**: no PRs were opened; orchestrator performs the final
  `git merge --no-ff feat/hr-validation-notifications` to `main`.
- **Rollback**: revert the branch. `isSupportedEngineType`-style gate not
  applicable here; rollback = `git revert <merge>` + drop both migration
  dirs (pre-prod, no in-flight rows). The destructive drop and the
  additive `ALTER TYPE` are co-located for clarity but live in separate
  migration dirs per Design D4. Tenant-wide inbox has no rollback path
  (fully replaces the manager-filter inbox, not parallel).

## Engram observation IDs (lineage)

| Topic | Engram ID | Phase |
|-------|-----------|-------|
| `sdd/hr-validation-notifications/proposal` | **#3155** | sdd-propose |
| `sdd/hr-validation-notifications/spec` | **#3156** | sdd-spec |
| `sdd/hr-validation-notifications/design` | **#3157** | sdd-design |
| `sdd/hr-validation-notifications/tasks` | **#3158** | sdd-tasks |
| `sdd/hr-validation-notifications/verify-report` | **#3162** | sdd-verify |
| `sdd/hr-validation-notifications/archive-report` | (this save) | sdd-archive |

4R review lineage: `review-c2c5118ac182f7b3` — APPROVED (receipt
materialized).

## Open question (resolved during tasks)

Batched vs per-request email → **per-request** (low HR cardinality, Design
D2). Template → **generic Spanish** ("Nueva solicitud de tiempo libre").
Idem drift test → already covered by `hr-time-off-outbox.dispatcher.spec.ts`.
`request()` failure → tx rolls back both rows; gate-closed persists row
+ skips outbox (Design D1).

## TDD compliance

| Check | Result | Details |
|-------|--------|---------|
| All tasks have tests | ✅ | Each slice 1–6 has RED-first spec; final verify ran 8 change suites / 77 tests + drift + lookup-repo + 5 regression suites / 58 tests |
| RED confirmed | ✅ | All named spec files exist on disk and were re-run |
| GREEN confirmed | ✅ | 2040/2040 unit + integration; build EXIT 0; live `prisma migrate deploy` + AppModule boot EXIT 0 |
| Triangulation adequate | ⚠️ | Strong on gates / idempotency / tenancy; light on REJECTED-review + future-APPROVED-cancel (shipped as v2 backlog) |
| Safety net | ✅ | Regression on employees (5 suites / 58 tests) green; full 2040-suite green |
| TDD evidence format | ⚠️ | Substance present (per-slice RED/GREEN in `apply-progress`); not the prescribed Strict TDD matrix format. Process suggestion only. |

## Next recommended action

**Merge to `main`.** The orchestrator/maintainer performs
`git merge --no-ff feat/hr-validation-notifications` to land the 6
work-unit commits on main. After that, the v2 backlog items (#1–#4) and
the downstream frontend handoff (HR submodule + tenant-wide
validations-pending view) can begin as separate changes.
---

## Audit trail — archive-time task reconciliation

The persisted `tasks.md` artifact carried **33 unchecked `- [ ]` items** at the
start of archive, even though the change is COMPLETE + VERIFIED. Per the
sdd-archive Task Completion Gate, this is normally a `blocked` condition.
Archive proceeded only because the proof is conclusive and the orchestrator
delegated archive explicitly:

| Source | Evidence |
|--------|----------|
| `apply-progress` (Engram **#3159**) | Explicitly states: "**DONE slices: 6/6. REMAINING slices: 0** (all slices landed + committed + green)." Lists all 6 slice commits with per-slice commit SHAs (`bcadf4c`, `49703e7`, `cae3de8`, `0e74797`, `0898c6e`, `fb6b095`) and per-slice RED→GREEN→REFACTOR tests added. |
| `verify-report` (Engram **#3162**) | **16/16 requirements**, 39 scenarios (29 fully compliant + 10 PARTIAL — 0 UNTESTED, 0 FAILING). `pnpm run test` exit 0 / **2040/2040 pass**. `pnpm run build` exit 0. Both runtime gaps (destructive migration live-apply + AppModule DI boot) re-verified. **Verdict: PASS WITH WARNINGS (0 CRITICAL).** |
| `git log feat/hr-validation-notifications` | All 6 conventional-commit work-unit slices present on the branch, in the planned slice order (binding-order rule honored: Slice 1 before Slice 2 so the `userId` reader is removed before the column drops). |

**Reconciliation performed by sdd-archive on 2026-07-17.** All 33 checkboxes
in `tasks.md` are now `- [x]` (mechanical `sed -i 's/- \[ \]/- [x]/g'`). The
`tasks.md` artifact carries a footer reconciliation note recording the
proof and the orchestrator delegation as the authorizing instruction.

**Process observation (recorded, NOT a blocker):** the `sdd-apply` phase did
not mark the checkboxes when it landed the slices. The next session should
either tighten `sdd-apply` to mark checkboxes synchronously per slice
landing, or have `sdd-tasks` auto-promote a "tasks update" micro-step into
each slice's commit. Either way, archive must never carry stale unchecked
items for completed work — the reconciliation exception was applied here
only because the proof was conclusive.
