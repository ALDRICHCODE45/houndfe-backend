# Shipping settings screens — zones, zone validations, packaging, boxes, origin, opening hours

**Status:** implemented on the backend's local `main` (d858cc3, **not pushed**). The seed data in §8 comes from the dev showcase step `shipping` (branch `docs/fe-shipping-handoff`). §9 lists what is still pending.

Shapes in this document come from the controllers, DTOs, mappers and filters. The `GET` shapes and the error bodies marked **(seen)** were checked with read-only requests against the dev API on `:3003` on 2026-11-06. Write examples (`PUT`, `POST`, `PATCH`, `DELETE`) were not sent to the dev DB; they follow the code and its integration specs.

Sources: `docs/delivery-zones.md`, `docs/shipping-packaging.md`, `docs/chatbot-checkout-shipping.md` §4, `docs/shipping-quotes.md`.

## 0. Before you start: four error envelopes

These routes do **not** share one error body. Switch on the field named in each row, never on `message`.

| Envelope | Body | Used by |
| --- | --- | --- |
| **A. Domain** | `{ "statusCode", "error": "<CODE>", "message", "timestamp" }` | `403 INSUFFICIENT_PERMISSIONS` on every route; `ENTITY_NOT_FOUND`, `ENTITY_ALREADY_EXISTS`, `INVALID_OPENING_HOURS` |
| **B. Delivery-zone filter** | `{ "statusCode", "code": "<CODE>", "message" }` (key **`code`**, no `timestamp`) | Zone and zone-validation domain errors (§1, §2) |
| **C. Validation pipe** | `{ "statusCode": 400, "error": "Bad Request", "message": [ { "property", "children", "constraints": { "<rule>": "<text>" } } ] }` | Bad DTO bodies and query strings (unknown key, wrong type, out of range) |
| **D. Nest HTTP** | `{ "statusCode", "error": "Bad Request" \| "Not Found" \| "Forbidden" \| "Unauthorized", "message": "<text>" }` | Bad UUID or postal-code params, some `404`s, missing tenant context, `401` |

(seen) examples:

```json
{ "statusCode": 403, "error": "INSUFFICIENT_PERMISSIONS", "message": "Insufficient permissions", "timestamp": "2026-11-06T04:32:24.654Z" }
```

```json
{ "message": [ { "property": "limit", "children": [], "constraints": { "min": "limit must not be less than 1" } } ], "error": "Bad Request", "statusCode": 400 }
```

```json
{ "message": "Validation failed (uuid is expected)", "error": "Bad Request", "statusCode": 400 }
```

The guards always run in this order: JWT (`401`), then tenant context (`401 Tenant context required` for a non-admin token without a tenant), then CASL (`403 INSUFFICIENT_PERMISSIONS`), then params and body (`400`). A user without the permission therefore gets `403` even for a malformed id.

## 1. Who can do what

A sucursal is a tenant. Every route works only on the caller's sucursal (the JWT tenant).

| Screen / action | CASL (`action:Subject`) | Super Admin | Manager | Cashier | repartidor / Vendedor (showcase) |
| --- | --- | --- | --- | --- | --- |
| Zones: list, detail | `read:DeliveryZone` | ✓ | ✓ | — | — |
| Zones: create/replace, deactivate | `manage:DeliveryZone` | ✓ | ✓ | — | — |
| Pending validations: list, detail, approve/reject | `validate:DeliveryZone` (also granted by `manage:DeliveryZone`, a CASL wildcard) | ✓ | ✓ | — | — |
| Product/variant packaging: read | `read:Product` | ✓ | ✓ | ✓ | Vendedor ✓ |
| Product/variant packaging: write, delete | `update:Product` | ✓ | ✓ | — | — |
| Boxes, origin, opening hours: read | `read:ShippingSettings` | ✓ | ✓ | — | — |
| Boxes, origin, opening hours: write | `update:ShippingSettings` | ✓ | ✓ | — | — |

- Grants come from `prisma/seed.ts` (Manager gets `DeliveryZone` read/validate/manage and `ShippingSettings` read/update; Cashier gets none of them). `GET /admin/permissions` lists the subjects `DeliveryZone` (`read`, `manage`, `validate`) and `ShippingSettings` (`read`, `update`).
- **The dev DB on `:3003` was seeded before these grants existed.** Until the showcase step runs, `manager@houndfe.com` gets `403 INSUFFICIENT_PERMISSIONS` on every route in this document (seen). The showcase adds the five grants to the Centro and Norte `Manager` roles.
- **Super Admin** (`admin@houndfe.com`) logs in without a tenant:
  - The zone and zone-validation routes need a tenant. Without one they answer `403 { "message": "Tenant context required", "error": "Forbidden", "statusCode": 403 }` (envelope D, seen). Call `POST /auth/switch-tenant` first.
  - The `/tenants/:tenantId/...` routes accept any tenant path for a Super Admin (`manage:all`), even after switching. A UUID that is not a tenant still answers `200` with `configured: false` (seen). The FE should always send the active sucursal id.
