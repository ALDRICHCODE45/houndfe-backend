# Delta for Notification Configuration

## ADDED Requirements

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