# Delivery Routes Specification

## Purpose

Define the tenant-scoped delivery-route bounded context that groups eligible
`Sale`s into an ordered `DeliveryRoute` assigned to a driver `User`. The route
goes through a four-state lifecycle (`DRAFT → ACTIVE → COMPLETED` or
`DRAFT|ACTIVE → CANCELLED`). Completing a stop atomically flips the
`DeliveryRouteStop.status` to `COMPLETED`, mirrors `Sale.deliveryStatus = 'DELIVERED'`
in the same transaction, and (when a next stop exists) durably emits a
`delivery.next_stop.notify` outbox event that drives an opt-in
"arriving soon" email through the proven outbox → dedicated poller/dispatcher
→ Inngest → `MAILER` pipeline.

`DeliveryRouteStop.status === 'COMPLETED'` is the single source of truth for
"this sale was delivered". `Sale.deliveryStatus = 'DELIVERED'` is a derived
mirror written only by the route check-in flow, in the same `runInTransaction`.
No other code path in this change writes `DELIVERED` for a sale that belongs to
a route. The chatbot's existing direct Prisma path that writes `SHIPPED` is
unchanged and orthogonal.

A Sale MAY appear in at most one ACTIVE route at any time. The invariant is
enforced by the partial unique index on
`delivery_route_stops (tenant_id, sale_id) WHERE activeRouteId IS NOT NULL`;
a violation — whether a pre-existing claim or a concurrent start race —
surfaces as Prisma `P2002` and is mapped to HTTP 409
`DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` by the repository (ADR-7).
Driver ownership ("driver may only `read`/`update` their own routes") is
enforced by a CASL subject-condition matcher resolved via a minimal
guard/resolver extension, not by per-controller branching.

The bounded context lives under `src/delivery-routes/` and is mounted at
`/delivery-routes` (no `/admin/` prefix because both tenant admins and
drivers call the same endpoints; CASL decides). The capability is gated by
`create / read / update / delete :DeliveryRoute` permissions, auto-seeded by
`PermissionSeeder` on bootstrap; a tenant-created `Driver` role is documented
to grant `read:DeliveryRoute` and `update:DeliveryRoute` only (the
`create`/`delete` presence is the route-manager discriminator). The "next
stop arriving soon" notification is opt-in per tenant via
`NotificationConfig.enabledActions.includes('DELIVERY_NEXT_STOP')`.

GPS, map-provider optimization, driver self-registration, per-stop
notes/photos/signatures, re-editing ACTIVE routes, and carrier/tracking
metadata capture are explicitly out of scope.

## Requirements

### Requirement: DeliveryRoute Lifecycle States

The system MUST persist a `DeliveryRoute` row per tenant with the following
fields: `id` (uuid), `tenantId` (FK → `Tenant`, cascade on delete),
`driverUserId` (FK → `User`, restrict on delete), `status`
(`DeliveryRouteStatus` enum `DRAFT | ACTIVE | COMPLETED | CANCELLED`,
default `DRAFT`), `startedAt`, `completedAt`, `cancelledAt`, `notes`,
`createdAt`, `updatedAt`. The Prisma table MUST be named `delivery_routes`
and the model MUST belong to the `Tenant` relation set so cascade delete
propagates. The system MUST index on `[tenantId]`, `[tenantId, driverUserId, status]`,
and `[tenantId, status]` so list and lookup queries stay tenant-scoped and
cheap.

The `DeliveryRoute.status` field MUST follow exactly the four-state
lifecycle below:

- `DRAFT → ACTIVE`: explicit admin/driver action via `POST /delivery-routes/:id/start`.
- `DRAFT | ACTIVE → CANCELLED`: explicit admin/driver action via `POST /delivery-routes/:id/cancel`.
- `ACTIVE → COMPLETED`: automatic, triggered when the last `PENDING`/`IN_PROGRESS` stop
  is transitioned to `COMPLETED` by `checkInStop`.
- `COMPLETED` and `CANCELLED` are terminal — any further transition attempt
  MUST be rejected with `DeliveryRouteInvalidTransitionError` (HTTP 422).

The aggregate MUST reject any status mutation outside these transitions.
`completedAt` is set only on the auto `ACTIVE → COMPLETED` transition.
`cancelledAt` is set only on `DRAFT|ACTIVE → CANCELLED`. `startedAt` is set
only on `DRAFT → ACTIVE`.

#### Scenario: Happy path — DRAFT → ACTIVE → COMPLETED

- GIVEN an `ACTIVE` route with two `PENDING` stops
- WHEN the first stop is checked in and then the second stop is checked in
- THEN after the first check-in the route is still `ACTIVE` and the second stop is still `PENDING`
- AND after the second check-in the route is `COMPLETED`, `completedAt` is set, and the second stop is `COMPLETED`

#### Scenario: DRAFT → CANCELLED is allowed without a prior start

- GIVEN a `DRAFT` route with three `PENDING` stops
- WHEN an authorized caller invokes `cancel`
- THEN the route is `CANCELLED`, `cancelledAt` is set, `startedAt` and `completedAt` remain `null`
- AND the stops remain `PENDING` (no stop mutation on cancel)

#### Scenario: ACTIVE → CANCELLED is allowed mid-route

- GIVEN an `ACTIVE` route with three stops, one `COMPLETED` and two `PENDING`
- WHEN an authorized caller invokes `cancel`
- THEN the route is `CANCELLED`, `cancelledAt` is set
- AND the stops are left untouched (no retroactive `COMPLETED` flips or back-outs)

#### Scenario: COMPLETED is terminal

- GIVEN a `COMPLETED` route
- WHEN any caller attempts `start`, `cancel`, or `checkInStop` against it
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND the route's status, `completedAt`, and stops are unchanged

#### Scenario: CANCELLED is terminal

- GIVEN a `CANCELLED` route
- WHEN any caller attempts `start`, `cancel`, or `checkInStop` against it
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND the route's status, `cancelledAt`, and stops are unchanged

### Requirement: Route Stop Model and Ordering

The system MUST persist a `DeliveryRouteStop` row per tenant with the
following fields: `id` (uuid), `tenantId` (FK → `Tenant`, cascade on
delete), `routeId` (FK → `DeliveryRoute`, cascade on delete), `saleId`
(FK → `Sale`, restrict on delete), `sortOrder` (integer, unique per route),
`status` (`DeliveryRouteStopStatus` enum `PENDING | IN_PROGRESS | COMPLETED | SKIPPED`,
default `PENDING`), `checkedInAt`, `completedAt`, `skippedReason`,
`activeRouteId` (nullable string — see ADR-7; non-null exactly while the
owning route is `ACTIVE`), `createdAt`, `updatedAt`. The Prisma table MUST
be named `delivery_route_stops`.

The system MUST enforce `@@unique([routeId, sortOrder])` so two stops on
the same route cannot share a position. The system MUST index on
`[tenantId]`, `[tenantId, saleId]`, and `[saleId]`. The model MUST
belong to the `Tenant` and `Sale` relation sets so cascade delete
propagates from `Tenant` and `DeliveryRoute`, and so a sale cannot be
hard-deleted while it is referenced by a stop. The `SKIPPED` status is
reserved for forward-compatibility; no endpoint, no service path, and no
transition in this change MUST emit `SKIPPED`. `checkInStop` MUST only
transition `PENDING → COMPLETED`.

#### Scenario: Stops are ordered by sortOrder ascending

- GIVEN a route with three stops at `sortOrder` 0, 1, 2
- WHEN the read model is assembled
- THEN the stops appear in the response in `sortOrder` ascending order
- AND ties never occur (`@@unique([routeId, sortOrder])`)

#### Scenario: Duplicate sortOrder is rejected at persist time

- GIVEN a route with one stop at `sortOrder=1`
- WHEN the service attempts to insert another stop with `sortOrder=1` on the same route
- THEN the Prisma `P2002` unique violation is raised
- AND no second stop is persisted