- Hide or disable controls from `GET /admin/permissions` and the user's role grants. The backend checks again on every call.

## 2. Delivery zones

A zone is one row per sucursal and postal code (`zipCode`, 5 digits).

| `type` | `surchargeCents` | `etaDays` | Meaning (UI) |
| --- | --- | --- | --- |
| `FREE` | must be absent or `null` | required, `0..60` | «Envío gratis» with own delivery |
| `SURCHARGE` | required, integer `1..100000000` | required, `0..60` | Own delivery with a fixed surcharge |
| `CARRIER_ONLY` | must be absent or `null` | must be absent or `null` | Parcel carrier only; the carrier quote brings its own ETA |
| `DENIED` | must be absent or `null` | must be absent or `null` | Not delivered; the bot offers store pickup |

`PENDING` is not a zone type (see §3). A deactivated zone (`isActive: false`) behaves like an unknown postal code for the bot: the next customer who asks opens a new validation.

### 2.1 `GET /delivery-zones` — list

Query (all optional):

| Param | Rule |
| --- | --- |
| `page` | integer `1..10000`, default `1` |
| `limit` | integer `1..100`, default `20` |
| `search` | up to 100 chars, trimmed. Matches a `zipCode` **prefix**, or `state` / `municipality` / `neighborhood` containing the text (case-insensitive) |
| `type` | `FREE` \| `SURCHARGE` \| `CARRIER_ONLY` \| `DENIED` |
| `active` | `true` \| `false` (omit for both) |

Sorted by `zipCode` ascending. `200`:

```json
{
  "data": [
    {
      "id": "0b9e6a2c-…",
      "zipCode": "06700",
      "type": "SURCHARGE",
      "surchargeCents": 4500,
      "etaDays": 2,
      "state": "Ciudad de México",
      "municipality": "Cuauhtémoc",
      "neighborhood": "Roma Norte",
      "isActive": true,
      "approvedBy": { "id": "5c1d…", "displayName": "Manager Centro" },
      "approvedAt": "2026-11-06T18:00:00.000Z",
      "sourceValidationId": null,
      "createdAt": "2026-11-06T18:00:00.000Z",
      "updatedAt": "2026-11-06T18:00:00.000Z"
    }
  ],
  "pagination": { "pageIndex": 0, "pageSize": 20, "totalCount": 1, "pageCount": 1 }
}
```

- This is **not** the `{ items, nextCursor }` page from the handoff index conventions. `pageIndex` is 0-based; the `page` query param is 1-based. (seen, empty: `{"data":[],"pagination":{"pageIndex":0,"pageSize":20,"totalCount":0,"pageCount":0}}`)
- `approvedBy` is a snapshot of who last saved the zone (manual edit or validation resolve). `sourceValidationId` is the validation that last settled the zone, or `null` after a manual edit.
- `surchargeCents` and `etaDays` are `null` (never omitted) when the type does not use them. `state`, `municipality` and `neighborhood` can be `null`.

Errors: `400` (C) for a bad query, e.g. `?limit=0` or `?type=PENDING` (seen).

### 2.2 `GET /delivery-zones/:zipCode` — detail

Returns one zone, active or not, with the item shape above.

| Status | Body | When |
| --- | --- | --- |
| `400` | D `"zipCode must be exactly five digits"` (seen) | Param is not exactly 5 digits |
| `404` | D `{ "message": "Delivery zone not found", "error": "Not Found", "statusCode": 404 }` (seen) | No zone for that postal code |

### 2.3 `PUT /delivery-zones/:zipCode` — create or replace (`manage:DeliveryZone`)

Creates the zone, or replaces it, and (re)activates it. The approver becomes the caller and `sourceValidationId` becomes `null`.

```json
{ "type": "SURCHARGE", "surchargeCents": 4500, "etaDays": 2, "state": "Ciudad de México", "municipality": "Cuauhtémoc", "neighborhood": "Roma Norte" }
```

- **Whole-record replace:** an omitted `state`, `municipality` or `neighborhood` is stored as `null`. Always send the three labels you show.
- Labels: optional, `null` allowed, trimmed, 1–120 chars.
- `200` returns the zone (§2.1 item).

Valid / invalid examples:

| Body | Result |
| --- | --- |
| `{ "type": "FREE", "etaDays": 0 }` | `200` (same-day free delivery) |
| `{ "type": "CARRIER_ONLY" }` | `200` |
| `{ "type": "DENIED", "etaDays": null, "surchargeCents": null }` | `200` (`null` is the same as absent) |
| `{ "type": "SURCHARGE", "etaDays": 2 }` | `400` B `INVALID_DELIVERY_ZONE` — "A SURCHARGE zone requires a positive integer surchargeCents" |
| `{ "type": "SURCHARGE", "surchargeCents": 0, "etaDays": 2 }` | `400` B `INVALID_DELIVERY_ZONE` |
| `{ "type": "FREE", "surchargeCents": 100, "etaDays": 1 }` | `400` B `INVALID_DELIVERY_ZONE` — "surchargeCents is only allowed for a SURCHARGE zone" |
| `{ "type": "FREE" }` or `{ "type": "FREE", "etaDays": 61 }` | `400` B `INVALID_DELIVERY_ZONE` — "FREE and SURCHARGE zones require etaDays between 0 and 60" |
| `{ "type": "CARRIER_ONLY", "etaDays": 3 }` | `400` B `INVALID_DELIVERY_ZONE` — "etaDays is only allowed for FREE and SURCHARGE zones" |
| `{ "type": "SURCHARGE", "surchargeCents": 45.5, "etaDays": 2 }` | `400` C (`isInt`) |
| `{ "type": "PENDING" }`, an unknown key, or `"neighborhood": ""` | `400` C |

Shape errors (B) look like:

```json
{ "statusCode": 400, "code": "INVALID_DELIVERY_ZONE", "message": "A SURCHARGE zone requires a positive integer surchargeCents" }
```

Other errors:

| Status | Body | When |
| --- | --- | --- |
| `400` | D | `:zipCode` is not 5 digits |
| `401` | B `{ "statusCode": 401, "code": "UNAUTHORIZED", "message": "Unauthorized" }` | The user is inactive or not a member of the sucursal |
| `409` | B `DELIVERY_ZONE_VALIDATION_PENDING` — "A validation is pending for this postal code; resolve it instead", plus `validationId` | A validation is open for that postal code. Send the user to the validation (`GET /delivery-zone-validations/<validationId>`, §3.3), so the waiting customers get the answer |

The PENDING `409` is envelope B with one extra key, `validationId` (the PENDING validation of that postal code):

```json
{
  "statusCode": 409,
  "code": "DELIVERY_ZONE_VALIDATION_PENDING",
  "message": "A validation is pending for this postal code; resolve it instead",
  "validationId": "8a2f1c3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
}
```

### 2.4 `DELETE /delivery-zones/:zipCode` — deactivate (`manage:DeliveryZone`)

Soft deactivation. `200` returns the zone with `isActive: false`. Deleting an inactive zone again is also `200`. To reactivate, `PUT` the zone again. `DELETE` does not check for an open validation: it never answers `409 DELIVERY_ZONE_VALIDATION_PENDING`.

| Status | Body | When |
| --- | --- | --- |
| `404` | B `{ "statusCode": 404, "code": "DELIVERY_ZONE_NOT_FOUND", "message": "Delivery zone not found" }` | No zone for that postal code (note: envelope B here, D on `GET`) |

## 3. Pending zone validations

When a WhatsApp customer gives a postal code with no active zone, the bot opens a **validation**. There is at most one PENDING validation per sucursal and postal code. Every customer asking for that postal code joins it as a **requester** (`requesterCount`). One resolve answers all of them. The customer phone and conversation are never returned.

The FE cannot create validations; only the bot can.

### 3.1 Urgency (24 h WhatsApp rule)

WhatsApp allows a free-text reply only within 24 h of the customer's last message. The block is computed from the **oldest pending requester**:

- `lastCustomerMessageAt`: that requester's last message.
- `urgency.deadlineAt` = `lastCustomerMessageAt` + 24 h (UTC ISO).
- `urgency.hoursLeft`: hours left, rounded **down** to one decimal, never below `0`.
- `urgency.level`:

| `level` | Time left | Suggested UI |
| --- | --- | --- |
| `OK` | ≥ 12 h | neutral |
| `WARNING` | < 12 h | amber |
| `CRITICAL` | < 4 h | red |
| `EXPIRED` | 0 | grey: «Plazo vencido». The bot can no longer answer by free text, but the zone is still saved for future customers |

The values are computed when the server answers. To keep a live countdown, count down from `deadlineAt` on the client and refetch now and then. On a RESOLVED validation, `lastCustomerMessageAt` and `urgency` are `null`.

### 3.2 `GET /delivery-zone-validations` — list (`validate:DeliveryZone`)

Only PENDING validations. They are sorted by `lastCustomerMessageAt` ascending, so the earliest deadline comes first. Query: `page` (`1..10000`, default 1), `limit` (`1..100`, default 20) and optional `zipCode` (exactly 5 digits). `zipCode` narrows the list to that postal code: 0 or 1 item, since at most one validation is PENDING per postal code. Without it the list is unchanged. Pagination as in §2.1.

Example: `GET /delivery-zone-validations?zipCode=06600` returns the item below, or `{ "data": [], "pagination": { "pageIndex": 0, "pageSize": 20, "totalCount": 0, "pageCount": 0 } }` when nothing is pending for that postal code. A malformed `zipCode` (`6700`, `067000`, `06a00`) is a `400` C:

```json
{ "statusCode": 400, "error": "Bad Request", "message": [ { "property": "zipCode", "children": [], "constraints": { "matches": "zipCode must be exactly five digits" } } ] }
```

```json
{
  "data": [
    {
      "id": "8a2f1c3e-…",
      "zipCode": "06600",
      "state": "Ciudad de México",
      "municipality": "Cuauhtémoc",
      "neighborhood": "Juárez",
      "status": "PENDING",
      "version": 1,
      "createdAt": "2026-11-06T03:00:00.000Z",
      "requesterCount": 2,
      "lastCustomerMessageAt": "2026-11-06T03:00:00.000Z",
      "urgency": { "deadlineAt": "2026-11-07T03:00:00.000Z", "hoursLeft": 9, "level": "WARNING" },
      "resolution": null
    }
  ],
  "pagination": { "pageIndex": 0, "pageSize": 20, "totalCount": 1, "pageCount": 1 }
}
```

The place labels are what the customer typed (normalized by the bot). They are always strings here.

### 3.3 `GET /delivery-zone-validations/:id` — detail (`validate:DeliveryZone`)

Same item shape, PENDING or RESOLVED. A resolved one:

```json
{
  "id": "8a2f1c3e-…",
  "zipCode": "11000",
  "state": "Ciudad de México",
  "municipality": "Miguel Hidalgo",
  "neighborhood": "Lomas de Chapultepec",
  "status": "RESOLVED",
  "version": 2,
  "createdAt": "2026-11-05T22:00:00.000Z",
  "requesterCount": 1,
  "lastCustomerMessageAt": null,
  "urgency": null,
  "resolution": {
    "action": "APPROVE_DELIVERY_ZONE",
    "zoneType": "SURCHARGE",
    "surchargeCents": 8900,
    "etaDays": 3,
    "resolvedAt": "2026-11-06T18:00:00.000Z",
    "resolvedBy": { "id": "5c1d…", "displayName": "Manager Centro" }
  }
}
```

| Status | Body | When |
| --- | --- | --- |
| `400` | D `"Validation failed (uuid is expected)"` (seen) | `:id` is not a UUID |
| `404` | D `{ "message": "Delivery zone validation not found", "error": "Not Found", "statusCode": 404 }` (seen) | Missing, or another sucursal's |

There is no list of resolved validations. A resolved validation stays reachable by id, and the zone it created points to it through `sourceValidationId`.

### 3.4 `POST /delivery-zone-validations/:id/resolve` — approve or reject (`validate:DeliveryZone`)

One step decides everything («Todo junto»): deliver or not, the type, the surcharge and the usual days. The body is a closed union; any other key is rejected.

Approve:

```json
{
  "expectedVersion": 1,
  "resolutionRequestId": "3f6c9a1e-4b2d-4c8e-9f0a-1b2c3d4e5f60",
  "action": "APPROVE_DELIVERY_ZONE",
  "zoneType": "SURCHARGE",
  "surchargeCents": 4500,
  "etaDays": 2
}
```

Reject (the zone is saved as `DENIED`; the bot offers store pickup):

```json
{ "expectedVersion": 1, "resolutionRequestId": "3f6c9a1e-4b2d-4c8e-9f0a-1b2c3d4e5f60", "action": "REJECT_DELIVERY_ZONE" }
```

Rules:

- `expectedVersion`: the `version` you displayed (always `1` for a PENDING validation). It is a positive integer.
- `resolutionRequestId`: a UUID (v1–v8, lowercase hex) that the FE generates **once per user submission**. Reuse it only to retry the same body after a network error. It goes in the body, not in an `Idempotency-Key` header.
- `zoneType` on approve: `FREE`, `SURCHARGE` or `CARRIER_ONLY`. To deny, use `REJECT_DELIVERY_ZONE` (approving with `DENIED` is a `400`). `surchargeCents` and `etaDays` follow §2; `null` and absent are the same.
- `REJECT_DELIVERY_ZONE` must not carry `zoneType`, `surchargeCents` or `etaDays`.

In one transaction the backend: flips the validation to RESOLVED v2; creates or replaces the zone, activates it and sets `sourceValidationId`; and answers every waiting requester (the bot then messages each customer). The response is `200`, both the first time and on an exact replay:

```json
{
  "validation": { "…": "the §3.3 item, RESOLVED, version 2" },
  "zone": { "…": "the §2.1 item, with sourceValidationId = this validation id" }
}
```

Errors:

| Status | Body | When | FE action |
| --- | --- | --- | --- |
| `400` | B `{ "statusCode": 400, "code": "INVALID_DELIVERY_ZONE", "message": "…" }` | Any body problem: unknown or missing key, bad UUID, `expectedVersion` < 1, approve with `DENIED`, bad surcharge/ETA shape. The code is always `INVALID_DELIVERY_ZONE` (the message says "Invalid delivery zone resolve request" or names the shape rule) | Fix the form |
| `400` | D `"Validation failed (uuid is expected)"` | `:id` is not a UUID | — |
| `401` | B `UNAUTHORIZED` | Inactive user, or not a member of the sucursal | Log out |
| `404` | B `DELIVERY_ZONE_VALIDATION_NOT_FOUND` | Missing or another sucursal's (note: envelope B here, D on `GET`) | Back to the list |
| `409` | B `VERSION_CONFLICT` | `expectedVersion` is stale | Reload the detail |
| `409` | B `ALREADY_RESOLVED` | Another reviewer resolved it first, with another `resolutionRequestId` | Reload: show who decided and what |
| `409` | B `IDEMPOTENCY_CONFLICT` | The same `resolutionRequestId` was used with another body or by another user | Generate a new id only if the user really changed the decision; normally reload |

While a validation is PENDING, a manual `PUT /delivery-zones/<its zipCode>` answers `409 DELIVERY_ZONE_VALIDATION_PENDING` with its `validationId` (§2.3).

Email: when a validation opens, users with `validate:DeliveryZone` (or `manage`) can get an email «Validar zona de entrega: CP 06700». It is the notification action `DELIVERY_ZONE_VALIDATION_REQUESTED`, off until the sucursal enables it in `PUT /notification-config` (`enabledActions`). The showcase leaves it off.

## 4. Product and variant packaging

Packaging is the **packed item as handed to a carrier**: package weight in grams and outer size in centimetres. It is not the editorial net weight. Carrier quotes need it on every line; a line without it makes the quote fail.

| Field | Rule | Valid | Invalid (`400` C) |
| --- | --- | --- | --- |
| `weightG` | integer `1..70000` | `450`, `70000` | `0`, `10.5`, `70001` |
| `lengthCm`, `widthCm`, `heightCm` | number `0.1..300`, **at most one decimal** | `20.5`, `12`, `0.1` | `10.25`, `-1`, `300.1`, `0` |

All four fields are required on `PUT` (whole-record replace); an unknown key such as `netWeightG` is a `400`.

### 4.1 Product

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| `GET` | `/products/:productId/packaging` | `read:Product` | `200` |
| `PUT` | `/products/:productId/packaging` | `update:Product` | `200` |
| `DELETE` | `/products/:productId/packaging` | `update:Product` | `204` (idempotent) |

`PUT` body:

```json
{ "weightG": 450, "lengthCm": 20.5, "widthCm": 12, "heightCm": 8.3 }
```

`GET` / `PUT` response (`packaging: null` until it is set):

```json
{
  "productId": "6f1c…",
  "packaging": { "weightG": 450, "lengthCm": 20.5, "widthCm": 12, "heightCm": 8.3, "updatedAt": "2026-11-06T18:00:00.000Z" }
}
```

### 4.2 Variant (whole-record override)

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| `GET` | `/products/:productId/variants/:variantId/packaging` | `read:Product` | `200` |
| `PUT` | same | `update:Product` | `200` |
| `DELETE` | same | `update:Product` | `204` (back to inheriting) |

A variant either inherits the product record or has its **own complete record**, which replaces the product's. There is no per-field inheritance. `PUT` takes the same body as §4.1.

```json
{
  "productId": "6f1c…",
  "variantId": "a91e…",
  "override": { "weightG": 480, "lengthCm": 32, "widthCm": 22, "heightCm": 5.5, "updatedAt": "…" },
  "productPackaging": { "weightG": 320, "lengthCm": 25, "widthCm": 18, "heightCm": 4.5, "updatedAt": "…" },
  "effective": { "weightG": 480, "lengthCm": 32, "widthCm": 22, "heightCm": 5.5, "updatedAt": "…" },
  "source": "VARIANT"
}
```

- `source`: `"VARIANT"` (own record), `"PRODUCT"` (inherits), or `null` (no data anywhere; then `effective` is `null`).
- `effective` is what quotes use. Show it, with a «Heredado del producto» badge when `source` is `"PRODUCT"`.
- Suggested UI: «Usar el empaque del producto» (DELETE) / «Empaque propio» (PUT).

### 4.3 Errors (both)

| Status | Body | When |
| --- | --- | --- |
| `400` | C | Bad body |
| `400` | D `"Validation failed (uuid is expected)"` | `:productId` or `:variantId` is not a UUID |
| `404` | A `{ "statusCode": 404, "error": "ENTITY_NOT_FOUND", "message": "Product with id \"…\" not found", "timestamp": "…" }` (seen) | Product missing or in another sucursal. For a variant: `Variant with id "…" not found`, also when the variant belongs to another product |

The product and variant DTOs of `/products` are unchanged; packaging is only on these sub-resources.

## 5. Standard boxes

