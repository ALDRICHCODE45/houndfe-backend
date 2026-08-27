# Delivery Routes — Frontend Integration Guide

**Feature**: `delivery-routes` — route planning, driver check-ins, route timeline and the "next stop" arriving-soon email
**Module**: `src/delivery-routes/` (HTTP) + `src/notification-config/` (email opt-in)
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL
**Branch**: `feat/delivery-routes-wu3`
**Status**: ✅ WU3 implemented (timeline on detail, next-stop email pipeline via outbox + Inngest)

> **TL;DR.** A route-manager groups eligible sales (`deliveryStatus` `PENDING`/`SHIPPED` + a shipping address) into a `DeliveryRoute` assigned to a driver. The route goes `DRAFT → ACTIVE → COMPLETED` (or `CANCELLED`). Drivers check in each stop from the field; every check-in mirrors the sale to `DELIVERED` and — when another stop follows — queues the "next stop arriving soon" email to the next customer (opt-in per tenant via `PUT /notification-config`). The detail endpoint returns a read-only `timeline` so the frontend can render route history without polling extra endpoints.

---

## 1. Endpoint overview

All routes are under `/delivery-routes` and require a JWT bearer token. The tenant is resolved from the token (CLS); a route id that belongs to another tenant returns `404`, never `403` (presence is not leaked across tenants).

| Method | Endpoint | Permission | Description |
| ------ | -------- | ---------- | ----------- |
| `POST` | `/delivery-routes` | `create:DeliveryRoute` | Create a DRAFT route from ≥1 eligible sale (`201 Created`) |
| `GET` | `/delivery-routes` | `read:DeliveryRoute` | List routes. Drivers see **only their own**; route-managers see the tenant-wide list |
| `GET` | `/delivery-routes/:id` | `read:DeliveryRoute` | Route detail + timeline |
| `PATCH` | `/delivery-routes/:id` | `update:DeliveryRoute` | DRAFT-only: reassign driver and/or update notes |
| `DELETE` | `/delivery-routes/:id` | `delete:DeliveryRoute` | Hard-delete a DRAFT route with zero stops (`204 No Content`) |
| `POST` | `/delivery-routes/:id/start` | `update:DeliveryRoute` | DRAFT → ACTIVE |
| `POST` | `/delivery-routes/:id/cancel` | `update:DeliveryRoute` | DRAFT or ACTIVE → CANCELLED |
| `POST` | `/delivery-routes/:id/stops` | `update:DeliveryRoute` | Append one eligible sale to a DRAFT route (`201 Created`) |
| `POST` | `/delivery-routes/:id/stops/:stopId/check-in` | `update:DeliveryRoute` | Check in a stop on an ACTIVE route; mirrors the sale to DELIVERED; emits the next-stop email row when a next stop exists |
| `PUT` | `/delivery-routes/:id/stops/reorder` | `update:DeliveryRoute` | Replace the stop order of a DRAFT route |

**Route lifecycle** (server-enforced):

```
DRAFT ──start──▶ ACTIVE ──checkInStop(last)──▶ COMPLETED
  │                 │
  └──cancel──┐  ┌──cancel──┐
             ▼  ▼
          CANCELLED
```

`COMPLETED` is terminal. `start` requires at least one stop; `PATCH`/`stops`/`reorder` are DRAFT-only; `check-in` requires ACTIVE.

---

## 2. Response shape — `DeliveryRouteResponseDto`

Every route endpoint (except `DELETE`, which is `204`) returns this shape:

```typescript
{
  id: string;                        // UUID
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  driver: { id: string; name: string; email: string } | null;
  startedAt: string | null;          // ISO 8601
  completedAt: string | null;        // ISO 8601
  cancelledAt: string | null;        // ISO 8601
  notes: string | null;              // ≤ 280 chars, trimmed
  stops: DeliveryRouteStop[];        // sorted by sortOrder ASC
  timeline: DeliveryRouteTimelineEvent[];  // see §4
}
```

`DeliveryRouteStop`:

```typescript
{
  id: string;                       // stop UUID
  saleId: string;                   // the sale this stop delivers
  saleFolio: string | null;         // e.g. "A-202608-000123" (null when the sale has no folio yet)
  sortOrder: number;                // 0-based position in the route
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  checkedInAt: string | null;       // ISO 8601, set on check-in
  completedAt: string | null;       // ISO 8601, set on check-in
  customer: { id: string; name: string; email: string | null } | null;
  shippingAddress: {
    id: string;
    street: string | null;
    exteriorNumber: string | null;
    interiorNumber: string | null;
    zipCode: string | null;
    neighborhood: string | null;
    municipality: string | null;
    city: string | null;
    state: string | null;
    label: string | null;
  } | null;
}
```

Notes:

- `customer.name` is `firstName + ' ' + lastName` (trimmed), already concatenated by the backend.
- `customer` / `shippingAddress` are `null` when the sale has no customer / no shipping address.
- The backend never exposes the internal `activeRouteId` marker column (authorization/invariant machinery, not wire data).
- The `timeline` field is present on **both** `GET /delivery-routes/:id` and every item of `GET /delivery-routes`.

---

## 3. Endpoints — full detail

### 3.1 `POST /delivery-routes` — create a route (`create:DeliveryRoute`)

**Request** `201 Created`:

```json
{
  "saleIds": ["11111111-2222-3333-4444-555555555555", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
  "driverUserId": "00000000-0000-0000-0000-0000000000aa",
  "notes": "Entrega del viernes"
}
```

| Field | Type | Required | Validation |
| ----- | ---- | -------- | ---------- |
| `saleIds` | `string[]` | ✅ | ≥ 1 uuid v4. Every sale is re-checked for eligibility server-side |
| `driverUserId` | string | ✅ | uuid v4 |
| `notes` | string | ❌ | ≤ 280 chars, trimmed |

**Response**: `DeliveryRouteResponseDto` with `status: "DRAFT"` and one `PENDING` stop per sale (sortOrder 0..n-1).

**Eligibility rule (server-side)**: a sale can join a route only when `deliveryStatus ∈ {PENDING, SHIPPED}` **and** it has a `shippingAddressId`. Any ineligible sale fails the whole create with `422 DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` (details include the offending `saleId`).

**Errors**: `401` no token · `403` missing `create:DeliveryRoute` · `422 DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` · `400` DTO validation (non-uuid ids, empty `saleIds`).

### 3.2 `GET /delivery-routes` — list routes (`read:DeliveryRoute`)

**Query** (all optional): `?status=DRAFT|ACTIVE|COMPLETED|CANCELLED`

**Response** `200`: array of `DeliveryRouteResponseDto` ordered by `createdAt DESC` (newest first).

**Scoping — the Driver vs route-manager discriminator** (see §5):
- **Driver-only caller** (read+update on `DeliveryRoute`, no create/delete): receives **only routes assigned to them** (`driverUserId = self`). The filter is applied server-side via CASL; the query DTO has **no** `driverUserId` field — do not try to send one.
- **Route-manager caller** (has `create` or `delete` on `DeliveryRoute`): receives the full tenant list.

### 3.3 `GET /delivery-routes/:id` — route detail + timeline (`read:DeliveryRoute`)

**Response** `200`: `DeliveryRouteResponseDto` including the populated `timeline` array (see §4).

**Errors**:
| HTTP | Code | Cause |
| ---- | ---- | ----- |
| `404` | `ENTITY_NOT_FOUND` | Route id missing **or** belongs to another tenant (same code, no presence leak) |
| `403` | — | Caller is driver-only and the route is not assigned to them (CASL condition `{ driverUserId: userId }` fails) |

### 3.4 `PATCH /delivery-routes/:id` — update a DRAFT route (`update:DeliveryRoute`)

**Request** — both fields optional; only the sent fields are updated:

```json
{ "driverUserId": "00000000-0000-0000-0000-0000000000bb" }
```

```json
{ "notes": "Entregar antes de las 14:00" }
```

```json
{ "notes": null }
```

| Field | Type | Validation |
| ----- | ---- | ---------- |
| `driverUserId` | string (uuid v4) | DRAFT-only; **mid-route reassignment is rejected** (aggregate rule ADR Q4) |
| `notes` | string \| null | ≤ 280 chars; `null` clears the notes |

