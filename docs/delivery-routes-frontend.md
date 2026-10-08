# Delivery Routes — Frontend Integration Guide

**Feature**: `delivery-routes` — route planning, driver check-ins, route timeline and the "next stop" arriving-soon email
**Module**: `src/delivery-routes/` (HTTP) + `src/notification-config/` (email opt-in)
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL
**Branch**: `feat/delivery-routes-wu3`
**Status**: ✅ WU3 implemented (timeline on detail, next-stop email pipeline via outbox + Inngest)

> ⚠️ **Local implementation; not deployed.** DRAFT+ACTIVE reservation, the `eligible-sales` selector (§11) and the explicit DRAFT→DRAFT transfer (§12) are implemented locally. Local commits do not imply a push, deployment or integrated browser validation. Isolated integration evidence is **bounded to ordering**: an integration run covered controlled `transfer`/`start` in **both orderings** across independent CLS contexts (19/19 PASS, exit 0) with clean resource teardown. It does **not** prove all concurrent interleavings and there is **no** `pg_locks` confirmation that a contender was actually blocked. Treat this as the agreed contract, not as verified production behaviour. The checks described here are **not** deployment approval.

---

> **TL;DR.** A route-manager groups eligible sales (`deliveryStatus` `PENDING`/`SHIPPED` + a shipping address) into a `DeliveryRoute` assigned to a driver. The route goes `DRAFT → ACTIVE → COMPLETED` (or `CANCELLED`). Drivers check in each stop from the field; every check-in mirrors the sale to `DELIVERED` and — when another stop follows — queues the "next stop arriving soon" email to the next customer (opt-in per tenant via `PUT /notification-config`). Every completed stop, **including the last**, also queues an ids-only customer thank-you email gated by its own flat opt-in action (§6.1). The detail endpoint returns a read-only `timeline` so the frontend can render route history without polling extra endpoints.

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
| `POST` | `/delivery-routes/:id/stops/:stopId/check-in` | `update:DeliveryRoute` | Check in a stop on an ACTIVE route; mirrors the sale to DELIVERED; queues the next-stop row when a next stop exists and the ids-only thank-you row for every completed stop (last included) |
| `POST` | `/delivery-routes/:routeId/stops/:stopId/transfer` | `update:DeliveryRoute` | Move one stop DRAFT → DRAFT (both routes must be DRAFT) — §12 |
| `PUT` | `/delivery-routes/:id/stops/reorder` | `update:DeliveryRoute` | Replace the stop order of a DRAFT route |
| `GET` | `/delivery-routes/eligible-sales` | `read:Sale` **and** `create:DeliveryRoute` | Paginated/searchable eligible-sale selector with availability state — §11 |

**Route lifecycle** (server-enforced):

```
DRAFT ──start──▶ ACTIVE ──checkInStop(last)──▶ COMPLETED
  │                 │
  └──cancel──┐  ┌──cancel──┐
             ▼  ▼
          CANCELLED
```

`COMPLETED` is terminal. `start` requires at least one stop; `PATCH`/`stops`/`reorder`/`transfer` are DRAFT-only; `check-in` requires ACTIVE.

**Reservation starts at DRAFT (not at start).** A sale is reserved by a route as soon as it is assigned while the route is `DRAFT`, and the reservation survives `DRAFT → ACTIVE` (cleared on `COMPLETED`/`CANCELLED`). At most one `DRAFT`-or-`ACTIVE` route may hold a given sale; the DB partial unique index enforces it. The older "one sale in one ACTIVE route" wording is obsolete. `transfer` is the only DRAFT→DRAFT move — there are **no** transfers involving `ACTIVE` routes.

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

**Errors**: `401` no token · `403` missing `create:DeliveryRoute` · `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` (a sale is already reserved by another DRAFT/ACTIVE route — `conflictSaleIds`) · `422 DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` · `400` DTO validation (non-uuid ids, empty `saleIds`).

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
- Reservation is armed when a sale joins a DRAFT route; `start` re-arms each stop's marker idempotently. If any sale is already reserved by **another DRAFT-or-ACTIVE route**, the DB partial-unique index raises and the backend returns `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` (the historic code suffix is kept for wire stability; see §12 for the structured `details`).

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

