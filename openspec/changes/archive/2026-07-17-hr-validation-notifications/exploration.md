# Exploration: HR time-off validations redesign + notifications (`hr-validation-notifications`)

> Backend-only change. Scope: (1) retire `Employee.userId` completely, (2) make the
> pending-validations inbox tenant-wide, (3) emit an HR notification event through the
> existing data-driven notification pipeline. Frontend is a downstream handoff (see §9).
>
> **Confirmed decision (not re-litigated).** 3 separate levers — REQUEST = `create:EmployeeTimeOff`,
> APPROVE/reject authority = `update:EmployeeTimeOff`, NOTIFY = Configuración→Notificaciones
> recipients. Golden rule: authority = permission; notification = config.

---

## 1. Current State

### 1.1 Time-off / validaciones flow (`src/employees/`)
- `EmployeeTimeOffService.request()` (`src/employees/application/employee-time-off.service.ts:42-72`) creates a `PENDING` `EmployeeTimeOff` row via a **plain** `prisma.employeeTimeOff.create(...)` (no transaction, no event emission). It stores `requestedByUserId` (`:68`).
- `review()` (`:74-100`) approve/reject gates **only by permission** — no manager/org-chart check. Stamps `reviewerUserId`, `reviewedAt`, `reviewerNotes`.
- `listPendingApprovalsForManager(managerId)` (`:218-246`) filters `employee.managerId = managerId` → subordinate ids → their `PENDING` rows, ordered `startDate asc`.
- `listPendingApprovalsForCurrentUser(userId)` (`:248-262`) resolves `User → Employee` via `prisma.employee.findFirst({ where: { userId } })` (`:254-255`) then delegates to the manager view. **This is the ONLY runtime consumer of `Employee.userId`.**
- Controller (`src/employees/employee-time-off.controller.ts`): all routes guard `JwtAuthGuard → TenantContextGuard → PermissionsGuard` (`:26`). Permissions already match the decision:
  - `POST admin/employees/:employeeId/time-off` → `create:EmployeeTimeOff` (`:31-33`)
  - `POST .../:timeOffId/review` → `update:EmployeeTimeOff` (`:64-65`)
  - `GET admin/employees-time-off/pending-approvals` → `read:EmployeeTimeOff`, calls `listPendingApprovalsForCurrentUser(user.userId)` (`:87-92`)
  - `GET admin/employees-time-off/pending-approvals/by-manager/:managerId` → `read:EmployeeTimeOff` (`:95-101`)

### 1.2 Notification pipeline — the reference blueprint (low-stock)
The data-driven notification system lives across `notification-config/` (the config CRUD) and `stock-alerts/` (the durable send). End-to-end:

1. **Write seam (transactional outbox).** `OutboxWriterService.publish(tx, tenantId, aggregateType, aggregateId, eventType, payload)` (`src/shared/outbox/outbox-writer.service.ts:23-42`) inserts a `PENDING` `outbox_events` row inside a caller's transaction. Low-stock callers: product repo, `sales.service.ts`, `receipt-review.service.ts`.
2. **Two disjoint pollers** (claim disjointness — Slice F.3):
   - **Generic** `OutboxPollerService` (`src/shared/outbox/outbox-poller.service.ts`) claims `WHERE eventType <> 'stock.low.detected'` (`:66`) → `OutboxDispatcherService.dispatch()` → `EventEmitter2.emit(eventType, payload)` **fire-and-forget in-process**, then marks `PUBLISHED` synchronously (`src/shared/outbox/outbox-dispatcher.service.ts:17-31`).
   - **Dedicated** `LowStockOutboxPoller` (`src/stock-alerts/outbox/low-stock-outbox.poller.ts`) claims `WHERE eventType = 'stock.low.detected'` (`:145`) with `FOR UPDATE SKIP LOCKED` → `LowStockOutboxDispatcher.dispatch()`.
