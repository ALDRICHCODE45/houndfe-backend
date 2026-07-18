# Delta for Employee Time-Off

This is the initial full specification for the `employee-time-off` capability
(no prior main spec exists). It encodes the locked 3-lever model: REQUEST is
gated by `create:EmployeeTimeOff`, REVIEW authority is the
`update:EmployeeTimeOff` permission (tenant-wide, no manager filter), and the
notification is owned by the `notification-config` capability (see
`time-off-notifications`). The prior `Employee.userId` bridge is retired; the
former manager-scoped pending-approvals inbox is replaced by a tenant-wide
inbox. No new CASL permissions are introduced.

## ADDED Requirements

### Requirement: Request Time-Off Validation

`POST /admin/employees/:employeeId/time-off` MUST create an
`EmployeeTimeOff` row in status `PENDING`. The call MUST require
`create:EmployeeTimeOff`. The caller MAY request for any employee in the
tenant (no org-chart relationship required); the requester's identity MUST be
recorded in the `requestedByUserId` audit field of the persisted row.

#### Scenario: Happy path — request created in PENDING

- GIVEN a caller with `create:EmployeeTimeOff` and a valid employee `E` in tenant `T`
- WHEN they POST `{ type, startDate, endDate, reason }` for `E`
- THEN an `EmployeeTimeOff` row exists in `T` with `status='PENDING'`, `employeeId=E.id`, and `requestedByUserId` equal to the caller's user id
- AND no other field of the row is changed by side effect

#### Scenario: Missing create permission denied

- GIVEN a caller without `create:EmployeeTimeOff`
- WHEN they POST a valid body
- THEN the response is HTTP 403 and no row is written

#### Scenario: Invalid date range rejected before persist

- GIVEN `endDate < startDate`
- WHEN the caller POSTs the body
- THEN the response is HTTP 400 `INVALID_DATE_RANGE` and no row is written

#### Scenario: Unknown employee rejected

- GIVEN `employeeId` does not exist in the tenant
- WHEN the caller POSTs the body
- THEN the response is HTTP 404 `EMPLOYEE_NOT_FOUND` and no row is written

### Requirement: Atomic Request Writes Time-Off and Outbox Event in One Transaction

A successful `request` MUST persist the `EmployeeTimeOff` row AND a `PENDING`
`outbox_events` row of type `hr.timeoff.requested` within a single tenant
transaction. If either insert fails, both MUST be rolled back. The outbox row
payload MUST carry `tenantId` and `timeOffId`; the idempotency key MUST be
`${tenantId}:${timeOffId}`.

#### Scenario: Success persists both rows

- GIVEN a successful `request` in tenant `T`
- WHEN the request resolves
- THEN exactly one `EmployeeTimeOff` row exists
- AND exactly one `outbox_events` row exists with `eventType='hr.timeoff.requested'`, `status='PENDING'`, `tenantId=T`, and `aggregateId=timeOffId`
- AND both rows share the same transaction commit

#### Scenario: Failure leaves no orphan row

- GIVEN the `outbox_events` insert fails after the `EmployeeTimeOff` insert
- WHEN the transaction rolls back
- THEN zero `EmployeeTimeOff` rows are persisted for the call
- AND zero `outbox_events` rows are persisted for the call

### Requirement: Approve or Reject Time-Off Validation (Review)

`POST /admin/employees/:employeeId/time-off/:timeOffId/review` MUST require
`update:EmployeeTimeOff` and MUST NOT consult the org chart, a manager
relationship, or `Employee.userId`. The persisted row's `reviewerUserId` MUST
be set to the caller's user id and `reviewedAt` MUST be set to the review
time. The decision MUST be one of `APPROVED` or `REJECTED`. The transition MUST
be allowed only from `PENDING`; any other current status MUST be rejected.

#### Scenario: Pending → Approved transitions and records reviewer

- GIVEN a `PENDING` row owned by employee `E`
- WHEN a caller with `update:EmployeeTimeOff` POSTs `{ decision: 'APPROVED' }`
- THEN the row's `status='APPROVED'`, `reviewerUserId=<caller>`, and `reviewedAt` is set
- AND the response is HTTP 200

