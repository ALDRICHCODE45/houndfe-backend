# Design: HR time-off validations redesign + notifications

## Technical Approach

Approach A (LOCKED): durable dedicated outbox→poller→dispatcher→Inngest→Resend pipeline mirroring low-stock, keyed on new action `TIME_OFF_REQUESTED` / outbox `eventType='hr.timeoff.requested'` / Inngest event `hr/timeoff.requested`. Three independent levers stay decoupled: REQUEST=`create:EmployeeTimeOff`, APPROVE=`update:EmployeeTimeOff` (tenant-wide), NOTIFY=notification-config. `Employee.userId` is retired. Verified seams below cite current source.

## Architecture Decisions

| # | Decision | Choice / Rationale (vs low-stock) |
|---|----------|-----------------------------------|
| D1 | **Emit gate placement** | Gate at **write time** inside `request()` tx: create row always, read config, publish outbox **only if** `enabled && enabledActions.includes('TIME_OFF_REQUESTED')`. Low-stock writes unconditionally + gates in the fn; HR spec (`time-off-notifications` REQ "Emit Gate") forbids the orphan row → gate must move upstream. Fn **re-gates** (config drift defense). |
| D2 | **No batching** | Per-request single email to all recipients (Open-Q1). Omit low-stock's `batchEvents` (`low-stock.functions.ts:120-124`); HR cardinality is low. |
| D3 | **Self-contained payload** | Payload carries `{tenantId,timeOffId,employeeId,type,startDate,endDate,employeeName,requestedByUserId}` — `employee` already loaded (`service.ts:47`). Dispatcher needs no `enrich()` re-read (unlike `low-stock-outbox.dispatcher.ts:250`). Recipients still resolved at send time in-tenant. |
| D4 | **Two migrations** | Split `ALTER TYPE ADD VALUE` from the destructive `employees` drop: keeps each single-concern for drift guards + avoids PG `ADD VALUE` in-tx caveat. (Proposal's "same migration" was rollback narrative, not a locked decision.) |
| D5 | **Reuse DI tokens** | `NOTIFICATION_CONFIG_REPOSITORY`, `USER_EMAIL_LOOKUP`, `MAILER`, `TenantRunnerService` all resolve at AppModule scope (proven by `LowStockInngestRegistrar`). No new adapters. |

## Data Flow

    request() ─tx─► employeeTimeOff.create (always)
        │           └► config.find() ─gate─► outboxWriter.publish('hr.timeoff.requested')
        ▼
    HrTimeOffOutboxPoller (claims =type) ─► Dispatcher ─AWAIT─► InngestService.send('hr/timeoff.requested', idem=`${tenantId}:${timeOffId}`)
        ▼
    Inngest fn: load-config(re-gate)→resolve-recipients(USER_EMAIL_LOOKUP)→send-email(ResendMailer)

## File Changes

| File:line | Action | Change |
|-----------|--------|--------|
| `schema.prisma:205-207` | Modify | enum `+ TIME_OFF_REQUESTED` |
| `schema.prisma:1355-1356,1378,943` | Delete | drop `userId`, `user` rel, `@@unique([tenantId,userId])`, `User.employees` |
| `prisma/migrations/*_add_time_off_requested/` | New | `ALTER TYPE "NotificationActionKey" ADD VALUE 'TIME_OFF_REQUESTED'` |
| `prisma/migrations/*_retire_employee_userid/` | New | `DROP CONSTRAINT employees_userId_fkey; DROP INDEX employees_tenantId_userId_key; DROP COLUMN "userId"` — touches only `employees` |
| `notification-config.ts:10-14` | Modify | add key to alias + `NOTIFICATION_ACTION_KEYS` (allowlist read by `notification-config.service.ts:82` + repo `:74` — no DTO edit) |
| `low-stock-migration-drift.spec.ts:52-55` | Modify | assert BOTH keys in schema enum AND import TS array; fail on drift |
| `employee-time-off.service.ts:42-72` | Rewrite | `runInTransaction`: create + gated `outboxWriter.publish` |
| `employee-time-off.service.ts:218-262` | Delete→add | drop `...ForManager`/`...ForCurrentUser` (kills sole `userId` reader `:254-255`); add `listPendingApprovals()` = `WHERE status='PENDING' orderBy [startDate asc,id asc]` (idx `:1507`), reuse `stripMedicalReason` |
| `employee-time-off.controller.ts:86-102` | Modify | delete `by-manager/:managerId`; repoint `GET pending-approvals`→`listPendingApprovals()`, keep `read:EmployeeTimeOff` |
| `employee-time-off.service.spec.ts:471-522` | Rewrite | tenant-wide + tx/gate tests |
| `seed.ts:1152-1156,1179-1180` | Delete | drop `userId` writes only; **keep** `recordedByUserId` (feeds audit `requestedByUserId/reviewerUserId` `:1112,1115`) |
| `outbox-poller.service.ts:66` | Modify | `<> 'stock.low.detected'` → `NOT IN ('stock.low.detected','hr.timeoff.requested')` |
| `outbox-poller.service.spec.ts:122` | Modify | assert `NOT IN` form w/ both types |
| `employees.module.ts` | Modify | import `OutboxModule` + `NotificationConfigModule` |
| `src/hr-time-off/outbox/{poller,dispatcher,module}.ts` | New | mirror `low-stock-outbox.*`; claim `=type`; dispatcher AWAITs send, no `enrich` |
| `src/hr-time-off/inngest/{time-off-notification.functions,registrar}.ts` | New | mirror builder+registrar; no `batchEvents` |
| `src/notifications/email/templates/time-off-request.email.tsx` | New | Spanish copy (matches low-stock convention) |
| `app.module.ts:101,108` | Modify | add `HrTimeOffOutboxModule` + `HrTimeOffInngestRegistrar` provider |

## Interfaces / Contracts

- Outbox: `aggregateType='EmployeeTimeOff'`, `eventType='hr.timeoff.requested'`, `aggregateId=timeOffId`.
- Idempotency: `${tenantId}:${timeOffId}` (send `id`, fn `idempotency:'event.id'`).
- Email (es): subject `"Nueva solicitud de tiempo libre"`; body = employee, type, dates. No PII in nothing outside body.

## Testing Strategy

| Layer | Test |
|-------|------|
| Unit | request() atomic (both rows / rollback), gate on/off (row persists, no outbox), tenant-wide inbox order + SICK strip, dispatcher idem `T:X` dedupe (`hr-time-off-outbox.dispatcher.spec.ts`) |
| Structural | drift guard (both keys, both places); retire migration touches only `employees`; poller claim disjointness |
| Fn | re-gate (master off / action absent), tenant boundary + inactive membership excluded, empty recipients → no mailer |

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. HTTP route change is authz-gated by existing CASL; Inngest send rides the already-hardened signature-verified `InngestService`.

## Migration / Rollout

Pre-prod, destructive. Run `prisma migrate dev` (split into two dirs per D4). Rollback = revert feature branch + delete both migration dirs (no in-flight rows). Tenant-wide inbox fully replaces the manager filter (no parallel path).

## Open Questions (resolved)

- Batched vs per-request → **per-request** (D2). Template → **generic Spanish** (D3/es).
- Idem drift test → `src/hr-time-off/outbox/hr-time-off-outbox.dispatcher.spec.ts`.
- request() failure → **tx rolls back both**; gate-closed persists row, skips outbox (D1).

## Blast radius & review forecast

Sole runtime `Employee.userId` reader = `service.ts:254-255` (grep-confirmed; all other `userId` = `TenantMembership`). New pipeline (~6 files + specs) ⇒ **400-line budget risk: HIGH** (proposal-aligned). Solo-dev: work-unit commits on ONE feature branch, no PRs. Suggested slices for sdd-tasks: (1) inbox refactor [removes reader] → (2) schema retirement [drop col] → (3) action-key registry → (4) emit seam + poller exclusion → (5) HR outbox poller/dispatcher → (6) Inngest fn + template + registrar. Order matters: slice 1 before 2 (reader must go before column).