3. **Dedicated dispatcher → Inngest.** `LowStockOutboxDispatcher.dispatch()` (`src/stock-alerts/outbox/low-stock-outbox.dispatcher.ts:108-190`) enriches the payload (`:250-304`), computes an idempotency key `${tenantId}:${productId}:${variantKey}:${alertEpoch}` (`:313-320`), calls `InngestService.send('stock/low.detected', enriched, idemKey)` (`:145`), then `markPublished`/`markRetry` with exponential backoff (`:216-236`, max 5 retries → `FAILED`).
4. **Inngest boundary.** `InngestService.send(name, data, idempotencyKey)` (`src/inngest/inngest.service.ts:95-105`) passes `id: idempotencyKey` so replays dedupe. Functions are registered at boot via `registerFunctions()` (`:142-158`).
5. **Inngest function reads config + sends email.** `buildLowStockFunctions()` (`src/stock-alerts/inngest/low-stock.functions.ts:112-248`) creates `low-stock-email` triggered by `stock/low.detected` (`:117-118`), batched per tenant (`:120-124`). Inside it:
   - `step.run('load-config')` → `tenantRunner.runWithTenant(tenantId, () => notificationConfigRepository.find())` (`:165-173`). **CLS must be seeded INSIDE the step callback** (`:153-164`) or the tenant scope is lost.
   - Gates: `if (!config.enabled) skip` (`:175`); `if (!config.enabledActions.includes('LOW_STOCK')) skip` (`:178`).
   - `step.run('resolve-recipients')` → `userEmailLookup.resolveEmailsByUserIds(config.recipients)` (`:192-196`).
   - Renders the React email template, `step.run('send-email')` → `mailer.send({ to, subject, html })` (`:232-238`).
6. **Registrar wiring.** `LowStockInngestRegistrar` (`src/stock-alerts/inngest/low-stock-inngest-registrar.ts:38-69`) injects `NOTIFICATION_CONFIG_REPOSITORY`, `USER_EMAIL_LOOKUP`, `MAILER`, `TenantRunnerService` and registers the function `onModuleInit`. Wired only in `app.module.ts`.
7. **Recipient resolution (tenant-safe).** `PrismaUserEmailLookupRepository.resolveEmailsByUserIds()` (`src/stock-alerts/infrastructure/prisma-user-email-lookup.repository.ts:32-62`) joins `tenantMembership → user` filtered by `tenantId` + `user.isActive=true` — cross-tenant safe by construction.
8. **Mailer.** `ResendMailer.send()` (`src/notifications/email/resend.mailer.ts:71-114`): prod uses Resend SDK; dev/test logs a **recipient-redacted** entry; prod-without-key throws (fail-closed).

### 1.3 Notification config CRUD + the action-key registry
- `NotificationConfigController` (`src/notification-config/notification-config.controller.ts`): `GET` → `read:NotificationConfig` (`:38`); `PUT` → `update:NotificationConfig` (`:49`). Full-overwrite semantics.
- `NotificationConfigService.replace()` (`src/notification-config/notification-config.service.ts:77-115`) validates action keys against `NOTIFICATION_ACTION_KEYS` (`:81-88`) and validates recipient tenant-membership (`:92-112`) before delegating to the port.
- `PrismaNotificationConfigRepository` (`src/notification-config/infrastructure/prisma-notification-config.repository.ts`): `find()` (`:36-64`) reads `NotificationSettings.enabled` + `NotificationRecipient.userId[]` + `NotificationAction.action[]`; `replace()` (`:66-116`) full-overwrite in a `$transaction`.

**The action-key type exists in TWO places that must stay in sync:**
- **Prisma enum** `NotificationActionKey { LOW_STOCK }` (`prisma/schema.prisma:205-207`); `NotificationAction.action` is typed by it (`:1595`). Created by migration `20260706202542_low_stock_alerts` (`migration.sql:2` — `CREATE TYPE "NotificationActionKey" AS ENUM ('LOW_STOCK')`).
- **Hand-maintained TS type alias** `NotificationActionKey = 'LOW_STOCK'` + `NOTIFICATION_ACTION_KEYS` array (`src/notification-config/domain/notification-config.ts:10-14`).

