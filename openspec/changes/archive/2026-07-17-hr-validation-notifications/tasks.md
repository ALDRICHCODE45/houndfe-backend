# Tasks: HR Time-Off Validations Redesign + Notifications

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | HIGH — >400 (~6 new files + 2 migrations + specs) |
| 400-line budget risk | High |
| Chained PRs recommended | No (solo-dev, no PRs) — sliced into 6 work-unit commits |
| Suggested split | 6 work-unit commits on one feature branch |
| Delivery strategy | single-pr (solo-dev: no PRs; final `git merge --no-ff`) |
| Chain strategy | size-exception (accepted: solo-dev work-unit commits) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

Reviewer-burden mitigation = 6 small reviewable work-unit commits on branch
`feat/hr-validation-notifications`, merged with `git merge --no-ff` to main at
the end. Strict TDD is ACTIVE (Jest 30, `pnpm test`) — RED test precedes each
behavior. ORDER IS BINDING: Slice 1 (inbox refactor) MUST land before Slice 2
(schema drop) — Slice 1 removes the sole `Employee.userId` reader at
`employee-time-off.service.ts:254-255`; dropping the column first breaks the build.

### Suggested Work Units

| Unit | Goal | Commit | Focused test command | Runtime harness | Rollback boundary |
|------|------|--------|----------------------|-----------------|-------------------|
| 1 | Tenant-wide inbox replaces manager-scoped routing; kills userId reader | Slice 1 | `pnpm test employee-time-off.service employee-time-off.controller` | N/A — no runtime boundary; unit-spec covered | `employee-time-off.{service,controller}.ts` + spec revert; no schema touched |
| 2 | Retire `Employee.userId` column/FK/index/back-rel + seed writes | Slice 2 | `pnpm test` (build + prisma validate) | `pnpm prisma migrate reset` on scratch DB | destructive migration `retire_employee_userid` + schema hunks; reverts 20260528031500 |
| 3 | Register `TIME_OFF_REQUESTED` action key (TS + Prisma enum) + drift guard | Slice 3 | `pnpm test low-stock-migration-drift` | `pnpm prisma migrate` for ADD VALUE | `add_time_off_requested` migration + `notification-config.ts` + drift spec |
| 4 | Gated outbox emit in `request()` tx + generic-poller exclusion | Slice 4 | `pnpm test employee-time-off.service outbox-poller.service` | N/A — tx + poller unit-spec covered | `employee-time-off.service.ts` request() hunk + `outbox-poller.service.ts:66` |
| 5 | HR outbox poller + dispatcher (claim `=type`, idempotent send) | Slice 5 | `pnpm test hr-time-off-outbox` | N/A — dispatcher idempotency unit-spec covered | new `src/hr-time-off/outbox/*` dir removable standalone |
| 6 | Inngest fn + Spanish email template + registrar wiring | Slice 6 | `pnpm test time-off-notification` | `pnpm build` + AppModule boot | new `src/hr-time-off/inngest/*` + template + `app.module.ts` hunks |

---

## Phase 1: Inbox Refactor — remove the userId reader (Slice 1)

> Commit: `refactor(hr): replace manager-scoped time-off inbox with tenant-wide query`
> Spec: `employee-time-off` → "Tenant-Wide Pending Approvals Inbox", "Employee.userId Is Retired" (route removal half). Design seams: service.ts:218-262, controller.ts:86-102.

- [x] 1.1 RED: rewrite `employee-time-off.service.spec.ts:471-522` — assert `listPendingApprovals()` returns all tenant `PENDING` rows ordered `[startDate asc, id asc]`, issues NO `Employee.userId`/`managerId` query, and strips `SICK.reason` without `read:EmployeeTimeOffMedical`
- [x] 1.2 GREEN: in `employee-time-off.service.ts:218-262` DELETE `ForManager`/`ForCurrentUser` methods (removes sole userId reader at :254-255); ADD `listPendingApprovals()` = `WHERE status=PENDING orderBy [startDate asc, id asc]` (idx schema:1507), reuse `stripMedicalReason`
- [x] 1.3 GREEN: `employee-time-off.controller.ts:86-102` delete `by-manager/:managerId` route; repoint `GET admin/employees-time-off/pending-approvals` → `listPendingApprovals()`, keep `read:EmployeeTimeOff` guard
- [x] 1.4 REFACTOR: verify no other reference to removed methods (`pnpm test employee-time-off.service employee-time-off.controller` green)

## Phase 2: Schema Retirement — drop the column (Slice 2)

> Commit: `refactor(hr)!: drop Employee.userId identity link`
> Spec: `employee-time-off` → "Employee.userId Is Retired" (schema half). Design: schema.prisma:1355-1356,1378,943; new destructive migration; seed.ts:1152-1156,1179-1180. Design D4 — split from ADD VALUE.

