# Proposal — `delivery-routes` (Circuit-like Delivery Route Tracking)

Status: proposed

## Intent

Introduce a tenant-scoped, route-aware delivery workflow inside HoundFe. A `Driver` (a `User` granted a dedicated `Driver` role) is assigned a `DeliveryRoute` — an ordered list of stops, each stop backed by an existing `Sale` whose `deliveryStatus ∈ {PENDING, SHIPPED}` and that has a `shippingAddress`. The driver checks in stop-by-stop through the frontend web (no GPS in MVP); completing a stop transitions the underlying `Sale.deliveryStatus` to `DELIVERED` and durably emails the customer of the **next** stop an "arriving soon" notification (when that customer has an email). Route ordering is manual today and hidden behind an abstracted `IRouteOptimizer` port, so a map-provider adapter can replace the manual one later without touching domain code. The change is a new bounded context under `src/delivery-routes/` mirroring the proven `src/admin/payment-details/` slice.

## Problem (current-state gap)

1. **No route aggregate.** Nothing in the schema groups sales into a driver-assignable, ordered route with a lifecycle. The shipping workflow today collapses to two Sale-level transitions: `PENDING` (charge time) and `SHIPPED` (chatbot direct prisma update at `src/chatbot-api/application/chatbot-api.service.ts:401-433`). There is no `DELIVERED` aggregate method, no stop concept, no driver concept.
2. **No "delivered" transition.** `Sale.setDeliveryMetadata` exists on the aggregate (`src/sales/domain/sale.entity.ts:622-630`) but `ISaleRepository.save()` (`src/sales/infrastructure/prisma-sale.repository.ts:101-113`) does **not** persist `carrierName / trackingRef / estimatedDeliveryAt` and no method exists to write `deliveryStatus = 'DELIVERED'` through the aggregate. Today the only write path that flips status to anything other than `PENDING` is the chatbot's direct `prisma.sale.update`, which is an architectural smell (repository bypass).
3. **Drivers have no identity seam.** `User` has no delivery-related role. There is no model that connects a User to assigned sales with a shipping address. `Employee.userId` was the closest bridge (retired in `hr-validation-notifications`); the delivery flow needs its own first-class `User` relation.
4. **No "arriving soon" notification story.** The durable email pipeline (outbox → dedicated poller/dispatcher → Inngest → `MAILER`) is proven for low-stock and HR time-off but there is no entry point for route stop completion events, and `NotificationActionKey` has no delivery variant.
5. **No ordering abstraction.** Even a future optimization story has nowhere to plug in; introducing one now keeps the door open without forcing a refactor later.

## Goals / Outcome

After this change:

- A tenant admin can **create a `DeliveryRoute` in `DRAFT`**, add stops by selecting existing `Sale`s (`deliveryStatus ∈ {PENDING, SHIPPED}` + `shippingAddress` present), reorder them, assign a driver `User`, and **start** the route (transitions to `ACTIVE`). Cancelling a route (in `DRAFT` or `ACTIVE`) transitions to `CANCELLED`. Completing the last stop transitions the route to `COMPLETED`.
- A driver can `GET /delivery-routes/:id`, list their assigned routes, and `POST /delivery-routes/:id/stops/:stopId/check-in`. Check-in flips the stop's status to `COMPLETED`, transitions the underlying `Sale.deliveryStatus` to `DELIVERED` atomically in one transaction, and (if there is a next stop whose `Customer.email` is non-null) durably emails that customer.
- The route is the single source of truth for "this sale was delivered": `DeliveryRouteStop.status === 'COMPLETED'`. `Sale.deliveryStatus === 'DELIVERED'` is a derived mirror written in the same transaction; no other write path can flip a sale to `DELIVERED`.
- A Sale can appear in at most one ACTIVE route at a time (DB-level partial unique index + application-level validation on `start()`).
- The notification reaches the next-stop customer through the existing outbox → poller → Inngest → `MAILER` pipeline; tenants opt in via `PUT /notification-config` (`enabledActions.includes('DELIVERY_NEXT_STOP')`).
- All read/write paths are tenant-scoped via `TENANT_SCOPED_MODELS` allowlist + explicit `where: { id, tenantId }` defense in depth.

## Non-goals (explicit)

