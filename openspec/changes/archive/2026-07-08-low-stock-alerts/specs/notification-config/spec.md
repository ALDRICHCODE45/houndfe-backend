# Delta for notification-config

> New domain. Owns per-tenant notification configuration (master toggle,
> recipient list, enabled actions) and the REST API for the Notificaciones UI.

## ADDED Requirements

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