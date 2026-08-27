# Design — `delivery-routes`

Status: design (proposed change)

Authoritative inputs:

- `openspec/changes/delivery-routes/proposal.md` (decisions + rationale)
- `openspec/changes/delivery-routes/exploration.md` (structural evidence)
- `openspec/config.yaml` (design rules: sequence diagrams for complex flows; document decisions with rationale)

This document does **not** modify `src/` or `prisma/`. It specifies the design the implementation phases will follow.

---

## 0. Design-rule conformance

- **Sequence diagrams** for the two complex flows are in §5 (route check-in durable pipeline) and §6 (one-active-route-per-sale invariant).
- **Architecture decisions with rationale** are recorded as ADRs in §3.

---

## 1. Overview

`delivery-routes` introduces a tenant-scoped bounded context under `src/delivery-routes/` that groups eligible `Sale`s into an ordered `DeliveryRoute` assigned to a driver `User`. A driver checks in stop-by-stop; completing a stop atomically:

1. flips the stop to `COMPLETED` (canonical write),
2. mirrors `Sale.deliveryStatus = 'DELIVERED'` in the same transaction,
3. when a next stop exists, writes a durable outbox row `delivery.next_stop.notify` that is delivered via the proven outbox → dedicated poller/dispatcher → Inngest → `MAILER` pipeline.

The change is purely additive and mirrors the existing `src/admin/payment-details/` (hexagonal slice), `src/hr-time-off/` (durable outbox + Inngest) and `src/sales/` (`findOneWithRelations` + `buildSaleTimeline`) patterns.

---

## 2. Resolved product defaults (proposal open questions)

The proposal recorded five open product questions. The design resolves each to a safe default; the implementation MUST follow these defaults unless a later spec phase explicitly supersedes them.

| # | Question | Resolved default |
|---|---|---|
| 1 | **Driver role creation flow.** Seed a system `Driver` role, or let tenants create it? | **Tenant-admin created.** The `Driver` role is created via `AdminRoleService` and granted the documented permission set (`read` + `update` on `DeliveryRoute`). No system-role seeder is added; this keeps the new context decoupled from role management and is fully reversible. The permission set is documented in the API/admin notes. |
| 2 | **Email copy and template variant.** Single template, or route-progress-rich template? | **Single template.** `DeliveryNextStopEmail.tsx` titled "Tu paquete está por llegar", rendering `nextCustomerName`, `nextAddressLabel`, `appBaseUrl`, and tenant brand (`BRAND` / `LOGO_URL`). No route-progress ("stop N of M") content, so the Inngest function never has to re-read the route aggregate. |
| 3 | **Stop skip semantics.** Expose `SKIPPED` now or reserve it? | **Reserved, not exposed.** `DeliveryRouteStopStatus.SKIPPED` exists in the enum for forward-compatibility but has no endpoint, no service path, and no transition in this change. `checkInStop` only transitions `PENDING → COMPLETED`. |
| 4 | **Read-only assignment change.** Allow `driverUserId` reassignment only in `DRAFT`, or also in `ACTIVE`? | **`DRAFT` only.** `PATCH /delivery-routes/:id` accepts `driverUserId` (and stop set mutations) only while `status === DRAFT`. `ACTIVE` reassignment is rejected with `DeliveryRouteInvalidTransitionError`. This avoids the mid-route hand-off failure mode. |
| 5 | **Auto-create from sales list.** Explicit `create` + `addStop`, or a convenience batch endpoint? | **Explicit `create` + `addStop`.** The create request accepts `saleIds` (ordered) to build the route in one call internally (per proposal `create({ saleIds })`), but the wire API remains the explicit `POST /delivery-routes` shape. A future convenience endpoint can merge the two calls without changing the aggregate. |

### Additional design-time clarifications (not proposal open questions, but resolved here)