Boxes per sucursal. A quote packs the whole order into **one** box: the smallest active box where every item fits (items can rotate), the total item volume fits, and `maxContentWeightG` is enough. With no active box that fits, the carrier quote fails, so the store must keep boxes up to date. Only active boxes are used.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| `GET` | `/tenants/:tenantId/shipping-boxes` | `read:ShippingSettings` | `200` |
| `POST` | `/tenants/:tenantId/shipping-boxes` | `update:ShippingSettings` | `201` |
| `PATCH` | `/tenants/:tenantId/shipping-boxes/:boxId` | `update:ShippingSettings` | `200` |
| `DELETE` | `/tenants/:tenantId/shipping-boxes/:boxId` | `update:ShippingSettings` | `204` (hard delete) |

`POST` body (`PATCH` takes any subset of it):

```json
{ "name": "Caja chica", "innerLengthCm": 30, "innerWidthCm": 20, "innerHeightCm": 15, "weightG": 180, "maxContentWeightG": 5000, "isActive": true }
```

| Field | Rule |
| --- | --- |
| `name` | trimmed, 1–80 chars, unique in the sucursal |
| `innerLengthCm`, `innerWidthCm`, `innerHeightCm` | inner size; `0.1..300`, at most one decimal |
| `weightG` | the empty box's own weight; integer `1..70000` |
| `maxContentWeightG` | the most content it carries, **box weight not included**; integer `1..70000` |
| `isActive` | optional boolean, default `true`. To retire a box but keep it, `PATCH { "isActive": false }` |

Do not send `null` for a field on `PATCH`; leave it out.

`GET` response (seen, empty: `{"data":[]}`). Active boxes come first, then by name. It is not paginated.

```json
{
  "data": [
    {
      "id": "c0b7…",
      "name": "Caja chica",
      "innerLengthCm": 30,
      "innerWidthCm": 20,
      "innerHeightCm": 15,
      "weightG": 180,
      "maxContentWeightG": 5000,
      "isActive": true,
      "createdAt": "2026-11-06T18:00:00.000Z",
      "updatedAt": "2026-11-06T18:00:00.000Z"
    }
  ]
}
```

`POST` / `PATCH` return one box in the same shape.

| Status | Body | When |
| --- | --- | --- |
| `400` | C | Bad body: blank name, `weightG: 0`, `maxContentWeightG: 70001`, `innerLengthCm: 20.25`, `innerWidthCm: 301`, a missing size on `POST`, an unknown key |
| `400` | D | `:tenantId` or `:boxId` is not a UUID (seen for `:tenantId`) |
| `404` | D `"Shipping settings not found for tenant <id>"` | `:tenantId` is not the caller's sucursal (and the caller is not a Super Admin) |
| `404` | A `ENTITY_NOT_FOUND` `ShippingBox with id "…" not found` | The box is missing or in another sucursal |
| `409` | A `ENTITY_ALREADY_EXISTS` `ShippingBox "Caja chica" already exists` | Duplicate name (on `POST`, or a rename on `PATCH`) |

## 6. Shipping origin

The address carriers pick up from. It is separate from the free-text `Tenant.address` of the sucursal profile, which is unchanged. The bot also shows it as the pickup address.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| `GET` | `/tenants/:tenantId/shipping-origin` | `read:ShippingSettings` | `200` |
| `PUT` | `/tenants/:tenantId/shipping-origin` | `update:ShippingSettings` | `200`, `Cache-Control: no-store` |

`PUT` body (whole replace):

```json
{
  "addressLine1": "Av. Insurgentes Sur 1458",
  "addressLine2": "Local 3, planta baja",
  "neighborhood": "Del Valle Centro",
  "municipality": "Benito Juárez",
  "state": "Ciudad de México",
  "postalCode": "03100",
  "contactPhone": "5555432100"
}
```

| Field | Rule | Valid | Invalid (`400` C) |
| --- | --- | --- | --- |
| `addressLine1` | trimmed, 1–200 chars | `Av. Juárez 123` | `"  "` |
| `addressLine2` | optional, up to 200 chars; omitted, `null` or `""` → stored `null` | `Local 4` | — |
| `neighborhood` (colonia), `municipality` (alcaldía), `state` | trimmed, 1–120 chars, required | `Centro` | `" "`, missing |
| `postalCode` | exactly 5 digits | `06000` | `6000`, `06A00` |
| `contactPhone` | 10–15 digits, optional leading `+` | `5512345678`, `+525512345678` | `12345`, `55 1234 5678` |

Unknown keys (e.g. `country`) are a `400`. All four of colonia, alcaldía, state and postal code are needed for a carrier quote.

Response (seen, unconfigured: `{"configured":false,"origin":null}`):

```json
{
  "configured": true,
  "origin": {
    "addressLine1": "Av. Insurgentes Sur 1458",
    "addressLine2": "Local 3, planta baja",
    "neighborhood": "Del Valle Centro",
    "municipality": "Benito Juárez",
    "state": "Ciudad de México",
    "postalCode": "03100",
    "contactPhone": "5555432100",
    "updatedAt": "2026-11-06T18:00:00.000Z"
  }
}
```