**Response** `200`: updated `DeliveryRouteResponseDto`.

**Errors**: `404 ENTITY_NOT_FOUND` · `422 DELIVERY_ROUTE_INVALID_TRANSITION` (route not DRAFT) · `403` (driver-only caller on a route not assigned to them).

### 3.5 `DELETE /delivery-routes/:id` — delete a DRAFT route (`delete:DeliveryRoute`)

**Response** `204 No Content` (empty body).

**Rules**:
- Hard delete, **only** when the route is `DRAFT` **and** has zero stops. Enforced twice (aggregate pre-check + adapter precondition).
- Deleting a route with stops or a non-DRAFT route → `422 DELIVERY_ROUTE_INVALID_TRANSITION`.

### 3.6 `POST /delivery-routes/:id/start` — start the route (`update:DeliveryRoute`)

**Request**: no body. **Response** `200`: `DeliveryRouteResponseDto` with `status: "ACTIVE"`, `startedAt` stamped.

**Rules**:
- `DRAFT → ACTIVE`; requires ≥ 1 stop.
- Server-side conflict check: if any sale on the route already belongs to **another ACTIVE route**, the DB partial-unique index raises and the backend returns `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`.

**Errors**: `404 ENTITY_NOT_FOUND` · `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` · `422 DELIVERY_ROUTE_INVALID_TRANSITION` (not DRAFT / zero stops).

### 3.7 `POST /delivery-routes/:id/cancel` — cancel the route (`update:DeliveryRoute`)

**Request**: no body. **Response** `200`: `DeliveryRouteResponseDto` with `status: "CANCELLED"`, `cancelledAt` stamped.

**Rules**: allowed from `DRAFT` or `ACTIVE`. `COMPLETED` is terminal → `422 DELIVERY_ROUTE_INVALID_TRANSITION`.

### 3.8 `POST /delivery-routes/:id/stops` — append a stop (`update:DeliveryRoute`)

**Request** `201 Created`:

```json
{ "saleId": "11111111-2222-3333-4444-555555555555" }
```

**Response**: updated `DeliveryRouteResponseDto` with the new stop appended (`sortOrder = stops.length`).

**Rules**: DRAFT-only; the sale is re-checked for eligibility (same rule as create).

### 3.9 `POST /delivery-routes/:id/stops/:stopId/check-in` — check in a stop (`update:DeliveryRoute`)

**Request**: no body (route id + stop id in the path, both uuid v4).

**Response** `200`: `DeliveryRouteResponseDto`.

**Behavior** (all inside one DB transaction):
1. Route must be `ACTIVE`; the stop must be `PENDING` → flips to `COMPLETED` and stamps `checkedInAt`/`completedAt`.
2. The sale is mirrored to `deliveryStatus: "DELIVERED"` in the same transaction.
3. If a next `PENDING` stop exists, a `delivery.next_stop.notify` outbox event is queued (this is what eventually sends the "next stop arriving soon" email — see §6).
4. If the checked-in stop was the last one, the route auto-completes (`status: "COMPLETED"`).

**Idempotency**: re-checking an already-`COMPLETED` stop is a no-op and does **not** enqueue a second email — safe to retry the request.

**Errors**: `404 ENTITY_NOT_FOUND` · `422 DELIVERY_ROUTE_INVALID_TRANSITION` (route not ACTIVE / unknown stop / stop not PENDING).

### 3.10 `PUT /delivery-routes/:id/stops/reorder` — reorder stops (`update:DeliveryRoute`)

**Request**:

```json
{ "orderedStopIds": ["stop-uuid-2", "stop-uuid-1", "stop-uuid-3"] }
```

**Response** `200`: updated `DeliveryRouteResponseDto` with stops re-sorted.

**Rules**: DRAFT-only. `orderedStopIds` must reference **every** existing stop of the route **exactly once** (any length mismatch, unknown id, or duplicate → `422 DELIVERY_ROUTE_INVALID_TRANSITION`).

---

## 4. Timeline — `GET /delivery-routes/:id` → `timeline`