**Rules**: DRAFT-only; the sale is re-checked for eligibility (same rule as create). The reservation is taken here too: if the sale is already reserved by another DRAFT/ACTIVE route the call fails `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` with `conflictSaleIds`.

### 3.9 `POST /delivery-routes/:id/stops/:stopId/check-in` — check in a stop (`update:DeliveryRoute`)

**Request**: no body (route id + stop id in the path, both uuid v4).

**Response** `200`: `DeliveryRouteResponseDto`.

**Behavior** (all inside one DB transaction):
1. Route must be `ACTIVE`; the stop must be `PENDING` → flips to `COMPLETED` and stamps `checkedInAt`/`completedAt`.
2. The sale is mirrored to `deliveryStatus: "DELIVERED"` in the same transaction.
3. If a next `PENDING` stop exists, a `delivery.next_stop.notify` outbox event is queued (this is what eventually sends the "next stop arriving soon" email — see §6).
4. For **every** stop completed by this winning attempt — including the last — an ids-only `delivery.thank_you.notify` outbox event is queued in the **same** transaction (the customer thank-you email — see §6.1). The row carries only `{tenantId, saleId, routeId, stopId}`; the recipient is resolved at send time.
5. If the checked-in stop was the last one, the route auto-completes (`status: "COMPLETED"`).

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
3. **Selector access** — `GET /delivery-routes/eligible-sales` (§11) requires `read:Sale` **and** `create:DeliveryRoute`, so only managers can read it; a driver-only caller gets `403`.

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
| `enabledActions` | string[] | Keys from the locked set: `LOW_STOCK`, `TIME_OFF_REQUESTED`, `DELIVERY_NEXT_STOP`, `PROMOTION_EXPIRING`, `PROMOTION_NEAR_CAPACITY`, `DELIVERY_THANK_YOU`. Anything else → `400 UNKNOWN_ACTION_KEY` |

Behavior notes:

- The email recipient is the **next stop's customer email** (`sale.customer.email`), resolved authoritatively at send time — **not** the `recipientUserIds` list (those belong to the low-stock flow). An empty `recipientUserIds` is fine for enabling the delivery email.
- The Inngest function re-gates at send time: if `enabled` was turned off or `DELIVERY_NEXT_STOP` removed from `enabledActions` between check-in and dispatch, the email is skipped (config-drift protection).
- If the next sale has no customer email, the email is skipped (no error).
- `GET /notification-config` (permission `read:NotificationConfig`) returns the current `{ enabled, recipients, enabledActions }`.

**Frontend guidance**: in the "Notificaciones" admin screen, add a "Next stop delivery notification" toggle that includes `DELIVERY_NEXT_STOP` in `enabledActions` and sends the whole object (it is a full overwrite — read the current config first, then PUT the merged result, re-sending **only the keys currently enabled**). Sending every key would turn on actions the tenant had off, and omitting an enabled key would clear it. Handle `400 UNKNOWN_ACTION_KEY` (stale client enum) and `400 INVALID_RECIPIENT` (a recipient was removed from the tenant).

### 6.1 Thank-you email (`DELIVERY_THANK_YOU`)

When a driver completes a stop — the **last** one included — the backend also queues a customer thank-you email in the same transaction, gated by its own flat action key `DELIVERY_THANK_YOU`.

- **Documented but not live.** The action ships **disabled** for every tenant (no seeded rows). Enabling it can also release **older pending/retrying events**; inspect and resolve that backlog under the owner-approved gate before opting in. There is **no** proven live send (only an offline AppModule boot with stubbed ports; no live boot, Inngest Cloud, Resend or inbox evidence), so **do not** present a `200` as "email delivered".
- **Recipient is resolved at send time** from the sale's customer (tenant-scoped) — never from `recipients`/`recipientUserIds`, which stay the staff list.
- **Delivery is asynchronous** (outbox + Inngest); HTTP success means "accepted", not "delivered". A stable Inngest `event.id` reduces duplicates but is **not** an exactly-once guarantee.
- **Activation is gated.** Enabling `DELIVERY_THANK_YOU` in a real tenant requires the owner-approved activation/rollback conditions in `docs/delivery-thank-you-activation.md`.

---

## 7. Errors — reference table

