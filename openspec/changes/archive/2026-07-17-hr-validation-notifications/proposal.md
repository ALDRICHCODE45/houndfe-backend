# Proposal: HR time-off validations redesign + notifications (`hr-validation-notifications`)

## Intent

The HR time-off "validaciones" flow today conflates three concerns — who can
**request**, who can **approve**, and who gets **notified** — and bridges them
with the awkward `Employee.userId` column so the pending-approvals inbox can
resolve "the current user" back to a manager employee. The result is a
manager-scoped inbox that contradicts the actual authority model (a CASL
permission), a notification story that's bolted onto the employee model
instead of the Configuración→Notificaciones config, and one
runtime-only consumer of a column that exists for no other reason.

Business outcome: anyone with `update:EmployeeTimeOff` can act on any pending
request in the tenant (no org-chart filter), requesters go through
`create:EmployeeTimeOff`, and HR recipients are configured centrally — three
independent levers, each owned by its existing seam.

## Scope

### In Scope (backend-only)
- Retire `Employee.userId` (column + FK + unique index) via destructive migration.
- Refactor pending-approvals inbox to **tenant-wide**; drop manager-route + user-resolving service methods.
- Add new `NotificationActionKey` value, emit `hr/timeoff.requested` via a **durable dedicated** outbox→Inngest pipeline.
- Wire `request()` into `OutboxWriterService` inside a tenant tx.

### Out of Scope (downstream handoff)
- Frontend `notification-config` UI registry (HR submodule entry).
- Frontend `validations-pending` view consuming the tenant-wide endpoint.
- Manager/hierarchical approval routing, employee self-service, per-action recipients.

## Capabilities (contract with `sdd-spec`)

### New Capabilities
- `time-off-notifications`: durably emit an HR time-off request event through the existing notification pipeline and email configured recipients.

### Modified Capabilities
- `employee-time-off`: pending-approvals inbox becomes tenant-wide; request flow emits a notification event; `Employee.userId` bridge is gone.
- `notification-config`: registry gains a new `NotificationActionKey` value.

## Approach

**Chosen — Approach A: Dedicated durable pipeline (low-stock blueprint).**

1. Wrap `EmployeeTimeOffService.request()` (`src/employees/application/employee-time-off.service.ts:42-72`) in `tenantPrisma.runInTransaction`, write a `PENDING` `outbox_events` row via `OutboxWriterService.publish(...)` (mirrors `products.service.ts:742`).
2. Add `hr.timeoff.requested` to the generic poller's exclusion (`src/shared/outbox/outbox-poller.service.ts:66` → `AND eventType NOT IN ('stock.low.detected','hr.timeoff.requested')`).
3. New `HrTimeOffOutboxPoller` + `HrTimeOffOutboxDispatcher` claiming `eventType = 'hr.timeoff.requested'` → `InngestService.send('hr/timeoff.requested', payload, `${tenantId}:${timeOffId}`)`.
4. New `timeoff-request-email` Inngest function (loads config inside `runWithTenant`, gates `enabledActions.includes('TIME_OFF_REQUESTED')`, reuses `USER_EMAIL_LOOKUP` + `MAILER`); new React email template.
5. Idempotency: `${tenantId}:${timeOffId}` so replays dedupe at the Inngest boundary.