The detail endpoint assembles a read-only, deterministically sorted history of the route. Every event carries `at` (ISO 8601) and an `actor`; events are sorted by `at` **ascending** (the backend sorts — no client-side ordering needed).

Conceptually the timeline covers `created → started → stopCompleted → cancelled | completed`; on the wire those map to these exact event types:

```typescript
type DeliveryRouteTimelineEvent =
  | { type: 'ROUTE_CREATED';    at: string; actor: null }                       // route created (creator not tracked in MVP)
  | { type: 'ROUTE_STARTED';    at: string; actor: { id: string; name: string } | null }  // driver started the route
  | { type: 'STOP_CHECKED_IN';  at: string; stopId: string; sortOrder: number;
      actor: { id: string; name: string } | null }                              // driver checked in a stop
  | { type: 'ROUTE_COMPLETED';  at: string; actor: { id: string; name: string } | null }  // last stop checked in
  | { type: 'ROUTE_CANCELLED';  at: string; actor: { id: string; name: string } | null }; // route cancelled
```

Semantics for the frontend:

- **`ROUTE_CREATED`** is always present, with `actor: null` (the MVP does not persist a creator id).
- **`ROUTE_COMPLETED` and `ROUTE_CANCELLED` are mutually exclusive** (the aggregate lifecycle prevents both).
- `ROUTE_STARTED` and `STOP_CHECKED_IN` are present only when the route actually started / the stop was checked in.
- **Actor attribution**: the MVP tracks no per-action actor ids, so the route's assigned `driver` is used as the actor for `ROUTE_STARTED`, `STOP_CHECKED_IN`, `ROUTE_COMPLETED` and `ROUTE_CANCELLED`. When the route has no driver, `actor` is `null`.
- Rendering suggestion: render a vertical timeline with icon + label per `type` (`ROUTE_CREATED` → "Route created", `ROUTE_STARTED` → "Route started", `STOP_CHECKED_IN` → "Stop checked in" + stop/sortOrder, `ROUTE_COMPLETED` → "Route completed", `ROUTE_CANCELLED` → "Route cancelled"), formatted `at` in the tenant's timezone.

---

## 5. Permissions — Driver role vs route-manager

Four `DeliveryRoute` permissions exist (auto-seeded in the boot `PermissionSeeder`, grantable via the existing `PATCH /admin/roles/:id/permissions`):

| Permission | Meaning | Who typically has it |
| ---------- | ------- | -------------------- |
| `read:DeliveryRoute` | View routes | Driver **and** manager |
| `update:DeliveryRoute` | DRAFT edits, start, check-in, cancel, reorder | Driver **and** manager |
| `create:DeliveryRoute` | Create routes from sales | **Manager only** |
| `delete:DeliveryRoute` | Hard-delete DRAFT routes | **Manager only** |

**Driver role permission set**: `read` + `update` on `DeliveryRoute` **only**.

**The route-manager discriminator**: a user with `create` **or** `delete` on `DeliveryRoute` is treated as a route **manager**; a user with only `read`/`update` is treated as a **driver**. This drives two behaviors you must know:

1. **List scoping** — `GET /delivery-routes` returns the tenant-wide list for managers and **only the caller's own routes** for drivers. The filter is server-side (CASL); the frontend cannot and should not send a `driverUserId` filter.
2. **Detail authorization** — for a driver-only caller, `GET /delivery-routes/:id` and every `update:` action additionally require `route.driverUserId === currentUserId`; otherwise `403`.

**Frontend guidance**:
- Use `GET /auth/me/permissions` to detect `create:DeliveryRoute` / `delete:DeliveryRoute`. If present → render the manager UI (create/edit/delete/reorder); if only `read`/`update` → render the driver UI (route list + check-in buttons only). Do **not** infer roles from the route payload itself.
- Hide create/delete/reorder controls from drivers; hide nothing extra for managers.

---

## 6. Opt-in: "next stop" arriving-soon email (`PUT /notification-config`)

When a driver checks in a stop and a next stop exists, the backend emits a `delivery.next_stop.notify` event that sends an email to the **next customer** ("Tu paquete está por llegar"). Sending is **opt-in per tenant** through the notification-config endpoint (same one used by low-stock alerts):