| HTTP | Code | Endpoint | Meaning / recommended action |
| ---- | ---- | -------- | ---------------------------- |
| 401 | — | all | Token missing/expired → redirect to login |
| 403 | — | all | Missing the required CASL permission, or driver-only caller acting on someone else's route → hide/disable the action |
| 404 | `ENTITY_NOT_FOUND` | `GET/:id`, `PATCH`, `DELETE`, `start`, `cancel`, `stops`, `check-in`, `reorder` | Route id missing or belongs to another tenant → show "Route not found"; do not leak presence |
| 409 | `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` | `POST /delivery-routes`, `POST :id/stops`, `POST :routeId/stops/:stopId/transfer`, `start` | One or more sales are already **reserved** by another DRAFT-or-ACTIVE route. `details` = `{ reason, routeId, conflictSaleIds }`; `conflictSaleIds` is always an array (empty for a raw index race) → render an inline conflict per `saleId` and keep the manager's selection |
| 422 | `DELIVERY_ROUTE_INVALID_TRANSITION` | `PATCH`, `DELETE`, `start`, `cancel`, `stops`, `check-in`, `reorder` | Illegal lifecycle transition (e.g. editing a non-DRAFT route, cancelling a COMPLETED route, checking in on a DRAFT route, bad reorder payload). Details carry `reason` |
| 422 | `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` | `POST /delivery-routes`, `POST :id/stops` | A sale is not `PENDING`/`SHIPPED` or has no shipping address. Details carry `saleId` + `deliveryStatus` |
| 400 | — | create/PATCH/stops/reorder | DTO validation (bad uuid, empty `saleIds`, notes > 280, `forbidNonWhitelisted`) |
| 400 | `UNKNOWN_ACTION_KEY` / `INVALID_RECIPIENT` | `PUT /notification-config` | Unknown action key / recipient not a tenant member |

The error body follows the global envelope: `{ statusCode, error, message, timestamp }` plus any `details` spread at the top level.

---

## 8. UI guide

### 8.1 Route manager screen (create/plan)

- Fetch eligible sales from `GET /delivery-routes/eligible-sales` (§11) instead of the shared sales list: it is paginated, searchable, and reports each row's `availability` (`AVAILABLE` / `IN_CURRENT_ROUTE` / `OCCUPIED` / `INELIGIBLE`). The backend still re-validates on write.
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
- [ ] Selector: call `GET /delivery-routes/eligible-sales` with `page`/`limit`/`q`/`contextRouteId`; only `availability.state === 'AVAILABLE'` rows are selectable — `OCCUPIED` (even with `occupiedRoute: null`) and `INELIGIBLE` are never selectable (§11).
- [ ] Transfer: `POST /delivery-routes/:routeId/stops/:stopId/transfer` with `{ destinationRouteId }`; both routes must be DRAFT and both return in the `200` body (§12).
- [ ] After every create/append/transfer/start/cancel write, invalidate and refetch the selector (availability changes when a reservation moves).
- [ ] Never send `id`, `tenantId`, `createdAt`, `updatedAt`, `timeline`, or `activeRouteId` in any request body (rejected by `forbidNonWhitelisted`).

---

## 10. Technical notes