#### Scenario: Pending → Rejected transitions and records reviewer

- GIVEN a `PENDING` row owned by employee `E`
- WHEN a caller with `update:EmployeeTimeOff` POSTs `{ decision: 'REJECTED' }`
- THEN the row's `status='REJECTED'`, `reviewerUserId=<caller>`, and `reviewedAt` is set

#### Scenario: Authority is the permission, not the notification recipients list

- GIVEN a caller with `update:EmployeeTimeOff` but NOT listed in
  `NotificationRecipient` for the tenant
- WHEN they POST `{ decision: 'APPROVED' }` on a `PENDING` row
- THEN the transition succeeds
- AND the notification-config recipients list is never read on the review path

#### Scenario: Missing update permission denied

- GIVEN a caller without `update:EmployeeTimeOff`
- WHEN they POST any decision
- THEN the response is HTTP 403 and the row is unchanged

#### Scenario: Reviewing a non-pending row is rejected

- GIVEN a row in `APPROVED`, `REJECTED`, or `CANCELLED`
- WHEN the caller POSTs a decision
- THEN the response is HTTP 409 `INVALID_TRANSITION` and the row is unchanged

### Requirement: Tenant-Wide Pending Approvals Inbox

`GET /admin/employees-time-off/pending-approvals` MUST require
`read:EmployeeTimeOff` and MUST return every `EmployeeTimeOff` row in the
caller's tenant with `status='PENDING'`. The response MUST NOT depend on
`Employee.userId`, `Employee.managerId`, or any caller-resolved manager
identity. Results MUST be ordered deterministically (start date ascending,
ties broken by row id ascending). The prior
`/admin/employees-time-off/pending-approvals/by-manager/:managerId` route MUST
NOT exist.

#### Scenario: Tenant-wide scope returns every PENDING row

- GIVEN tenant `T` with three `PENDING` rows owned by employees in different org branches
- WHEN any caller with `read:EmployeeTimeOff` in `T` calls the endpoint
- THEN the response contains all three rows
- AND no `Employee.userId` query is issued
- AND no `Employee.managerId` filter is applied

#### Scenario: Cross-tenant rows are never returned

- GIVEN tenants `T1` and `T2`, each with their own `PENDING` rows
- WHEN a `T1` caller calls the endpoint
- THEN only `T1` rows are returned; `T2` rows are not visible

#### Scenario: Deterministic ordering

- GIVEN multiple `PENDING` rows with distinct `startDate` values in `T`
- WHEN the caller calls the endpoint
- THEN rows are returned ordered by `startDate` ascending, with `id` ascending as the tie-breaker

#### Scenario: Missing read permission denied

- GIVEN a caller without `read:EmployeeTimeOff`
- WHEN they call the endpoint
- THEN the response is HTTP 403 and no rows are returned

### Requirement: Medical Reason Visibility Is Preserved Across the Inbox

The `read:EmployeeTimeOffMedical` permission MUST gate `SICK` row visibility
identically in every read path: per-employee list, tenant-wide inbox, and
vacation balance. A caller without the permission MUST receive `SICK` rows
with their `reason` stripped or redacted.

#### Scenario: SICK reason stripped in the tenant-wide inbox without permission

- GIVEN a `SICK` `PENDING` row with a `reason` in tenant `T`
- WHEN a caller with `read:EmployeeTimeOff` but NOT `read:EmployeeTimeOffMedical` in `T` calls the inbox endpoint
- THEN the row appears in the response WITHOUT a usable `reason` (stripped or redacted)

#### Scenario: SICK reason preserved in the tenant-wide inbox with permission

- GIVEN the prior scenario state
- WHEN a caller with BOTH `read:EmployeeTimeOff` AND `read:EmployeeTimeOffMedical` in `T` calls the inbox endpoint
- THEN the row appears with the original `reason` value

### Requirement: Cancel Time-Off