**`PUT /notification-config`** — permission `update:NotificationConfig` — full overwrite of the tenant's config:

```json
{
  "enabled": true,
  "recipientUserIds": [],
  "enabledActions": ["DELIVERY_NEXT_STOP"]
}
```

| Field | Type | Validation |
| ----- | ---- | ---------- |
| `enabled` | boolean | Master switch; `false` disables every notification |
| `recipientUserIds` | string[] | **Every id must be a member of the current tenant** (else `400 INVALID_RECIPIENT`). Can be empty — see below |
| `enabledActions` | string[] | Keys from the locked set: `LOW_STOCK`, `TIME_OFF_REQUESTED`, `DELIVERY_NEXT_STOP`. Anything else → `400 UNKNOWN_ACTION_KEY` |

Behavior notes:

- The email recipient is the **next stop's customer email** (`sale.customer.email`), resolved authoritatively at send time — **not** the `recipientUserIds` list (those belong to the low-stock flow). An empty `recipientUserIds` is fine for enabling the delivery email.
- The Inngest function re-gates at send time: if `enabled` was turned off or `DELIVERY_NEXT_STOP` removed from `enabledActions` between check-in and dispatch, the email is skipped (config-drift protection).
- If the next sale has no customer email, the email is skipped (no error).
- `GET /notification-config` (permission `read:NotificationConfig`) returns the current `{ enabled, recipients, enabledActions }`.

**Frontend guidance**: in the "Notificaciones" admin screen, add a "Next stop delivery notification" toggle that includes `DELIVERY_NEXT_STOP` in `enabledActions` and sends the whole object (it is a full overwrite — read the current config first, then PUT the merged result). Handle `400 UNKNOWN_ACTION_KEY` (stale client enum) and `400 INVALID_RECIPIENT` (a recipient was removed from the tenant).

---

## 7. Errors — reference table

| HTTP | Code | Endpoint | Meaning / recommended action |
| ---- | ---- | -------- | ---------------------------- |
| 401 | — | all | Token missing/expired → redirect to login |
| 403 | — | all | Missing the required CASL permission, or driver-only caller acting on someone else's route → hide/disable the action |
| 404 | `ENTITY_NOT_FOUND` | `GET/:id`, `PATCH`, `DELETE`, `start`, `cancel`, `stops`, `check-in`, `reorder` | Route id missing or belongs to another tenant → show "Route not found"; do not leak presence |
| 409 | `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` | `start` | One or more sales already belong to another ACTIVE route → surface a clear conflict message |
| 422 | `DELIVERY_ROUTE_INVALID_TRANSITION` | `PATCH`, `DELETE`, `start`, `cancel`, `stops`, `check-in`, `reorder` | Illegal lifecycle transition (e.g. editing a non-DRAFT route, cancelling a COMPLETED route, checking in on a DRAFT route, bad reorder payload). Details carry `reason` |
| 422 | `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` | `POST /delivery-routes`, `POST :id/stops` | A sale is not `PENDING`/`SHIPPED` or has no shipping address. Details carry `saleId` + `deliveryStatus` |
| 400 | — | create/PATCH/stops/reorder | DTO validation (bad uuid, empty `saleIds`, notes > 280, `forbidNonWhitelisted`) |
| 400 | `UNKNOWN_ACTION_KEY` / `INVALID_RECIPIENT` | `PUT /notification-config` | Unknown action key / recipient not a tenant member |

The error body follows the global envelope: `{ statusCode, error, message, timestamp }` plus any `details` spread at the top level.

---

## 8. UI guide

### 8.1 Route manager screen (create/plan)

- Fetch eligible sales from the existing sales list (a sale is eligible when `deliveryStatus ∈ {PENDING, SHIPPED}` and `shippingAddress != null` — pre-filter client-side for UX; the backend re-validates anyway).
- Create: `POST /delivery-routes` with `saleIds[]` + `driverUserId` + optional `notes`. The route returns `DRAFT` — the manager can keep editing before start.
- While `DRAFT`: allow `PATCH` (driver + notes), `POST :id/stops` (append sale), `PUT :id/stops/reorder` (drag & drop), and `DELETE` (only meaningful with zero stops; hide the button once stops exist).
- Start: `POST :id/start` — confirm before firing; a `409` means a sale got claimed by another active route (reload the list and let the manager pick again).