#### Scenario: SKIPPED is reserved — no path produces it

- GIVEN any route in any state
- WHEN `start`, `cancel`, or `checkInStop` is invoked
- THEN no stop's `status` becomes `SKIPPED` as a side effect
- AND no `skippedReason` value is written by this change

### Requirement: Create DeliveryRoute in DRAFT

`POST /delivery-routes` MUST create a new `DeliveryRoute` in `DRAFT` with
at least one stop. The request MUST require `create:DeliveryRoute`. The
request body MUST carry an ordered array of `saleIds` (≥ 1, all uuids,
all tenant-scoped) and a `driverUserId` (uuid, must reference an existing
`User` in the same tenant). Each `saleId` MUST satisfy the sale-eligibility
rules at create time:

- The Sale MUST belong to the calling tenant.
- The Sale's `deliveryStatus` MUST be `PENDING` or `SHIPPED` (never `DELIVERED`,
  `NOT_APPLICABLE`, or any non-eligible value).
- The Sale MUST have a non-null `shippingAddressId`.

Stops MUST be created with `sortOrder = [0..n-1]` and `status = PENDING`
inside the same transaction. The route MUST be persisted with
`status='DRAFT'`, `startedAt=null`, `completedAt=null`, `cancelledAt=null`.
The system MUST return HTTP 201 with the `DeliveryRouteResponseDto` for
the new route.

`notes` MAY be supplied and trimmed before persistence; stored value MUST
be the trimmed string or `NULL`. `Sale.setDeliveryMetadata` MUST NOT be
called; the route flow never writes carrier metadata.

#### Scenario: Happy path — DRAFT route with ordered stops

- GIVEN three eligible sales S1, S2, S3 in tenant T and a driver User D in T
- WHEN a caller with `create:DeliveryRoute` POSTs `{ driverUserId: D.id, saleIds: [S1.id, S2.id, S3.id] }`
- THEN a `DeliveryRoute` is created with `status='DRAFT'`, `tenantId=T`, `driverUserId=D.id`
- AND three `DeliveryRouteStop` rows are created with `sortOrder` 0, 1, 2 and `status='PENDING'`
- AND `startedAt`, `completedAt`, `cancelledAt` are `null`
- AND the response is HTTP 201 with the new route's `DeliveryRouteResponseDto`

#### Scenario: Sale not in the caller's tenant is rejected

- GIVEN sale S1 belongs to tenant T1 and the caller is authenticated in T2
- WHEN the caller POSTs a create request including S1.id
- THEN the response is HTTP 422 `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE`
- AND no route, no stops, and no other side effects are written

#### Scenario: Sale already DELIVERED is ineligible

- GIVEN sale S1 in tenant T has `deliveryStatus='DELIVERED'`
- WHEN a caller with `create:DeliveryRoute` in T POSTs a create request including S1.id
- THEN the response is HTTP 422 `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE`
- AND no route is created

#### Scenario: Sale without a shipping address is ineligible

- GIVEN sale S1 in tenant T has `shippingAddressId=null`
- WHEN a caller POSTs a create request including S1.id
- THEN the response is HTTP 422 `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE`
- AND no route is created

#### Scenario: Empty saleIds list is rejected

- GIVEN a caller with `create:DeliveryRoute`
- WHEN they POST `{ driverUserId, saleIds: [] }`
- THEN the response is HTTP 400 (DTO validation)
- AND no route is created

#### Scenario: Unknown driverUserId is rejected

- GIVEN no `User` exists with the supplied `driverUserId` in the caller's tenant
- WHEN the caller POSTs a create request
- THEN the response is HTTP 404 (driver not found)
- AND no route is created

#### Scenario: Missing create permission denied

- GIVEN a caller without `create:DeliveryRoute`
- WHEN they POST a valid body
- THEN the response is HTTP 403 and no route is created

### Requirement: Edit DeliveryRoute Stops and Driver Only While DRAFT

`PATCH /delivery-routes/:id` MUST allow mutating `driverUserId` and
`notes` ONLY when the route is `DRAFT`. Stop-set mutations are exposed as
dedicated endpoints, all gated by `update:DeliveryRoute` and DRAFT-only:
`POST /delivery-routes/:id/stops` adds a stop (`addStop`) and
`PUT /delivery-routes/:id/stops/reorder` reorders stops (`reorderStops`).
Removing a stop (`removeStop`) is NOT exposed in this change. Any
mutation attempt against an `ACTIVE`, `COMPLETED`, or `CANCELLED` route
MUST be rejected with `DeliveryRouteInvalidTransitionError` (HTTP 422).
Reassigning the driver mid-route (in `ACTIVE`) is intentionally rejected
to avoid the mid-route hand-off failure mode.

#### Scenario: Reassign driver in DRAFT succeeds

- GIVEN a `DRAFT` route assigned to driver D1
- WHEN an authorized caller PATCHes `{ driverUserId: D2.id }` and D2 exists in the tenant
- THEN the route's `driverUserId` is `D2.id`
- AND `updatedAt` is bumped

#### Scenario: Reassign driver in ACTIVE is rejected

- GIVEN an `ACTIVE` route assigned to driver D1
- WHEN an authorized caller PATCHes `{ driverUserId: D2.id }`
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND the route's `driverUserId` and `status` are unchanged

#### Scenario: Reorder stops in DRAFT succeeds

- GIVEN a `DRAFT` route with stops at `sortOrder` 0, 1, 2 referencing S1, S2, S3
- WHEN an authorized caller PATCHes `{ orderedStopIds: [stop3, stop1, stop2] }`
- THEN the route's stops now reference S3, S1, S2 in `sortOrder` 0, 1, 2
- AND the route's `status` remains `DRAFT`

#### Scenario: Edit a COMPLETED route is rejected

- GIVEN a `COMPLETED` route
- WHEN an authorized caller PATCHes any mutable field
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND the route's fields are unchanged

### Requirement: Start DeliveryRoute (DRAFT → ACTIVE)

`POST /delivery-routes/:id/start` MUST transition a `DRAFT` route to
`ACTIVE` and set `startedAt` to the start time. The endpoint MUST require
`update:DeliveryRoute`. The transition MUST be allowed only when:

- The current status is `DRAFT`.
- The route has at least one stop.

