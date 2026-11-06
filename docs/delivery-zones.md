# Delivery zones (shipping-zones / T1)

Covers specs **S1, S2, S3** of `odd/tasks/shipping-zones.md`. Design: `docs/shipping-and-delivery-zones-proposal.md` §1–§5, §10, §11.

A tenant is a sucursal. Every zone, zone validation and bot requester is tenant-scoped: the tenant comes from the JWT (store) or the service credential (bot), never from a request body, and another tenant's row always answers `404`.

## 1. Model

| Concept | Table | What it is |
| --- | --- | --- |
| Zone | `delivery_zones` | One row per tenant + postal code: `type`, `surchargeCents`, `etaDays`, place labels, `isActive`, approver snapshot (`approvedBy`, `approvedAt`), `sourceValidationId`. |
| Zone validation | `delivery_zone_validations` | The human decision for an unknown postal code. At most **one PENDING per tenant + postal code** (partial unique index). Versioned resolution `1 → 2`. |
| Requester | `delivery_zone_requests` | One row per bot intake (`sourceRequestId`). Each requester has its own `PENDING → RESOLVED → ACK` cycle, so every waiting customer is notified. Stores the customer phone and conversation reference (never returned by any endpoint). |

### Zone types

| Type | `surchargeCents` | `etaDays` | Meaning |
| --- | --- | --- | --- |
| `FREE` | must be absent/`null` | required, `0..60` | Own delivery at no cost. |
| `SURCHARGE` | required, `1..100000000` | required, `0..60` | Own delivery with a fixed surcharge. |
| `CARRIER_ONLY` | must be absent/`null` | must be absent/`null` | Parcel carrier only; the carrier quote brings its own ETA. |
| `DENIED` | must be absent/`null` | must be absent/`null` | Not delivered (the bot offers store pickup). |

The same rule is a database CHECK on all three tables. A violation is `400 INVALID_DELIVERY_ZONE`.

`PENDING` is not a zone type. It is an open validation.

A deactivated zone (`isActive: false`) is treated as an unknown postal code by the bot: the next intake opens a new validation.

## 2. Permissions

CASL subject `DeliveryZone`. `validate` is a new action verb.

| Permission | Grants |
| --- | --- |
| `read:DeliveryZone` | `GET /delivery-zones`, `GET /delivery-zones/:zipCode` |
| `manage:DeliveryZone` | `PUT` / `DELETE /delivery-zones/:zipCode`. CASL `manage` is a wildcard, so it also grants `read` and `validate`. |
| `validate:DeliveryZone` | `GET /delivery-zone-validations`, `GET /delivery-zone-validations/:id`, `POST /delivery-zone-validations/:id/resolve`; receiving the validation email. |

Seeded defaults (`prisma/seed.ts`; `PermissionSeeder` upserts the three rows on boot):

| Role | Grants |
| --- | --- |
| Super Admin | global `manage:all` (includes everything above) |
| Manager | `read`, `validate`, `manage` on `DeliveryZone` |
| Cashier | none |

Frontend impact: `GET /admin/permissions` now lists the subject `DeliveryZone` with actions `read`, `manage`, `validate`.

## 3. Store endpoints (JWT)

All store routes use `JwtAuthGuard → TenantContextGuard → PermissionsGuard`. Errors use the envelope `{ "statusCode", "code", "message" }`. Body validation errors (unknown keys, wrong types) come from the global validation pipe as `400`.

### 3.1 `GET /delivery-zones` — `read:DeliveryZone`

Query: `page` (1-based, default 1), `limit` (1..100, default 20), `search` (postal-code prefix or place text), `type`, `active` (`true` | `false`). Sorted by `zipCode`.

```json
{
  "data": [
    {
      "id": "0b9e…",
      "zipCode": "06700",
      "type": "SURCHARGE",
      "surchargeCents": 4500,
      "etaDays": 2,
      "state": "Ciudad de México",
      "municipality": "Cuauhtémoc",
      "neighborhood": "Roma Norte",
      "isActive": true,
      "approvedBy": { "id": "5c1d…", "displayName": "Gerente Centro" },
      "approvedAt": "2026-11-05T18:00:00.000Z",
      "sourceValidationId": "8a2f…",
      "createdAt": "2026-11-05T18:00:00.000Z",
      "updatedAt": "2026-11-05T18:00:00.000Z"
    }
  ],
  "pagination": { "pageIndex": 0, "pageSize": 20, "totalCount": 1, "pageCount": 1 }
}
```

### 3.2 `GET /delivery-zones/:zipCode` — `read:DeliveryZone`

Returns one zone, active or not. Responses: `400` if the postal code is not 5 digits, `404` if missing or foreign.

