# Time-Off Notifications Specification

## Purpose

Define the durable, tenant-scoped notification pipeline that emits an HR
time-off request event and emails the tenant's configured
`NotificationRecipients`. This capability is owned by the `notification-config`
configuration (master toggle, recipient list, action allowlist) and is
triggered by a successful `EmployeeTimeOff` creation. Authority to approve
or reject is NOT a concern of this capability — that is the
`update:EmployeeTimeOff` permission on the `employee-time-off` capability.
Recipients are NOT routed by org chart, by manager identity, or by
`Employee.userId`.

## Requirements

### Requirement: Notification Emit Is a Sibling Concern to Authority

The notification pipeline MUST be triggered solely by the success of a time-off
`request`. The pipeline MUST NOT be triggered by, gated by, or read from the
`review`, `cancel`, `list`, `get`, `vacation-balance`, or any other operation
on `EmployeeTimeOff`. The capability to approve a request is
`update:EmployeeTimeOff`; the capability to be notified is the
`notification-config` master toggle plus the `TIME_OFF_REQUESTED` action key.

#### Scenario: Review does not trigger a notification

- GIVEN a `PENDING` time-off row
- WHEN a caller with `update:EmployeeTimeOff` posts a review decision
- THEN no outbox event is written
- AND no email is sent

#### Scenario: Cancel does not trigger a notification

- GIVEN a `PENDING` or future `APPROVED` time-off row
- WHEN the cancel endpoint is invoked
- THEN no outbox event is written
- AND no email is sent

### Requirement: Emit Gate Requires Master Toggle AND Action Key

When a time-off `request` succeeds, the system MUST emit a notification event
IF AND ONLY IF the calling tenant's `NotificationSettings.enabled` is `true`
AND `TIME_OFF_REQUESTED` is present in `NotificationAction.enabledActions`.
If the master toggle is `false`, the system MUST NOT write the outbox row. If
the action key is absent, the system MUST NOT write the outbox row. The
`request` row itself MUST still be persisted in both cases.

#### Scenario: All gates open → outbox row written

- GIVEN tenant `T` with `enabled=true`, recipients `[u1,u2]`, and `enabledActions=['TIME_OFF_REQUESTED']`
- WHEN a `request` succeeds in `T`
- THEN a `PENDING` `outbox_events` row of type `hr.timeoff.requested` is written

#### Scenario: Master toggle off → no outbox row, request still persists

- GIVEN tenant `T` with `enabled=false` and `enabledActions=['TIME_OFF_REQUESTED']`
- WHEN a `request` succeeds in `T`
- THEN the `EmployeeTimeOff` row is persisted
- AND no `outbox_events` row is written

#### Scenario: Action key absent → no outbox row, request still persists

- GIVEN tenant `T` with `enabled=true` and `enabledActions=[]`
- WHEN a `request` succeeds in `T`
- THEN the `EmployeeTimeOff` row is persisted
- AND no `outbox_events` row is written

### Requirement: Delivery Is Durable, Not Fire-and-Forget

The system MUST deliver the email through an outbox→poller→Inngest→mailer
pipeline. A failure at any stage MUST surface as a retryable, observable
state — never as a silently lost notification. The generic outbox poller's
exclusion list MUST include both `stock.low.detected` AND
`hr.timeoff.requested`; the dedicated HR poller MUST claim only
`hr.timeoff.requested`.

#### Scenario: Pipeline stages are claim-disjoint

- GIVEN both pollers are running
- WHEN an `hr.timeoff.requested` outbox row exists
- THEN the generic poller does NOT claim it (excluded by event type)
- AND the dedicated HR poller claims it within its tick window

#### Scenario: Mailer failure is retried, not dropped

- GIVEN a claimed `hr.timeoff.requested` row and the mailer port throws
- WHEN the Inngest function retries
- THEN the row remains un-`PUBLISHED` until the mailer succeeds
- AND after max retries the row reaches `FAILED` with an observable error

### Requirement: Recipients Are Resolved Within the Correct Tenant

When the Inngest function loads the config and resolves recipients, it MUST
operate inside `runWithTenant` for the `tenantId` carried in the outbox
payload. Recipient resolution MUST join the tenant's active memberships to
`User`. The system MUST NOT send emails to users outside the originating
tenant, and MUST NOT mix recipients across tenants when multiple tenants emit
events in the same poll tick.

#### Scenario: Tenant boundary respected

- GIVEN tenants `T1` and `T2` each with their own recipient list
- WHEN a `T1` request triggers emission
- THEN only `T1` users are emailed
- AND no `T2` user is emailed

#### Scenario: Inactive memberships excluded

- GIVEN tenant `T` with recipient `u1` whose membership is inactive
- WHEN a `T` request triggers emission
- THEN `u1` is NOT emailed

### Requirement: Idempotency Key Deduplicates Retries

The Inngest send for a given time-off request MUST use
`${tenantId}:${timeOffId}` as the idempotency key. A retried dispatch (e.g.
outbox poller claim lost, Inngest replay) MUST NOT result in a duplicate
email for the same request.

#### Scenario: Duplicate dispatch collapses to one email

- GIVEN a `PENDING` `hr.timeoff.requested` row in tenant `T` for time-off `X`
- WHEN the dispatcher sends it twice with idem key `T:X`
- THEN at most one email is delivered to the recipient set

### Requirement: Recipients Empty or Unresolved → No Send

If the tenant's recipient list is empty, or if resolution returns zero active
memberships, the system MUST NOT call the mailer port. The outbox row MUST
reach a terminal `PUBLISHED` (or `FAILED` if a lower-stage error occurred)
state without an outbound email.

#### Scenario: Empty recipients → no mailer call

- GIVEN tenant `T` with `enabled=true`, `TIME_OFF_REQUESTED` enabled, recipients `[]`
- WHEN a `T` request is processed by the Inngest function
- THEN the mailer port is never invoked
- AND the outbox row reaches `PUBLISHED`

## Verification Surface

- `src/hr-time-off/outbox/hr-time-off-outbox.poller.spec.ts` (claim-disjointness with generic poller)
- `src/hr-time-off/outbox/hr-time-off-outbox.dispatcher.spec.ts` (idem key, payload shape)
- `src/hr-time-off/inngest/timeoff-request.functions.spec.ts` (gates, recipient resolution, mailer invocation, tenant boundary)
- `src/shared/outbox/outbox-poller.service.spec.ts` (generic poller exclusion includes `hr.timeoff.requested`)
- `src/employees/application/employee-time-off.service.spec.ts:42-72` (request tx wrap + outbox write)