`POST /admin/employees/:employeeId/time-off/:timeOffId/cancel` MUST require
`update:EmployeeTimeOff` and MUST transition the row to `CANCELLED`. The
transition MUST be allowed when the current status is `PENDING`, or when it
is `APPROVED` and `startDate` is in the future; any other status (or an
already-started `APPROVED` row) MUST be rejected.

#### Scenario: Cancel a pending row

- GIVEN a `PENDING` row
- WHEN a caller with `update:EmployeeTimeOff` POSTs the cancel
- THEN the row's `status='CANCELLED'`

#### Scenario: Cancel a future approved row

- GIVEN an `APPROVED` row with `startDate` in the future
- WHEN the caller POSTs the cancel
- THEN the row's `status='CANCELLED'`

#### Scenario: Cancel an already-started approved row rejected

- GIVEN an `APPROVED` row with `startDate <= now`
- WHEN the caller POSTs the cancel
- THEN the response is HTTP 409 `INVALID_TRANSITION` and the row is unchanged

### Requirement: List Time-Off for a Single Employee

`GET /admin/employees/:employeeId/time-off` MUST require
`read:EmployeeTimeOff` and MUST return only that employee's rows. The
`SICK`-reason stripping rule MUST apply identically to the inbox.

#### Scenario: List scoped to one employee

- GIVEN employees `E1` and `E2` each with rows in tenant `T`
- WHEN the caller lists for `E1`
- THEN only `E1`'s rows are returned

### Requirement: Vacation Balance Is Unchanged by the Redesign

`GET /admin/employees/:employeeId/time-off/vacation-balance` MUST require
`read:EmployeeTimeOff` and MUST aggregate `APPROVED` and `PENDING` `VACATION`
rows in the requested year, using the employee's `annualVacationDays`. The
endpoint behavior MUST NOT change in this delta.

#### Scenario: Balance counts approved and pending vacation days

- GIVEN employee `E` with `annualVacationDays=20`, an `APPROVED` 5-day vacation, and a `PENDING` 3-day vacation in the year
- WHEN the caller requests the balance
- THEN the response is `{ entitlement: 20, used: 5, pending: 3, remaining: 15 }`

### Requirement: Employee.userId Is Retired

The `Employee` model MUST NOT expose a `userId` identity link (column,
foreign key, unique index, or back-relation on `User.employees`). No
runtime reader of `Employee.userId` MAY remain. The previous manager-scoped
pending-approvals routing (by-manager view and current-user-manager view) MUST
be removed and replaced exclusively by the tenant-wide inbox.

#### Scenario: Schema no longer carries the column

- GIVEN the destructive migration has run
- WHEN the `employees` table is inspected
- THEN the column, the foreign key `employees_userId_fkey`, and the unique index `employees_tenantId_userId_key` are absent
- AND `User.employees` back-relation is absent

#### Scenario: Removal preserves create / list / get / cancel / reactivate / salary / position / documents / emergency-contacts

- GIVEN the destructive migration has run and the manager-scoped routes are removed
- WHEN the surviving endpoints (`create`, `list`, `get`, `cancel`, `reactivate`, salary, position, documents, emergency-contacts) are exercised
- THEN each endpoint succeeds for a caller with the appropriate existing permission
- AND the tenant-wide inbox continues to return `PENDING` rows correctly

## Verification Surface

- `src/employees/employee-time-off.controller.spec.ts`
- `src/employees/application/employee-time-off.service.spec.ts` (rewritten for tenant-wide inbox + tx-wrapped `request`)
- `src/employees/application/employee-time-off.service.ts:42-72` (request tx wrap), `:218-262` (manager/current-user methods deleted; tenant-wide added)
- `src/employees/employee-time-off.controller.ts:86-101` (manager route removed; pending-approvals repointed)
- `prisma/schema.prisma:1355-1378` (column, FK, unique index removed)
- `prisma/migrations/<new>` (destructive migration; reverse of `20260528031500_add_employee_user_identity_link`)
- `prisma/seed.ts:1152-1156,1179-1180` (`userId` plumbing removed)