- [x] 2.1 RED: extend/confirm a schema-inspection assertion (in `low-stock-migration-drift.spec.ts` or a co-located schema test) that `employees_userId_fkey`, index `employees_tenantId_userId_key`, column `userId`, and `User.employees` back-relation are ABSENT
- [x] 2.2 GREEN: edit `schema.prisma` — remove `userId` (:1355-1356), the `@@unique([tenantId, userId])` (:1378), and `User.employees` back-relation (:943)
- [x] 2.3 GREEN: create destructive migration `retire_employee_userid` — `DROP CONSTRAINT employees_userId_fkey; DROP INDEX employees_tenantId_userId_key; DROP COLUMN userId` (touches ONLY `employees`; reverses 20260528031500)
- [x] 2.4 GREEN: `seed.ts:1152-1156,1179-1180` delete `userId` writes ONLY; KEEP `recordedByUserId` (feeds audit `requestedByUserId`/`reviewerUserId` at :1112,1115)
- [x] 2.5 REFACTOR: `pnpm prisma migrate reset` on scratch DB + `pnpm test` — full build compiles with no userId reader

## Phase 3: Action-Key Registry (Slice 3)

> Commit: `feat(notifications): register TIME_OFF_REQUESTED action key`
> Spec: `notification-config` → "NotificationActionKey Registry Accepts TIME_OFF_REQUESTED". Design: notification-config.ts:10-14; schema.prisma:205-207; add_time_off_requested migration; drift spec:52-55.

- [x] 3.1 RED: extend `low-stock-migration-drift.spec.ts:52-55` — assert BOTH `LOW_STOCK` AND `TIME_OFF_REQUESTED` present in the Prisma enum text AND in the imported TS `NOTIFICATION_ACTION_KEYS` array; fail if either side is missing either key
- [x] 3.2 GREEN: `notification-config.ts:10-14` add `TIME_OFF_REQUESTED` to the alias union + `NOTIFICATION_ACTION_KEYS` array (allowlist read at notification-config.service.ts:82 + prisma-notification-config.repository.ts:74; NO DTO literal change)
- [x] 3.3 GREEN: `schema.prisma:205-207` add `TIME_OFF_REQUESTED` to `NotificationActionKey` enum; create migration `add_time_off_requested` (`ALTER TYPE ... ADD VALUE`, standalone per D4 to avoid PG in-tx caveat)
- [x] 3.4 REFACTOR: confirm unknown-key path still returns 400 `UNKNOWN_ACTION_KEY` (existing spec green); `pnpm test low-stock-migration-drift`

## Phase 4: Emit Seam + Generic-Poller Exclusion (Slice 4)

> Commit: `feat(hr): emit gated hr.timeoff.requested outbox event on request`
> Spec: `employee-time-off` → "Atomic Request Writes...Outbox Event"; `time-off-notifications` → "Emit Gate Requires Master Toggle AND Action Key", "Delivery Is Durable" (exclusion). Design D1; service.ts:42-72; outbox-poller.service.ts:66; employees.module.ts.

- [x] 4.1 RED: in `employee-time-off.service.spec.ts` add cases — (a) all gates open → one `PENDING` outbox row `eventType='hr.timeoff.requested'`, `aggregateId=timeOffId`, payload carries `{tenantId,timeOffId,employeeId,type,startDate,endDate,employeeName,requestedByUserId}`; (b) `enabled=false` → row persists, NO outbox; (c) `enabledActions=[]` → row persists, NO outbox; (d) outbox insert fails → both rolled back
- [x] 4.2 RED: `outbox-poller.service.spec.ts:122` flip assertion `<> 'stock.low.detected'` → `NOT IN ('stock.low.detected','hr.timeoff.requested')`
- [x] 4.3 GREEN: rewrite `employee-time-off.service.ts:42-72` `request()` — `runInTransaction`: `employeeTimeOff.create` ALWAYS → tx-bound tenant-scoped `notificationConfigRepo.find()` → publish outbox with idem `${tenantId}:${timeOffId}` ONLY if `enabled && enabledActions.includes('TIME_OFF_REQUESTED')` (D1)
- [x] 4.4 GREEN: `outbox-poller.service.ts:66` change `<> 'stock.low.detected'` → `NOT IN ('stock.low.detected','hr.timeoff.requested')`
- [x] 4.5 GREEN: `employees.module.ts` import `OutboxModule` + `NotificationConfigModule` (exports `NOTIFICATION_CONFIG_REPOSITORY` at :44)
- [x] 4.6 REFACTOR: `pnpm test employee-time-off.service outbox-poller.service` green

## Phase 5: HR Outbox Poller + Dispatcher (Slice 5)

> Commit: `feat(hr): add dedicated hr.timeoff.requested outbox poller and dispatcher`
> Spec: `time-off-notifications` → "Delivery Is Durable" (dedicated HR poller claims only `hr.timeoff.requested`), "Idempotency Key Deduplicates Retries". Design: NEW src/hr-time-off/outbox/{poller,dispatcher,module}.ts (mirror low-stock-outbox.*).