**There is NO "module grouping" in the backend.** `enabledActions` is a flat `string[]`; recipients are a flat per-tenant list (`NotificationRecipient`, one row set per tenant, NOT per-action). The "Acciones a notificar" submodule grouping is a **frontend** presentation concern (REQ-10, out of scope — §9).

### 1.4 CASL registry
`src/auth/authorization/domain/permission.ts`:
- `EmployeeTimeOff`: `create`, `read`, `update`, `delete`, `manage` (`:361-386`).
- `EmployeeTimeOffMedical`: `read` (`:388-393`) — gates SICK reason via `stripMedicalReason` (`service:266-275`).
- `NotificationConfig`: `read`, `update` (`:422-433`).
- Subjects union includes both (`:39-42`).

---

## 2. Affected Areas (file:line)

### 2.1 Retire `Employee.userId` — full blast radius
| Location | What | Change |
|---|---|---|
| `prisma/schema.prisma:1355-1356` | `userId String?` + `user User? @relation(onDelete:SetNull)` | **DROP** |
| `prisma/schema.prisma:1378` | `@@unique([tenantId, userId])` | **DROP** |
| `prisma/schema.prisma:943` | `User.employees Employee[]` back-relation | **DROP** (relation dies with the FK) |
| new `prisma/migrations/*` | reverse of `20260528031500_add_employee_user_identity_link` | DROP COLUMN `userId` + FK `employees_userId_fkey` + unique index `employees_tenantId_userId_key` |
| `src/employees/application/employee-time-off.service.ts:248-262` | `listPendingApprovalsForCurrentUser` (only column consumer, `findFirst({where:{userId}})`) | **DELETE** (replaced by tenant-wide) |
| `src/employees/employee-time-off.controller.ts:86-92` | `pendingApprovals` route calling it | **REPOINT** to tenant-wide method |
| `src/employees/application/employee-time-off.service.spec.ts:472-507` | tests for `listPendingApprovalsForCurrentUser` (mock `where:{userId:'user-1'}` at `:483`) | **DELETE/REWRITE** |
| `prisma/seed.ts:1152-1156` | `updateMany({where:{tenantId,userId},data:{userId:null}})` | **REMOVE** |
| `prisma/seed.ts:1179-1180` | `userId: seed.employeeNumber === 'EMP-006' ? recordedByUserId : undefined` | **REMOVE** (and the now-unused `recordedByUserId` plumbing at `:1137-1141`, `:1529`) |

**Verified NOT affected (false positives — separate concerns, keep):**
- `EmployeeTimeOff.requestedByUserId` (`schema:1500`) and `reviewerUserId` (`schema:1497`) — audit FKs on the time-off row, **not** `Employee.userId`. Keep.
- Every `req.user.userId` / `store.userId` / `user.userId` across `src/` (e.g. `employees.service.ts:42`, controller `:39`,`:72`) = the authenticated **User** id from JWT/CLS for CASL, **not** the `Employee.userId` column. A repo-wide grep confirmed **no other code reads `Employee.userId`**.
- No employee DTO or mapper references `userId` (grep of `src/employees` returned only service + controller + specs; repo uses `any` payloads so no compile break).

### 2.2 Tenant-wide pending inbox
- `src/employees/application/employee-time-off.service.ts:218-262` — collapse to a tenant-wide `listPendingApprovals()` querying all `employeeTimeOff WHERE status='PENDING'` in the tenant, ordered (`startDate asc` or `createdAt`), keep `stripMedicalReason` per ability.
- **Index already exists:** `@@index([tenantId, status, startDate])` (`schema:1507`) — perfect coverage; no new index needed.
- Routes (`controller:86-101`): repoint `pending-approvals` to tenant-wide; decide the fate of `pending-approvals/by-manager/:managerId` (§5).

### 2.3 New action key + emit
- `prisma/schema.prisma:205-207` — add enum value (e.g. `TIME_OFF_REQUESTED`) → migration `ALTER TYPE "NotificationActionKey" ADD VALUE ...`.
- `src/notification-config/domain/notification-config.ts:10-14` — add the value to the TS alias + array.
- `src/employees/application/employee-time-off.service.ts:42-72` (`request()`) — emit point.
- New Inngest function + registrar (mirror `stock-alerts/inngest/`) + new email template.
- `src/employees/employees.module.ts` — new wiring (import `OutboxModule`/notification ports as chosen in §6).