- **Tenant isolation**: every repository read takes an explicit `tenantId` (defense in depth on top of the CLS-injected tenant filter); a cross-tenant route surfaces as `404 ENTITY_NOT_FOUND`, never `403`.
- **ADR-7 reservation marker (extended by migration `20261007221500_reserve_draft_delivery_route_sales`)**: a stop pins `activeRouteId` from DRAFT assignment and keeps it across `DRAFT → ACTIVE` (cleared on cancel/complete, and re-pointed — never released — by a DRAFT→DRAFT transfer). The partial unique index on `(tenantId, saleId) WHERE activeRouteId IS NOT NULL` therefore guarantees "one sale reserved by at most one DRAFT-or-ACTIVE route" at commit time. The `save`/`start`/`transfer` race maps `P2002` → `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` with structured `details`.
- **Legacy reservation migration (no automatic cleanup)**: the migration backfills `activeRouteId` for every pre-existing DRAFT/ACTIVE stop that still has a NULL marker, so older DRAFT reservations are enforced by the same index. If a `(tenantId, saleId)` is claimed by more than one DRAFT/ACTIVE route, the migration **refuses to backfill** and aborts with a `RAISE EXCEPTION`; it never deletes, moves or reassigns a stop, and there is **no automatic duplicate resolution** — the ambiguous rows require a **human remediation decision** before the migration can be re-run.
- **Bounded concurrency evidence (ordering, not a full proof)**: an isolated integration run exercised controlled `transfer` and `start` in **both orderings** under independent CLS tenant contexts (19/19 PASS, exit 0) and confirmed the reservation invariant with clean teardown. This is an **ordering** proof only — it does not enumerate every concurrent interleaving, and no `pg_locks` check confirmed that a contending writer was blocked. The race-safe guarantee still rests on the DB partial unique index (ADR-7 bullet above), not on this test.
- **Check-in atomicity**: stop flip + `Sale.deliveryStatus = DELIVERED` mirror + outbox row commit in one transaction; a replay of an already-`COMPLETED` stop is a no-op and does not duplicate the email.
- **Timeline**: built by the pure `buildDeliveryRouteTimeline` function — no extra queries, deterministic ascending order, `ROUTE_COMPLETED`/`ROUTE_CANCELLED` mutually exclusive, actor = assigned driver (MVP has no per-action actor ids).
- **Next-stop email pipeline**: `checkInStop` → outbox `delivery.next_stop.notify` (idempotency key `${tenantId}:${currentStopId}`) → dedicated poller/dispatcher → Inngest `delivery-next-stop-notify` fn → React-email template sent via `MAILER`. The customer email is re-resolved at send time; config re-gated at send time (§6).
- **Thank-you email pipeline (dormant action)**: the same `checkInStop` transaction writes an ids-only `delivery.thank_you.notify` row for every completed stop (last included) → dedicated claim `IN ('delivery.next_stop.notify', 'delivery.thank_you.notify')` → fail-closed awaited dispatcher → Inngest `delivery-thank-you-notify` fn → `DeliveryThankYouSender`. The generic poller **excludes** `delivery.thank_you.notify`, so an unrouted row stays `PENDING` instead of being mis-dispatched. The sender proves the exact completed stop (both timestamps, tenant-scoped), reads the persisted `CONFIRMED` + `DELIVERED` summary, resolves the customer email at send time, re-gates master/action at send time, and sends only to the customer. Stable Inngest id `${tenantId}:${saleId}:${stopId}`; **no** exactly-once guarantee. The action is disabled by default — see `docs/delivery-thank-you-activation.md`.
- **Permissions**: the 4 `DeliveryRoute` permissions auto-seed on boot; `create`/`delete` presence is the manager discriminator (ADR-5), and driver-only callers receive CASL conditional rules `{ driverUserId: userId }` for read/update.

---

## 11. Eligible-sales selector — `GET /delivery-routes/eligible-sales`

Route-manager only: requires **both** `read:Sale` and `create:DeliveryRoute` (the same manager discriminator as §5). A driver-only caller gets `403`. This is the supported way to populate the "add sales to a route" picker: it is server-scoped, paginated and searchable, and returns the authoritative availability state for every row.

### 11.1 Query

| Param | Type | Default | Validation / meaning |
| ----- | ---- | ------- | -------------------- |
| `page` | number | `1` | ≥ 1 (1-based) |
| `limit` | number | `20` | 1–100 |
| `q` | string | — | Optional, ≤ 200 chars. Free-text over customer first/last name, the **numeric suffix** of the folio, and the shipping address (`street`, `neighborhood`, `municipality`, `city`, `zipCode`) |
| `contextRouteId` | uuid v4 | — | Optional. The route currently being edited; its stops drive `IN_CURRENT_ROUTE` |

```http
GET /delivery-routes/eligible-sales?page=1&limit=20&q=ana&contextRouteId=00000000-0000-0000-0000-0000000000aa
```

### 11.2 Response

```typescript
{
  data: EligibleSaleRow[];              // ordered: confirmedAt DESC NULLS LAST, then id DESC
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
```

`totalPages` is `0` when `total` is `0`.

