# Notification Configuration Specification

## Purpose

Define the per-tenant notification configuration bounded context: a master
enable/disable toggle, a single per-tenant recipient list, and a per-tenant
set of enabled actions (currently `LOW_STOCK` only). Provides the REST API
consumed by the Configuración → Notificaciones UI and the configuration
data read by downstream notification functions.

## Requirements

### Requirement: Read Per-Tenant Notification Config

`GET /notification-config` MUST return the calling tenant's
`{ enabled: boolean, recipients: string[], enabledActions: NotificationActionKey[] }`.
A tenant with no persisted rows MUST return `{ enabled: false, recipients: [], enabledActions: [] }`.

#### Scenario: Existing config returned verbatim
- GIVEN T1 with `enabled=true`, recipients `[u1,u2]`, `LOW_STOCK` enabled
- WHEN a T1 user calls `GET /notification-config`
- THEN response is `{ enabled:true, recipients:["u1","u2"], enabledActions:["LOW_STOCK"] }`

#### Scenario: Unconfigured tenant returns safe defaults
- GIVEN T2 with zero notification rows
- WHEN a T2 user calls `GET /notification-config`
- THEN response is `{ enabled:false, recipients:[], enabledActions:[] }`

#### Scenario: Tenant isolation on read
- GIVEN T1 and T2 each with distinct config
- WHEN a T1 user calls `GET /notification-config`
- THEN only T1's rows appear; T2's data is never read

#### Scenario: Read requires read:NotificationConfig
- GIVEN caller without `read:NotificationConfig`
- WHEN they call `GET /notification-config`
- THEN response is HTTP 403 and no config rows are read

### Requirement: Update Per-Tenant Notification Config

`PUT /notification-config` MUST overwrite the calling tenant's
`NotificationSettings.enabled`, replace its `NotificationRecipient` rows, and
replace its `NotificationAction` rows. Body:
`{ enabled: boolean, recipientUserIds: string[], enabledActions: NotificationActionKey[] }`.
Unknown action keys MUST be rejected with HTTP 400.

#### Scenario: Full overwrite succeeds
- GIVEN T1 with prior `{ enabled:true, recipients:[u1], actions:[LOW_STOCK] }`
- WHEN a T1 user PUTs `{ enabled:false, recipientUserIds:[u2,u3], enabledActions:[] }`
- THEN response is HTTP 200
- AND a follow-up `GET` returns the new state
- AND no leftover T1 recipient row references `u1`

#### Scenario: Unknown action key rejected
- GIVEN body `enabledActions:["LEAD_CREATED"]`
- WHEN `PUT /notification-config` is called
- THEN response is HTTP 400 `UNKNOWN_ACTION_KEY` and no rows are written

#### Scenario: Update requires update:NotificationConfig
- GIVEN caller without `update:NotificationConfig`
- WHEN they call `PUT /notification-config` with a valid body
- THEN response is HTTP 403 and the tenant's config is unchanged

### Requirement: Default State Is Notifications OFF

A tenant with no `NotificationSettings` row MUST behave as `enabled=false` with
empty recipients; any downstream send for that tenant MUST short-circuit.

#### Scenario: No config row means no outbound traffic
- GIVEN T with zero notification rows
- WHEN a T product crosses `<= minQuantity`
- THEN no email send is attempted and no Inngest function is enqueued for T

### Requirement: CASL Permission Is Grantable Per Role

`read:NotificationConfig` and `update:NotificationConfig` MUST be seeded into
`PERMISSION_REGISTRY` and grantable to any role via DB `RolePermission` rows.
No role receives them implicitly except super admin (`manage:all`).

#### Scenario: Permission rows seeded idempotently
- GIVEN the seeder has run once
- WHEN it runs again
- THEN exactly one `(NotificationConfig, read)` and one `(NotificationConfig, update)` row exist

#### Scenario: Grant via RolePermission enables access
- GIVEN role R with `RolePermission` granting `update:NotificationConfig`
- WHEN an R user calls `PUT /notification-config`
- THEN response is HTTP 200 (no hardcoded role check)

#### Scenario: Absence of grant denies access
- GIVEN role R with no grant for `update:NotificationConfig`
- WHEN an R user calls `PUT /notification-config`
- THEN response is HTTP 403

### Requirement: Empty Recipient List Suppresses Sends

If recipients are empty while `enabled=true` and `LOW_STOCK` is enabled, the
system MUST short-circuit: no mailer port call, no Resend API call.

#### Scenario: Empty recipients, master ON, action ON → no send
- GIVEN T with `enabled=true`, `LOW_STOCK` enabled, recipients `[]`
- WHEN a T crossing is emitted
- THEN the mailer port is never invoked and no email is sent

#### Scenario: Recipients added later enable subsequent sends
- GIVEN the prior scenario state
- WHEN a T user PUTs recipients `[u1]`
- THEN the next crossing sends ONE email to `u1`
- AND the prior suppressed send is NOT retroactively sent

### Requirement: NotificationActionKey Registry Accepts TIME_OFF_REQUESTED

The `NotificationActionKey` registry MUST accept `TIME_OFF_REQUESTED` as a
valid value alongside the existing `LOW_STOCK`. The registry MUST remain
closed: action keys outside the allowlist MUST continue to be rejected with
HTTP 400 `UNKNOWN_ACTION_KEY`. The TS alias and the Prisma enum MUST agree;
a drift between the two MUST be caught by an automated test.

#### Scenario: TIME_OFF_REQUESTED accepted on PUT

- GIVEN tenant `T` with no current `NotificationAction` rows
- WHEN a caller with `update:NotificationConfig` PUTs
  `{ enabled: true, recipientUserIds: ['u1'], enabledActions: ['TIME_OFF_REQUESTED'] }`
- THEN the response is HTTP 200
- AND a follow-up `GET` returns `enabledActions: ['TIME_OFF_REQUESTED']`

#### Scenario: Mixed registry accepted on PUT

- GIVEN tenant `T` with prior `enabledActions: ['LOW_STOCK']`
- WHEN the caller PUTs `enabledActions: ['LOW_STOCK', 'TIME_OFF_REQUESTED']`
- THEN the response is HTTP 200
- AND both keys are stored

#### Scenario: Unknown key still rejected

- GIVEN the registry contains only `LOW_STOCK` and `TIME_OFF_REQUESTED`
- WHEN the caller PUTs `enabledActions: ['LEAD_CREATED']`
- THEN the response is HTTP 400 `UNKNOWN_ACTION_KEY` and no rows are written

#### Scenario: Registry drift is caught by a test

- GIVEN the TS array `NOTIFICATION_ACTION_KEYS` and the Prisma enum `NotificationActionKey`
- WHEN the drift test runs
- THEN the test asserts both `LOW_STOCK` AND `TIME_OFF_REQUESTED` are present in BOTH places
- AND the test fails if either side is missing one of the two keys

## Verification Surface

- `src/notification-config/notification-config.controller.spec.ts`
- `src/notification-config/notification-config.service.spec.ts`
- `src/notification-config/infrastructure/prisma-notification-config.repository.spec.ts`
- `src/auth/authorization/seed/permission.seeder.spec.ts`
- `src/shared/prisma/tenant-isolation.spec.ts` (cross-tenant rows invisible)