---

## 3. Approaches — how to emit the HR notification (the core design fork)

**Constraint discovered:** the generic outbox poller dispatches via `EventEmitter2.emit` fire-and-forget and marks `PUBLISHED` synchronously (`outbox-dispatcher.service.ts:17-31`). It **cannot durably reach Inngest/Resend** — this is exactly why low-stock built a dedicated poller and why the generic poller excludes `stock.low.detected` (`outbox-poller.service.ts:48-66`). So any new event routed through the generic poller is best-effort in-process only.

1. **Dedicated durable pipeline (blueprint-faithful).** Add `hr.timeoff.requested` to the generic poller exclusion (`outbox-poller.service.ts:66` → `NOT IN (...)`); new dedicated poller + dispatcher claiming `= 'hr.timeoff.requested'` → `InngestService.send('hr/timeoff.requested', payload, idemKey)`; new Inngest function `timeoff-request-email` (reads config, gates `enabledActions.includes('TIME_OFF_REQUESTED')`, resolves recipients via the SAME `USER_EMAIL_LOOKUP`, new template, `MAILER.send`). `request()` wraps create + `OutboxWriterService.publish(tx, ...)` in `tenantPrisma.runInTransaction`.
   - Pros: at-least-once durability; identical to the proven house pattern; transactional (email iff row committed); reuses recipient/config/mailer seams verbatim.
   - Cons: most code (poller + dispatcher + module + registrar + function + template); touches the shared generic poller predicate (low regression risk).
   - Effort: **High**

2. **Generalize the low-stock dedicated pipeline** into a reusable Inngest-outbox keyed by a SET of durable event types.
   - Pros: no duplicated poller/dispatcher; cleanest long-term.
   - Cons: refactors a **prod-critical working path** (low-stock) → highest regression risk; larger blast radius on code that already has passing tests.
   - Effort: **High**

3. **Direct `InngestService.send` from `request()` (pragmatic, best-effort).** After the create commits, call `inngestService.send('hr/timeoff.requested', payload, `${tenantId}:${timeOffId}`)`; same new Inngest function as (1). No outbox, no new poller/dispatcher.
   - Pros: smallest surface; no shared-code changes; Inngest still retries once the event lands; a notification is arguably best-effort.
   - Cons: dual-write (send-after-commit can drop the event if `send()` itself throws); diverges from the established durable pattern; `EmployeeTimeOffService` gains an Inngest dependency.
   - Effort: **Low-Medium**

**Recipients note (all options):** the `NotificationRecipient` list is per-tenant, not per-action, so the configured recipients receive every enabled action's email; per-action gating is purely `enabledActions`. This matches the golden rule (notification = config).

---

## 4. Recommendation

- **Schema/inbox/permissions:** unambiguous. Drop `Employee.userId` (3 schema edits + 1 migration + 2 code deletions + seed + spec), refactor the inbox to tenant-wide (reusing the existing `[tenantId,status,startDate]` index), and **add ZERO CASL permissions** — `create`/`update`/`read:EmployeeTimeOff` and `read`/`update:NotificationConfig` already cover all three levers.
- **New action key:** add the value in BOTH the Prisma enum (`schema:205`) AND the TS registry (`notification-config.ts:10`) — a new migration `ALTER TYPE ... ADD VALUE`. No backend module grouping to touch.
- **Emit path:** recommend **Approach 1 (dedicated durable pipeline)** for durability + consistency with the proven blueprint, but **explicitly surface Approach 3** as a legitimate lighter alternative — it materially cuts task count and PR size. The final call belongs to `design` because it changes the work-unit forecast (Approach 1 likely exceeds the 400-line review budget alone).

---