- **CASL conditions are not evaluated for string subjects.** The current `PermissionsGuard` calls `ability.can(action, subject)` with a *string* subject; CASL ignores rule conditions for string subjects, so `can('read', 'DeliveryRoute', { driverUserId })` would be a false positive. §3.5 specifies the minimal guard extension needed to make driver-ownership actually enforceable (this is a clarification of proposal key decision #11, not a change of intent).
- **The proposal's partial-unique-index SQL is not valid PostgreSQL.** A partial-index predicate cannot contain a subquery that references another table. §3.7 specifies a Postgres-valid equivalent (denormalized `activeRouteId` marker column + `WHERE "activeRouteId" IS NOT NULL`) that preserves the intended invariant.
- **`Sale.markDelivered` must not write a second timestamp.** The proposal snippet sets `this._deliveryCompletedAt = now`, but no such field exists on `Sale` and adding one would create a second source of truth for "when delivered". §3.3 resolves this by keeping the Sale mirror to `deliveryStatus` only; canonical timestamps live on `DeliveryRouteStop.checkedInAt` / `completedAt`.

---

## 3. Architecture decision records

### ADR-1 — Driver = `User`, not `Employee`

**Decision.** `DeliveryRoute.driverUserId` references `User`, and the `Driver` concept is a tenant-admin-created `Role`, not an `Employee`.

**Rationale.**

- `Employee.userId` was the closest bridge and was retired in `hr-validation-notifications`; there is no reliable `Employee → User` seam to reuse.
- Drivers authenticate through the same web app as every other `User`; authorization is the single lever (`CASL` permissions), matching the canonical "authority = permission" decision already encoded in the HR precedent.
- Using `User` avoids coupling the delivery context to the HR `Employee` module and keeps the driver relation first-class and tenant-scoped.

**Consequences.**

- `driver` is a `User` relation named `DeliveryRouteDriver` with `onDelete: Restrict` (a route cannot outlive its driver).
- No `Employee` import appears in `src/delivery-routes/**`.

---

### ADR-2 — Single source of truth = `DeliveryRouteStop.status`; `Sale.deliveryStatus` is a derived mirror

**Decision.** `DeliveryRouteStop.status === 'COMPLETED'` is the canonical fact "this sale was delivered". `Sale.deliveryStatus = 'DELIVERED'` is a derived mirror written **only** by the route check-in flow, in the **same** `runInTransaction`.

**Rationale.**

- Two independent writers of "delivered" (chatbot `SHIPPED` + a new `DELIVERED` path) already raise a dual-write hazard. Making the route stop canonical and the Sale field a mirror collapses the hazard to a single commit.
- The exploration's finding #3 ("must decide whether stop check-in drives `Sale.deliveryStatus` or is independent") is answered: stop check-in drives it, atomically.
- Keeping the mirror in the same transaction means rollback reverts both writes; there is no window where a stop is `COMPLETED` but the Sale is still `PENDING`/`SHIPPED`.

**Consequences.**

- No other code path writes `Sale.deliveryStatus = 'DELIVERED'`. The chatbot's direct `prisma.sale.update` to `SHIPPED` remains unchanged and orthogonal.
- `Sale.cancel()`'s existing `SHIPPED | DELIVERED` guard continues to protect delivered sales.
- The canonical "when delivered" timestamps are `DeliveryRouteStop.checkedInAt` / `completedAt` (and `DeliveryRoute.completedAt` for the route); the Sale mirror carries **status only**.

---

### ADR-3 — Narrow `Sale.markDelivered` + `ISaleRepository.markSaleDelivered`; do **not** widen `save()`

**Decision.** Add a single-purpose aggregate method `Sale.markDelivered()` and a single-purpose port method `ISaleRepository.markSaleDelivered(tx, { tenantId, saleId })`. Do **not** widen `ISaleRepository.save()` to persist carrier metadata.

**Rationale.**

- Widening `save()` to persist `carrierName` / `trackingRef` / `estimatedDeliveryAt` would change the persistence semantics of a large, load-bearing repository (every existing `save()` call site) to close a gap that is **orthogonal** to this change. The route flow never writes carrier fields.
- A narrow `markSaleDelivered` writes exactly the one field the route flow owns (`deliveryStatus`), with `where: { id: saleId, tenantId }` defense in depth, and is trivially reviewable and reversible.
- The carrier-metadata gap (`save()` drops those fields) is acknowledged and remains explicitly out of scope; a future change will handle it.

**Consequences.**

- `Sale.markDelivered()` signature is `markDelivered(): void` (no timestamp argument). It is idempotent: if `deliveryStatus === 'DELIVERED'` it returns without error; otherwise it guards `status === 'CONFIRMED'` (throwing `SaleNotDeliverableError`, a new `BusinessRuleViolationError` subclass with code `SALE_NOT_DELIVERABLE`) and sets `_deliveryStatus = 'DELIVERED'`.
- `ISaleRepository.markSaleDelivered(tx: Prisma.TransactionClient, input: { tenantId: string; saleId: string }): Promise<void>` performs `tx.sale.update({ where: { id: saleId, tenantId }, data: { deliveryStatus: 'DELIVERED' } })`.
- The proposal's `completedAt`/`_deliveryCompletedAt` fields are dropped (see ADR-2): the Sale mirror is status-only.

---

### ADR-4 — `IRouteOptimizer` port + `ManualRouteOptimizer` default adapter, token via `Symbol.for`

**Decision.** Route ordering is hidden behind `IRouteOptimizer` (port in `src/delivery-routes/domain/ports/route-optimizer.port.ts`), with a default `ManualRouteOptimizer` that returns `{ orderedSaleIds: input.saleIds }` (identity). Token is `export const ROUTE_OPTIMIZER = Symbol.for('IRouteOptimizer')`.

**Rationale.**

- A map-provider adapter is a future concern (non-goal); the port keeps the door open without forcing an integration now.
- `Symbol.for('…')` matches the cross-context seam convention already used by `MAILER`, `USER_EMAIL_LOOKUP`, and `NOTIFICATION_CONFIG_REPOSITORY`. The proposal chooses **one** convention for the new context rather than importing the codebase's inconsistent `Symbol('…')` history.
- Domain code depends only on the port; swapping the adapter is a one-line module registration change.

**Consequences.**

- `ManualRouteOptimizer` is registered in `DeliveryRoutesModule`: `{ provide: ROUTE_OPTIMIZER, useClass: ManualRouteOptimizer }`.
- The adapter is invoked at `create`/`addStop`/`reorderStops` boundaries (MVP: it validates/echoes the caller-supplied order). `reorderStops` remains `DRAFT`-only.

---

### ADR-5 — Driver ownership via CASL subject-condition matcher (guard-decided, not controller-branched)

**Decision.** Ownership ("driver can only `read`/`update` their own routes; admin can act on any") is expressed as a CASL subject condition `{ driverUserId: <userId> }` on `DeliveryRoute`, built in `CaslAbilityFactory`, and enforced by `PermissionsGuard`.

**Rationale.**

- A single controller serves admins and drivers; per-request `if (admin) … else if (driver owns) …` branches in the controller are explicitly rejected (proposal key decision #11).
- The ownership decision therefore lives entirely in the CASL ability, keeping the controller thin.

**Admin-vs-driver discriminator (data-driven, no role marker).**

- The proposal documents the driver role as `['read','DeliveryRoute']` + `['update','DeliveryRoute']` only, and admin roles as the full CRUD set (`create`, `read`, `update`, `delete`).
- Therefore `create`/`delete` presence is the reliable discriminator: **route manager = holds `create` (or `delete`) on `DeliveryRoute`**; driver-only = holds `read`/`update` but neither `create` nor `delete`.
- `CaslAbilityFactory.createForUser` computes `isRouteManager = permissions.some(p => p.subject === 'DeliveryRoute' && (p.action === 'create' || p.action === 'delete'))`. For a **non-manager** it emits `can('read', 'DeliveryRoute', { driverUserId: userId })` and `can('update', 'DeliveryRoute', { driverUserId: userId })`; for a **manager** it emits unconditional `can(action, 'DeliveryRoute')` for each granted action. Super-admin (`manage:all`) short-circuits as today.

**Required guard extension (clarification).**

- `PermissionsGuard` today evaluates `ability.can(action, subject)` with a **string** subject; CASL does not evaluate rule conditions against string subjects. To make the condition real, the guard gains one backward-compatible step:
  1. Build the ability (unchanged).
  2. Run the existing coarse `ability.can(action, subject)` loop (unchanged — this still gates "does the user hold the permission at all").
  3. For condition-bearing, instance-scoped subjects (in this change, `DeliveryRoute`) and only when `request.params.id` is present, resolve the subject instance via an injected resolver registry and re-check `ability.can(action, subject('DeliveryRoute', { driverUserId }))` using `@casl/ability`'s `subject()` helper (so the plain object is typed as `DeliveryRoute`). Throw `InsufficientPermissionsError` (403) on false.
- A new small seam `src/auth/authorization/subject-instance-resolver.ts` defines `SUBJECT_INSTANCE_RESOLVERS = Symbol.for('SubjectInstanceResolvers')` and `SubjectInstanceResolverMap = Partial<Record<AppSubjects, { resolveSubject(request): Promise<Record<string, unknown> | null> }>>`. `DeliveryRoutesModule` provides `{ DeliveryRoute: { resolveSubject: req => repo.findDriverUserIdById(req.params.id) } }` (returns `{ driverUserId }` or `null`).
- If the resolver returns `null` (route not found / cross-tenant), the guard does **not** throw; the service later returns the proper 404 (no existence oracle in the guard).
- `POST /delivery-routes` (create) and `GET /delivery-routes` (list) have no `:id`, so the instance step is skipped there.

**List scoping.**

- Ownership of the *list* (`GET /delivery-routes`) is a query scope, not a guard instance check. The controller attaches the built ability to `request.ability` (a one-line, backward-compatible guard addition). `DeliveryRoutesService.list()` filters by `driverUserId = user.id` when `!request.ability.can('create', 'DeliveryRoute')` (i.e., driver-only); admins/super-admins get the unfiltered tenant list.

**Consequences.**

- `permissions.guard.ts` and `casl-ability.factory.ts` are touched (the proposal's affected-areas list already includes the factory; the guard/resolver addition is the precise mechanism required by the decision).
- A tenant that grants `create` to a "driver" role thereby makes that role a route manager — documented as intended (the discriminator is permission-derived, not role-name-derived).

---

### ADR-6 — Durable outbox → dedicated poller/dispatcher → Inngest → `MAILER` (no post-commit direct send)

**Decision.** The next-stop email is emitted as an outbox row inside the check-in transaction, claimed by a dedicated `DeliveryRoutesOutboxPoller`, forwarded by a dedicated `DeliveryRoutesOutboxDispatcher` that **awaits** `InngestService.send`, and re-gated + sent by a dedicated Inngest function.

**Rationale.**

- A direct `InngestService.send` after the domain write would dual-write after commit and silently lose notifications on failure; the codebase already rejected this for `low-stock` and `hr-time-off`.
- The dedicated (not generic) poller/dispatcher is required because the generic dispatcher is fire-and-forget (`eventEmitter.emit`) and cannot guarantee durability for email.
- The Inngest function re-gates on `NotificationConfig.enabledActions.includes('DELIVERY_NEXT_STOP')` because config can drift between outbox write and send time (same as `TIME_OFF_REQUESTED`).

**Resolved emit/re-gate semantics (safe default).**

- The outbox row is written whenever `checkInStop` produces a next stop, **regardless** of whether the next customer has an email at write time. The authoritative email is resolved **at send time** by the Inngest function via `ISaleCustomerEmailLookup` (tenant-scoped). This matches the existence of the lookup port and proposal risk #7 ("Inngest handler logs `skipped: no email`").
- The payload carries a nullable write-time snapshot `nextCustomerEmail` for observability only; the handler does not trust it for the send decision.
- The handler's re-gate is: config enabled + `DELIVERY_NEXT_STOP` enabled + resolved `Customer.email` non-null. "Next stop exists" is guaranteed at write time and is stable because `ACTIVE` routes are frozen (stops cannot be reordered/removed once active).

**Consequences.**

- Generic `OutboxPollerService` exclusion list extends to `('stock.low.detected', 'hr.timeoff.requested', 'delivery.next_stop.notify')`.
- Idempotency key = `${tenantId}:${currentStopId}` (dedupes retries at the Inngest boundary); `checkInStop` is itself idempotent (a second check-in of a `COMPLETED` stop is a no-op and emits no second row).

---

### ADR-7 — Postgres-valid partial unique index for "one Sale in at most one ACTIVE route"

**Decision.** The invariant is enforced by a **partial unique index on `delivery_route_stops` over `(tenant_id, sale_id) WHERE "activeRouteId" IS NOT NULL`**, backed by a denormalized nullable `activeRouteId` column on `DeliveryRouteStop`.

**Rationale.**

- PostgreSQL partial-index predicates may only reference columns of the indexed table; they **cannot** contain a subquery that reads `delivery_routes` (so the proposal's `WHERE EXISTS (SELECT 1 FROM delivery_routes …)` is invalid SQL).
- The `activeRouteId` marker is the Postgres-friendly encoding of the same intent: it equals the route id only while the route is `ACTIVE`, and is set to `NULL` when the route leaves `ACTIVE` (cancel/complete). A non-null marker means "this stop's route is currently ACTIVE".
- The unique index over `(tenant_id, sale_id) WHERE activeRouteId IS NOT NULL` then makes two ACTIVE routes claiming the same sale impossible at commit time.

**Maintenance (all inside `runInTransaction`).**

- `start()`: set `activeRouteId = route.id` on every stop (route transitions `DRAFT → ACTIVE`).
- `cancel()` (`ACTIVE → CANCELLED`): set `activeRouteId = NULL` on every stop.
- `checkInStop()` when the last stop completes (`ACTIVE → COMPLETED`): set `activeRouteId = NULL` on every stop.
- `DRAFT` routes always have `activeRouteId = NULL`.

**Defense in depth.**

- `DeliveryRoutesService.start()` also runs the application-level pre-check (query for an existing ACTIVE route referencing each `saleId`) so the common case fails fast with `DeliveryRouteStopSaleAlreadyOnActiveRouteError` (422) instead of surfacing a raw `P2002`.
- The DB `P2002` is mapped in the Prisma adapter to `BusinessRuleViolationError('DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE')` → 409, covering the concurrent-race case the pre-check cannot see.

**Consequences.**

- `DeliveryRouteStop` gains one nullable column beyond the proposal sketch (`activeRouteId String?`). This is the only schema deviation, and it exists solely to make the required DB-level invariant valid PostgreSQL.
- The `activeRouteId` column is **not** part of the public read model and is not surfaced in any DTO.

---

## 4. Data model (refined)

### 4.1 Enums (additive)

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
```

### 4.2 Models

```prisma
model DeliveryRoute {
  id           String              @id @default(uuid())
  tenantId     String
  tenant       Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  driverUserId String
  driver       User                @relation("DeliveryRouteDriver", fields: [driverUserId], references: [id], onDelete: Restrict)
  status       DeliveryRouteStatus @default(DRAFT)
  startedAt    DateTime?
  completedAt  DateTime?
  cancelledAt  DateTime?
  notes        String?
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
  stops        DeliveryRouteStop[]
  @@index([tenantId])
  @@index([tenantId, driverUserId, status])
  @@index([tenantId, status])
  @@map("delivery_routes")
}

model DeliveryRouteStop {
  id            String                  @id @default(uuid())
  tenantId      String
  tenant        Tenant                  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  routeId       String
  route         DeliveryRoute           @relation(fields: [routeId], references: [id], onDelete: Cascade)
  saleId        String
  sale          Sale                    @relation(fields: [saleId], references: [id], onDelete: Restrict)
  sortOrder     Int
  status        DeliveryRouteStopStatus @default(PENDING)
  checkedInAt   DateTime?
  completedAt   DateTime?
  skippedReason String?
  // ADR-7: non-null exactly while the owning route is ACTIVE; feeds the partial unique index.
  activeRouteId String?
  createdAt     DateTime                @default(now())
  updatedAt     DateTime                @updatedAt
  @@unique([routeId, sortOrder])
  @@index([tenantId])
  @@index([tenantId, saleId])
  @@index([saleId])
  @@map("delivery_route_stops")
}
```

Back-relations (one line each) on `Tenant`, `User`, `Sale` as specified in the proposal.

### 4.3 Partial unique index (valid PostgreSQL)

```sql
CREATE UNIQUE INDEX delivery_route_stops_active_sale_uniq
  ON "delivery_route_stops" ("tenant_id", "sale_id")
  WHERE "activeRouteId" IS NOT NULL;
```

### 4.4 `NotificationActionKey`

```ts
export type NotificationActionKey = 'LOW_STOCK' | 'TIME_OFF_REQUESTED' | 'DELIVERY_NEXT_STOP';
export const NOTIFICATION_ACTION_KEYS = ['LOW_STOCK', 'TIME_OFF_REQUESTED', 'DELIVERY_NEXT_STOP'] as const;
```

Standalone migration (cannot run inside a transaction):

```sql
ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP';
```

### 4.5 Tenant allowlist

`src/shared/tenant/tenant-scoped-models.constant.ts` gains `'DeliveryRoute'` and `'DeliveryRouteStop'`.

---

## 5. Sequence diagram — route check-in flow

```mermaid
sequenceDiagram
    autonumber
    actor D as Driver / Admin
    participant C as DeliveryRoutesController
    participant S as DeliveryRoutesService
    participant TP as TenantPrismaService
    participant R as DeliveryRoute aggregate
    participant SR as ISaleRepository
    participant OW as OutboxWriterService
    participant DB as PostgreSQL
    participant P as DeliveryRoutesOutboxPoller
    participant DP as DeliveryRoutesOutboxDispatcher
    participant IN as Inngest
    participant FN as delivery-next-stop-notify fn
    participant EL as ISaleCustomerEmailLookup
    participant M as MAILER
    participant CX as Customer

    D->>C: POST /delivery-routes/:id/stops/:stopId/check-in
    C->>S: checkInStop(routeId, stopId, actor)
    S->>TP: runInTransaction(cb)
    TP->>DB: BEGIN
    S->>S: load route by (id, tenantId) — ACTIVE
    S->>R: checkInStop(stopId, now)
    R-->>S: nextStop snapshot | null (stop -> COMPLETED; maybe route -> COMPLETED)
    S->>DB: UPDATE stop status=COMPLETED, checkedInAt, completedAt
    alt last remaining stop completed
        S->>DB: UPDATE route status=COMPLETED, completedAt; clear stops.activeRouteId (ADR-7)
    end
    S->>SR: markSaleDelivered(tx, { tenantId, saleId })
    SR->>DB: UPDATE sales SET deliveryStatus='DELIVERED' WHERE id=saleId AND tenantId
    alt nextStop exists (write-time gate)
        S->>OW: publish(tx, tenantId, 'DeliveryRoute', routeId, 'delivery.next_stop.notify', payload)
        OW->>DB: INSERT outbox_events (PENDING)
    end
    TP->>DB: COMMIT
    S-->>C: DeliveryRouteResponseDto (200)

    Note over P,DB: async pipeline — runs after commit, retried until PUBLISHED/FAILED
    loop @Interval(1000), throttled
        P->>DB: claim PENDING delivery.next_stop.notify (FOR UPDATE SKIP LOCKED)
        P->>DP: dispatch(claimedEvent)
        DP->>IN: send('delivery/next-stop-notify', payload, idemKey=`${tenantId}:${currentStopId}`)
        alt send resolves
            DP->>DB: mark outbox row PUBLISHED (lockToken compare-and-swap)
        else send rejects
            DP->>DB: markRetry (backoff) or FAILED at maxRetries
        end
    end

    IN->>FN: trigger delivery/next-stop-notify
    FN->>FN: step.load-config inside tenantRunner.runWithTenant
    alt config disabled or DELIVERY_NEXT_STOP not enabled
        FN-->>FN: return { skipped: 'action-disabled' }
    end
    FN->>EL: step.resolve-recipient inside runWithTenant — findEmailBySaleId(tenantId, nextSaleId)
    EL-->>FN: email | null
    alt email is null
        FN-->>FN: log structured "skipped: no email" (nextSaleId) and return
    else email present
        FN->>FN: renderToStaticMarkup(<DeliveryNextStopEmail/>)
        FN->>M: step.send-email — mailer.send({ to: email, ... })
        M-->>CX: "Tu paquete está por llegar" email
    end
```

**Notes.**

- The outbox row and the `Sale` mirror commit together; if any write fails, everything rolls back and no row reaches the poller.
- `checkInStop` is idempotent: a second call on a `COMPLETED` stop returns the existing state and emits no second outbox row.
- The "next stop exists" gate is evaluated at write time and is stable because `ACTIVE` route stop sets are frozen; the handler re-resolves the customer email (authoritative) and re-gates on config.

---

## 6. Sequence diagram — one-active-route-per-sale invariant

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin
    participant C as DeliveryRoutesController
    participant S as DeliveryRoutesService
    participant TP as TenantPrismaService
    participant R as DeliveryRoute aggregate
    participant DB as PostgreSQL

    A->>C: POST /delivery-routes/:id/start
    C->>S: start(routeId, actor)
    S->>TP: runInTransaction(cb)
    TP->>DB: BEGIN
    S->>S: load route by (id, tenantId) — DRAFT
    S->>R: start(now) (DRAFT->ACTIVE; re-validate stop sale eligibility)
    R-->>S: ok, or DeliveryRouteStopSaleNotEligibleError
    loop each stop.saleId
        S->>DB: SELECT 1 FROM delivery_route_stops s JOIN delivery_routes r ON r.id=s.route_id WHERE s.tenant_id=$1 AND s.sale_id=$2 AND r.status='ACTIVE' LIMIT 1
        alt sale already on another ACTIVE route
            DB-->>S: row found
            S-->>C: DeliveryRouteStopSaleAlreadyOnActiveRouteError (422)
            TP->>DB: ROLLBACK
        end
    end
    S->>DB: UPDATE delivery_routes SET status='ACTIVE', startedAt=now WHERE id=routeId AND tenant_id
    S->>DB: UPDATE delivery_route_stops SET activeRouteId=routeId WHERE routeId=routeId (ADR-7)
    DB->>DB: enforce unique index (tenant_id, sale_id) WHERE activeRouteId IS NOT NULL
    alt concurrent duplicate (race missed by pre-check)
        DB-->>S: P2002 unique violation
        S-->>C: 409 BusinessRuleViolationError('DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE')
        TP->>DB: ROLLBACK
    else no violation
        TP->>DB: COMMIT
        S-->>C: DeliveryRouteResponseDto (200, status ACTIVE)
    end
```

**Notes.**

- The application-level pre-check gives a fast, friendly 422 for the common case; the DB partial unique index is the authoritative race-safe guard.
- The `activeRouteId` write is what makes the index predicate true; clearing it on `cancel`/`complete` releases the claim so the sale may later join a new ACTIVE route.

---

## 7. Read-model design

Mirrors `SaleDetailResponseDto` + `buildSaleTimeline` (`src/sales/dto/sale-detail-response.dto.ts`, `src/sales/domain/build-sale-timeline.ts`) and the assembly in `SalesService.getSaleDetail`.

### 7.1 DTOs (`src/delivery-routes/dto/delivery-route-response.dto.ts`)

```ts
export type DeliveryRouteStatusDto = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type DeliveryRouteStopStatusDto = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';

export type DeliveryRouteTimelineEventDto =
  | { type: 'ROUTE_CREATED';  at: string; actor: { id: string; name: string } | null }
  | { type: 'ROUTE_STARTED';  at: string; actor: { id: string; name: string } | null }
  | { type: 'STOP_CHECKED_IN'; at: string; stopId: string; sortOrder: number; actor: { id: string; name: string } | null }
  | { type: 'ROUTE_COMPLETED'; at: string; actor: { id: string; name: string } | null }
  | { type: 'ROUTE_CANCELLED'; at: string; actor: { id: string; name: string } | null };

export interface DeliveryRouteDriverDto {
  id: string;
  name: string;
  email: string;
}

export interface DeliveryRouteShippingAddressDto {
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
}

export interface DeliveryRouteStopDto {
  id: string;
  saleId: string;
  saleFolio: string | null;
  sortOrder: number;
  status: DeliveryRouteStopStatusDto;
  checkedInAt: string | null;
  completedAt: string | null;
  customer: { id: string; name: string; email: string | null } | null;
  shippingAddress: DeliveryRouteShippingAddressDto | null;
}

export interface DeliveryRouteResponseDto {
  id: string;
  status: DeliveryRouteStatusDto;
  driver: DeliveryRouteDriverDto | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  stops: DeliveryRouteStopDto[];
  timeline: DeliveryRouteTimelineEventDto[];
}
```

The proposal sketch's `byUserId` fields map to `actor.id` in this SaleDetail-mirroring shape.

### 7.2 Repository read method

`IDeliveryRouteRepository.findOneWithStops(id: string): Promise<DeliveryRouteReadModel | null>` (tenant-scoped via CLS + explicit `where: { id, tenantId }`). The read model includes:

- route fields (`id`, `status`, `startedAt`, `completedAt`, `cancelledAt`, `notes`, `createdAt`, `updatedAt`),
- `driver: { id, name, email }` (from the `DeliveryRouteDriver` User relation),
- `stops` ordered by `sortOrder`, each with `saleFolio` (from `sale.folio`), `customer: { id, name, email } | null`, and `shippingAddress` (`CustomerAddress` fields) — all nested selects, mirroring `prisma-sale.repository.ts:1517-1680` `findOneWithRelations`.

The `activeRouteId` marker column is **not** selected into the read model.

### 7.3 Timeline builder (`src/delivery-routes/domain/build-delivery-route-timeline.ts`)

```ts
export function buildDeliveryRouteTimeline(input: {
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  driver: { id: string; name: string } | null;
  stops: Array<{ id: string; sortOrder: number; checkedInAt: Date | null }>;
}): DeliveryRouteTimelineEventDto[];
```

Behavior (mirrors `buildSaleTimeline` ordering):

1. Always emit `ROUTE_CREATED` at `createdAt` with `actor: null` (no creator is tracked in MVP).
2. Emit `ROUTE_STARTED` at `startedAt` (actor = `driver`) when present.
3. For each stop with non-null `checkedInAt`, emit `STOP_CHECKED_IN` at `checkedInAt` (actor = `driver`, with `stopId` + `sortOrder`).
4. Emit `ROUTE_COMPLETED` at `completedAt`, or `ROUTE_CANCELLED` at `cancelledAt`, whichever is present (actor = `driver`).
5. Return events sorted by `at` ascending.

**Actor attribution default.** MVP persists no per-action actor ids (`createdByUserId`, `startedByUserId`, `cancelledByUserId`, `checkedInByUserId`). The route's assigned `driver` is the single available actor identity and is used for all driver-attributable events; `ROUTE_CREATED` uses `null`. If a future change needs precise per-action actors, those columns are additive.

### 7.4 Service assembly (`DeliveryRoutesService.getById`)

1. Validate UUID.
2. `repo.findOneWithStops(id)` → read model.
3. Cross-tenant miss → `DeliveryRouteNotFoundError` (404 via global filter).
4. Map read model → `DeliveryRouteResponseDto` (dates to ISO strings; `saleFolio`; nested `customer` / `shippingAddress`).
5. `buildDeliveryRouteTimeline(...)` → `timeline`.

---

## 8. Contracts

### 8.1 HTTP API (`/delivery-routes`, no `/admin/` prefix)

Guards: `JwtAuthGuard`, `TenantContextGuard`, `PermissionsGuard`.

| Method | Path | Permission | Access | Notes |
|---|---|---|---|---|
| `POST` | `/delivery-routes` | `create:DeliveryRoute` | admin | Create `DRAFT` route with ordered `saleIds` |
| `GET` | `/delivery-routes` | `read:DeliveryRoute` | admin / driver | Driver list is filtered to `driverUserId = self` |
| `GET` | `/delivery-routes/:id` | `read:DeliveryRoute` | admin / driver | Driver must own |
| `PATCH` | `/delivery-routes/:id` | `update:DeliveryRoute` | admin | `DRAFT` only (driver reassignment + stop mutations) |
| `POST` | `/delivery-routes/:id/start` | `update:DeliveryRoute` | admin / driver | Driver must own |
| `POST` | `/delivery-routes/:id/stops/:stopId/check-in` | `update:DeliveryRoute` | admin / driver | Driver must own |
| `POST` | `/delivery-routes/:id/cancel` | `update:DeliveryRoute` | admin (any) / driver (own `ACTIVE`) | Driver must own |
| `DELETE` | `/delivery-routes/:id` | `delete:DeliveryRoute` | admin | `DRAFT` + no stops (hard delete) |

### 8.2 `DeliveryRoute` aggregate API

- `static create({ tenantId, driverUserId, saleIds, notes, now })` — validates driver exists; every `saleId` is tenant-scoped, `deliveryStatus ∈ {PENDING, SHIPPED}`, `shippingAddressId` non-null; builds `DRAFT` with `sortOrder = [0..n-1]`.
- `static fromPersistence(props)` — no validation.
- `addStop(saleId)`, `removeStop(stopId)`, `reorderStops(orderedStopIds)` — `DRAFT` only.
- `assignDriver(driverUserId)` — `DRAFT` only (proposal open question #4).
- `start(now)` — `DRAFT → ACTIVE`; re-validates stop eligibility; sets `startedAt`; returns `this` + logs an in-memory `DeliveryRouteStartedEvent`.
- `checkInStop(stopId, now)` — `ACTIVE` only; `PENDING → COMPLETED` (idempotent); sets `checkedInAt` + `completedAt`; returns `{ nextStop } | null`; completes the route when the last stop completes.
- `cancel(now, reason)` — `DRAFT | ACTIVE → CANCELLED`; sets `cancelledAt`.

Errors (subclass `BusinessRuleViolationError` / `EntityNotFoundError`, mirroring `PaymentDetail` mapping): `DeliveryRouteNotFoundError`, `DeliveryRouteInvalidTransitionError`, `DeliveryRouteStopSaleNotEligibleError`, `DeliveryRouteStopSaleAlreadyOnActiveRouteError`.

### 8.3 Ports

```ts
// src/delivery-routes/domain/delivery-route.repository.ts
export const DELIVERY_ROUTE_REPOSITORY = Symbol.for('IDeliveryRouteRepository');
export interface IDeliveryRouteRepository {
  create(route: DeliveryRoute): Promise<DeliveryRoute>;
  findById(id: string): Promise<DeliveryRoute | null>;
  findOneWithStops(id: string): Promise<DeliveryRouteReadModel | null>;
  findDriverUserIdById(id: string): Promise<string | null>;
  save(route: DeliveryRoute): Promise<DeliveryRoute>;
  delete(id: string): Promise<void>;
}

// src/delivery-routes/domain/ports/route-optimizer.port.ts
export const ROUTE_OPTIMIZER = Symbol.for('IRouteOptimizer');
export interface IRouteOptimizer {
  optimize(input: { saleIds: string[]; tenantId: string }): Promise<{ orderedSaleIds: string[] }>;
}

// src/delivery-routes/domain/ports/sale-customer-email.port.ts
export const SALE_CUSTOMER_EMAIL_LOOKUP = Symbol.for('ISaleCustomerEmailLookup');
export interface ISaleCustomerEmailLookup {
  findEmailBySaleId(input: { tenantId: string; saleId: string }): Promise<string | null>;
}

// src/sales/domain/sale.repository.ts (addition)
markSaleDelivered(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; saleId: string },
): Promise<void>;
```

### 8.4 Outbox event

- `aggregateType: 'DeliveryRoute'`, `aggregateId: routeId`, `eventType: 'delivery.next_stop.notify'`.
- Payload:

```ts
{
  tenantId: string;
  routeId: string;
  currentStopId: string;
  nextSaleId: string;
  nextSaleFolio: string | null;
  nextCustomerName: string | null;
  nextCustomerEmail: string | null;   // write-time snapshot; authoritative email re-resolved in Inngest
  nextAddressLabel: string | null;
  nextEstimatedApproach: 'soon';
}
```

- Idempotency key (dispatcher): `${tenantId}:${currentStopId}`.

### 8.5 Inngest function

`buildDeliveryNextStopNotifyFunctions({ inngestClient, tenantRunner, notificationConfigRepository, saleCustomerEmailLookup, mailer, appBaseUrl })` returns `[fn]`:

- `id: 'delivery-next-stop-notify'`, `triggers: [{ event: 'delivery/next-stop-notify' }]`, `idempotency: 'event.id'`, `retries: 3`, `concurrency: { limit: 5 }`.
- Steps (each wrapped in `tenantRunner.runWithTenant` inside `step.run`):
  1. `load-config` — re-gate `enabled && enabledActions.includes('DELIVERY_NEXT_STOP')`.
  2. `resolve-recipient` — `saleCustomerEmailLookup.findEmailBySaleId({ tenantId, saleId: nextSaleId })` → `email | null`; return `{ skipped: 'no-email' }` when null.
  3. `send-email` — `renderToStaticMarkup(<DeliveryNextStopEmail …/>)` + `mailer.send({ to: email, … })`.

`DeliveryRoutesInngestRegistrar` is registered as a top-level provider in `app.module.ts` (mirror of `HrTimeOffInngestRegistrar`).

---

## 9. Error mapping

| Condition | Domain error | HTTP |
|---|---|---|
| Route/stop not found or cross-tenant | `DeliveryRouteNotFoundError` | 404 |
| Invalid lifecycle transition | `DeliveryRouteInvalidTransitionError` | 422 |
| Sale not eligible (`deliveryStatus` not in `PENDING`/`SHIPPED`, or no shipping address) | `DeliveryRouteStopSaleNotEligibleError` | 422 |
| Sale already on another ACTIVE route (pre-check) | `DeliveryRouteStopSaleAlreadyOnActiveRouteError` | 422 |
| Partial unique index `P2002` (race) | `BusinessRuleViolationError('DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE')` | 409 |
| Missing permission | `InsufficientPermissionsError` | 403 |
| Sale not `CONFIRMED` during `markDelivered` | `SaleNotDeliverableError` (`SALE_NOT_DELIVERABLE`) | 422 (mapped via global filter) |

---

## 10. Affected areas

| Area | Change |
|---|---|
| `prisma/schema.prisma` | Two enums, two models (+ `activeRouteId` per ADR-7), back-relations, partial unique index (migration SQL) |
| `prisma/migrations/<ts>_add_delivery_routes/migration.sql` | Create tables + partial unique index |
| `prisma/migrations/<ts>_add_delivery_next_stop_action/migration.sql` | `ALTER TYPE … ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP'` |
| `src/shared/tenant/tenant-scoped-models.constant.ts` | Add `DeliveryRoute`, `DeliveryRouteStop` |
| `src/auth/authorization/domain/permission.ts` | Add `'DeliveryRoute'` to `AppSubjects`; 4 CRUD registry entries |
| `src/auth/authorization/casl-ability.factory.ts` | Driver-ownership condition matcher (ADR-5) + `isRouteManager` discriminator |
| `src/auth/authorization/permissions.guard.ts` | Attach `request.ability`; optional subject-instance condition evaluation (ADR-5) |
| `src/auth/authorization/subject-instance-resolver.ts` | New resolver seam (ADR-5) |
| `src/notification-config/domain/notification-config.ts` | Add `DELIVERY_NEXT_STOP` to union + array |
| `src/shared/outbox/outbox-poller.service.ts` | Extend `NOT IN (..., 'delivery.next_stop.notify')` |
| `src/sales/domain/sale.entity.ts` | Add `markDelivered()` (status-only, idempotent) |
| `src/sales/domain/sale.errors.ts` | Add `SaleNotDeliverableError` |
| `src/sales/domain/sale.repository.ts` | Add `markSaleDelivered(tx, { tenantId, saleId })` |
| `src/sales/infrastructure/prisma-sale.repository.ts` | Implement `markSaleDelivered` |
| `src/delivery-routes/**` | New bounded context (domain, application, infrastructure, ports, outbox, inngest, presentation, dto, module) |
| `src/notifications/email/templates/delivery-next-stop.email.tsx` | New React Email template |
| `src/app.module.ts` | Register `DeliveryRoutesModule`, `DeliveryRoutesOutboxModule`, top-level `DeliveryRoutesInngestRegistrar` |
| `openspec/specs/delivery-routes/spec.md` (later phase) | Capability spec |

---

## 11. Testing plan

Unit specs (co-located `*.spec.ts`):

- `delivery-route.entity.spec.ts` — create validation, lifecycle transitions, `checkInStop` idempotency + route auto-complete, `start()` re-validation, error cases.
- `delivery-routes.service.spec.ts` — check-in transaction orchestration (stop + sale + outbox publish), driver-only list scoping, `start()` pre-check, error mapping.
- `build-delivery-route-timeline.spec.ts` — event ordering and actor defaults.
- `delivery-route-response.dto` mapper spec.
- `casl-ability.factory` spec — driver-only vs admin condition building.
- `permissions.guard` spec — subject-instance condition evaluation (pass/403/null→defer).
- `notification-config` drift spec — TS union and Prisma enum both contain `DELIVERY_NEXT_STOP`.
- Generic outbox poller claim-disjointness spec extended with `delivery.next_stop.notify`.
- `delivery-next-stop-notify.functions` spec — config re-gate, null-email skip, send path.

Integration specs (`*.integration.spec.ts`, against `jest.integration.config.js`):

- `prisma-delivery-route.repository` — tenant scoping, `findOneWithStops` projection, `findDriverUserIdById`, `P2002` mapping.
- `prisma-sale.repository.markSaleDelivered` — tenant-scoped `WHERE { id, tenantId }`.

Success gates: `pnpm build`, `pnpm test` (existing suites + new).

---

## 12. Rollout & rollback

Additive change; single revert commit removes the module, the `markDelivered`/`markSaleDelivered` additions, the RBAC entries, the `NotificationActionKey` entry, the poller exclusion, the CASL matcher/resolver, and `app.module.ts` registrations. Migrations are additive; `ALTER TYPE … ADD VALUE` cannot roll back inside a transaction and is left inert; tables can be dropped by a follow-up migration. Permission seeder rows remain inert after rollback (follow-up cleanup migration optional). Disable `DeliveryRoutesOutboxModule` registration before a broader revert to avoid in-flight `delivery.next_stop.notify` rows being claimed by the generic dispatcher (which would `eventEmitter.emit` into a no-listener void).

---

## 13. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | `markSaleDelivered` is the second Sale delivery writer (chatbot `SHIPPED` is the first) | It is the only `DELIVERED` writer; `SHIPPED` remains orthogonal; documented in code comment |
| 2 | Partial unique index invalid PostgreSQL (proposal subquery predicate) | ADR-7 `activeRouteId` marker + `WHERE IS NOT NULL`; verified Postgres semantics |
| 3 | CASL string-subject guard does not evaluate ownership conditions | ADR-5 guard extension + resolver registry; unit spec covers 403/pass/null |
| 4 | Driver list scope leak | `request.ability.can('create','DeliveryRoute')` discriminator; list filtered for driver-only |
| 5 | `NotificationActionKey` TS/Prisma drift | Drift spec + standalone `ALTER TYPE` migration |
| 6 | Null customer email → silent skip | Structured log with `nextSaleId`; documented template note |
| 7 | Generic outbox poller claims delivery rows (regression) | Single `NOT IN` exclusion + claim-disjointness spec |
| 8 | Carrier-metadata gap still unaddressed | Explicit non-goal; route flow never writes carrier fields |
| 9 | `Optimizer` port never gets a real adapter | Intentional future-proofing; manual adapter is the documented default |

---

## 14. Out of scope (reaffirmed)

GPS/live tracking, map-provider optimization, driver self-registration/app, other notification triggers, carrier/tracking metadata capture on check-in, re-editing `ACTIVE` routes, per-stop notes/photos/signatures, cross-tenant routes, historical audit UI, refunds touching route state.