### 8.2 Driver screen

- List: `GET /delivery-routes?status=ACTIVE` — the backend already returns only this driver's routes (no filter param needed).
- Detail: `GET /delivery-routes/:id` → render stops in `sortOrder`, show `customer.name` + `shippingAddress` (formatted address; `label` first, then street/exterior/interior, locality, `CP zipCode`).
- Check-in: `POST /delivery-routes/:id/stops/:stopId/check-in` → on success, mark the stop `COMPLETED` (or the whole route `COMPLETED` when it was the last stop) and refresh the detail to update the `timeline`.
- Timeline: render the `timeline` array (see §4) sorted as returned.

---

## 9. Checklist for frontend integration

- [ ] Read `GET /auth/me/permissions`; if `create:DeliveryRoute` or `delete:DeliveryRoute` present → manager UI; else → driver UI (read/update only).
- [ ] Manager: create route (`POST /delivery-routes`, `saleIds` ≥ 1, `driverUserId`, optional `notes`); handle `422 DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE`.
- [ ] Manager: DRAFT edits via `PATCH` (driver + notes), append stop via `POST :id/stops`, reorder via `PUT :id/stops/reorder` (all stops exactly once).
- [ ] Manager: `POST :id/start` with confirm; handle `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`.
- [ ] Manager: `DELETE` only when DRAFT with zero stops; `204` response, no body.
- [ ] Driver: list only own routes (no `driverUserId` param — server-scoped); filter by `?status=` when needed.
- [ ] Driver: check-in via `POST :id/stops/:stopId/check-in`; refresh detail + timeline after success; replay-safe.
- [ ] Render the `timeline` from `GET /delivery-routes/:id` (types `ROUTE_CREATED | ROUTE_STARTED | STOP_CHECKED_IN | ROUTE_COMPLETED | ROUTE_CANCELLED`).
- [ ] Notification admin: `GET /notification-config` → merge toggle → `PUT /notification-config` with `enabledActions` including `DELIVERY_NEXT_STOP` (full overwrite); handle `400 UNKNOWN_ACTION_KEY` / `400 INVALID_RECIPIENT`.
- [ ] Never send `id`, `tenantId`, `createdAt`, `updatedAt`, `timeline`, or `activeRouteId` in any request body (rejected by `forbidNonWhitelisted`).

---

## 10. Technical notes

- **Tenant isolation**: every repository read takes an explicit `tenantId` (defense in depth on top of the CLS-injected tenant filter); a cross-tenant route surfaces as `404 ENTITY_NOT_FOUND`, never `403`.
- **ADR-7 active marker**: a stop pins `activeRouteId` exactly while its route is `ACTIVE`; a partial unique index on `(tenantId, saleId) WHERE activeRouteId IS NOT NULL` guarantees "one sale in at most one ACTIVE route" at commit time. The `start` race maps `P2002` → `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`.
- **Check-in atomicity**: stop flip + `Sale.deliveryStatus = DELIVERED` mirror + outbox row commit in one transaction; a replay of an already-`COMPLETED` stop is a no-op and does not duplicate the email.
- **Timeline**: built by the pure `buildDeliveryRouteTimeline` function — no extra queries, deterministic ascending order, `ROUTE_COMPLETED`/`ROUTE_CANCELLED` mutually exclusive, actor = assigned driver (MVP has no per-action actor ids).
- **Next-stop email pipeline**: `checkInStop` → outbox `delivery.next_stop.notify` (idempotency key `${tenantId}:${currentStopId}`) → dedicated poller/dispatcher → Inngest `delivery-next-stop-notify` fn → React-email template sent via `MAILER`. The customer email is re-resolved at send time; config re-gated at send time (§6).
- **Permissions**: the 4 `DeliveryRoute` permissions auto-seed on boot; `create`/`delete` presence is the manager discriminator (ADR-5), and driver-only callers receive CASL conditional rules `{ driverUserId: userId }` for read/update.