Errors: `400` C or D, and `404` D for a foreign `:tenantId`, as in §5. There is no delete.

## 7. Opening hours

The sucursal's weekly hours, shown by the bot for store pickup.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| `GET` | `/tenants/:tenantId/opening-hours` | `read:ShippingSettings` | `200` |
| `PUT` | `/tenants/:tenantId/opening-hours` | `update:ShippingSettings` | `200`, `Cache-Control: no-store` |

`PUT` replaces the whole week:

```json
{
  "timeZone": "America/Mexico_City",
  "days": [
    { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "19:30" }] },
    { "day": "TUESDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "19:30" }] },
    { "day": "WEDNESDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "19:30" }] },
    { "day": "THURSDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "19:30" }] },
    { "day": "FRIDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "19:30" }] },
    { "day": "SATURDAY", "ranges": [{ "open": "09:00", "close": "14:00" }] },
    { "day": "SUNDAY", "ranges": [] }
  ]
}
```

Rules:

- `days` lists each of `MONDAY` … `SUNDAY` exactly once, in any order. They are stored and returned Monday first, and each day's ranges sorted by `open`.
- `ranges: []` means closed. A day has at most 6 ranges.
- Times are `HH:mm`, `00:00`–`23:59`; `open` must be before `close`; a range never crosses midnight.
- Ranges of a day must not overlap **or touch**: `09:00–14:00` + `14:00–18:00` must be sent as `09:00–18:00`.
- `timeZone` is an IANA zone. It is optional (up to 64 chars); the default is `America/Mexico_City`.

Response (seen, unconfigured: `{"configured":false,"openingHours":null}`):

```json
{
  "configured": true,
  "openingHours": {
    "timeZone": "America/Mexico_City",
    "days": [
      { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "19:30" }] },
      { "day": "SUNDAY", "ranges": [] }
    ],
    "updatedAt": "2026-11-06T18:00:00.000Z"
  }
}
```

(The example is cut short; `days` always has seven entries.)

| Body | Result |
| --- | --- |
| `MONDAY` `[{ "open": "16:00", "close": "20:00" }, { "open": "09:00", "close": "14:00" }]` | `200`, stored sorted |
| `{ "open": "9:00", "close": "14:00" }` | `400` C (time format) |
| `"day": "FUNDAY"`, an unknown key such as `note`, more than 7 days or 6 ranges | `400` C |
| Only six days, or `MONDAY` twice | `400` A `INVALID_OPENING_HOURS` ("Every weekday is required; missing SUNDAY") |
| `{ "open": "18:00", "close": "09:00" }` | `400` A `INVALID_OPENING_HOURS` ("FRIDAY: open must be before close") |
| `09:00–14:00` + `13:00–15:00`, or + `14:00–18:00` | `400` A `INVALID_OPENING_HOURS` ("FRIDAY: ranges must not overlap or touch") |
| `"timeZone": "Mars/Olympus"` | `400` A `INVALID_OPENING_HOURS` |

`INVALID_OPENING_HOURS` uses envelope A, and its `message` names the day, so it can be shown next to that day. A foreign `:tenantId` is a `404` D ("Opening hours not found for tenant <id>").

The bot's summary for this week reads: «Lunes a viernes: 09:00–14:00 y 16:00–19:30. Sábado: 09:00–14:00. Domingo: cerrado.» The store API does not return the summary; build the FE label from `days`.

## 8. Seed data on `:3003`

The data below exists **after** the backend runs the showcase step on the dev DB:

```sh
pnpm build && pnpm seed:showcase
```

That command runs all modules, `shipping` last. It is idempotent. Before that run, every list in this section is empty and `manager@houndfe.com` gets `403` (§1).

Log in as `manager@houndfe.com` (Sucursal Centro, id `ced6cc10-a037-4f41-92af-ee69bbb51c8b`; seeded dev password, not repeated here). Use `cashier@houndfe.com` or `vendedor@houndfe.com` to see the `403` screens. All zones and validations are approved/resolved by «Manager Centro».

**Zones** (`GET /delivery-zones` → 10 rows):

| `zipCode` | Colonia, alcaldía | `type` | Surcharge | `etaDays` | Notes |
| --- | --- | --- | --- | --- | --- |
| 03020 | Narvarte Poniente, Benito Juárez | `FREE` | — | 1 | |
| 03100 | Del Valle Centro, Benito Juárez | `FREE` | — | 0 | Same postal code as the sucursal |
| 03300 | Portales Norte, Benito Juárez | `FREE` | — | 1 | `isActive: false` (filter `active=false`) |
| 03810 | Nápoles, Benito Juárez | `FREE` | — | 1 | |
| 04000 | Villa Coyoacán, Coyoacán | `SURCHARGE` | $69.00 (`6900`) | 2 | |
| 06700 | Roma Norte, Cuauhtémoc | `SURCHARGE` | $45.00 (`4500`) | 2 | A showcase customer lives here |
| 11000 | Lomas de Chapultepec, Miguel Hidalgo | `SURCHARGE` | $89.00 (`8900`) | 3 | Created by an approved validation: `sourceValidationId` is set |
| 12000 | Villa Milpa Alta, Milpa Alta | `DENIED` | — | — | |
| 14000 | Tlalpan Centro, Tlalpan | `CARRIER_ONLY` | — | — | |
| 16000 | Xochimilco Centro, Xochimilco | `CARRIER_ONLY` | — | — | |