```typescript
interface EligibleSaleRow {
  id: string;
  folio: string | null;
  status: string;                       // raw Sale.status
  paymentStatus: string | null;         // raw Sale.paymentStatus
  deliveryStatus: string;               // raw Sale.deliveryStatus
  totalCents: number;
  debtCents: number;
  confirmedAt: string | null;           // ISO 8601
  dueDate: string | null;               // ISO 8601
  customer: { id: string; name: string } | null;   // name = firstName + ' ' + lastName (trimmed)
  shippingAddress: EligibleSaleShippingAddress | null;
  productSummary: string[];             // ≤ 3 SaleItem.productName, in sale-line order
  availability: EligibleSaleAvailability;
}

interface EligibleSaleShippingAddress {
  id: string;
  label: string | null;
  street: string;                       // non-null (unlike DeliveryRouteStop.shippingAddress)
  exteriorNumber: string | null;
  interiorNumber: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

type EligibleSaleAvailability =
  | { state: 'AVAILABLE' }
  | { state: 'IN_CURRENT_ROUTE'; stopId: string; sortOrder: number }
  | { state: 'OCCUPIED'; reason: 'RESERVED_BY_ROUTE';
      occupiedRoute: { id: string; status: 'DRAFT' | 'ACTIVE' } | null }
  | { state: 'INELIGIBLE'; reason: 'MISSING_ADDRESS' | 'DELIVERY_STATUS' };
```

### 11.3 Availability semantics (precedence is server-side)

`INELIGIBLE` → `IN_CURRENT_ROUTE` → `OCCUPIED` → `AVAILABLE`.

| State | Meaning | Selectable? |
| ----- | ------- | ----------- |
| `AVAILABLE` | Eligible and not reserved anywhere | ✅ |
| `IN_CURRENT_ROUTE` | Already a stop of `contextRouteId` (live route) | Already in the route |
| `OCCUPIED` | Reserved by another DRAFT/ACTIVE route | ❌ **never** |
| `INELIGIBLE` | Missing shipping address (`MISSING_ADDRESS`) or `deliveryStatus ∉ {PENDING, SHIPPED}` (`DELIVERY_STATUS`) | ❌ |

- **`occupiedRoute: null` is NOT "free".** The backend returns `null` when the caller cannot read the occupying route instance (driver-scoped CASL condition) **or** when the reservation marker's route status is outside `{DRAFT, ACTIVE}`. In both cases the row stays `OCCUPIED` — a forbidden or unknown holder is **never** downgraded to `AVAILABLE`. Render an "occupied by another route" state without a link.
- `IN_CURRENT_ROUTE` is only produced for a **live** (`DRAFT`/`ACTIVE`) context route. A `COMPLETED`/`CANCELLED` `contextRouteId` is validated for existence/authorization but contributes no stops, so its sales fall through to normal occupancy (historical routes do not block re-selection).
- `INELIGIBLE` rows are intentionally kept in the page (with the reason) so the UI can explain why a search hit is not selectable.

### 11.4 `contextRouteId` authorization

`contextRouteId` must exist in the caller's tenant **and** the caller must be able to read that route instance. Any miss — unknown, cross-tenant, or unauthorized — returns `404 ENTITY_NOT_FOUND` (never `403`, never an existence oracle), the same rule as `GET /delivery-routes/:id`.

### 11.5 Errors

| HTTP | Code | Cause |
| ---- | ---- | ----- |
| `401` | — | No/invalid token |
| `403` | — | Caller lacks `read:Sale` and/or `create:DeliveryRoute` |
| `404` | `ENTITY_NOT_FOUND` | `contextRouteId` unknown, cross-tenant, or not instance-readable |
| `400` | — | DTO validation (`page`/`limit` out of range, `q` > 200, non-uuid `contextRouteId`) |

### 11.6 Invalidate after mutations

Availability is a snapshot. **Refetch the selector after every mutating call** (`create`, `POST :id/stops`, `transfer`, `start`, `cancel`): a reservation is taken/released the moment a sale joins or leaves a DRAFT/ACTIVE route, so cached rows can go stale between two writes.

> Backend wiring note: the selector lives in `EligibleSalesController`, which must be registered **before** `DeliveryRoutesController` so `GET /delivery-routes/:id` does not shadow `GET /delivery-routes/eligible-sales`.

---

## 12. Stop transfer — `POST /delivery-routes/:routeId/stops/:stopId/transfer`