- [x] 5.1 RED: create `src/hr-time-off/outbox/hr-time-off-outbox.dispatcher.spec.ts` — assert dispatcher AWAITs `InngestService.send('hr/timeoff.requested', idem=${tenantId}:${timeOffId})`; duplicate dispatch with same idem → send invoked with the SAME idempotency key (collapses to one email); mailer/send failure → `markRetry` + backoff, row stays un-`PUBLISHED`; success → `markPublished`
- [x] 5.2 GREEN: create `src/hr-time-off/outbox/hr-time-off-outbox.poller.ts` mirroring `low-stock-outbox` poller — claim ONLY `eventType='hr.timeoff.requested'` within tick window
- [x] 5.3 GREEN: create `hr-time-off-outbox.dispatcher.ts` — AWAIT `send`, NO `enrich()` re-read (self-contained payload per D3, unlike low-stock-outbox.dispatcher.ts:250), keep `markPublished`/`markRetry`/backoff/idem `${tenantId}:${timeOffId}`
- [x] 5.4 GREEN: create `hr-time-off-outbox.module.ts` wiring poller + dispatcher (reuse tokens per D5, no new adapters)
- [x] 5.5 REFACTOR: `pnpm test hr-time-off-outbox` green; confirm claim-disjoint from generic poller (Slice 4.4 exclusion)

## Phase 6: Inngest Function + Email Template + Registrar (Slice 6)

> Commit: `feat(hr): send tenant-scoped time-off request notification emails`
> Spec: `time-off-notifications` → "Recipients Are Resolved Within the Correct Tenant", "Recipients Empty or Unresolved → No Send", "Emit Gate" (fn re-gate for drift). Design: NEW src/hr-time-off/inngest/*; time-off-request.email.tsx; app.module.ts:101,108.

- [x] 6.1 RED: create `time-off-notification.functions.spec.ts` — fn runs inside `runWithTenant(payload.tenantId)`; re-gates config (drift); resolves recipients via `USER_EMAIL_LOOKUP` (tenantMembership join + `isActive`); tenant boundary (only T1 users emailed, no T2); inactive membership excluded; empty/zero recipients → mailer NEVER called, row reaches `PUBLISHED`; mailer throws → retryable, `FAILED` after max retries
- [x] 6.2 GREEN: create `src/hr-time-off/inngest/time-off-notification.functions.ts` mirroring `buildLowStockFunctions` — steps `load-config` (re-gate) → `resolve-recipients` → `send-email`; NO `batchEvents` (D2, per-request); `idempotency: 'event.id'`
- [x] 6.3 GREEN: create `src/notifications/email/templates/time-off-request.email.tsx` — Spanish, subject "Nueva solicitud de tiempo libre", matches low-stock template convention
- [x] 6.4 GREEN: create `hr-time-off-inngest-registrar.ts` mirroring `LowStockInngestRegistrar` (reuse NOTIFICATION_CONFIG_REPOSITORY / USER_EMAIL_LOOKUP / MAILER / TenantRunnerService at AppModule scope per D5)
- [x] 6.5 GREEN: `app.module.ts:101,108` add `HrTimeOffOutboxModule` import + `HrTimeOffInngestRegistrar` provider
- [x] 6.6 REFACTOR: `pnpm test time-off-notification` + `pnpm build` + AppModule boot green

## Phase 7: Integration Verification

- [x] 7.1 Full suite: `pnpm test` green (all slices)
- [x] 7.2 Build: `pnpm build` compiles with zero `Employee.userId` references remaining
- [x] 7.3 `git merge --no-ff feat/hr-validation-notifications` → main (final step; solo-dev, no PR)

---

## Archive-time reconciliation note

**Reconciliation performed by sdd-archive on 2026-07-17.**

The persisted `tasks.md` artifact carried 33 unchecked `- [ ]` items even though the change is COMPLETE + VERIFIED. Per the sdd-archive Task Completion Gate, this is normally a `blocked` condition; archive proceeded only because the proof is conclusive:

- **apply-progress (Engram #3159)** explicitly states: "DONE slices: 6/6. REMAINING slices: 0 (all slices landed + committed + green)." Lists all 6 slice commits with per-slice commit SHAs (`bcadf4c`, `49703e7`, `cae3de8`, `0e74797`, `0898c6e`, `fb6b095`) and explicit per-slice RED→GREEN→REFACTOR tests added.
- **verify-report (Engram #3162)** confirms: 16/16 requirements, 39 scenarios (29 fully compliant, 10 PARTIAL — 0 UNTESTED, 0 FAILING), `pnpm run test` exit 0 / 2040/2040 pass, `pnpm run build` exit 0, both runtime gaps (destructive migration live-apply + AppModule DI boot) re-verified. **Verdict: PASS WITH WARNINGS (0 CRITICAL).**
- **git log** confirms all 6 conventional-commit work-unit slices on `feat/hr-validation-notifications` matching the planned tasks.

The sdd-apply phase did not mark the checkboxes when it landed the slices; this is recorded here as a process observation (re: sdd-apply checkbox reconciliation after the fact). All 33 checkboxes are now marked `[x]` so the archived audit trail does NOT carry stale unchecked items for completed work.

The archive report (`archive-report.md`) records the same reconciliation reason under "Audit trail" for traceability.