### 3.3 `PUT /delivery-zones/:zipCode` — `manage:DeliveryZone`

Creates or replaces the zone and (re)activates it. The approver is the caller, and `sourceValidationId` becomes `null`.

```json
{ "type": "FREE", "etaDays": 1, "state": "Ciudad de México", "municipality": "Cuauhtémoc", "neighborhood": "Roma Norte" }
```

`200` returns the zone.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `INVALID_DELIVERY_ZONE` | Shape rule broken. |
| `409` | `DELIVERY_ZONE_VALIDATION_PENDING` | A validation is open for that postal code. Resolve it instead, so the waiting customers get the answer. The body adds `validationId`, the id of that PENDING validation (read under the same per-postal-code lock that detected it). |

```json
{
  "statusCode": 409,
  "code": "DELIVERY_ZONE_VALIDATION_PENDING",
  "message": "A validation is pending for this postal code; resolve it instead",
  "validationId": "8a2f1c3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

### 3.4 `DELETE /delivery-zones/:zipCode` — `manage:DeliveryZone`

Soft deactivation. `200` returns the zone with `isActive: false`. `404 DELIVERY_ZONE_NOT_FOUND` if missing or foreign. It does not check for an open validation, so it never answers `409 DELIVERY_ZONE_VALIDATION_PENDING`.

### 3.5 `GET /delivery-zone-validations` — `validate:DeliveryZone`

PENDING validations, **one per postal code**. They are sorted by the oldest pending requester's `lastCustomerMessageAt` ascending, so the earliest WhatsApp deadline comes first. Query: `page`, `limit`, and optional `zipCode` (exactly 5 digits) that narrows the list to that postal code (0 or 1 item, since at most one is PENDING per postal code). Example: `GET /delivery-zone-validations?zipCode=06700`. A malformed `zipCode` is a validation-pipe `400`:

```json
{ "statusCode": 400, "error": "Bad Request", "message": [ { "property": "zipCode", "children": [], "constraints": { "matches": "zipCode must be exactly five digits" } } ] }
```

```json
{
  "data": [
    {
      "id": "8a2f…",
      "zipCode": "06700",
      "state": "Ciudad de México",
      "municipality": "Cuauhtémoc",
      "neighborhood": "Roma Norte",
      "status": "PENDING",
      "version": 1,
      "createdAt": "2026-11-05T15:00:00.000Z",
      "requesterCount": 2,
      "lastCustomerMessageAt": "2026-11-05T05:00:00.000Z",
      "urgency": { "deadlineAt": "2026-11-06T05:00:00.000Z", "hoursLeft": 11, "level": "WARNING" },
      "resolution": null
    }
  ],
  "pagination": { "pageIndex": 0, "pageSize": 20, "totalCount": 1, "pageCount": 1 }
}
```

Urgency ("Urgencia + plazo"):
- `deadlineAt` = oldest pending requester's `lastCustomerMessageAt` + 24 h.
- `hoursLeft` is rounded down to one decimal and never goes below 0.
- `level` is one of:

| `level` | Time left |
| --- | --- |
| `OK` | ≥ 12 h |
| `WARNING` | < 12 h |
| `CRITICAL` | < 4 h |
| `EXPIRED` | 0 |

### 3.6 `GET /delivery-zone-validations/:id` — `validate:DeliveryZone`

Returns the same item shape for a PENDING or RESOLVED validation. On a RESOLVED validation, `urgency` and `lastCustomerMessageAt` are `null`. `404` if missing or foreign.

### 3.7 `POST /delivery-zone-validations/:id/resolve` — `validate:DeliveryZone`

The body is a closed union. Unknown keys are rejected with `400`.

```json
{ "expectedVersion": 1, "resolutionRequestId": "3f6c…", "action": "APPROVE_DELIVERY_ZONE", "zoneType": "SURCHARGE", "surchargeCents": 4500, "etaDays": 2 }
```

```json
{ "expectedVersion": 1, "resolutionRequestId": "3f6c…", "action": "REJECT_DELIVERY_ZONE" }
```

- `APPROVE_DELIVERY_ZONE`: `zoneType` must be `FREE`, `SURCHARGE` or `CARRIER_ONLY`, with the shape rules from §1 ("Todo junto": deliver or not, type, surcharge and usual days in one step).
- `REJECT_DELIVERY_ZONE`: always settles the zone as `DENIED`.

In **one transaction** (under the postal-code lock), resolving:
1. flips the validation `PENDING v1 → RESOLVED v2`;
2. creates or updates the zone and activates it, with `sourceValidationId` = this validation;
3. resolves every PENDING requester of the validation with the zone outcome.

`200` (first resolve and exact replay):

```json
{
  "validation": {
    "id": "8a2f…",
    "zipCode": "06700",
    "status": "RESOLVED",
    "version": 2,
    "requesterCount": 2,
    "lastCustomerMessageAt": null,
    "urgency": null,
    "resolution": {
      "action": "APPROVE_DELIVERY_ZONE",
      "zoneType": "SURCHARGE",
      "surchargeCents": 4500,
      "etaDays": 2,
      "resolvedAt": "2026-11-05T18:00:00.000Z",
      "resolvedBy": { "id": "5c1d…", "displayName": "Gerente Centro" }
    }
  },
  "zone": { "zipCode": "06700", "type": "SURCHARGE", "surchargeCents": 4500, "etaDays": 2, "isActive": true, "sourceValidationId": "8a2f…" }
}
```

The response above is trimmed. `validation` also carries `state`, `municipality`, `neighborhood` and `createdAt`; `zone` is the full object from §3.1.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `INVALID_DELIVERY_ZONE` / validation error | Bad body or shape. |
| `401` | `UNAUTHORIZED` | Inactive user, or not a member of the tenant. |
| `403` | — | Missing `validate:DeliveryZone`. |
| `404` | `DELIVERY_ZONE_VALIDATION_NOT_FOUND` | Missing or foreign validation. |
| `409` | `VERSION_CONFLICT` | `expectedVersion` is stale. |
| `409` | `IDEMPOTENCY_CONFLICT` | Same `resolutionRequestId` with another payload or actor. |
| `409` | `ALREADY_RESOLVED` | Resolved with another `resolutionRequestId`. |

## 4. Bot cycle (service credential)

DELIVERY_ZONE reuses the existing human-decision bot routes and scopes. `DELIVERY_ZONE` is a wire discriminator only: these rows are **not** stored in `human_decisions`. The store list, detail and resolve routes under `/human-decisions`, and every RESTOCK/EXPIRATION response, are unchanged.

| Route | Scope | DELIVERY_ZONE behavior |
| --- | --- | --- |
| `POST /chatbot-api/human-decisions` | `human-decisions:create` | Intake when `type` is `"DELIVERY_ZONE"`. |
| `GET /chatbot-api/human-decisions/:id` | `human-decisions:read` | Poll by **requester id**. |
| `POST /chatbot-api/human-decisions/:id/application-outcome` | `human-decisions:ack` | Terminal ACK per **requester id**. |

The poll and ACK always try RESTOCK/EXPIRATION first. Only their not-found falls through to a DELIVERY_ZONE requester, so a miss in both is the same `404`.

### 4.1 Intake

Header `X-Idempotency-Key` must equal `sourceRequestId` byte for byte. The body must contain **exactly** these keys:

```json
{
  "sourceRequestId": "6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b",
  "type": "DELIVERY_ZONE",
  "zipCode": "06700",
  "state": "Ciudad de México",
  "municipality": "Cuauhtémoc",
  "neighborhood": "Roma Norte",
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "conversationRef": "wa:conv-123",
  "lastCustomerMessageAt": "2026-11-05T10:00:00.000Z"
}
```

| Key | Rule |
| --- | --- |
| `sourceRequestId` | UUID v1–v8. |
| `zipCode` | Exactly 5 digits. |
| `state`, `municipality`, `neighborhood` | 1–120 characters after whitespace collapse; no control characters. |
| `phoneCountryCode` | 1–10 digits, no `+` (as in `pricing/evaluate-cart`). |
| `phone` | 1–20 digits. |
| `conversationRef` | 1–200 characters. |
| `lastCustomerMessageAt` | ISO UTC instant, no more than 5 min in the future. |

Any violation is `400 VALIDATION_ERROR`.

Semantics (agreed with the chatbot):
- **Requester identity = `sourceRequestId`** (sender + turn, as in RESTOCK).
  - Same id and same content: replay, `200`, the same requester.
  - Same id with different content: `409 IDEMPOTENCY_CONFLICT`.
  - A new id: a new requester, `201`.
- **Zone already active for the postal code:** the requester is created already `RESOLVED` (`resolution.source = "EXISTING_ZONE"`, `decisionId: null`). No validation is opened.
- **Otherwise:** the requester joins the **single PENDING validation** of the postal code. That validation is opened if none is open, and the email outbox row is written then (§5). Several customers asking for the same postal code share one validation (`decisionId`), and each one is answered on its own.
- Every intake writer, resolve and manual zone edit for one tenant + postal code is serialized by a transaction advisory lock. A race therefore always ends in one of the two cases above.

`201` / `200` body. Unlike the RESTOCK receipt, this is the **current** requester state:

```json
{
  "id": "c41b…",
  "sourceRequestId": "6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b",
  "type": "DELIVERY_ZONE",
  "status": "PENDING",
  "version": 1,
  "createdAt": "2026-11-05T10:01:00.000Z",
  "decisionId": "8a2f…",
  "snapshot": {
    "branchName": "Sucursal Centro",
    "zipCode": "06700",
    "state": "Ciudad de México",
    "municipality": "Cuauhtémoc",
    "neighborhood": "Roma Norte"
  },
  "resolution": null,
  "applyBefore": null
}
```

### 4.2 Poll — `GET /chatbot-api/human-decisions/:id` (requester id)

Same body as the intake, in the current state, with `Cache-Control: no-store`. Once resolved:

```json
{
  "status": "RESOLVED",
  "version": 2,
  "decisionId": "8a2f…",
  "resolution": {
    "source": "VALIDATION",
    "zoneType": "SURCHARGE",
    "surchargeCents": 4500,
    "etaDays": 2,
    "resolvedAt": "2026-11-05T18:00:00.000Z"
  },
  "applyBefore": "2026-11-06T18:00:00.000Z"
}
```

- `resolution.source` is `VALIDATION` (a human decided) or `EXISTING_ZONE` (answered at intake).
- `surchargeCents` and `etaDays` are **omitted** (never `null`) when they do not apply: e.g. `DENIED` and `CARRIER_ONLY` carry neither.
- `applyBefore` = `resolvedAt` + 24 h.
- The customer phone, conversation reference, tenant, source, hash and credential are never returned.

### 4.3 ACK — `POST /chatbot-api/human-decisions/:id/application-outcome` (requester id)

The body, outcomes and response are identical to the RESTOCK ACK: `expectedResolutionVersion: 2`, `attemptId`, `outcome` (`PROVIDER_ACCEPTED`, `PROVIDER_ACCEPTED_LATE`, `DELIVERY_UNKNOWN`, `STALE`) and its evidence. Rules:
- One terminal outcome **per requester**.
- An exact replay (same `attemptId` + evidence) returns `200` with the same acknowledgment.
- Errors: `409 IDEMPOTENCY_CONFLICT`, `409 OUTCOME_ALREADY_RECORDED`, `409 VERSION_CONFLICT` (requester not resolved yet), `404` (missing or foreign).
- The application window is **24 h**: `[resolvedAt, resolvedAt + 24 h)`, the same as EXPIRATION. Outside it: `400`.

## 5. Email (S3)

New `NotificationActionKey` **`DELIVERY_ZONE_VALIDATION_REQUESTED`** (migration `20261106010000_delivery_zone_notification_action`).

Default enablement:
- Like every action since `PROMOTION_EXPIRING`, **no rows are seeded**. The action is disabled until a tenant opts in with `PUT /notification-config` (`enabled: true`, the key in `enabledActions`, recipients selected).
- `GET /notification-config` only lists enabled actions, so tenants that never opt in see no change.

Pipeline (same as `TIME_OFF_REQUESTED`):
1. The intake that **opens** a validation writes an `outbox_events` row in the same transaction. This happens only when the master toggle is on and the action is enabled.
   - `eventType`: `delivery_zone.validation.requested`
   - `aggregateType`: `DeliveryZoneValidation`
   - `aggregateId`: the validation id
   - payload: `tenantId`, `validationId`, `branchName`, `zipCode`, `state`, `municipality`, `neighborhood`, `lastCustomerMessageAt`, `deadlineAt`
   - Joining an existing validation writes nothing.
2. `DeliveryZoneOutboxPoller` / `DeliveryZoneOutboxDispatcher` claim only that event type. The generic poller excludes it. The dispatcher awaits `InngestService.send('delivery-zones/validation.requested', payload, "<tenantId>:<validationId>")`, with retries and backoff.
3. The Inngest function `delivery-zone-validation-email` handles it:
   1. Re-checks the gate.
   2. Narrows the configured recipients to active tenant members holding `validate:DeliveryZone`, `manage:DeliveryZone` or `manage:all`.
   3. Renders `src/notifications/email/templates/delivery-zone-validation.email.tsx`. The subject is `Validar zona de entrega: CP 06700`. The Spanish body states the deadline (`deadlineAt`, Mexico City time) and the WhatsApp 24 h rule. The CTA links to `APP_WEB_URL`. No customer phone is included.

## 6. Migrations

| Folder | Content |
| --- | --- |
| `20261106010000_delivery_zone_notification_action` | `ALTER TYPE "NotificationActionKey" ADD VALUE 'DELIVERY_ZONE_VALIDATION_REQUESTED'` |
| `20261106010100_delivery_zones` | 3 enums, 3 tables, partial unique index, shape/range/resolution/ACK CHECKs. Additive only; `human_decisions` is untouched. |
