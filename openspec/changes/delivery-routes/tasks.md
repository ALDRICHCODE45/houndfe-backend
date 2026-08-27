# Tasks — `delivery-routes`

Status: tasks (proposed change)
Authoritative inputs: `proposal.md`, `exploration.md`, `specs/delivery-routes/spec.md`, `design.md`, `openspec/config.yaml`.
This document does **not** modify `src/` or `prisma/`. It sequences the implementation phases specified by the design.

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~950–1100 (additions; no deletions on additive change) |
| 400-line budget risk | **High** (this change alone exceeds 400 net additions; combined with migration SQL and new module skeleton it is at the edge of the 600-line soft budget for chained delivery) |
| Chained PRs recommended | **Yes** |
| Suggested split | **WU1 (Prisma + tenant/RBAC seeds) → WU2 (bounded-context core + Sale mirror + CASL/guard) → WU3 (outbox/Inngest/email + tests + docs)** — three stacked PRs to `main` |
| Delivery strategy | `ask-on-risk` |
| Chain strategy | `pending` (decision needed: stacked-to-main vs feature-branch-chain) |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
```

The aggregate exceeds the 600-line soft budget for a single PR. Recommend splitting along the three natural seams below. Each WU has clear start/finish/verification/rollback boundaries (mirroring `src/admin/payment-details/`, `src/hr-time-off/`, and `src/sales/` precedents).

---

## Work-unit boundaries

- **WU1 — Persistence & access seeds (no runtime code).** Prisma models + enums + two additive migrations + `TENANT_SCOPED_MODELS` + `AppSubjects`/`PERMISSION_REGISTRY` + `NotificationConfig` union entry. ~280 changed lines. Finish when `pnpm prisma:migrate` runs cleanly and `pnpm build` regenerates the client.
- **WU2 — Bounded context + CASL/guard extension + Sale mirror.** New `src/delivery-routes/**` (domain, application, infrastructure, presentation, dto, module), `IRouteOptimizer` port + `ManualRouteOptimizer` adapter, narrow `Sale.markDelivered` + `ISaleRepository.markSaleDelivered`, `SUBJECT_INSTANCE_RESOLVERS` seam + guard change, list-scope discriminator. ~520 changed lines. Finish when `pnpm build` succeeds and co-located unit specs for `delivery-routes.service` and the guard pass.
- **WU3 — Durable pipeline + read model + tests + docs.** Dedicated outbox poller + dispatcher, Inngest function + React Email template, `DeliveryRouteResponseDto` + `buildDeliveryRouteTimeline`, integration specs, NotificationActionKey drift spec, `docs/delivery-routes-frontend.md`, final `pnpm test` + `pnpm build` gates. ~280 changed lines. Finish when all gates are green and docs are committed.

Each WU is a single chained PR (stacked to `main`) once `chain_strategy` is decided.

---

## Phase 0 — Pre-flight

- [ ] Confirm review-mode switch state and, if off, ask the user explicitly whether to enable receipt-driven development before applying WU1. <!-- sdd-owner: parent -->
- [ ] Resolve `chain_strategy` (`stacked-to-main` recommended) and confirm with the parent/orchestrator before opening the WU1 PR. <!-- sdd-owner: parent -->

---

## Phase 1 — WU1 (Persistence & access seeds)

Group: Prisma + allowlist + permission registry.

- [x] **1.1** Add `enum DeliveryRouteStatus { DRAFT ACTIVE COMPLETED CANCELLED }` and `enum DeliveryRouteStopStatus { PENDING IN_PROGRESS COMPLETED SKIPPED }` to `prisma/schema.prisma` next to existing delivery enums. Acceptance: `pnpm prisma format` reports no diff and enum renders in `prisma generate` output. (spec: *DeliveryRoute Lifecycle States*) <!-- sdd-owner: implementation -->
- [x] **1.2** Add `model DeliveryRoute { … }` and `model DeliveryRouteStop { … }` per `design.md §4.2` — UUID `id`, `tenantId` FK with cascade, `driverUserId` FK → `User` (`onDelete: Restrict`, named relation `DeliveryRouteDriver`), `status` default `DRAFT`, lifecycle timestamps (`startedAt`, `completedAt`, `cancelledAt`), `notes`, `createdAt`, `updatedAt`; denormalized nullable `activeRouteId` (ADR-7); `stops DeliveryRouteStop[]` back-relation with `onDelete: Cascade`; sale relation back to `Sale` (`onDelete: Restrict`, `@@unique([routeId, saleId])`); indexes on `[tenantId]`, `[tenantId, driverUserId, status]`, `[tenantId, status]`. Acceptance: model round-trips via `prisma validate`. (spec: *DeliveryRoute Lifecycle States*, *Tenant Scoping of DeliveryRoute and DeliveryRouteStop*) <!-- sdd-owner: implementation -->
- [x] **1.3** Generate additive migration `prisma/migrations/<ts>_add_delivery_routes/migration.sql` containing both `CREATE TABLE` statements plus `CREATE UNIQUE INDEX delivery_route_stops_active_sale_uniq ON "delivery_route_stops" ("tenant_id", "sale_id") WHERE "activeRouteId" IS NOT NULL;` (ADR-7 Postgres-valid form). Acceptance: `pnpm prisma migrate dev --name add_delivery_routes` produces a single forward-only file; re-running is a no-op. (spec: *One Active Route Per Sale*) <!-- sdd-owner: implementation -->
- [x] **1.4** Generate standalone `ALTER TYPE` migration `prisma/migrations/<ts>_add_delivery_next_stop_action/migration.sql` containing `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP';` (design §4.4). Acceptance: migration applies; `SELECT enum_range(NULL::"NotificationActionKey")` includes `DELIVERY_NEXT_STOP`. (spec: *NotificationActionKey Registry Accepts DELIVERY_NEXT_STOP*) <!-- sdd-owner: implementation -->
- [x] **1.5** Run `pnpm prisma generate` and commit regenerated `@prisma/client` typings. Acceptance: `pnpm build` succeeds with no missing-type errors. <!-- sdd-owner: implementation -->
- [x] **1.6** Add `'DeliveryRoute'` and `'DeliveryRouteStop'` to `src/shared/tenant/tenant-scoped-models.constant.ts`. Acceptance: `TENANT_SCOPED_MODELS` includes both new entries; existing tests that snapshot the list are updated. (spec: *Tenant Scoping of DeliveryRoute and DeliveryRouteStop*) <!-- sdd-owner: implementation -->
- [x] **1.7** Extend `src/auth/authorization/domain/permission.ts`: add `'DeliveryRoute'` to `AppSubjects` union; add four CRUD entries (`create:DeliveryRoute`, `read:DeliveryRoute`, `update:DeliveryRoute`, `delete:DeliveryRoute`) to `PERMISSION_REGISTRY` with descriptive labels per design §8 conventions. Acceptance: TS compiles; `PermissionSeeder` bootstrap re-emits the four rows (covered in WU2 when PermissionSeeder is touched). (spec: *RBAC Permissions for DeliveryRoute*) <!-- sdd-owner: implementation -->
- [x] **1.8** Extend `src/notification-config/domain/notification-config.ts`: add `'DELIVERY_NEXT_STOP'` to the `NotificationActionKey` union and to the default `enabledActions` array (tenant can opt out via config). Acceptance: TS compiles; existing notification-config specs are updated. (spec: *NotificationConfig Re-Gate at Send Time*, *NotificationActionKey Registry Accepts DELIVERY_NEXT_STOP*) <!-- sdd-owner: implementation -->
- [x] **1.9** WU1 verification gate: run `pnpm prisma:migrate`, `pnpm prisma generate`, `pnpm build` — all green; commit `WU1: prisma + tenant/permission/notification seeds`. Rollback: revert the WU1 commit (migrations forward-only; tables are unused until WU2 wires reads/writes). <!-- sdd-owner: implementation -->

---

## Phase 2 — WU2 (Bounded context core + CASL/guard + Sale mirror)

Group: new `src/delivery-routes/**` + Sale narrow method + RBAC enforcement.

### 2.A Sale narrow integration (touch src/sales/** first; small, isolated)

- [x] **2.1** Add `Sale.markDelivered(): void` to `src/sales/domain/sale.entity.ts` per ADR-3: idempotent (no-op when `_deliveryStatus === 'DELIVERED'`); guards `_status === 'CONFIRMED'` and throws new `SaleNotDeliverableError` (subclass `BusinessRuleViolationError`, code `SALE_NOT_DELIVERABLE`); sets `_deliveryStatus = 'DELIVERED'`. Acceptance: `Sale.markDelivered()` returns without error on already-delivered sale; throws `SaleNotDeliverableError` on non-CONFIRMED; mirrors state in `toResponse()`. (spec: *Sale Delivery Status Is Mirrored Atomically by the Route Flow*) <!-- sdd-owner: implementation -->
- [x] **2.2** Add `SaleNotDeliverableError` to `src/sales/domain/sale.errors.ts` extending `BusinessRuleViolationError` with `code = 'SALE_NOT_DELIVERABLE'`. Acceptance: error renders in the existing error-mapping table. <!-- sdd-owner: implementation -->
- [x] **2.3** Extend `ISaleRepository` in `src/sales/domain/sale.repository.ts` with `markSaleDelivered(tx: Prisma.TransactionClient, input: { tenantId: string; saleId: string }): Promise<void>` (ADR-3). Acceptance: port compiles; no other signatures change. <!-- sdd-owner: implementation -->
- [x] **2.4** Implement `markSaleDelivered` in `src/sales/infrastructure/prisma-sale.repository.ts`: `tx.sale.update({ where: { id: saleId, tenantId }, data: { deliveryStatus: 'DELIVERED' } })`. Acceptance: tenant-scoped `where` is present (defense in depth); throws `P2025` if missing (mapped by caller). <!-- sdd-owner: implementation -->

### 2.B Bounded-context skeleton + domain aggregates

- [x] **2.5** Create `src/delivery-routes/domain/delivery-route.entity.ts` with `DeliveryRoute` aggregate per design §8.2: `static create(props)` (validates `saleIds` ≥ 1, every sale eligible `deliveryStatus ∈ {PENDING, SHIPPED}` + has `shippingAddressId`, optimizes via `IRouteOptimizer`, builds ordered stops with `position: 1..N`); `static fromPersistence(props)`; instance methods `addStop`, `reorderStops` (DRAFT-only, ADR Q4), `assignDriver`, `start` (DRAFT→ACTIVE, sets `activeRouteId` on every stop, ADR-7), `cancel` (DRAFT|ACTIVE→CANCELLED, clears `activeRouteId`), `checkInStop(stopId)` (atomic: stop→COMPLETED, mark sale delivered, emit outbox, auto-complete when last), `delete` (DRAFT-only). Throw `DeliveryRouteInvalidTransitionError` (`BusinessRuleViolationError` subclass, code `DELIVERY_ROUTE_INVALID_TRANSITION`) for illegal transitions; throw `DeliveryRouteSaleAlreadyInActiveRouteError` for pre-check failures (mapped to 409 by error table). Acceptance: aggregate is pure (no Prisma imports in `domain/`). (spec: *DeliveryRoute Lifecycle States*, *Create DeliveryRoute in DRAFT*, *Edit DeliveryRoute Stops and Driver Only While DRAFT*, *Start DeliveryRoute*, *Check-In Stop Atomically*, *One Active Route Per Sale*) <!-- sdd-owner: implementation -->
- [x] **2.6** Create `src/delivery-routes/domain/delivery-route-stop.entity.ts` with `DeliveryRouteStop` value-object: `static create`, `static fromPersistence`, `markCompleted(now: Date): void` (idempotent on `COMPLETED`), `markInProgress(now: Date): void` (optional). Acceptance: stop entity owns its timestamps (`checkedInAt`, `completedAt`); no DB imports. (spec: *Route Stop Model and Ordering*) <!-- sdd-owner: implementation -->
- [x] **2.7** Create `src/delivery-routes/domain/delivery-route.errors.ts` with `DeliveryRouteInvalidTransitionError` (422), `DeliveryRouteSaleAlreadyInActiveRouteError` (409), `DeliveryRouteSaleNotEligibleError` (422), `DeliveryRouteNotFoundError` (404, subclass `EntityNotFoundError`). Acceptance: error table in `src/shared/errors/` is updated where required. <!-- sdd-owner: implementation -->
- [x] **2.8** Create `src/delivery-routes/domain/delivery-route.repository.ts`: `IDeliveryRouteRepository` port methods per design §8.3 — `findById`, `findOneWithStops`, `list({ tenantId, driverUserId?, status? })`, `findDriverUserIdById({ tenantId, id })`, `save`, `runInTransaction`, `claimNextOutboxEvent`, `markOutboxEventSent`, `markOutboxEventFailed`, plus a session-scoped `tx` accessor. Export `DELIVERY_ROUTE_REPOSITORY = Symbol.for('IDeliveryRouteRepository')` (ADR-4 convention). Acceptance: port compiles; no Prisma imports. <!-- sdd-owner: implementation -->
- [x] **2.9** Create `src/delivery-routes/domain/ports/route-optimizer.port.ts`: `IRouteOptimizer` interface and `ROUTE_OPTIMIZER = Symbol.for('IRouteOptimizer')`. Acceptance: port compiles. (spec: *IRouteOptimizer Port with Manual Default Adapter*) <!-- sdd-owner: implementation -->
- [x] **2.10** Create `src/delivery-routes/infrastructure/prisma-delivery-route.repository.ts`: tx-aware Prisma adapter implementing `IDeliveryRouteRepository`. `runInTransaction` delegates to `prisma.$transaction`. `findOneWithStops` projection per design §7.2. `findDriverUserIdById` returns `{ driverUserId }` or `null`. Map `P2002` on the partial-unique index to `DeliveryRouteSaleAlreadyInActiveRouteError` (409). Acceptance: integration spec covers tenant scoping + 2002 mapping (in WU3). <!-- sdd-owner: implementation -->
- [x] **2.11** Create `src/delivery-routes/infrastructure/manual-route-optimizer.ts`: identity adapter `optimize({ tenantId, saleIds }) => ({ orderedSaleIds: saleIds })`. Acceptance: exported and registered in module (2.15). (spec: *IRouteOptimizer Port*) <!-- sdd-owner: implementation -->

### 2.C Application service + presentation + DTOs

- [x] **2.12** Create `src/delivery-routes/dto/`: `create-delivery-route.dto.ts` (body: `{ saleIds: string[]; driverUserId?: string; notes?: string }`, validates `saleIds.length ≥ 1`), `add-stop.dto.ts`, `reorder-stops.dto.ts`, `update-delivery-route.dto.ts` (DRAFT-only `driverUserId`/`notes`/stop mutations), `delivery-route-response.dto.ts` per design §7.1. Acceptance: DTOs use class-validator decorators consistent with existing modules; `DeliveryRouteResponseDto` carries `stops[]` with embedded `saleId`, `position`, `status`, `checkedInAt`, `completedAt`, `customerName`, `addressLabel`. (spec: *DeliveryRouteResponseDto Read Model*) <!-- sdd-owner: implementation -->
- [x] **2.13** Create `src/delivery-routes/application/delivery-routes.service.ts`: methods per design §1 + §7.4 — `create`, `addStop`, `reorderStops`, `update`, `start` (pre-check + start + setting `activeRouteId`), `cancel`, `checkInStop` (single transaction orchestrating stop → sale → outbox per §5), `list(ctx, query)` (uses `request.ability` driver-only filter from §2.14), `getById`, `delete` (DRAFT-only). Inject via tokens `DELIVERY_ROUTE_REPOSITORY`, `SALE_REPOSITORY`, `ROUTE_OPTIMIZER`. Service uses `repository.runInTransaction(async tx => …)` and propagates the `tx` to `markSaleDelivered` and to outbox writes. Acceptance: co-located unit spec covers check-in orchestration, list scoping, error mapping (in WU3). (spec: *Check-In Stop Atomically Writes Stop, Sale Mirror, and Outbox Event*, *List, Get, Cancel, and Delete Endpoints*) <!-- sdd-owner: implementation -->
- [x] **2.14** Create `src/delivery-routes/presentation/delivery-routes.controller.ts`: routes per design §8.1 — `POST /delivery-routes`, `GET /delivery-routes`, `GET /delivery-routes/:id`, `PATCH /delivery-routes/:id`, `DELETE /delivery-routes/:id`, `POST /delivery-routes/:id/start`, `POST /delivery-routes/:id/cancel`, `POST /delivery-routes/:id/stops/:stopId/check-in`, `POST /delivery-routes/:id/stops`, `PUT /delivery-routes/:id/stops/reorder`. Apply `@RequirePermissions` per action (create/read/update/delete). Driver-ownership is enforced by guard (2.16–2.18) + `request.ability`-driven list scope (2.13) — **no controller branching**. Acceptance: controller is thin (no `if (admin) … else …`). <!-- sdd-owner: implementation -->
- [x] **2.15** Create `src/delivery-routes/delivery-routes.module.ts`: register controller + service; provide `DELIVERY_ROUTE_REPOSITORY` → `PrismaDeliveryRouteRepository`, `ROUTE_OPTIMIZER` → `ManualRouteOptimizer`, `SUBJECT_INSTANCE_RESOLVERS` (partial) → `{ DeliveryRoute: { resolveSubject: req => repo.findDriverUserIdById({ tenantId, id: req.params.id }) } }` (2.18). Acceptance: module compiles; no circular deps with `src/sales/`. <!-- sdd-owner: implementation -->

### 2.D CASL + guard extension (ADR-5)

- [x] **2.16** Create `src/auth/authorization/subject-instance-resolver.ts`: `SUBJECT_INSTANCE_RESOLVERS = Symbol.for('SubjectInstanceResolvers')`, `SubjectInstanceResolverMap`, `SubjectInstanceResolver` types; export `null` for missing (defer to service 404, never throw inside guard). Acceptance: seam is generic; only one resolver is registered in WU2. (spec: *Driver Ownership Enforced by CASL Subject-Instance Condition*) <!-- sdd-owner: implementation -->
- [x] **2.17** Update `src/auth/authorization/casl-ability.factory.ts`: compute `isRouteManager = permissions.some(p => p.subject === 'DeliveryRoute' && (p.action === 'create' || p.action === 'delete'))` (ADR-5). For non-manager, emit `can('read', 'DeliveryRoute', { driverUserId: userId })` and `can('update', 'DeliveryRoute', { driverUserId: userId })`. Manager path: unconditional `can(action, 'DeliveryRoute')` per granted action (existing behavior). Super-admin `manage:all` short-circuits as today. Acceptance: existing CASL specs still pass; new spec added in WU3. (spec: *Driver Ownership Enforced by CASL Subject-Instance Condition*, *RBAC Permissions for DeliveryRoute*) <!-- sdd-owner: implementation -->
- [x] **2.18** Update `src/auth/authorization/permissions.guard.ts`: (a) attach `request.ability` after building; (b) when `request.params.id` is present and a `SUBJECT_INSTANCE_RESOLVERS` entry exists for the subject, resolve the instance and re-check `ability.can(action, subject('DeliveryRoute', { driverUserId }))` via `@casl/ability`'s `subject()` helper; throw `InsufficientPermissionsError` on false; on `null` resolver result, defer (no throw). Acceptance: existing guard specs still pass; new instance-condition spec added in WU3. (spec: *Driver Ownership Enforced by CASL Subject-Instance Condition*) <!-- sdd-owner: implementation -->

### 2.E App wiring

- [x] **2.19** Update `src/app.module.ts` to import `DeliveryRoutesModule` (WU2-only registration; outbox/email wiring arrives in WU3 to keep WU2 self-contained). Acceptance: app boots; `pnpm build` succeeds; `GET /delivery-routes` returns 401 without a session. <!-- sdd-owner: implementation -->
- [x] **2.20** WU2 verification gate: `pnpm build` green; co-located unit specs for `delivery-route.entity` + `delivery-routes.service` (happy paths + error cases) pass. Commit `WU2: bounded context + CASL/guard + Sale mirror`. Rollback: revert WU2 commit; WU1 prisma additions remain inert. <!-- sdd-owner: implementation -->

---

## Phase 3 — WU3 (Durable pipeline + read model + tests + docs)

Group: outbox/poller/dispatcher/Inngest/email + DTO timeline + tests + frontend docs.

### 3.A Outbox emit inside the check-in transaction

- [x] **3.1** Define outbox event type `delivery.next_stop.notify` in `src/delivery-routes/outbox/delivery-route-outbox.types.ts` per design §8.4: `{ tenantId, routeId, currentStopId, nextStopId, nextSaleId, nextCustomerName, nextAddressLabel, nextCustomerEmail | null, idempotencyKey: \`\${tenantId}:\${currentStopId}\`, occurredAt }`. Acceptance: type is importable from both poller and dispatcher. (spec: *Durable Next-Stop Notification Pipeline*) <!-- sdd-owner: implementation -->
- [x] **3.2** Inside `DeliveryRoutesService.checkInStop`, after flipping the stop and the Sale mirror in `runInTransaction`, insert one outbox row (using a generic outbox Prisma model already present in the codebase per `low-stock-alerts` precedent) carrying the payload above. The insert MUST be inside the same `tx`; `checkInStop` idempotency guarantees no second row. Acceptance: no outbox row when the route has no next stop; exactly one row when it does. <!-- sdd-owner: implementation -->

### 3.B Dedicated poller + dispatcher

- [x] **3.3** Create `src/delivery-routes/outbox/delivery-routes-outbox.poller.ts`: extends the codebase's polling service contract; polls the outbox table with `event_type = 'delivery.next_stop.notify'` AND status pending; uses `repository.claimNextOutboxEvent(tx)` to claim exclusively; respects the configured poll interval. Acceptance: claim-disjointness spec added (WU3 tests). <!-- sdd-owner: implementation -->
- [x] **3.4** Create `src/delivery-routes/outbox/delivery-routes-outbox.dispatcher.ts`: forwards claimed rows to `InngestService.send('delivery/next-stop.notify', payload)` **awaited** (not fire-and-forget); on success calls `markOutboxEventSent`; on error calls `markOutboxEventFailed` with the error message and respects backoff. Acceptance: dispatcher logs structured `outbox.event.delivered` / `outbox.event.failed`. (spec: *Durable Next-Stop Notification Pipeline*) <!-- sdd-owner: implementation -->
- [x] **3.5** Update `src/shared/outbox/outbox-poller.service.ts` to extend the generic poller's exclusion list: `NOT IN ('stock.low.detected', 'hr.timeoff.requested', 'delivery.next_stop.notify')`. Acceptance: claim-disjointness spec extended; generic poller never claims a delivery row. <!-- sdd-owner: implementation -->

### 3.C Inngest function + React Email template

- [x] **3.6** Create `src/delivery-routes/inngest/delivery-next-stop-notify.functions.ts`: Inngest function `delivery/next-stop.notify`. Steps: (1) re-gate on `NotificationConfig.enabledActions.includes('DELIVERY_NEXT_STOP')` via `NOTIFICATION_CONFIG_REPOSITORY` (idempotent); (2) resolve authoritative email via `ISaleCustomerEmailLookup` by tenant (do not trust write-time snapshot); (3) if email is null, log `skipped: no email` and exit (no error); (4) render `DeliveryNextStopEmail.tsx` and send via `MAILER`. Acceptance: idempotency dedup via `id = \`\${tenantId}:\${currentStopId}\`` at Inngest boundary; re-gate spec added. (spec: *Durable Next-Stop Notification Pipeline*, *NotificationConfig Re-Gate at Send Time*) <!-- sdd-owner: implementation -->
- [x] **3.7** Create `src/notifications/email/templates/delivery-next-stop.email.tsx` (React Email) titled "Tu paquete está por llegar" per design §2 Q2 (single template): renders `nextCustomerName`, `nextAddressLabel`, `appBaseUrl`, tenant `BRAND`, `LOGO_URL`. No "stop N of M" content. Acceptance: template renders with mock data; existing email-template snapshot suite is updated. <!-- sdd-owner: implementation -->
- [x] **3.8** Create `src/delivery-routes/inngest/delivery-routes-inngest-registrar.ts`: registers the function with `InngestService`. Update `src/app.module.ts` to register it as a top-level provider (mirror `HrTimeOffInngestRegistrar`). Acceptance: app boots; Inngest dev UI lists the function. <!-- sdd-owner: implementation -->

### 3.D Read model

- [x] **3.9** Create `src/delivery-routes/domain/build-delivery-route-timeline.ts`: pure function `buildDeliveryRouteTimeline(route, stops): DeliveryRouteTimelineEvent[]` mirroring `buildSaleTimeline` style. Events: `created`, `started`, `stopCompleted` (per stop with actor), `cancelled`, `completed`. Defaults: actor `'system'` when unknown; `at = updatedAt` when timestamps absent. Acceptance: co-located unit spec covers ordering, actor defaults, and terminal states. (spec: *DeliveryRoute Timeline Mirrors buildSaleTimeline*) <!-- sdd-owner: implementation -->
- [x] **3.10** Wire `DeliveryRoutesService.getById` per design §7.4: fetch route + stops + customer/address projections, map via `DeliveryRouteResponseDto.fromAggregate(...)`, attach `timeline = buildDeliveryRouteTimeline(...)`. Acceptance: integration spec covers DTO projection. <!-- sdd-owner: implementation -->

### 3.E Tests

- [x] **3.11** Add `src/delivery-routes/domain/delivery-route.entity.spec.ts`: create validation (empty `saleIds`, ineligible sale), `start`/`cancel`/`checkInStop` transitions including `DeliveryRouteInvalidTransitionError`, `checkInStop` idempotency (second call no-op), auto-complete on last stop, `activeRouteId` set/cleared per ADR-7. (spec: *DeliveryRoute Lifecycle States*, *Check-In Stop Atomically*) <!-- sdd-owner: implementation -->
- [x] **3.12** Add `src/delivery-routes/application/delivery-routes.service.spec.ts`: check-in transaction orchestration (stop + sale + outbox publish with mocked `repo` and `prisma`), driver-only list scoping (`request.ability.can('create','DeliveryRoute') === false` → filter by `driverUserId`), `start()` pre-check vs DB 409 race, error mapping. (spec: *Check-In Stop Atomically*, *Driver Ownership Enforced by CASL Subject-Instance Condition*) <!-- sdd-owner: implementation -->
- [x] **3.13** Add `src/delivery-routes/infrastructure/manual-route-optimizer.spec.ts`: identity echo for `optimize({ saleIds })`. (spec: *IRouteOptimizer Port with Manual Default Adapter*) <!-- sdd-owner: implementation -->
- [x] **3.14** Add `src/delivery-routes/domain/build-delivery-route-timeline.spec.ts`: ordering, actor defaults, terminal states. (spec: *DeliveryRoute Timeline Mirrors buildSaleTimeline*) <!-- sdd-owner: implementation -->
- [x] **3.15** Add `src/auth/authorization/casl-ability.factory.spec.ts`: driver-only emits `{ driverUserId }` conditions; manager emits unconditional `can(action, 'DeliveryRoute')`; super-admin short-circuit unchanged. (spec: *Driver Ownership Enforced by CASL Subject-Instance Condition*, *RBAC Permissions for DeliveryRoute*) <!-- sdd-owner: implementation -->
- [x] **3.16** Add `src/auth/authorization/permissions.guard.spec.ts`: subject-instance condition pass/403/null-defer for `DeliveryRoute`; existing subjects unchanged. (spec: *Driver Ownership Enforced by CASL Subject-Instance Condition*) <!-- sdd-owner: implementation -->
- [x] **3.17** Add NotificationActionKey drift spec `src/notification-config/domain/notification-config.drift.spec.ts`: TS union and Prisma enum both contain `DELIVERY_NEXT_STOP` (assert by introspecting Prisma client enum). (spec: *NotificationActionKey Registry Accepts DELIVERY_NEXT_STOP*) <!-- sdd-owner: implementation -->
- [x] **3.18** Add `src/sales/infrastructure/prisma-sale.repository.markSaleDelivered.integration.spec.ts`: tenant-scoped `WHERE { id, tenantId }` returns void for own tenant; throws for cross-tenant. (spec: *Sale Delivery Status Is Mirrored Atomically by the Route Flow*) <!-- sdd-owner: implementation -->
- [x] **3.19** Add `src/delivery-routes/infrastructure/prisma-delivery-route.repository.integration.spec.ts`: tenant scoping, `findOneWithStops` projection shape, `findDriverUserIdById` null on missing, `P2002` mapped to `DeliveryRouteSaleAlreadyInActiveRouteError`. (spec: *Tenant Scoping of DeliveryRoute and DeliveryRouteStop*, *One Active Route Per Sale*) <!-- sdd-owner: implementation -->
- [x] **3.20** Add `src/shared/outbox/outbox-poller.service.spec.ts` extension: claim-disjointness — `delivery.next_stop.notify` rows are never claimed by the generic poller. (spec: *Durable Next-Stop Notification Pipeline*) <!-- sdd-owner: implementation -->
- [x] **3.21** Add `src/delivery-routes/inngest/delivery-next-stop-notify.functions.spec.ts`: config re-gate (off → skip), null email → skip, success path renders + sends via `MAILER` mock. (spec: *NotificationConfig Re-Gate at Send Time*) <!-- sdd-owner: implementation -->
- [x] **3.22** Run final gates: `pnpm test` (all existing + new specs green) and `pnpm build` (green). Acceptance: zero failures, zero type errors. <!-- sdd-owner: implementation -->

### 3.F Documentation

- [x] **3.23** Create `docs/delivery-routes-frontend.md`: documents the `/delivery-routes` HTTP API per design §8.1, the `Driver` role permission set (`read` + `update` only; `create`/`delete` are the route-manager discriminator), opt-in via `PUT /notification-config` (`enabledActions.includes('DELIVERY_NEXT_STOP')`), and the timeline shape returned by `GET /delivery-routes/:id`. Acceptance: docs render in repo markdown preview; no broken internal links. <!-- sdd-owner: implementation -->
- [x] **3.24** WU3 verification gate: `pnpm test && pnpm build` green; commit `WU3: outbox + Inngest + email + read model + tests + docs`. Rollback: revert WU3 commit; WU1/WU2 features remain operational (routes work end-to-end without email). <!-- sdd-owner: implementation -->

---

## Phase 4 — Parent post-apply actions (review & archive)

Group: explicit bounded-review and lifecycle-gate actions owned by the parent.

- [ ] Start or reuse a bounded review for WU1 once the PR is open; verify migration applies on a clean DB and rollback instructions in `design.md §12` are accurate. <!-- sdd-owner: parent -->
- [ ] Start or reuse a bounded review for WU2 once the PR is open; verify CASL/guard extension behavior against the driver-vs-manager matrix in `spec.md` (*Driver Ownership Enforced by CASL Subject-Instance Condition*). <!-- sdd-owner: parent -->
- [ ] Start or reuse a bounded review for WU3 once the PR is open; verify outbox→Inngest→email end-to-end with `Inngest dev` and a local Resend mock, and that `docs/delivery-routes-frontend.md` matches the actual API surface. <!-- sdd-owner: parent -->
- [ ] Run `openspec archive delivery-routes --yes` after all three WUs are merged and CI is green, per `openspec/config.yaml` `archive:` rule ("warn before merging destructive deltas" — this change is additive, no destructive delta). <!-- sdd-owner: parent -->

---

## Spec coverage matrix (acceptance traceability)

| Requirement ID | Task IDs |
|---|---|
| DeliveryRoute Lifecycle States | 1.1, 1.2, 2.5, 2.6, 2.13, 3.11 |
| Route Stop Model and Ordering | 1.2, 2.5, 2.6, 2.11, 3.13 |
| Create DeliveryRoute in DRAFT | 2.5, 2.13, 2.14 |
| Edit DeliveryRoute Stops and Driver Only While DRAFT | 2.5, 2.13, 2.14 |
| Start DeliveryRoute (DRAFT → ACTIVE) | 2.5, 2.13, 2.14 |
| Check-In Stop Atomically Writes Stop, Sale Mirror, and Outbox Event | 2.1, 2.4, 2.13, 3.1, 3.2, 3.12 |
| Sale Delivery Status Is Mirrored Atomically by the Route Flow | 2.1, 2.2, 2.3, 2.4, 3.18 |
| One Active Route Per Sale (App Pre-Check + DB Partial Unique Index) | 1.3, 2.5, 2.10, 3.19 |
| Tenant Scoping of DeliveryRoute and DeliveryRouteStop | 1.2, 1.6, 2.10, 3.19 |
| RBAC Permissions for DeliveryRoute | 1.7, 2.17, 3.15 |
| Driver Ownership Enforced by CASL Subject-Instance Condition | 2.16, 2.17, 2.18, 3.15, 3.16 |
| List, Get, Cancel, and Delete Endpoints | 2.13, 2.14, 3.10, 3.12 |
| Durable Next-Stop Notification Pipeline | 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.20, 3.21 |
| NotificationConfig Re-Gate at Send Time | 1.8, 3.6, 3.21 |
| NotificationActionKey Registry Accepts DELIVERY_NEXT_STOP | 1.4, 1.8, 3.17 |
| DeliveryRouteResponseDto Read Model | 2.12, 3.10 |
| DeliveryRoute Timeline Mirrors buildSaleTimeline | 3.9, 3.14 |
| IRouteOptimizer Port with Manual Default Adapter | 2.9, 2.11, 3.13 |

---

## Rollback summary

Per `design.md §12`: additive change. Revert each WU commit in reverse order (WU3 → WU2 → WU1). For a wider revert, disable `DeliveryRoutesOutboxModule` registration first to stop the dedicated poller/dispatcher from claiming new outbox rows before the generic dispatcher would emit them into a no-listener void. The additive `ALTER TYPE` migration cannot roll back inside a transaction; leave it inert and drop the new tables in a follow-up migration if a hard cleanup is desired.