Sale eligibility is validated when stops are added (`create` / `addStop`).
`start` itself does NOT re-validate each stop's sale eligibility: the
transition requires only `DRAFT` status and at least one stop. A sale
that became `DELIVERED` (e.g. via the chatbot's direct path) between
stop-add and start still starts; the subsequent check-in mirror is
idempotent for an already-delivered sale. The Inngest/email pipeline
MUST NOT be triggered by `start`.

#### Scenario: Happy path — DRAFT → ACTIVE with eligible stops

- GIVEN a `DRAFT` route with three eligible stops
- WHEN an authorized caller POSTs `/start`
- THEN the route is `ACTIVE`, `startedAt` is set to now
- AND the stops remain `PENDING`
- AND `activeRouteId` is set on every stop (see "one-active-route-per-sale" requirement)

#### Scenario: Start against a non-DRAFT route is rejected

- GIVEN an `ACTIVE` route
- WHEN an authorized caller POSTs `/start`
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND the route's status, `startedAt`, and stops are unchanged

#### Scenario: Start does not re-validate eligibility — a now-ineligible stop still starts

- GIVEN a `DRAFT` route that referenced sale S1 with `deliveryStatus='PENDING'`, but S1 was later updated to `deliveryStatus='DELIVERED'` (chatbot or other path) before start
- WHEN an authorized caller POSTs `/start`
- THEN the route transitions to `ACTIVE` and `startedAt` is set (no re-validation on start)
- AND every stop keeps `activeRouteId` set; a later `checkInStop` mirrors the already-delivered sale idempotently

### Requirement: Check-In Stop Atomically Writes Stop, Sale Mirror, and Outbox Event

`POST /delivery-routes/:id/stops/:stopId/check-in` MUST transition the
target stop's `status` from `PENDING` to `COMPLETED`, set the stop's
`checkedInAt` and `completedAt`, mirror `Sale.deliveryStatus='DELIVERED'`
on the underlying Sale, and (when a next stop exists) durably emit a
`delivery.next_stop.notify` outbox event — all inside a single
`runInTransaction` on the tenant Prisma client. The endpoint MUST require
`update:DeliveryRoute`. The transition MUST be allowed only when:

- The route is `ACTIVE`.
- The target stop belongs to the route (same `routeId`) and the tenant.
- The stop's current `status` is `PENDING`.

The check-in MUST be idempotent: a second call with the same `stopId` on
an already-`COMPLETED` stop returns the existing state without writing a
second `outbox_events` row, without mutating the Sale mirror, and without
flipping the route again. The aggregate's idempotency check MUST run
before the outbox publish call.

#### Scenario: Happy path — stop check-in flips stop and Sale, emits outbox when next stop exists

- GIVEN an `ACTIVE` route with stops [S1=PENDING, S2=PENDING] and a non-last stop `S1`
- WHEN an authorized caller POSTs `/stops/S1.id/check-in`
- THEN `DeliveryRouteStop(S1).status = 'COMPLETED'`, `checkedInAt` and `completedAt` are set
- AND `Sale(S1).deliveryStatus = 'DELIVERED'` (written inside the same tx)
- AND exactly one `outbox_events` row exists with `eventType='delivery.next_stop.notify'`, `status='PENDING'`, `tenantId=T`, `aggregateType='DeliveryRoute'`, `aggregateId=route.id`
- AND the route remains `ACTIVE` (S2 is still `PENDING`)
- AND the transaction commits atomically — there is no commit window where the stop is `COMPLETED` and the Sale is still `PENDING`/`SHIPPED`

#### Scenario: Check-in that completes the last stop also flips the route

- GIVEN an `ACTIVE` route with two stops [S1=COMPLETED, S2=PENDING]
- WHEN an authorized caller POSTs `/stops/S2.id/check-in`
- THEN `DeliveryRouteStop(S2).status = 'COMPLETED'`, `checkedInAt` and `completedAt` are set
- AND `Sale(S2).deliveryStatus = 'DELIVERED'`
- AND the route is `COMPLETED`, `completedAt` is set
- AND `activeRouteId` is cleared on every stop (see "one-active-route-per-sale" requirement)
- AND no `delivery.next_stop.notify` outbox row is written (no next stop)

#### Scenario: Duplicate check-in on a COMPLETED stop is a no-op

- GIVEN an `ACTIVE` route where stop `S1` is already `COMPLETED`
- WHEN an authorized caller POSTs `/stops/S1.id/check-in` a second time
- THEN the response is HTTP 200 with the same `DeliveryRouteResponseDto`
- AND no additional `outbox_events` row of type `delivery.next_stop.notify` is written
- AND the Sale mirror is not mutated a second time
- AND the stop's `checkedInAt`/`completedAt` are not overwritten

#### Scenario: Check-in against a non-ACTIVE route is rejected

- GIVEN a `DRAFT` route with a `PENDING` stop S1
- WHEN an authorized caller POSTs `/stops/S1.id/check-in`
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND the stop's status and the Sale's `deliveryStatus` are unchanged

#### Scenario: Check-in of a stop belonging to a different route is rejected

- GIVEN routes R1 and R2 in tenant T, both ACTIVE, with stops `R1.S1` and `R2.S1`
- WHEN an authorized caller POSTs `/delivery-routes/R1.id/stops/R2.S1.id/check-in`
- THEN the response is HTTP 404 `DELIVERY_ROUTE_NOT_FOUND` (or 422 if the service layer distinguishes)
- AND no stop, no Sale mirror, and no outbox row are written

#### Scenario: Outbox publish failure rolls everything back

- GIVEN the `outbox_events` insert fails after the stop and Sale writes
- WHEN `runInTransaction` rejects
- THEN `DeliveryRouteStop.status` is NOT `'COMPLETED'` (rollback)
- AND `Sale.deliveryStatus` is NOT `'DELIVERED'` (rollback)
- AND no `outbox_events` row of type `delivery.next_stop.notify` survives
- AND the route's status is unchanged

### Requirement: Sale Delivery Status Is Mirrored Atomically by the Route Flow

The route check-in flow MUST be the only code path in this change that
writes `Sale.deliveryStatus='DELIVERED'`. The Sale aggregate MUST expose
`markDelivered()` as a status-only mutation: it MUST set
`_deliveryStatus = 'DELIVERED'` when the Sale is currently `CONFIRMED` and
its `deliveryStatus` is not already `DELIVERED`. It MUST be idempotent —
if `deliveryStatus` is already `DELIVERED`, the method MUST return
without throwing. When the Sale's `status` is not `CONFIRMED`, the
method MUST throw `SaleNotDeliverableError` (a `BusinessRuleViolationError`
subclass, code `SALE_NOT_DELIVERABLE`, mapped to HTTP 422 by the global
filter).

The repository MUST expose `markSaleDelivered(tx, { tenantId, saleId })`
that performs `tx.sale.update({ where: { id: saleId, tenantId }, data: { deliveryStatus: 'DELIVERED' } })`.
The route check-in MUST call `markSaleDelivered` inside the same
`runInTransaction` as the stop write. The Sale mirror carries status
ONLY — no carrier/tracking fields are written by the route flow, and no
`completedAt`/`_deliveryCompletedAt` is added on the Sale side. Canonical
"when delivered" timestamps live on `DeliveryRouteStop.checkedInAt`,
`DeliveryRouteStop.completedAt`, and `DeliveryRoute.completedAt`. The
chatbot's existing direct Prisma path that writes `SHIPPED` is
unchanged and orthogonal to this contract.

#### Scenario: markDelivered is idempotent

- GIVEN a `CONFIRMED` Sale with `deliveryStatus='DELIVERED'` already
- WHEN `markDelivered()` is called a second time
- THEN no exception is thrown and the Sale's mutable state is unchanged
- AND no `Sale.update` write is issued

#### Scenario: markDelivered on a non-CONFIRMED Sale is rejected

- GIVEN a Sale in any status other than `CONFIRMED` (e.g. `DRAFT`, `CANCELED`)
- WHEN `markDelivered()` is called
- THEN it throws `SaleNotDeliverableError` (HTTP 422 `SALE_NOT_DELIVERABLE`)
- AND no `Sale.update` write is issued

#### Scenario: markSaleDelivered is tenant-scoped at the WHERE clause

- GIVEN a Sale S1 belongs to tenant T1 and the caller is in tenant T2
- WHEN `markSaleDelivered(tx, { tenantId: T2, saleId: S1.id })` runs
- THEN `tx.sale.update` raises Prisma `P2025` (record not found) because the `(id, tenantId)` predicate does not match
- AND S1's `deliveryStatus` is unchanged

### Requirement: One Active Route Per Sale (DB Partial Unique Index)

A Sale MUST appear in at most one ACTIVE route at any time. The invariant
is enforced by a single authoritative layer — the DB partial unique index —
plus the aggregate's DRAFT-gating:

1. **Aggregate DRAFT-gating.** `DeliveryRouteStop.activeRouteId` is a
   denormalized nullable column that is set to the route id exactly while
   the owning route is `ACTIVE`. It stays `NULL` while the route is `DRAFT`
   (so DRAFT routes never claim a sale), is armed on the `DRAFT → ACTIVE`
   transition, and is cleared on `cancel` (`ACTIVE → CANCELLED`) and on the
   auto `ACTIVE → COMPLETED` transition.

2. **DB partial unique index (authoritative 409).** The schema MUST
   include:

   ```sql
   CREATE UNIQUE INDEX delivery_route_stops_active_sale_uniq
     ON "delivery_route_stops" ("tenant_id", "sale_id")
     WHERE "activeRouteId" IS NOT NULL;
   ```

   `PrismaDeliveryRouteRepository.save` MUST map the resulting `P2002` to
   `DeliveryRouteSaleAlreadyInActiveRouteError` (code
   `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`), which the global
   filter maps to HTTP 409. Both a pre-existing claim (a sale already on
   another ACTIVE route before `start`) and a concurrent start race
   surface through this single path as 409 — there is no separate
   fast-422 pre-check in the implemented design.

`activeRouteId` MUST NOT be selected into the public read model and MUST
NOT be exposed via any DTO.

#### Scenario: A pre-existing active claim resolves as 409

- GIVEN sale S1 already belongs to an `ACTIVE` route R1 in tenant T
- WHEN an authorized caller POSTs `/delivery-routes/R2.id/start` where R2 is a `DRAFT` route referencing S1
- THEN the response is HTTP 409 `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`
- AND R2 remains `DRAFT`
- AND R1 is unchanged

#### Scenario: Concurrent start races resolve as 409

- GIVEN two `DRAFT` routes R1 and R2 in tenant T, both referencing sale S1 with no prior ACTIVE claim
- WHEN two callers concurrently POST `/delivery-routes/R1.id/start` and `/delivery-routes/R2.id/start`
- THEN one transaction commits successfully and its route becomes `ACTIVE`
- AND the other transaction raises Prisma `P2002` on the partial unique index
- AND the second response is HTTP 409 `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`
- AND the second route remains `DRAFT`

#### Scenario: Cancel clears the active marker so the sale can join a new route

- GIVEN sale S1 belongs to an `ACTIVE` route R1 in tenant T
- WHEN the caller invokes `POST /delivery-routes/R1.id/cancel`
- THEN R1 is `CANCELLED` and every stop in R1 has `activeRouteId=NULL`
- AND a subsequent `POST /delivery-routes/R2.id/start` referencing S1 succeeds (route R2 transitions to `ACTIVE`)

#### Scenario: Auto-complete clears the active marker

- GIVEN an `ACTIVE` route R1 with one remaining `PENDING` stop `S1` whose Sale belongs to R1
- WHEN the caller checks in the last stop `S1`
- THEN R1 is `COMPLETED` and `S1.activeRouteId=NULL`
- AND S1's Sale may now join a new ACTIVE route in a future change

#### Scenario: DRAFT routes never claim the marker

- GIVEN a `DRAFT` route R1 with stops referencing sales S1 and S2
- WHEN no caller has started R1
- THEN every stop in R1 has `activeRouteId=NULL`
- AND R1 does not block other ACTIVE routes referencing the same sales

### Requirement: Tenant Scoping of DeliveryRoute and DeliveryRouteStop

Both `DeliveryRoute` and `DeliveryRouteStop` MUST be present in
`TENANT_SCOPED_MODELS` so `TenantPrismaService` automatically filters
reads and attributes writes by the caller's `tenantId`. Every repository
method MUST additionally pass explicit `where: { id, tenantId }` (and
`tenantId` on `create`) as defense in depth. Cross-tenant access MUST
always be HTTP 404 (`DeliveryRouteNotFoundError` via the global filter) —
never 403 — so presence/absence is indistinguishable across tenants.

`DeliveryRoute` MUST belong to the `Tenant` relation set so cascade
delete propagates from `Tenant` to `DeliveryRoute` and then to
`DeliveryRouteStop`. `DeliveryRouteStop` MUST belong to the `Tenant`
and `Sale` relation sets; `Sale` MUST NOT be cascade-deleted while a
stop references it (`onDelete: Restrict`).

#### Scenario: Admin list is tenant-scoped

- GIVEN tenants T1 and T2 each have 2 `DeliveryRoute` rows
- WHEN a caller authenticated in T1 calls `GET /delivery-routes`
- THEN the response includes only the T1 rows

#### Scenario: Cross-tenant GET by id returns 404

- GIVEN `DeliveryRoute` R1 belongs to tenant T1
- WHEN a caller authenticated in T2 calls `GET /delivery-routes/R1.id`
- THEN the response is HTTP 404 `DELIVERY_ROUTE_NOT_FOUND`
- AND R1's fields are not leaked in the body

#### Scenario: Cross-tenant PATCH returns 404

- GIVEN `DeliveryRoute` R1 belongs to tenant T1 and is `DRAFT`
- WHEN a caller authenticated in T2 calls `PATCH /delivery-routes/R1.id`
- THEN the response is HTTP 404
- AND R1's mutable fields are unchanged

#### Scenario: Cross-tenant DELETE returns 404

- GIVEN `DeliveryRoute` R1 belongs to tenant T1
- WHEN a caller authenticated in T2 calls `DELETE /delivery-routes/R1.id`
- THEN the response is HTTP 404
- AND R1 is unchanged

#### Scenario: Tenant allowlist omission is caught by spec

- GIVEN the new module is deployed
- WHEN the change verification runs
- THEN `'DeliveryRoute'` and `'DeliveryRouteStop'` are both present in `TENANT_SCOPED_MODELS`
- AND repository reads/writes outside the allowlist pattern are not accepted in review

### Requirement: RBAC Permissions for DeliveryRoute

The system MUST register four permissions for `DeliveryRoute` in
`PERMISSION_REGISTRY`, all auto-seeded by `PermissionSeeder` on
`OnApplicationBootstrap`:

- `read:DeliveryRoute` — `View delivery routes`
- `create:DeliveryRoute` — `Create delivery routes (DRAFT)`
- `update:DeliveryRoute` — `Edit routes in DRAFT; check-in / cancel routes in ACTIVE`
- `delete:DeliveryRoute` — `Hard-delete a route that is still in DRAFT and has no stops`

The system MUST extend `AppSubjects` in
`src/auth/authorization/domain/permission.ts` with `'DeliveryRoute'`.
`'DeliveryRouteStop'` MUST NOT be added as a separate subject; per-stop
actions ride on the route-level `update` permission. Granting is
performed via the existing `PATCH /admin/roles/:id/permissions` endpoint
like any other permission.

`update` covers `start`, `checkInStop`, and `cancel` — there is no
separate `'check-in'` permission.

#### Scenario: Permissions auto-seed at boot

- GIVEN the application starts with the new code deployed
- WHEN `PermissionSeeder.onApplicationBootstrap` runs
- THEN four new rows appear in the `Permission` table with
  `subject='DeliveryRoute'` and `action` ∈
  `{read, create, update, delete}`

#### Scenario: Missing permission is rejected

- GIVEN a caller authenticated in tenant T with role R that has
  `create:DeliveryRoute` but NOT `update:DeliveryRoute`
- WHEN the caller calls `POST /delivery-routes/R1.id/start`
- THEN the request is rejected by `PermissionsGuard` (HTTP 403)

#### Scenario: Permission is grantable to any role

- GIVEN role R1 with `read:DeliveryRoute`
- WHEN `PATCH /admin/roles/:R1.id/permissions` is called with the
  matching `Permission.id`
- THEN R1's granted permissions include the new entry
- AND the role can read `DeliveryRoute` immediately on the next request

#### Scenario: Driver role grants only `read` and `update`

- GIVEN a tenant-admin-created `Driver` role with permissions
  `['read','DeliveryRoute']` and `['update','DeliveryRoute']` only
- WHEN a User with the `Driver` role authenticates in T
- THEN the User MAY call `GET /delivery-routes`, `GET /delivery-routes/:id`,
  `POST /delivery-routes/:id/start`, `POST /delivery-routes/:id/stops/:stopId/check-in`,
  and `POST /delivery-routes/:id/cancel` for routes they own
- AND the User MUST NOT call `POST /delivery-routes` (create) or `DELETE /delivery-routes/:id`
  (missing `create` / `delete` permissions, rejected as 403)

### Requirement: Driver Ownership Enforced by CASL Subject-Instance Condition

Driver ownership MUST be enforced by a CASL subject condition, not by
per-controller branching. A driver MAY `read` and `update` only routes
where `driverUserId === <caller's user id>`. Admins and super-admins MAY
act on any route in the tenant. The route-manager vs. driver-only
discriminator MUST be permission-derived: a caller is a route manager
when ANY of their granted `DeliveryRoute` permissions include `create`
or `delete`; otherwise they are driver-only. For a driver-only caller
the system MUST emit
`can('read', 'DeliveryRoute', { driverUserId: <userId> })` and
`can('update', 'DeliveryRoute', { driverUserId: <userId> })`. For a
route-manager caller the system MUST emit unconditional
`can(action, 'DeliveryRoute')` for each granted action. Super-admin
(`isSuperAdmin && tenantId === null`) short-circuits to `manage:all` as
today.

The `PermissionsGuard` MUST gain a backward-compatible subject-instance
condition evaluation step:

1. Build the CASL ability (unchanged).
2. Run the existing coarse `ability.can(action, subject)` loop with a
   string subject (still gates "does the user hold the permission at all").
3. When the action target is an instance-scoped subject that supports a
   condition (in this change: `DeliveryRoute`) AND
   `request.params.id` is present, resolve the subject instance via the
   injected `SUBJECT_INSTANCE_RESOLVERS` registry and re-check
   `ability.can(action, subject('DeliveryRoute', { driverUserId }))`
   using the `@casl/ability` `subject()` helper so the plain object is
   typed as `DeliveryRoute`. Throw `InsufficientPermissionsError` (HTTP 403)
   on false.

`SUBJECT_INSTANCE_RESOLVERS` MUST be a new seam
(`src/auth/authorization/subject-instance-resolver.ts`) defined as
`SubjectInstanceResolverMap = Partial<Record<AppSubjects, { resolveSubject(request): Promise<Record<string, unknown> | null> }>>`,
registered with the symbol `Symbol.for('SubjectInstanceResolvers')`.
`DeliveryRoutesModule` MUST register
`{ DeliveryRoute: { resolveSubject: req => repo.findDriverUserIdById(req.params.id) } }`
into the static `SubjectInstanceResolverRegistry` (seam token
`Symbol.for('SubjectInstanceResolvers')`) at module construction time —
the guard reads the registry on every `canActivate` call so late
registration works without re-instantiating the guard. The resolver
returns `{ driverUserId }` or `null`. If the resolver returns `null`
(route not found or cross-tenant miss), the guard MUST NOT throw; the
service later returns the proper 404. `POST /delivery-routes` (create)
and `GET /delivery-routes` (list) have no `:id`, so the instance step
is skipped there.

`request.ability` MUST be attached to the request as a backward-compatible
guard addition so the service can perform list-scope filtering.

#### Scenario: Driver reads their own route

- GIVEN driver D is the assigned `driverUserId` of route R in tenant T
- WHEN D calls `GET /delivery-routes/R.id` with `read:DeliveryRoute`
- THEN the response is HTTP 200 with R's `DeliveryRouteResponseDto`

#### Scenario: Driver cannot read another driver's route

- GIVEN driver D2 is NOT the `driverUserId` of route R, and D1 owns R
- WHEN D2 calls `GET /delivery-routes/R.id` with `read:DeliveryRoute`
- THEN the response is HTTP 403 `INSUFFICIENT_PERMISSIONS`
- AND no `DeliveryRoute` row is read into the response body

#### Scenario: Driver cannot check in a stop on another driver's route

- GIVEN driver D2 is NOT the `driverUserId` of route R
- WHEN D2 calls `POST /delivery-routes/R.id/stops/R.S1.id/check-in` with `update:DeliveryRoute`
- THEN the response is HTTP 403
- AND R's stop status, Sale mirror, and outbox rows are unchanged

#### Scenario: Admin reads any route in their tenant

- GIVEN admin A in tenant T (with `manage:all` via super-admin membership, or with `read:DeliveryRoute`)
- WHEN A calls `GET /delivery-routes/R.id` for any route in T (owned by any driver)
- THEN the response is HTTP 200 with R's `DeliveryRouteResponseDto`

#### Scenario: Driver list is filtered to assigned routes only

- GIVEN driver D is assigned to two of three routes in T (R1, R2 assigned; R3 not)
- WHEN D calls `GET /delivery-routes`
- THEN the response includes only R1 and R2
- AND `request.ability.can('create', 'DeliveryRoute')` returns `false` so the list is scoped

#### Scenario: Admin list is the full tenant list

- GIVEN admin A in tenant T has `create:DeliveryRoute` (route-manager discriminator)
- WHEN A calls `GET /delivery-routes`
- THEN the response includes every `DeliveryRoute` row in T regardless of driver assignment

#### Scenario: Subject-instance resolver returning null does not 403

- GIVEN route R does not exist (or belongs to another tenant) and a driver calls its id
- WHEN the `DeliveryRoute` subject-instance resolver returns `null`
- THEN the guard MUST NOT throw `InsufficientPermissionsError`
- AND the service returns HTTP 404 `DELIVERY_ROUTE_NOT_FOUND` via the global filter

### Requirement: List, Get, Cancel, and Delete Endpoints

`GET /delivery-routes` MUST require `read:DeliveryRoute` and MUST return
every `DeliveryRoute` in the caller's tenant, filtered by `driverUserId = self`
when the caller lacks `create:DeliveryRoute` (driver-only). `GET /delivery-routes/:id`
MUST require `read:DeliveryRoute`, MUST apply the subject-instance driver-ownership
condition, and MUST return `DeliveryRouteResponseDto` (HTTP 404 on miss).

`POST /delivery-routes/:id/cancel` MUST require `update:DeliveryRoute`,
MUST allow admins (any status) and drivers on their own `ACTIVE` route,
MUST transition the route to `CANCELLED`, set `cancelledAt`, and clear
`activeRouteId` on every stop (see "one-active-route-per-sale" requirement).
Drivers cancelling a route they do not own MUST be rejected (HTTP 403 via
the subject-instance condition).

`DELETE /delivery-routes/:id` MUST require `delete:DeliveryRoute` and
MUST be allowed only when the route is `DRAFT` AND has zero stops (hard
delete). Any other status or any non-empty stop set MUST be rejected with
`DeliveryRouteInvalidTransitionError` (HTTP 422).

#### Scenario: Cancel an ACTIVE route as admin

- GIVEN an `ACTIVE` route R assigned to driver D in tenant T
- WHEN an admin with `update:DeliveryRoute` in T POSTs `/delivery-routes/R.id/cancel`
- THEN the response is HTTP 200 with the updated `DeliveryRouteResponseDto` (`status='CANCELLED'`, `cancelledAt` set)
- AND every stop in R has `activeRouteId=NULL`
- AND no Sale mirror write is performed

#### Scenario: Cancel an ACTIVE route as owning driver

- GIVEN an `ACTIVE` route R assigned to driver D in tenant T
- WHEN D POSTs `/delivery-routes/R.id/cancel` with `update:DeliveryRoute`
- THEN the response is HTTP 200 with R `CANCELLED`

#### Scenario: Cancel a route owned by another driver

- GIVEN route R is assigned to driver D1, caller D2 has `update:DeliveryRoute`
- WHEN D2 POSTs `/delivery-routes/R.id/cancel`
- THEN the response is HTTP 403 (subject-instance condition)
- AND R's status is unchanged

#### Scenario: Delete a DRAFT route with no stops

- GIVEN a `DRAFT` route R in tenant T with zero stops
- WHEN an admin with `delete:DeliveryRoute` DELETEs `/delivery-routes/R.id`
- THEN the response is HTTP 204
- AND the row is removed from `delivery_routes`

#### Scenario: Delete a DRAFT route with stops is rejected

- GIVEN a `DRAFT` route R in tenant T with two stops
- WHEN an admin DELETEs `/delivery-routes/R.id`
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND R and its stops are unchanged

#### Scenario: Delete an ACTIVE route is rejected

- GIVEN an `ACTIVE` route R in tenant T
- WHEN an admin DELETEs `/delivery-routes/R.id`
- THEN the response is HTTP 422 `DELIVERY_ROUTE_INVALID_TRANSITION`
- AND R is unchanged

### Requirement: Durable Next-Stop Notification Pipeline

When `checkInStop` produces a next stop (i.e. the completed stop was NOT
the last stop in the route), the service MUST emit a `PENDING`
`outbox_events` row of type `delivery.next_stop.notify` inside the same
`runInTransaction` as the stop write and the Sale mirror. The row MUST
carry:

- `aggregateType: 'DeliveryRoute'`, `aggregateId: routeId`
- `tenantId`, `routeId`, `currentStopId`, `nextStopId`, `nextSaleId`
- `nextCustomerName`, `nextCustomerEmail` (nullable write-time snapshot;
  the authoritative email is re-resolved at send time by the Inngest
  function), `nextAddressLabel`
- `idempotencyKey` (`${tenantId}:${currentStopId}` — the deterministic
  Inngest dedupe seed, computed by `computeDeliveryNextStopIdempotencyKey`)
- `occurredAt` (ISO-8601 check-in timestamp)

The dispatch MUST follow the proven low-stock / hr-time-off blueprint,
NOT a direct `InngestService.send` after commit:

1. **Generic outbox poller exclusion.** The shared `OutboxPollerService`
   exclusion list MUST include `'delivery.next_stop.notify'` alongside
   `'stock.low.detected'` and `'hr.timeoff.requested'`. The generic
   dispatcher is fire-and-forget and is insufficient for durable email.

2. **Dedicated poller.** A new `DeliveryRoutesOutboxPoller` MUST claim
   only `eventType='delivery.next_stop.notify'` rows at a fixed interval
   (decorator tick `1000ms`; effective default interval `5000ms`,
   DI-overridable, batch size 25), use `FOR UPDATE SKIP LOCKED` plus
   `lockToken` / `lockedUntil`, and tolerate multiple worker instances.

3. **Dedicated dispatcher.** A new `DeliveryRoutesOutboxDispatcher` MUST
   `await` `InngestService.send('delivery/next-stop-notify', payload, idempotencyKey)`,
   MUST mark the outbox row `PUBLISHED` only on resolve (lock-token
   compare-and-swap for stale-worker safety), and MUST mark `FAILED`
   with backoff at max retries on rejection. The idempotency key MUST be
   `${tenantId}:${currentStopId}` so retries dedupe at the Inngest
   boundary.

4. **Inngest function.** `buildDeliveryNextStopNotifyFunctions` MUST
   return one Inngest function with
   `id: 'delivery-next-stop-notify'`,
   `triggers: [{ event: 'delivery/next-stop-notify' }]`,
   `idempotency: 'event.id'`, `retries: 3`, `concurrency: { limit: 5 }`.
   The handler MUST run each `step.run` callback inside
   `tenantRunner.runWithTenant(payload.tenantId, …)` so the CLS tenant
   context is set for background flows.

#### Scenario: Outbox row is written atomically with the stop and Sale mirror

- GIVEN a non-last stop check-in succeeds with route R in tenant T
- WHEN the transaction commits
- THEN exactly one `outbox_events` row of `eventType='delivery.next_stop.notify'`,
  `aggregateType='DeliveryRoute'`, `aggregateId=R.id`, `tenantId=T`, and
  `status='PENDING'` exists
- AND the row's payload contains `nextSaleId`, `nextCustomerEmail`
  (nullable snapshot), and the rest of the documented fields
- AND both writes share the same transaction commit

#### Scenario: Last stop does NOT emit a next-stop outbox row

- GIVEN an `ACTIVE` route with one remaining `PENDING` stop
- WHEN the caller checks in that last stop
- THEN the route is `COMPLETED`
- AND no `outbox_events` row of `eventType='delivery.next_stop.notify'` is written

#### Scenario: Generic outbox poller does not claim delivery rows

- GIVEN a `PENDING` `delivery.next_stop.notify` outbox row exists
- WHEN the shared `OutboxPollerService` ticks
- THEN it MUST NOT claim the row (excluded by event type)
- AND the dedicated `DeliveryRoutesOutboxPoller` claims it within its tick window

#### Scenario: Mailer failure retries, not drops

- GIVEN the Inngest function attempts to call `MAILER.send` and the port throws
- WHEN Inngest retries
- THEN the outbox row remains un-`PUBLISHED` until the mailer succeeds
- AND after Inngest's max retries (`retries: 3`) the outbox row reaches `FAILED` with an observable error

#### Scenario: Idempotency key dedupes retries

- GIVEN a `PENDING` `delivery.next_stop.notify` row in tenant T for current stop `S1`
- WHEN the dispatcher sends the Inngest event twice with idem key `T:S1`
- THEN at most one `delivery-next-stop-notify` function invocation delivers one email to the recipient
- AND Inngest's `idempotency: 'event.id'` collapses the duplicate

### Requirement: NotificationConfig Re-Gate at Send Time

The `DeliveryNextStopEmail` send path MUST re-gate on
`NotificationConfig` at Inngest execution time, NOT only at outbox write
time, because configuration can drift between the outbox write and the
dispatch. The Inngest function MUST perform the following steps in order,
each wrapped in `step.run` with `tenantRunner.runWithTenant` for tenant
context:

1. `load-config` — load `NotificationConfig` for `payload.tenantId` and
   re-check `config.enabled === true AND config.enabledActions.includes('DELIVERY_NEXT_STOP')`.
   If either is false, the function MUST exit with `{ skipped: 'action-disabled' }`
   and MUST NOT invoke `MAILER`.

2. `resolve-recipient` — call `ISaleCustomerEmailLookup.findEmailBySaleId({ tenantId, saleId: payload.nextSaleId })`.
   If the lookup returns `null`, the function MUST exit with
   `{ skipped: 'no-email' }` and MUST NOT invoke `MAILER`. The handler
   MUST NOT trust the write-time `payload.nextCustomerEmail` snapshot
   for the send decision; the authoritative email is the lookup result.

3. `send-email` — render `DeliveryNextStopEmail.tsx` via
   `renderToStaticMarkup(<DeliveryNextStopEmail …/>)` and call
   `mailer.send({ to: resolvedEmail, subject: "Tu paquete está por llegar", html })`.
   The template MUST render `nextCustomerName`, `nextAddressLabel`,
   `appBaseUrl`, and tenant brand tokens (`BRAND` / `LOGO_URL`). The
   template MUST NOT require a route-progress ("stop N of M") payload.

The "next stop exists" gate is satisfied at write time because
`ACTIVE` route stop sets are frozen (no reorder/remove in `ACTIVE`); the
handler therefore does not need to re-read the route aggregate for that
gate.

#### Scenario: Config disabled at send time skips the send

- GIVEN a `delivery.next_stop.notify` outbox row was emitted in tenant T while `DELIVERY_NEXT_STOP` was enabled
- AND a tenant admin subsequently disabled the action (or master toggle) before the Inngest function ran
- WHEN the Inngest function runs
- THEN it exits at `load-config` with `{ skipped: 'action-disabled' }`
- AND `MAILER.send` is never called

#### Scenario: No email on file for the next customer skips the send

- GIVEN the next stop's Sale has a `Customer` with `email = null`
- WHEN the Inngest function runs
- THEN it exits at `resolve-recipient` with `{ skipped: 'no-email' }`
- AND `MAILER.send` is never called
- AND a structured log records the skip with `nextSaleId`

#### Scenario: Authoritative email is the lookup result, not the snapshot

- GIVEN the write-time payload snapshot is `nextCustomerEmail: "old@example.com"`
- AND `ISaleCustomerEmailLookup.findEmailBySaleId` returns `"new@example.com"`
- WHEN the Inngest function sends the email
- THEN `MAILER.send` is called with `to: "new@example.com"`
- AND the snapshot is logged but never used for the send decision

#### Scenario: Config enabled and email present sends successfully

- GIVEN tenant T has `enabled=true`, `enabledActions=['DELIVERY_NEXT_STOP']`
- AND the next stop's Customer has `email = "c@t.com"`
- WHEN the Inngest function runs
- THEN `MAILER.send` is called once with `to: "c@t.com"` and the rendered `DeliveryNextStopEmail` HTML
- AND the outbox row reaches `PUBLISHED`

### Requirement: NotificationActionKey Registry Accepts DELIVERY_NEXT_STOP

The `NotificationActionKey` registry MUST accept `DELIVERY_NEXT_STOP`
alongside `LOW_STOCK` and `TIME_OFF_REQUESTED`. The registry MUST remain
closed: action keys outside the allowlist MUST continue to be rejected
with HTTP 400 `UNKNOWN_ACTION_KEY`. The TS alias and the Prisma enum MUST
agree; a drift between the two MUST be caught by an automated test.

The Prisma enum addition MUST be applied by a standalone migration
(Postgres `ALTER TYPE ... ADD VALUE` cannot run inside a transaction
block):

```sql
ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP';
```

#### Scenario: DELIVERY_NEXT_STOP accepted on PUT

- GIVEN tenant T with no current `NotificationAction` rows
- WHEN a caller with `update:NotificationConfig` PUTs
  `{ enabled: true, recipientUserIds: ['u1'], enabledActions: ['DELIVERY_NEXT_STOP'] }`
- THEN the response is HTTP 200
- AND a follow-up `GET /notification-config` returns
  `enabledActions: ['DELIVERY_NEXT_STOP']`

#### Scenario: Mixed registry accepted on PUT

- GIVEN tenant T with prior `enabledActions: ['LOW_STOCK']`
- WHEN the caller PUTs `enabledActions: ['LOW_STOCK', 'TIME_OFF_REQUESTED', 'DELIVERY_NEXT_STOP']`
- THEN the response is HTTP 200 and all three keys are stored

#### Scenario: Unknown key still rejected

- GIVEN the registry contains `LOW_STOCK`, `TIME_OFF_REQUESTED`, and `DELIVERY_NEXT_STOP`
- WHEN the caller PUTs `enabledActions: ['LEAD_CREATED']`
- THEN the response is HTTP 400 `UNKNOWN_ACTION_KEY` and no rows are written

#### Scenario: Enum drift is caught by a test

- GIVEN the TS array `NOTIFICATION_ACTION_KEYS` and the Prisma enum `NotificationActionKey`
- WHEN the drift test runs
- THEN the test asserts `LOW_STOCK`, `TIME_OFF_REQUESTED`, AND `DELIVERY_NEXT_STOP` are present in BOTH places
- AND the test fails if either side is missing one of the three keys

### Requirement: DeliveryRouteResponseDto Read Model

`DeliveryRoutesService.getById(id)` MUST return a `DeliveryRouteResponseDto`
mirroring the shape and assembly of `SaleDetailResponseDto` (`src/sales/dto/sale-detail-response.dto.ts`).
The DTO MUST be:

```ts
{
  id: string;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  driver: { id: string; name: string; email: string } | null;
  startedAt: string | null;          // ISO 8601
  completedAt: string | null;        // ISO 8601
  cancelledAt: string | null;        // ISO 8601
  notes: string | null;
  stops: Array<{
    id: string;
    saleId: string;
    saleFolio: string | null;
    sortOrder: number;
    status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
    checkedInAt: string | null;       // ISO 8601
    completedAt: string | null;       // ISO 8601
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
  }>;
  timeline: DeliveryRouteTimelineEventDto[];
}
```

`DeliveryRouteResponseDto.driver` MUST be null only if the driver `User`
is hard-deleted (driver relation is `onDelete: Restrict`, so this should
not happen in practice; the field MUST be `null` rather than throw on the
edge case). The repository MUST expose
`findOneWithStops(id: string): Promise<DeliveryRouteReadModel | null>`
that uses tenant-scoped `findFirst` with explicit `where: { id, tenantId }`
and nested selects for `driver` (`{ id, name, email }`) and per-stop
`sale.folio`, `customer` (`{ id, name, email }`), and `shippingAddress`
fields mirroring `prisma-sale.repository.ts findOneWithRelations`.

The `activeRouteId` marker column MUST NOT be selected into the read
model and MUST NOT be exposed in the DTO.

The list endpoint MUST return the same DTO shape (an array of
`DeliveryRouteResponseDto`) for each route.

#### Scenario: Read model includes driver, stops, timeline, and addresses

- GIVEN an `ACTIVE` route R with driver D, three stops referencing three Sales with Customers and shipping addresses
- WHEN `GET /delivery-routes/R.id` is called by an authorized caller
- THEN the response includes `driver = { id: D.id, name, email }`, `stops[]` ordered by `sortOrder`, each with `customer` and `shippingAddress` projections, and a `timeline` array

#### Scenario: activeRouteId is not exposed on the wire

- GIVEN any route
- WHEN the response is serialized
- THEN no field named `activeRouteId` (or equivalent) appears on the route or on any stop

#### Scenario: Cross-tenant read returns 404 without body leakage

- GIVEN route R1 belongs to tenant T1
- WHEN a caller authenticated in T2 calls `GET /delivery-routes/R1.id`
- THEN the response is HTTP 404
- AND no driver, stop, or address data appears in the body

### Requirement: DeliveryRoute Timeline Mirrors buildSaleTimeline

The system MUST expose `buildDeliveryRouteTimeline(input)` mirroring
`buildSaleTimeline` (`src/sales/domain/build-sale-timeline.ts`). The
builder MUST consume:

```ts
{
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  driver: { id: string; name: string } | null;
  stops: Array<{ id: string; sortOrder: number; checkedInAt: Date | null }>;
}
```

The output MUST be a discriminated union of
`DeliveryRouteTimelineEventDto`:

- `{ type: 'ROUTE_CREATED', at: string, actor: { id, name } | null }` —
  always emitted at `createdAt`, with `actor: null` (no creator is
  tracked in MVP).
- `{ type: 'ROUTE_STARTED', at: string, actor: { id, name } | null }` —
  emitted at `startedAt` when present, with `actor = driver`.
- `{ type: 'STOP_CHECKED_IN', at: string, stopId: string, sortOrder: number, actor: { id, name } | null }` —
  emitted at each stop's `checkedInAt` when present, with
  `actor = driver`, including the stop's `stopId` and `sortOrder`.
- `{ type: 'ROUTE_COMPLETED', at: string, actor: { id, name } | null }` —
  emitted at `completedAt` when present, with `actor = driver`.
- `{ type: 'ROUTE_CANCELLED', at: string, actor: { id, name } | null }` —
  emitted at `cancelledAt` when present, with `actor = driver`.

Events MUST be returned sorted by `at` ascending. `actor` MUST default to
the route's assigned `driver` for driver-attributable events and `null`
for `ROUTE_CREATED` (no `createdByUserId` field is persisted in MVP).

#### Scenario: Happy-path timeline ordering

- GIVEN a route created at `t0`, started at `t1`, with two stops checked in at `t2` and `t3`, and completed at `t4`
- WHEN `buildDeliveryRouteTimeline` runs
- THEN the returned events, sorted by `at`, are
  `ROUTE_CREATED (t0, actor=null)`, `ROUTE_STARTED (t1, actor=driver)`,
  `STOP_CHECKED_IN (t2, sortOrder=0, actor=driver)`,
  `STOP_CHECKED_IN (t3, sortOrder=1, actor=driver)`,
  `ROUTE_COMPLETED (t4, actor=driver)`

#### Scenario: Cancelled route timeline has no completion event

- GIVEN a route created at `t0`, started at `t1`, then cancelled at `t2` (no stops checked in)
- WHEN `buildDeliveryRouteTimeline` runs
- THEN the returned events are
  `ROUTE_CREATED (t0, actor=null)`, `ROUTE_STARTED (t1, actor=driver)`,
  `ROUTE_CANCELLED (t2, actor=driver)`
- AND no `STOP_CHECKED_IN` and no `ROUTE_COMPLETED` events appear

#### Scenario: DRAFT-only route timeline has only the created event

- GIVEN a `DRAFT` route that was never started
- WHEN `buildDeliveryRouteTimeline` runs
- THEN the returned events contain exactly `ROUTE_CREATED (t0, actor=null)`

### Requirement: IRouteOptimizer Port with Manual Default Adapter

The system MUST declare an `IRouteOptimizer` port
(`src/delivery-routes/domain/ports/route-optimizer.port.ts`) with
`Symbol.for('IRouteOptimizer')` as the token, matching the cross-context
seam convention (`MAILER`, `USER_EMAIL_LOOKUP`,
`NOTIFICATION_CONFIG_REPOSITORY`). The port signature MUST be:

```ts
optimize(input: { saleIds: string[]; tenantId: string }): Promise<{ orderedSaleIds: string[] }>;
```

A default `ManualRouteOptimizer` adapter MUST be registered in
`DeliveryRoutesModule` with `{ provide: ROUTE_OPTIMIZER, useClass: ManualRouteOptimizer }`.
The default adapter MUST return `{ orderedSaleIds: input.saleIds }`
(identity — no reordering). The adapter MUST be invoked at the
`create` / `addStop` / `reorderStops` boundaries (MVP: it validates and
echoes the caller-supplied order). A future map-provider adapter MUST
be a one-line module registration change.

#### Scenario: Manual adapter returns caller order

- GIVEN any `IRouteOptimizer` consumer in MVP
- WHEN the consumer calls `optimize({ saleIds: [S3, S1, S2], tenantId: T })`
- THEN the result is `{ orderedSaleIds: [S3, S1, S2] }` (no reordering)

#### Scenario: Port can be swapped via DI

- GIVEN a future `MapProviderRouteOptimizer` adapter
- WHEN it is registered in `DeliveryRoutesModule` with `{ provide: ROUTE_OPTIMIZER, useClass: MapProviderRouteOptimizer }`
- THEN domain code depending on `IRouteOptimizer` continues to compile
- AND `optimize` calls are routed to the new adapter

## Verification Surface

- `prisma/schema.prisma` — `DeliveryRouteStatus` and
  `DeliveryRouteStopStatus` enums; `DeliveryRoute` and `DeliveryRouteStop`
  models with FK to `Tenant` (cascade), `DeliveryRoute` driver FK to
  `User` (restrict), and `DeliveryRouteStop` FK to `Sale` (restrict).
  Back-relations added on `Tenant`, `User`, and `Sale`.
- `prisma/migrations/<ts>_add_delivery_routes/migration.sql` —
  creates `delivery_routes` and `delivery_route_stops`, declares
  `@@unique([routeId, sortOrder])` and the partial unique index
  `delivery_route_stops_active_sale_uniq ON (tenant_id, sale_id) WHERE activeRouteId IS NOT NULL`.
- `prisma/migrations/<ts>_add_delivery_next_stop_action/migration.sql` —
  standalone `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP'`.
- `src/shared/tenant/tenant-scoped-models.constant.ts` —
  `'DeliveryRoute'` and `'DeliveryRouteStop'` entries present.
- `src/auth/authorization/domain/permission.ts` — `'DeliveryRoute'` in
  `AppSubjects`; four entries in `PERMISSION_REGISTRY`.
- `src/auth/authorization/casl-ability.factory.ts` — driver-ownership
  condition matcher (`{ driverUserId: userId }`) and the
  `isRouteManager` discriminator derived from `create` / `delete` grants.
- `src/auth/authorization/permissions.guard.ts` — backward-compatible
  subject-instance condition evaluation; `request.ability` attached.
- `src/auth/authorization/subject-instance-resolver.ts` — new seam,
  `SUBJECT_INSTANCE_RESOLVERS = Symbol.for('SubjectInstanceResolvers')`,
  `DeliveryRoutesModule` provides `{ DeliveryRoute: … }`.
- `src/notification-config/domain/notification-config.ts` —
  `'DELIVERY_NEXT_STOP'` added to union and `NOTIFICATION_ACTION_KEYS` array.
- `src/shared/outbox/outbox-poller.service.ts` — exclusion list extended
  to include `'delivery.next_stop.notify'`.
- `src/sales/domain/sale.entity.ts` — `markDelivered()` aggregate
  method (status-only, idempotent, `SaleNotDeliverableError` on
  non-`CONFIRMED`).
- `src/sales/domain/sale.errors.ts` — `SaleNotDeliverableError` added.
- `src/sales/domain/sale.repository.ts` — `markSaleDelivered(tx, { tenantId, saleId })`
  port method.
- `src/sales/infrastructure/prisma-sale.repository.ts` — implements
  `markSaleDelivered` with `where: { id: saleId, tenantId }` defense
  in depth.
- `src/delivery-routes/**` — new bounded context (domain entity + ports,
  application service, Prisma repository, outbox poller/dispatcher,
  Inngest function/registrar, controller, DTOs, timeline builder, module
  wiring).
- `src/notifications/email/templates/delivery-next-stop.email.tsx` —
  React Email template rendering `nextCustomerName`,
  `nextAddressLabel`, `appBaseUrl`, and tenant brand tokens.
- `src/app.module.ts` — registers `DeliveryRoutesModule`,
  `DeliveryRoutesOutboxModule`, and top-level `DeliveryRoutesInngestRegistrar`.
- Co-located Jest unit specs:
  - `src/delivery-routes/domain/delivery-route.entity.spec.ts` —
    lifecycle transitions, idempotency, create-time eligibility
    validation, auto-complete on last stop, error mapping.
  - `src/delivery-routes/application/delivery-routes.service.spec.ts` —
    check-in transaction orchestration (stop + Sale + outbox), driver
    list scoping, `start()` P2002 → 409 mapping, error mapping.
  - `src/delivery-routes/domain/build-delivery-route-timeline.spec.ts` —
    event ordering, actor defaults, missing-timestamp branches.
  - `src/delivery-routes/infrastructure/manual-route-optimizer.spec.ts` —
    identity echo.
  - `src/delivery-routes/inngest/delivery-next-stop-notify.functions.spec.ts` —
    config re-gate, null-email skip, send path, snapshot vs.
    authoritative lookup.
  - `src/auth/authorization/casl-ability.factory.spec.ts` —
    driver-only vs admin condition building, `isRouteManager`
    discriminator.
  - `src/auth/authorization/guards/permissions.guard.spec.ts` —
    subject-instance condition evaluation (pass / 403 / null → defer).
  - `src/notification-config/domain/notification-config.drift.spec.ts` —
    TS union and Prisma enum both contain `DELIVERY_NEXT_STOP`.
  - `src/shared/outbox/outbox-poller.service.spec.ts` —
    generic poller exclusion list includes `delivery.next_stop.notify`
    (claim-disjointness with the dedicated poller).
- `*.integration.spec.ts` against `jest.integration.config.js`:
  - `src/delivery-routes/infrastructure/prisma-delivery-route.repository.integration.spec.ts` —
    tenant scoping, `findOneWithStops` projection,
    `findDriverUserIdById`, `P2002` mapping on the partial unique
    index race.
  - `src/sales/infrastructure/prisma-sale.repository.markSaleDelivered.integration.spec.ts` —
    `markSaleDelivered` tenant-scoped `WHERE { id, tenantId }`.
- Verification commands: `pnpm build` (green); `pnpm test` — final
  suite 211 suites / 2929 tests green; integration specs green
  against the test DB (port 5433), including the ADR-7 `P2002` → 409
  mapping against real Postgres.