## 5. Route decisions (tenant-wide inbox)
- `GET admin/employees-time-off/pending-approvals` — **keep the path**, change the body to tenant-wide (drop `@CurrentUser` resolution). Frontend already calls this path.
- `GET admin/employees-time-off/pending-approvals/by-manager/:managerId` — contradicts the "no manager/org-chart filter" decision. It does **not** depend on `Employee.userId` (uses `managerId`), so it is schema-safe either way. Recommend **remove** (system not in prod) OR keep strictly as an optional manager filter — flag for `propose`.

---

## 6. Emit seam mechanics (Approach 1/3 detail)
- `request()` (`service:42-72`) is currently a bare create. For Approach 1, wrap in `tenantPrisma.runInTransaction(async () => { const row = await getClient().employeeTimeOff.create(...); await outboxWriter.publish(getClient(), tenantId, 'EmployeeTimeOff', row.id, 'hr.timeoff.requested', payload); })` (mirrors `products.service.ts:742` tx idiom).
- `EmployeeTimeOffService` does NOT currently inject `OutboxWriterService`/`InngestService`, and `EmployeesModule` does not import `OutboxModule` — new wiring required either way.
- Payload MUST carry `tenantId` (like low-stock) so the Inngest function opens the correct CLS scope inside `runWithTenant`. Idempotency key: `${tenantId}:${timeOffId}`.

---

## 7. Multi-tenancy (confirmed safe)
Recipient resolution runs inside `runWithTenant(tenantId, ...)` → tenant-scoped Prisma → `resolveEmailsByUserIds` joins `tenantMembership` filtered by `tenantId` + `isActive` (`prisma-user-email-lookup.repository.ts:40-51`). Cross-tenant leakage is structurally impossible. The new HR function reuses this seam unchanged; the only requirement is a `tenantId` in the event payload.

---

## 8. Risks
- **Schema migration (destructive):** dropping `Employee.userId` also drops FK `employees_userId_fkey` + unique index `employees_tenantId_userId_key`. Safe because not in prod and the only runtime reader is `listPendingApprovalsForCurrentUser` (being deleted). Prisma will auto-generate the DROP; verify the migration touches ONLY `employees` (no collateral drift).
- **Two-place enum drift:** forgetting either the Prisma enum (`schema:205`) or the TS array (`notification-config.ts:12`) yields silent mismatches (`UNKNOWN_ACTION_KEY` 400s or an un-persistable value). `prisma/low-stock-migration-drift.spec.ts:52-54` only asserts `LOW_STOCK` presence — adding a value passes, but consider extending the assertion.
- **Generic-poller coupling:** Approach 1/2 edits the shared `outbox-poller.service.ts:66` exclusion predicate — a working prod-critical path. Keep the change to a single `NOT IN (...)` and cover with a claim-disjointness test.
- **Durability tradeoff (Approach 3):** best-effort send-after-commit can silently drop a notification if `InngestService.send` throws; acceptable only if the product treats HR notifications as non-critical.
- **Hidden consumers:** none found — repo-wide grep confirms `Employee.userId` has exactly one code reader + seed + one spec. Distinguish it from `requestedByUserId`/`reviewerUserId` (audit fields, kept) and JWT/CLS `userId` (unrelated).
- **Review budget:** Approach 1 (migration + schema + 2 deletions + new poller/dispatcher/module/registrar/function/template + inbox refactor + tests) will likely exceed the 400-line budget → forecast chained PRs in `tasks`.

---

## 9. Frontend handoff (downstream — NOT in this backend change)
Separate repo `frontend-houndfe` (not read). Flag for downstream:
- `notification-config` UI registry (REQ-10 data-driven "Acciones a notificar") needs a new HR submodule entry mapping the new action key.
- A "validations pending" inbox view must consume the refactored tenant-wide `pending-approvals` endpoint (no more current-user/manager semantics).

---

## 10. Ready for Proposal
**Yes.** The schema retirement, tenant-wide inbox, permission reuse (zero new CASL), and the two-place action-key addition are fully mapped and low-ambiguity. The one open architectural decision — durable dedicated pipeline (Approach 1) vs pragmatic direct-send (Approach 3) — should be resolved in `propose`/`design` because it drives the task count and PR-splitting strategy. Recommend the orchestrator proceed to **propose**, carrying the Approach 1-vs-3 fork forward as the headline decision.