Moves one stop from the **origin** route (path `:routeId`) to a **destination** DRAFT route, appending it as the destination's last stop. It is the explicit replacement for editing two routes by hand, and the only way a sale changes route.

### 12.1 Request / response

```http
POST /delivery-routes/11111111-1111-1111-1111-111111111111/stops/22222222-2222-2222-2222-222222222222/transfer
```

```json
{ "destinationRouteId": "33333333-3333-3333-3333-333333333333" }
```

| Field | Type | Required | Validation |
| ----- | ---- | -------- | ---------- |
| `destinationRouteId` | uuid v4 | ✅ | Must be a **different** DRAFT route |

**Response** `200` — both routes with their committed state, so the caller can replace both cached copies without a follow-up read:

```typescript
interface TransferStopResponseDto {
  originRoute: DeliveryRouteResponseDto;       // §2
  destinationRoute: DeliveryRouteResponseDto;  // §2
}
```

Permission is `update:DeliveryRoute` at the controller, but the service additionally requires **`read` + `update` on `DeliveryRoute` for the instance of *both* routes** (the response discloses both full projections). A denial is `403` with **no write**.

### 12.2 Rules and effects

- Both origin and destination must be `DRAFT` — **no transfers with an ACTIVE route**, and origin ≠ destination.
- The stop must belong to the origin; the destination must not already hold the moved sale.
- Effects: the origin drops the stop and **re-numbers its remaining stops contiguously**; an empty origin is allowed but **cannot be started**; the destination appends the relocated stop with the **same stop id, sale id and `createdAt`, reset to `PENDING`**; the reservation marker is re-pointed to the destination route id (the reservation never drops during the move, so the sale is never briefly free).
- Both route projections are built **inside the locked transaction**, so the returned state is exactly what this request committed.

### 12.3 Reason codes (`422 DELIVERY_ROUTE_INVALID_TRANSITION` → `reason`)

| `reason` | Condition |
| ---------------- | --------- |
| `NOT_DRAFT` | Origin or destination is not DRAFT (`currentStatus` = the offending status) |
| `SAME_ROUTE_TRANSFER` | `destinationRouteId` equals the origin route |
| `UNKNOWN_STOP_ID` | The stop does not belong to the origin route |
| `DESTINATION_ALREADY_HAS_SALE` | The destination already has a stop for this sale (`saleId`, `destinationRouteId`) |

### 12.4 Errors

| HTTP | Code | Cause |
| ---- | ---- | ----- |
| `404` | `ENTITY_NOT_FOUND` | Origin or destination route missing / cross-tenant |
| `403` | — | Missing coarse `update:DeliveryRoute`, or instance `read`/`update` fails on either route (no write) |
| `422` | `DELIVERY_ROUTE_INVALID_TRANSITION` | Any rule in §12.2 fails — see `reason` |
| `409` | `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` | The moved sale is reserved by a **third** DRAFT/ACTIVE route; `conflictSaleIds` carries it |
| `400` | — | DTO validation (bad `stopId`/`destinationRouteId` uuid, unknown body field) |

### 12.5 Invalidate after transfer

The response already returns both routes, but the **selector** (§11) and any route list still need a refetch: a stop leaving/joining a DRAFT route changes reservations and stop counts immediately.

---

## 13. Legacy reservation migration (operator note)

The DRAFT+ACTIVE reservation change ships with migration `20261007221500_reserve_draft_delivery_route_sales`, which widens the meaning of `activeRouteId` (previously armed only while the route was ACTIVE). It is **not** a schema change — the column and its partial unique index already exist.

- **Safe backfill**: inside one `DO` block it sets `activeRouteId = routeId` for every pre-existing `DRAFT`/`ACTIVE` stop whose marker is still `NULL`, so older DRAFT reservations become enforced by the same index as new ones.
- **Refusal on ambiguous legacy state**: if any `(tenantId, saleId)` is claimed by more than one `DRAFT`/`ACTIVE` route, the migration raises an exception and **aborts the whole block**. It never deletes, moves or reassigns a stop.
- **Human remediation required**: there is **no automatic duplicate cleanup**. The ambiguous rows must be resolved manually (decide the owning route), then the migration re-run. Surface this to backend/ops — it is not a frontend decision.