- **GPS / live tracking.** No geolocation, no map, no live ETA. The driver interacts via the frontend web and taps "check-in".
- **Map-provider route optimization.** `IRouteOptimizer` exists as a port with a manual default adapter only. No Google/Mapbox integration in this change.
- **Driver self-registration or driver app.** Drivers authenticate through the same web app with the `Driver` role granted by a tenant admin.
- **Other notification triggers** (route started, route cancelled, last stop completed, customer "delivered" confirmation). Only "your package is arriving soon" (next stop) is in scope.
- **Carrier / tracking metadata capture** (`carrierName`, `trackingRef`, `estimatedDeliveryAt`) on stop completion. The exploration's finding about `Sale.setDeliveryMetadata` not being persisted via `save()` is acknowledged; we do NOT widen `save()` in this change. The chatbot's direct `prisma.sale.update` path remains the only writer of carrier metadata until a future change explicitly handles it.
- **Re-editing an ACTIVE route.** Stops can be reordered only in `DRAFT`; once `ACTIVE`, the route's stop set is frozen. Completing stops is the only mutation allowed.
- **Per-stop notes, photos, signatures, customer contact.** Not in MVP.
- **Cross-tenant routes.** Routes are tenant-scoped end-to-end; there is no `Super Admin`-only "operate any route" endpoint in this change.
- **Historical route replay / audit timeline UI.** Backend records events; a frontend timeline view is downstream.
- **Refunds touching route state.** `Sale.cancel()` already blocks cancellation when `SHIPPED|DELIVERED`. The route lifecycle does not need to add new cancellation rules to the Sale; the existing aggregate guard is sufficient.

## Proposed Solution

### Bounded context

A new module `src/delivery-routes/` with the canonical hexagonal layout:

```
src/delivery-routes/
  domain/
    delivery-route.entity.ts          # aggregate root
    delivery-route-stop.entity.ts     # stop entity
    delivery-route.repository.ts       # port + DELIVERY_ROUTE_REPOSITORY token
    delivery-route.errors.ts          # BusinessRuleViolationError / EntityNotFoundError subclasses
    ports/
      route-optimizer.port.ts         # IRouteOptimizer + ROUTE_OPTIMIZER token
  application/
    delivery-routes.service.ts        # orchestration (create / addStop / reorder / start / checkIn)
    delivery-routes.service.spec.ts   # co-located unit specs
  infrastructure/
    prisma-delivery-route.repository.ts
  outbox/
    delivery-routes-outbox.poller.ts
    delivery-routes-outbox.dispatcher.ts
    delivery-routes-outbox.module.ts
  inngest/
    delivery-routes-inngest-registrar.ts
    delivery-next-stop-notify.functions.ts
  presentation/
    delivery-routes.controller.ts     # /delivery-routes
  dto/
    create-delivery-route.dto.ts
    add-stop.dto.ts
    reorder-stops.dto.ts
    delivery-route-response.dto.ts
  delivery-routes.module.ts
```

Registration:
- `src/admin/admin.module.ts` does NOT import it — this is a top-level feature used by both tenant admins and drivers.
- `src/app.module.ts` imports `DeliveryRoutesModule`, `DeliveryRoutesOutboxModule`, and registers `DeliveryRoutesInngestRegistrar` as a top-level provider (mirror of `HrTimeOffInngestRegistrar` placement).

### Data model — Prisma

Two new tables, two new enums, additive migration only.

```prisma
enum DeliveryRouteStatus {
  DRAFT
  ACTIVE
  COMPLETED
  CANCELLED
}

enum DeliveryRouteStopStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  SKIPPED
}

model DeliveryRoute {
  id           String                @id @default(uuid())
  tenantId     String
  tenant       Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  driverUserId String
  driver       User                  @relation("DeliveryRouteDriver", fields: [driverUserId], references: [id], onDelete: Restrict)
  status       DeliveryRouteStatus   @default(DRAFT)
  startedAt    DateTime?
  completedAt  DateTime?
  cancelledAt  DateTime?
  notes        String?
  createdAt    DateTime              @default(now())
  updatedAt    DateTime              @updatedAt
  stops        DeliveryRouteStop[]
  @@index([tenantId])
  @@index([tenantId, driverUserId, status])
  @@index([tenantId, status])
  @@map("delivery_routes")
}

model DeliveryRouteStop {
  id           String                    @id @default(uuid())
  tenantId     String
  tenant       Tenant                    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  routeId      String
  route        DeliveryRoute             @relation(fields: [routeId], references: [id], onDelete: Cascade)
  saleId       String
  sale         Sale                      @relation(fields: [saleId], references: [id], onDelete: Restrict)
  sortOrder    Int
  status       DeliveryRouteStopStatus   @default(PENDING)
  checkedInAt  DateTime?
  completedAt  DateTime?
  skippedReason String?
  createdAt    DateTime                  @default(now())
  updatedAt    DateTime                  @updatedAt
  @@unique([routeId, sortOrder])
  @@index([tenantId])
  @@index([tenantId, saleId])
  @@index([saleId])
  @@map("delivery_route_stops")
}
```

Back-relations to add to `Tenant`, `User`, `Sale` (one line each):

```prisma
model Tenant {
  // ...
  deliveryRoutes         DeliveryRoute[]
  deliveryRouteStops     DeliveryRouteStop[]
}

model User {
  // ...
  deliveryRoutesAssigned DeliveryRoute[] @relation("DeliveryRouteDriver")
}

model Sale {
  // ...
  deliveryRouteStops     DeliveryRouteStop[]
}
```

Plus a partial unique index that makes "a sale is in at most one ACTIVE route" a database invariant:

```sql
CREATE UNIQUE INDEX delivery_route_stops_active_sale_uniq
  ON "delivery_route_stops" ("tenant_id", "sale_id")
  WHERE EXISTS (
    SELECT 1 FROM "delivery_routes"
    WHERE "delivery_routes"."id" = "delivery_route_stops"."route_id"
      AND "delivery_routes"."status" = 'ACTIVE'
  );
```

(The migration uses a Postgres-friendly equivalent; the partial-index SQL above is the canonical intent and is enforced through a separate `CREATE UNIQUE INDEX ... WHERE` statement in the same migration. The adapter's `start()` validates the same condition in code as a defense-in-depth check before insert.)

### Aggregate design

`DeliveryRoute` is the aggregate root; `DeliveryRouteStop` is a child entity owned by the route. Both are pure TypeScript with no Nest/Prisma dependencies:

- `static create({ tenantId, driverUserId, saleIds, notes, now })` — validates driver exists, every saleId belongs to the tenant and has `deliveryStatus ∈ {PENDING, SHIPPED}` and a `shippingAddressId`, builds the route in `DRAFT` with `sortOrder = [0..n-1]`.
- `static fromPersistence(props)` — round-trips without validation; preserves `status`, timestamps, and stop order.
- Mutators (each returns `this` and is the only place that may transition status):
  - `reorderStops(orderedStopIds)` — `DRAFT` only; re-sequences `sortOrder`.
  - `start(now)` — `DRAFT → ACTIVE`; asserts every sale is still eligible (re-validate `deliveryStatus`, `shippingAddressId`); sets `startedAt`; emits an in-memory `DeliveryRouteStartedEvent` (logged only, mirroring `sale-event.listener.ts`).
  - `checkInStop(stopId, now)` — `ACTIVE` only; flips the stop to `COMPLETED`, sets `checkedInAt` + `completedAt`; if all stops are `COMPLETED`, transitions route to `COMPLETED` and sets route `completedAt`; returns the next-stop snapshot (or `null`).
  - `cancel(now, reason)` — `DRAFT|ACTIVE → CANCELLED`; sets `cancelledAt`.
- Errors: `DeliveryRouteNotFoundError`, `DeliveryRouteInvalidTransitionError`, `DeliveryRouteStopSaleNotEligibleError`, `DeliveryRouteStopSaleAlreadyOnActiveRouteError` (mirroring `BusinessRuleViolationError` mapping in the global filter).

### Sale integration — single source of truth

The repository gets one new method, narrowly scoped:

```ts
// src/sales/domain/sale.repository.ts
markSaleDelivered(
  tx: PrismaTxClient,
  input: { tenantId: string; saleId: string; completedAt: Date },
): Promise<void>;
```

`PrismaSaleRepository.markSaleDelivered` does:

```ts
await tx.sale.update({
  where: { id: saleId, tenantId },  // defense in depth
  data: { deliveryStatus: 'DELIVERED' },
});
```

A new aggregate method on `Sale`:

```ts
// src/sales/domain/sale.entity.ts
markDelivered(now: Date): void {
  if (this._status !== 'CONFIRMED') throw new SaleNotConfirmableError(...);  // mirror existing guards
  if (this._deliveryStatus === 'DELIVERED') return; // idempotent
  this._deliveryStatus = 'DELIVERED';
  this._deliveryCompletedAt = now;
}
```

`markDelivered` is called inside the same `runInTransaction` as the route stop update, so a single commit flips both `DeliveryRouteStop.status` (root aggregate) and `Sale.deliveryStatus` (derived mirror). This is the **single source of truth** answer to the exploration's dual-write concern: the route stop is canonical, the Sale is mirrored in the same tx, no other code path writes `'DELIVERED'` for a Sale that belongs to a route.

`Sale.setDeliveryMetadata` is NOT widened in this change; the chatbot direct-prisma path stays as-is for carrier/tracking writes. A future change can address that gap explicitly.

### `IRouteOptimizer` port

```ts
// src/delivery-routes/domain/ports/route-optimizer.port.ts
export interface IRouteOptimizer {
  optimize(input: { saleIds: string[]; tenantId: string }): Promise<{ orderedSaleIds: string[] }>;
}
export const ROUTE_OPTIMIZER = Symbol.for('IRouteOptimizer');
```

`Symbol.for` is the chosen convention because the canonical cross-context seams (`MAILER`, `USER_EMAIL_LOOKUP`, `NOTIFICATION_CONFIG_REPOSITORY`) all use `Symbol.for`. The proposal picks **one** convention for the new bounded context (over the inconsistent `Symbol('…')` pattern) and states it here.

Default adapter `ManualRouteOptimizer` is registered in `DeliveryRoutesModule`:

```ts
{ provide: ROUTE_OPTIMIZER, useClass: ManualRouteOptimizer }
```

`ManualRouteOptimizer.optimize` returns `{ orderedSaleIds: input.saleIds }` (no reordering). The adapter is replaceable via Nest DI when a map-provider adapter is built later; domain code only depends on the port.

### RBAC

`AppSubjects` gains one new member: `'DeliveryRoute'`. `PERMISSION_REGISTRY` gains four entries (mirror `PaymentDetail` block):

```ts
{ subject: 'DeliveryRoute', action: 'create',  description: 'Create delivery routes (DRAFT)' },
{ subject: 'DeliveryRoute', action: 'read',    description: 'Read delivery routes' },
{ subject: 'DeliveryRoute', action: 'update',  description: 'Edit routes in DRAFT; check-in / cancel routes in ACTIVE' },
{ subject: 'DeliveryRoute', action: 'delete',  description: 'Hard-delete a route that is still in DRAFT and has no stops' },
```

`update` covers `start()`, `checkInStop()`, and `cancel()` — there is no separate `'check-in'` permission. `'DeliveryRouteStop'` is intentionally **not** added as a separate subject; per-stop actions ride on the route-level `update` permission.

The four entries are auto-seeded by `PermissionSeeder` at bootstrap (no manual seed script).

**Driver role** is a tenant-admin concern, not a seeder concern. The proposal documents the exact permission set a tenant should attach to a `Driver` role to use the driver surface:

```
['read', 'DeliveryRoute']  // list assigned routes + read detail
['update', 'DeliveryRoute'] // check-in / cancel own routes
```

Admin users with `manage:all` automatically get all four permissions via `CaslAbilityFactory`.

### NotificationActionKey + migration

```ts
// src/notification-config/domain/notification-config.ts
export type NotificationActionKey = 'LOW_STOCK' | 'TIME_OFF_REQUESTED' | 'DELIVERY_NEXT_STOP';
export const NOTIFICATION_ACTION_KEYS = ['LOW_STOCK', 'TIME_OFF_REQUESTED', 'DELIVERY_NEXT_STOP'] as const;
```

Standalone migration (Postgres `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block):

```sql
-- prisma/migrations/<ts>_add_delivery_next_stop_action/migration.sql
ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP';
```

### Durable email pipeline (outbox → poller → Inngest → MAILER)

Mirrors `hr-time-off` end-to-end. The change has four moving parts:

1. **Outbox emit (inside route check-in tx).** `DeliveryRoutesService.checkInStop` calls `tenantPrisma.runInTransaction(async tx => { ... mark stop completed; mark sale delivered; if (nextStop) { await outboxWriter.publish(tx, tenantId, 'DeliveryRoute', routeId, 'delivery.next_stop.notify', payload); } })`. Payload shape: `{ tenantId, routeId, currentStopId, nextSaleId, nextSaleFolio, nextCustomerName, nextAddressLabel, nextEstimatedApproach: 'soon' }` (no GPS).
2. **Generic poller exclusion.** `src/shared/outbox/outbox-poller.service.ts:66` extends `NOT IN (...)` to include `'delivery.next_stop.notify'`.
3. **Dedicated poller + dispatcher.** `src/delivery-routes/outbox/delivery-routes-outbox.poller.ts` (mirrors `hr-time-off-outbox.poller.ts`, claims only `eventType = 'delivery.next_stop.notify'`, `@Interval(1000)`, `lockToken` + `lockedUntil` + `FOR UPDATE SKIP LOCKED`). `src/delivery-routes/outbox/delivery-routes-outbox.dispatcher.ts` awaits `inngestService.send('delivery/next-stop-notify', payload, idempotencyKey)`, marks `PUBLISHED` only on resolve, `FAILED` on reject (with bounded retries already configured in Inngest). Idempotency key: `${tenantId}:${currentStopId}` so retries dedupe at the Inngest boundary.
4. **Inngest function.** `src/delivery-routes/inngest/delivery-next-stop-notify.functions.ts` `buildDeliveryNextStopNotifyFunctions({ inngestClient, tenantRunner, notificationConfigRepository, userEmailLookup, mailer, appBaseUrl })` returns `[fn]` via `inngestClient.createFunction({ id: 'delivery-next-stop-notify', triggers: [{ event: 'delivery/next-stop-notify' }], idempotency: 'event.id', retries: 3, concurrency: { limit: 5 } }, handler)`. Handler steps inside `step.run`: `load-config` (re-gate `enabledActions.includes('DELIVERY_NEXT_STOP')`); `resolve-recipient` (load `nextSaleId`'s `Customer.email` via a new narrow method on the sale/customer read projection — see below); `send-email` (`renderToStaticMarkup(<DeliveryNextStopEmail .../>)` + `mailer.send`). `tenantRunner.runWithTenant` runs INSIDE each `step.run` callback (mirroring `time-off-notification.functions.ts`).

`tenantRunner.runWithTenant` is the only path that creates a CLS tenant context for background flows; it seeds `tenantId`, `userId = 'system'`, `isSuperAdmin = false`. The recipient lookup happens under that context.

`DeliveryRoutesInngestRegistrar` is a top-level provider in `app.module.ts` (not nested inside a module) so the dep graph stays at AppModule scope — exact mirror of `HrTimeOffInngestRegistrar`.

### Customer email lookup

`Customer.email` is nullable and tenant-scoped (`src/customers/domain/...`). The Inngest function needs a narrow read projection that, given a `saleId`, returns the tenant-scoped `Customer.email` (or `null`).

A new port:

```ts
// src/delivery-routes/domain/ports/sale-customer-email.port.ts (or co-located in src/sales)
export interface ISaleCustomerEmailLookup {
  findEmailBySaleId(input: { tenantId: string; saleId: string }): Promise<string | null>;
}
export const SALE_CUSTOMER_EMAIL_LOOKUP = Symbol.for('ISaleCustomerEmailLookup');
```

The adapter is a thin Prisma call under `tenantRunner`'s CLS context:

```ts
const customer = await prisma.sale.findFirst({
  where: { id: saleId, tenantId },
  select: { customer: { select: { email: true } } },
});
return customer?.customer?.email ?? null;
```

If `email === null`, the Inngest function logs "no email — skipped" and exits cleanly (no send). This is the exploration's finding #4 resolution: the email is resolved tenant-scoped via a `null`-aware projection, not assumed.

### HTTP API

All routes are mounted at `/delivery-routes` (no `/admin/` prefix because both admin and driver users hit the same endpoints; CASL decides who can call what). Guards: `JwtAuthGuard`, `TenantContextGuard`, `PermissionsGuard` (mirror `admin-payment-detail.controller.ts`).

```
POST   /delivery-routes                                  create:DeliveryRoute   admin
GET    /delivery-routes                                  read:DeliveryRoute     admin / driver
GET    /delivery-routes/:id                              read:DeliveryRoute     admin / driver (driver must own)
PATCH  /delivery-routes/:id                              update:DeliveryRoute   admin (DRAFT only)
POST   /delivery-routes/:id/start                        update:DeliveryRoute   admin / driver (driver must own)
POST   /delivery-routes/:id/stops/:stopId/check-in       update:DeliveryRoute   admin / driver (driver must own)
POST   /delivery-routes/:id/cancel                       update:DeliveryRoute   admin (any status) / driver (own ACTIVE)
DELETE /delivery-routes/:id                              delete:DeliveryRoute   admin (DRAFT, no stops)
```

Driver-ownership enforcement is a CASL subject-matcher condition (`subject: 'DeliveryRoute'`, condition `route.driverUserId === user.id`); it lives in `CaslAbilityFactory` and is checked by `PermissionsGuard`. Drivers can only `update`/`read` their own routes; admins can `manage` all.

### DTOs and read model

`DeliveryRouteResponseDto`:

```ts
{
  id, status, driver: { id, name, email },
  startedAt?, completedAt?, cancelledAt?, notes?,
  stops: [
    {
      id, saleId, saleFolio, sortOrder, status,
      checkedInAt?, completedAt?,
      shippingAddress: { /* CustomerAddress shape */ },
      customer: { id, name, email? },
    }
  ],
  timeline: [
    { type: 'ROUTE_CREATED', at, byUserId },
    { type: 'ROUTE_STARTED', at, byUserId },
    { type: 'STOP_CHECKED_IN', at, stopId, byUserId },
    { type: 'ROUTE_COMPLETED' | 'ROUTE_CANCELLED', at, byUserId },
  ]
}
```

The service mirrors `SaleDetailService.getSaleDetail` (`src/sales/sales.service.ts:1452-1519`): read model from repository → domain entity → builder → DTO. A new `buildDeliveryRouteTimeline` helper mirrors `buildSaleTimeline` (`src/sales/domain/build-sale-timeline.ts:75-80`).

### Provider token convention decision

For the new bounded context we pick **`Symbol.for('…')` exclusively**, matching the cross-context seam convention (`MAILER`, `USER_EMAIL_LOOKUP`, `NOTIFICATION_CONFIG_REPOSITORY`). The intra-context port `DELIVERY_ROUTE_REPOSITORY` follows the same convention so the rule is uniform inside the new module. (The codebase's mixed `Symbol('…')` history is acknowledged; this proposal does not propose to normalize older modules, only to set the rule for new code.)

## Affected areas

| Area | Change |
|---|---|
| `prisma/schema.prisma` | New `DeliveryRouteStatus`, `DeliveryRouteStopStatus` enums; new `DeliveryRoute`, `DeliveryRouteStop` models; back-relations on `Tenant`, `User`, `Sale`. Partial unique index added via migration SQL. |
| `prisma/migrations/<ts>_add_delivery_routes/migration.sql` | Create `delivery_routes`, `delivery_route_stops` tables; create the partial unique index. |
| `prisma/migrations/<ts>_add_delivery_next_stop_action/migration.sql` | Standalone `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP'`. |
| `src/shared/tenant/tenant-scoped-models.constant.ts` | Add `'DeliveryRoute'` and `'DeliveryRouteStop'`. |
| `src/auth/authorization/domain/permission.ts` | Add `'DeliveryRoute'` to `AppSubjects`; 4 CRUD entries in `PERMISSION_REGISTRY`. |
| `src/auth/authorization/casl-ability.factory.ts` | Add driver-ownership condition matcher for `'DeliveryRoute'` subject. |
| `src/notification-config/domain/notification-config.ts` | Add `'DELIVERY_NEXT_STOP'` to union + `NOTIFICATION_ACTION_KEYS` array. |
| `src/shared/outbox/outbox-poller.service.ts` | Extend exclusion `NOT IN ('stock.low.detected','hr.timeoff.requested','delivery.next_stop.notify')`. |
| `src/sales/domain/sale.entity.ts` | Add `markDelivered(now)` aggregate method. |
| `src/sales/domain/sale.repository.ts` | Add `markSaleDelivered(tx, input)` port method. |
| `src/sales/infrastructure/prisma-sale.repository.ts` | Implement `markSaleDelivered` adapter. |
| `src/delivery-routes/**` | New bounded context (domain, application, infrastructure, dto, presentation, ports, outbox, inngest). |
| `src/app.module.ts` | Register `DeliveryRoutesModule`, `DeliveryRoutesOutboxModule`, top-level `DeliveryRoutesInngestRegistrar`. |
| `src/notifications/email/templates/delivery-next-stop.email.tsx` | New React Email template (BRAND / LOGO_URL convention, no GPS). |
| Optional new spec(s) under `openspec/specs/` | `delivery-routes` capability. |

## Business rules

- **Driver identity.** A `DeliveryRoute.driverUserId` MUST reference a `User` in the same tenant. Users with the `Driver` role are the only ones who can `update` their own routes; admins with `manage:all` can act on any route.
- **Sale eligibility.** A Sale can be added to a route stop ONLY when `deliveryStatus ∈ {PENDING, SHIPPED}` AND `shippingAddressId IS NOT NULL`. Validation runs at `create()` and again at `start()` (re-check, since the sale could have been modified in the meantime).
- **One active route per sale.** At most one ACTIVE route may reference a given `Sale.id` at any time. Enforced by partial unique index + application-level check in `start()`.
- **Stop ordering.** Stops are ordered by `sortOrder` (integer, unique per route). `reorderStops` is allowed only in `DRAFT`. The default `IRouteOptimizer` adapter is identity (no reordering).
- **Lifecycle transitions.**
  - `DRAFT → ACTIVE`: via `start()`. Allowed when ≥ 1 stop exists. Sets `startedAt`.
  - `DRAFT → CANCELLED` and `ACTIVE → CANCELLED`: via `cancel(reason)`. Sets `cancelledAt`.
  - `ACTIVE → COMPLETED`: auto, when the last remaining `PENDING`/`IN_PROGRESS` stop transitions to `COMPLETED`. Sets route `completedAt`. Route cannot leave `COMPLETED`.
- **Stop transitions.**
  - `PENDING → COMPLETED`: via `checkInStop`. Sets `checkedInAt` + `completedAt`.
  - `PENDING → IN_PROGRESS`: reserved for future UX; not exposed in this iteration.
  - `PENDING/IN_PROGRESS → SKIPPED`: out of scope.
- **Single source of truth for delivery.** Only the route check-in flow writes `DELIVERED`. The chatbot's direct prisma path can still write `SHIPPED` (unchanged). The Sale's `cancel()` already blocks cancellation when `SHIPPED|DELIVERED`.
- **Next-stop notification.** Emitted only when ALL of:
  1. The completed stop was NOT the last stop (route still has a next stop).
  2. The next stop's `Sale` has a `Customer` with a non-null `email`.
  3. `NotificationConfig.enabledActions.includes('DELIVERY_NEXT_STOP')` (re-checked inside the Inngest function — config can be toggled between outbox write and Inngest execution).
  When any of those fail, the route check-in still succeeds; the notification is logged as "skipped" with reason.
- **Idempotency.** Outbox idempotency key `${tenantId}:${currentStopId}` dedupes retries at Inngest. Stop `checkInStop` is itself idempotent: a second call with the same `stopId` in `COMPLETED` returns the existing state (no-op, no second outbox row).
- **Tenant isolation.** Every read/write path uses tenant-scoped prisma via CLS injection AND explicit `where: { id, tenantId }`. The repository port accepts `tenantId` on every method.
- **Authorization.** `@RequirePermissions([action, 'DeliveryRoute'])` on every controller method. Driver-ownership checked by CASL condition matcher.

## Risks & tradeoffs

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | Sale carrier metadata gap (exploration finding #1) is NOT closed in this change — `save()` still drops `carrierName/trackingRef/estimatedDeliveryAt`. | Low | Explicitly out of scope. Documented in the open-questions section; future change handles it. The route check-in does NOT write carrier fields, so the gap does not bite this iteration. |
| 2 | Sale `deliveryStatus` write paths multiply (chatbot direct prisma + new `markSaleDelivered`). | Med | `markSaleDelivered` is the only writer for `'DELIVERED'` (single source of truth). Chatbot's `'SHIPPED'` write is unchanged and orthogonal. Documented in code via comment. |
| 3 | Partial unique index may not work in all Prisma migration generators. | Med | Hand-written migration SQL with `CREATE UNIQUE INDEX ... WHERE ...`; verified against PG 14+ (target). Code-level check in `start()` is the second layer. |
| 4 | Generic outbox poller regression (forgetting to extend exclusion). | Low | Single SQL change in `outbox-poller.service.ts`; covered by claim-disjointness unit spec extended for the new event type. |
| 5 | `NotificationActionKey` enum drift (TS union vs Prisma). | Med | Drift spec extended (mirror the `TIME_OFF_REQUESTED` precedent) to assert both contain `DELIVERY_NEXT_STOP`. |
| 6 | Driver-ownership CASL matcher misconfigured → driver reads another driver's route. | Med | Unit spec for the matcher; integration spec for the controller. |
| 7 | Customer email nullable — silent skip could surprise tenants. | Low | Outbox payload includes `nextCustomerEmail: string | null`; Inngest handler logs structured "skipped: no email" with the sale id; documented in the React Email template's README so tenants know. |
| 8 | Optimizer port never gets a real adapter. | High | The port is the future-proofing; default adapter is documented as `ManualRouteOptimizer`. The proposal explicitly defers map integration. |
| 9 | CASL permission seeder adds `DeliveryRoute` permissions even for tenants that never use the feature. | Low | Standard `PermissionSeeder` precedent (low-stock, hr-time-off, payment-detail all do this). Permissions are inert until a role grants them. |
| 10 | Sale.markDelivered added but unused by non-route paths. | Low | Marked `@internal` comment; spec covers the only call site. |
| 11 | Inngest function receives `nextSaleId` after the Sale was already completed (race). | Low | Idempotent at Inngest; the email body is informational. If the Sale flipped to DELIVERED between outbox write and Inngest execution, the email is still useful — "arriving soon" is sent for stops the driver is currently working on. |
| 12 | Frontend web does not yet have a driver UI. | High | Out of scope here. Frontend ticket is downstream. Backend is fully usable via the documented HTTP API. |
| 13 | Module proliferation. | Low | Single bounded context mirroring `admin/payment-details/` + `hr-time-off/`. Adds predictable scope. |

## Rollback plan

The change is purely additive: 2 new tables, 2 new enums, 1 partial unique index, 1 `ALTER TYPE ... ADD VALUE`, 1 new bounded context, 1 new port + adapter, 1 new RBAC subject + 4 permissions, 1 new outbox pipeline, 1 new Inngest function, 1 new React Email template, 1 new aggregate method on `Sale`.

1. **Code rollback.** Single revert commit removes the `src/delivery-routes/` module, the `markDelivered` / `markSaleDelivered` additions, the `AppSubjects` / `PERMISSION_REGISTRY` entries, the `NotificationActionKey` union entry, the poller exclusion entry, the `casl-ability.factory` matcher, and the `app.module.ts` registrations. Old clients are unaffected (they never called these endpoints).
2. **Migration rollback.** The two new migrations are additive:
   - `ALTER TYPE ... ADD VALUE` cannot be rolled back inside a transaction block; it stays. Acceptable because the enum value is inert without the code that emits it.
   - `delivery_routes` + `delivery_route_stops` tables can be dropped via a follow-up additive migration (`DROP TABLE`). The partial unique index drops with the table.
3. **Permission seeder cleanup.** The 4 auto-seeded `DeliveryRoute` permission rows remain in the DB after rollback. They are inert (no controller references them). A follow-up cleanup migration can `DELETE FROM permissions WHERE subject = 'DeliveryRoute'` after a grace period.
4. **Outbox safety.** If the route module is rolled back while in-flight `delivery.next_stop.notify` rows exist, they will be claimed by the generic dispatcher (which only does `eventEmitter.emit(...)` — the listener does nothing because no listener is registered post-rollback). To avoid silent drops during rollback: disable the `DeliveryRoutesOutboxModule` registration in `app.module.ts` BEFORE the broader code revert. Rows remain `PENDING` and can be cleaned up by an admin.
5. **Inngest function deregistration.** `DeliveryRoutesInngestRegistrar` is no longer constructed → `inngestService.registerFunctions([...])` no longer adds the function. Inngest dev server / cloud will see the function disappear on next deploy. Already-processed events are unaffected.
6. **Verification after rollback.** `pnpm test` (unit suites), `pnpm build`, and a smoke test that the rest of the app (sales, quotations, low-stock, hr-time-off) still works.

## Key decisions (rationale encoded)

1. **Driver = User, not Employee.** `Employee` has no `userId` (the bridge was retired in `hr-validation-notifications`). Drivers authenticate as `User`s; the `Driver` role is the permission lever. This matches the canonical "authority = CASL permission" decision encoded in the HR precedent.
2. **Single source of truth = `DeliveryRouteStop.status`.** Sale's `deliveryStatus` mirrors it but is written in the same transaction. Avoids the dual-write hazard called out in the exploration.
3. **Add `markSaleDelivered`, do NOT widen `save()`.** The carrier-metadata gap is acknowledged but orthogonal; widening `save()` is a separate decision with broader blast radius. New repo method is narrowly scoped to the only field the route flow writes.
4. **`IRouteOptimizer` port with manual default adapter.** Future-proofs the seam without forcing a map-provider integration today. Adapter swap is a one-line module registration change.
5. **`Symbol.for` for ALL new ports in the new context.** Picks one convention, matches the cross-context seam precedent (`MAILER`, `USER_EMAIL_LOOKUP`).
6. **Driver role is admin-configurable, NOT auto-seeded.** Roles are tenant-admin concerns; the proposal documents the exact permission set, not the role row.
7. **Durable dedicated outbox pipeline (Approach A, low-stock / hr-time-off blueprint).** Direct `InngestService.send` after the route mutation would dual-write after commit and lose notifications on failure — the codebase already rejected this pattern for low-stock and HR time-off.
8. **Reuse `NotificationConfig` opt-in.** A new `NotificationActionKey` keeps tenants in control; the existing Configuración→Notificaciones UI gains the new action without server changes.
9. **No GPS in MVP.** Out of scope; product brief explicit. The `IRouteOptimizer` port is the only future door for location-aware ordering.
10. **Stops frozen in `ACTIVE`.** Reordering after start would invalidate the driver's progress and break the "next stop" semantics; route mutation is locked once active.
11. **Driver-ownership enforced by CASL subject condition, not by branching the controller.** A single controller serves admins and drivers; the guard decides.

## Open product questions (non-blocking)

These were NOT pre-decided in the brief and are NOT required for the proposal to be implemented. They are recorded so the design / spec phases can resolve them, or so the first iteration can choose the safer default.

1. **Driver role creation flow.** Proposal default: tenants create the role via `AdminRoleService` and grant it the documented permission set. Alternative: ship a one-shot system-role seeder that idempotently creates a `Driver` role on bootstrap with `isSystem: true`. Tradeoff: the latter is more "out of the box" but couples the bounded context to the role-management module and is harder to undo.
2. **Email copy and template variant.** Proposal default: a single `DeliveryNextStopEmail.tsx` template titled "Tu paquete está por llegar", rendering `nextCustomerName`, `nextAddressLabel`, `appBaseUrl`, and the tenant brand. Tradeoff: a richer template with route progress ("Stop 2 of 5") is feasible but couples the email to the route aggregate, which the Inngest function does not need to read.
3. **Stop skip semantics.** Proposal default: `SKIPPED` is reserved in the enum but not exposed (no endpoint, no flow). Tradeoff: drivers may need to skip a stop (customer absent) eventually; adding it later is additive.
4. **Read-only assignment change.** Proposal default: `PATCH /delivery-routes/:id` allows `driverUserId` re-assignment only while `DRAFT`. Tradeoff: allowing reassignment in `ACTIVE` (with audit) is feasible but introduces a new failure mode (driver mid-route hand-off).
5. **Auto-create from sales list.** Proposal default: explicit `create` + `addStop` calls. Tradeoff: a "create a route from these N sale ids" convenience endpoint could merge the two calls into one tx, but the current design favors clarity.

## Success criteria

- `prisma/schema.prisma` compiles; `pnpm build` passes; `pnpm test` passes (existing 199 suites + new specs).
- A new `DeliveryRoute` can be created in `DRAFT` with ≥ 1 eligible stop and assigned to a driver User; admin RBAC is enforced.
- `start()` rejects routes that reference a sale already on another ACTIVE route (DB error maps to 409 via global filter; service-level error is 422).
- `checkInStop()` flips `DeliveryRouteStop.status` to `COMPLETED` AND `Sale.deliveryStatus` to `DELIVERED` in one transaction; rollback on any failure reverts both.
- When the next stop's customer has a non-null `email`, a `delivery.next_stop.notify` outbox row is created in the same transaction; the dedicated poller claims it; the Inngest function re-gates on `NotificationConfig.enabledActions.includes('DELIVERY_NEXT_STOP')`; when enabled, the customer receives an email rendered from `DeliveryNextStopEmail.tsx`. When disabled or email is null, the route check-in still succeeds and the skip is logged.
- A driver can only `read`/`update` their own assigned routes; admins with `manage:all` can act on any.
- `TENANT_SCOPED_MODELS` contains `'DeliveryRoute'` and `'DeliveryRouteStop'`; cross-tenant reads return null/404, cross-tenant writes attribute to caller's tenantId.
- `PermissionSeeder` auto-creates the 4 `DeliveryRoute` permissions idempotently on bootstrap; existing tests still pass.
- The `NotificationActionKey` enum (Prisma + TS) contains `'DELIVERY_NEXT_STOP'`; the drift spec asserts both.
- The new bounded context is fully unit-tested with co-located `*.spec.ts`; optional `*.integration.spec.ts` covers the Prisma adapter against `jest.integration.config.js`.
- `pnpm test` and `pnpm build` pass at the end of the change.