**Pending validations** (`GET /delivery-zone-validations` → 3 rows, in this order). Hours are measured from the moment the seed ran:

| `zipCode` | Colonia | Requesters | Oldest message | `level` right after seeding |
| --- | --- | --- | --- | --- |
| 03900 | San José Insurgentes, Benito Juárez | 1 | 21 h ago | `CRITICAL` (~3 h left) |
| 06600 | Juárez, Cuauhtémoc | 2 (15 h and 3 h ago) | 15 h ago | `WARNING` (~9 h left) |
| 04510 | Ciudad Universitaria, Coyoacán | 1 | 2 h ago | `OK` (~22 h left) |

The levels move with time (CRITICAL becomes EXPIRED about 3 h after the seed). A later re-run puts the planned levels back. If you resolve one while testing, it stays resolved: the seed does not reopen it. Use 11000 (`GET /delivery-zone-validations/<sourceValidationId of zone 11000>`) for the RESOLVED detail.

**Boxes:** «Caja chica» 30 × 20 × 15 cm, 180 g, carries 5000 g; «Caja mediana» 45 × 35 × 30 cm, 420 g, carries 20000 g. Both active.

**Origin:** Av. Insurgentes Sur 1458, Local 3, planta baja, Del Valle Centro, Benito Juárez, Ciudad de México, C.P. 03100, tel. 5555432100.

**Opening hours:** Monday to Friday 09:00–14:00 and 16:00–19:30; Saturday 09:00–14:00; Sunday closed; `America/Mexico_City`.

**Packaging** (find the ids with `GET /products?search=…`):

| Product | Packaging |
| --- | --- |
| Alimento para Cachorro Raza Mediana 3 kg | 3150 g, 35 × 22 × 10 cm |
| Arena Sanitaria Aglomerante 10 kg | 10300 g, 40 × 28 × 12 cm |
| Shampoo Hipoalergénico 500 ml | 560 g, 20.5 × 7 × 5.5 cm |
| Desparasitante Oral Canino 10 ml | 45 g, 9.5 × 4 × 2.5 cm |
| Arnés Acolchado para Paseo | 320 g, 25 × 18 × 4.5 cm. Variant «Grande» has its own record (480 g, 32 × 22 × 5.5 cm, `source: "VARIANT"`); «Chico» and «Mediano» inherit (`source: "PRODUCT"`) |

Every other product has no packaging (`packaging: null`, variant `source: null`).

The seed only creates what is missing, so your edits on the dev DB are kept on the next run. The dev DB is disposable: change this data freely.

## 9. Status: on `main` vs pending

On the backend's local `main` (d858cc3, not pushed yet), merged and covered by tests:

- Everything in §2–§7, the permissions in §1, and the bot side: validation intake/poll/ACK, the validation email, quotes with own zones and carriers, and checkout with a quote or store pickup.

Pending or open:

| Item | State | FE impact |
| --- | --- | --- |
| Skydropx live proof | The adapter is built but has never quoted live: the backend `.env` needs Skydropx credentials. Until then `CARRIER_ONLY` quotes answer `503 SHIPPING_QUOTE_UNAVAILABLE`. | None on these screens. The `CARRIER_ONLY` zones, origin, boxes and packaging can be set up now. |
| Sale ETA adjustment (task T4) | Not built: adjusting a sale's estimated delivery date and telling the customer through the bot. | No endpoint yet. Do not build a screen for it. |
| Shipping credit on the zone surcharge | $120 MXN per unit above $500 always applies to carrier cost. Whether it also applies to a `SURCHARGE` zone is **POR CONFIRMAR** (owner). It is a server setting, `true` for now. | None here. Do not promise it in the zone screen copy. |
| Legacy bot checkout contracts | The old `shipping { chargeCents, approvalId }` shape is still accepted and deprecated until the chatbot finishes moving to `{ quoteId }` / `{ mode: "pickup" }`. | None on the store screens. |
| Delivery status for pickup sales | A pickup sale uses `deliveryStatus: PENDING` plus `fulfillmentMode: "PICKUP"` on `GET /sales/:id`; a dedicated pickup status is not settled. | Sales screens only (show «Recoger en tienda» when `fulfillmentMode` is `PICKUP`). |
| Error envelopes | The four envelopes in §0 are as built. Unifying them (e.g. one `404` shape for zones) would be a backend change. Ask if it blocks you. | Handle all four for now. |