**Rejected — Approach C: direct `InngestService.send` from `request()`.** Smallest surface, but dual-write after commit — if `send()` throws the notification is silently lost. Inconsistent with the standing Inngest-mandate precedent ("Inngest is MANDATORY across many features, not just email", Engram #2673). Accept only if the product later decides HR notifications are best-effort; until then, durability wins.

### Action key — pick `TIME_OFF_REQUESTED`
- Mirrors the existing `LOW_STOCK` precedent (`<SUBJECT>_<STATE>` past-tense), so the registry stays homogeneous.
- Names the subject (time-off), not the workflow (validation), leaving room for future keys (`TIME_OFF_APPROVED`, `TIME_OFF_REJECTED`) without renaming.
- Matches the event name (`hr/timeoff.requested`) at the product surface frontend already shows as-is.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `prisma/schema.prisma:205-207` | Modified | Add `TIME_OFF_REQUESTED` to `NotificationActionKey` enum. |
| `prisma/schema.prisma:1355-1378` | Removed | Drop `Employee.userId` col + FK + `@@unique([tenantId, userId])`. |
| new `prisma/migrations/*` | New | `ALTER TYPE ... ADD VALUE 'TIME_OFF_REQUESTED'` + reverse of `20260528031500_add_employee_user_identity_link`. |
| `src/notification-config/domain/notification-config.ts:10-14` | Modified | Add to TS alias + array. |
| `src/employees/application/employee-time-off.service.ts:42-72` | Modified | Wrap in `runInTransaction`, call `OutboxWriter.publish`. |
| `src/employees/application/employee-time-off.service.ts:218-262` | Removed | Delete `listPendingApprovalsForManager` + `listPendingApprovalsForCurrentUser`; add tenant-wide `listPendingApprovals()`. |
| `src/employees/employee-time-off.controller.ts:86-101` | Removed | Drop `by-manager/:managerId` route; repoint `pending-approvals` to tenant-wide. |
| `src/employees/application/employee-time-off.service.spec.ts:472-507` | Rewritten | Tests adapt to tenant-wide query + tx-wrapped `request`. |
| `prisma/seed.ts:1152-1156,1179-1180` | Removed | Drop `userId` plumbing + unused `recordedByUserId` references. |
| `src/shared/outbox/outbox-poller.service.ts:66` | Modified | Extend exclusion `NOT IN ('stock.low.detected','hr.timeoff.requested')`. |
| `src/hr-time-off/{outbox,inngest,...}` | New | Poller, dispatcher, Inngest function, registrar, email template. |
| `src/employees/employees.module.ts` | Modified | Import `OutboxModule`, notification-config/user-email/mailer ports; register HR registrar. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Destructive migration touches more than `employees`. | Low | Review generated SQL touches only `employees`; FK + unique index only. |
| Two-place enum drift (Prisma vs TS). | Med | Update both + extend `low-stock-migration-drift.spec.ts:52-54` to assert both keys. |
| Generic-poller exclusion regression. | Low | Single `NOT IN (...)` change; cover with claim-disjointness test. |
| Approach A exceeds 400-line review budget. | High | Forecast chained/sliced delivery in `sdd-tasks`; solo-dev = work-unit commits on ONE feature branch, no PRs. |
| `request()` tx wrap behavior changes (no longer fire-and-forget). | Med | Wrap ONLY `request()`, not `review()`/`cancel()`; document. |

## Rollback Plan

1. Revert all code changes via single feature-branch revert (work-unit commits stay atomic).
2. New migration is `ALTER TYPE ... ADD VALUE` (additive, irreversible without DDL) → mitigated by the destructive `Employee.userId` drop living in the SAME migration, so rollback = revert commit + drop migration entirely (pre-prod, no in-flight rows).
3. Disable HR registrar in `app.module.ts` to stop the Inngest function binding; outbox rows remain PENDING until the poller exclusion is reverted.
4. Tenant-wide inbox has no rollback path (replaces the only inbox) — acceptable because the prior manager-filter is fully replaced, not parallel.

## Dependencies

- Inngest service must be reachable in dev/prod (already required for low-stock).
- `NOTIFICATION_CONFIG_REPOSITORY`, `USER_EMAIL_LOOKUP`, `MAILER`, `TenantRunnerService` tokens — all registered for low-stock; HR module reuses them.

## Locked Decisions (encode, do not re-open)

1. Three separate levers: REQUEST = `create:EmployeeTimeOff`; APPROVE authority = `update:EmployeeTimeOff` (tenant-wide, no manager filter); NOTIFY = Configuración→Notificaciones.
2. **Authority = permission; notification = config.** Never conflate.
3. Retire `Employee.userId` completely (column + FK + unique index). Pre-prod = destructive migration acceptable.
4. Emit via Approach A (durable dedicated pipeline); Approach C is rejected, documented as lighter alternative.
5. Pending-approvals becomes tenant-wide; `by-manager/:managerId` route + manager/current-user service methods are removed.

## Open Questions for `sdd-design` / `sdd-spec`

- Should the Inngest function email be **batched per tenant** like low-stock (`low-stock.functions.ts:120-124`), or fire per request? Default: per request (low cardinality in HR).
- Email template wording — generic vs per-action ("Se solicitó una validación de tiempo libre" vs "Se solicitó una vacación"). Default: generic; tenant doesn't vary copy.
- Do we need an idempotency drift test (`hr/timeoff.requested` retry dedupes via `${tenantId}:${timeOffId}`)? Yes — add alongside the low-stock one.
- Should `request()` failure (e.g. invalid range) still write the outbox row on the read path? No — only on the successful create.

## Non-Goals

- Manager/hierarchical approval routing.
- Employee self-service (everything stays admin-scoped).
- Per-action recipient lists (recipients remain a flat per-tenant set).
- Approval/rejection/cancellation notification events (only REQUESTED emits for now; future keys can extend without rename).
- Frontend work.

## Success Criteria

- [ ] `Employee.userId` and its FK + unique index are gone from schema and DB; no runtime reader remains.
- [ ] `GET /admin/employees-time-off/pending-approvals` returns every PENDING row in the tenant; `by-manager/:managerId` is removed.
- [ ] A successful `POST .../time-off` writes both the `EmployeeTimeOff` row AND a `PENDING` `outbox_events` row in one tx; rollback on failure drops both.
- [ ] The HR Inngest function fires only when `enabledActions.includes('TIME_OFF_REQUESTED')`; recipients resolved by `USER_EMAIL_LOOKUP`; mailer is the same `ResendMailer` instance.
- [ ] Zero new CASL permissions; existing `create/update/read:EmployeeTimeOff` + `read/update:NotificationConfig` cover all levers.
- [ ] Drift test asserts both `LOW_STOCK` and `TIME_OFF_REQUESTED` are present in the TS array and the Prisma enum.
