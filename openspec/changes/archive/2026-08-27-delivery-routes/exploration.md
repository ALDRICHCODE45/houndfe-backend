# Exploration: `delivery-routes` — Circuit-like Delivery Route Tracking

> Phase: `explore` — read-only. This document gathers structural evidence only; it does
> not implement anything and does not modify `src/` or `prisma/`.

## Envelope

- **status:** complete
- **executive_summary:** The codebase has all the primitives needed for `delivery-routes` but no route aggregate yet. `Sale` already carries a `SaleDeliveryStatus` enum (`PENDING | DELIVERED | NOT_APPLICABLE | SHIPPED`), a `shippingAddressId` FK to `CustomerAddress`, and delivery metadata (`carrierName` / `trackingRef` / `estimatedDeliveryAt`) — but the metadata is only persisted through a chatbot-specific direct Prisma update (`chatbot-api.service.ts:401-433`), not through the `Sale` aggregate's repository `save()`. Multi-tenant scoping is an allowlist (`TENANT_SCOPED_MODELS`) that a new `DeliveryRoute` + `DeliveryRouteStop` model MUST join. RBAC is registry-driven (`AppSubjects` + `PERMISSION_REGISTRY`, seeded on bootstrap). Durable async email is already proven end-to-end via the outbox → dedicated poller/dispatcher → Inngest → `MAILER` (Resend/React Email) pattern (`low-stock-alerts` and `hr-time-off` are the canonical examples). The cleanest module to mirror for a new bounded context is `src/admin/payment-details/` (entity `create`/`fromPersistence`, port + Symbol token, Prisma adapter, thin controller, module wiring). The abstracted `IRouteOptimizer` port has an exact precedent in `IPaymentMethodResolver` / `POS_EVALUATE_PROMOTIONS_USE_CASE` (Symbol-port seam consumed by `SalesService`).
- **artifacts:**
  - `openspec/changes/delivery-routes/exploration.md` (this file — written)
- **next_recommended:** Proceed to proposal phase. The proposal should (1) define `DeliveryRoute` + `DeliveryRouteStop` Prisma models + migration, (2) add both to `TENANT_SCOPED_MODELS`, (3) add a `DeliveryRoute` subject + CRUD/check-in permissions to `AppSubjects`/`PERMISSION_REGISTRY`, (4) declare an `IRouteOptimizer` port behind a `Symbol` token with a no-op/manual default adapter, (5) emit a `delivery.stop.completed` (or equivalent) outbox event in the same transaction as the `Sale` `DELIVERED` transition and wire a dedicated poller/dispatcher + Inngest email function for "next stop arriving soon", and (6) mirror `findOneWithRelations` + `buildSaleTimeline` for the route/stop read projection.
- **risks:**
  - `Sale.setDeliveryMetadata` exists on the aggregate but `ISaleRepository.save()` does **not** persist `carrierName`/`trackingRef`/`estimatedDeliveryAt` — any route/check-in flow that goes through `save()` would silently drop those fields unless the repository is widened.
  - `deliveryStatus` transitions today happen either at charge time (`persistChargeConfirmation`, online→`PENDING`) or via chatbot direct `prisma.sale.update` (→`SHIPPED`); there is no domain aggregate method for `markDelivered`, so stop-completion will need a new aggregate mutation + repository write path.
  - `SaleDeliveryStatus` already contains `SHIPPED` and `DELIVERED`; the route stop model must decide whether stop check-in drives `Sale.deliveryStatus` or is independent (two sources of truth).
  - The `next stop` email needs the customer's email, which lives on `Customer.email` (nullable) — not on `Sale` — so the Inngest function must resolve customer email by tenant.
  - Provider token convention is inconsistent (`Symbol('…')` vs `Symbol.for('…')`); both work but the chosen convention must be stated in the proposal.

## skill_resolution

`none` — no project/user skill paths were injected for this phase ("Skills to load before work: none").

---

## 1. Sale domain & delivery fields

### 1.1 `SaleDeliveryStatus` (domain + Prisma)

Domain union — `src/sales/domain/sale.entity.ts:19-23`:

```ts
export type SaleDeliveryStatus =
  | 'PENDING'
  | 'DELIVERED'
  | 'NOT_APPLICABLE'
  | 'SHIPPED';
```

Prisma enum — `prisma/schema.prisma:161-165`:

```prisma
enum SaleDeliveryStatus {
  PENDING
  DELIVERED
  NOT_APPLICABLE
  SHIPPED
}
```

(`SHIPPED` was added later by `20260611045435_add_sale_delivery_and_receipt` via `ALTER TYPE ... ADD VALUE 'SHIPPED'`.)

### 1.2 `Sale` model delivery-related fields — `prisma/schema.prisma:741-850` (key lines)

```prisma
model Sale {
  ...
  shippingAddressId   String?
  ...
  deliveryStatus      SaleDeliveryStatus @default(DELIVERED)   // schema.prisma:750
  ...
  // Delivery metadata — set for bot-created ONLINE sales when dispatched
  carrierName         String?                                  // schema.prisma:765
  trackingRef         String?                                  // schema.prisma:766
  estimatedDeliveryAt DateTime?                                // schema.prisma:767
  ...
  shippingAddress    CustomerAddress? @relation(fields: [shippingAddressId], references: [id], onDelete: SetNull, onUpdate: Cascade)
  ...
  @@index([shippingAddressId])
}
```

`CustomerAddress` — `prisma/schema.prisma:1218-1244` — is the shipping-address source: `street`, `exteriorNumber`, `interiorNumber`, `zipCode`, `neighborhood`, `municipality`, `city`, `state`, `visualReferences`, `carrierPhone`, `label`, plus `sales Sale[]` back-relation and `tenantId`.

### 1.3 `Sale` aggregate delivery shape — `src/sales/domain/sale.entity.ts`

- `SaleFromPersistenceProps` carries delivery metadata at `sale.entity.ts:77-79` (`carrierName?`, `trackingRef?`, `estimatedDeliveryAt?`).
- Private fields `_carrierName`, `_trackingRef`, `_estimatedDeliveryAt` at `sale.entity.ts:147-149`.
- `static create(props)` (`sale.entity.ts:207`) hardcodes `deliveryStatus = 'DELIVERED'` and `channel = 'POS'` (POS default).
- `static fromPersistence(props)` (`sale.entity.ts:229`) round-trips `deliveryStatus ?? 'DELIVERED'` and `carrierName/trackingRef/estimatedDeliveryAt ?? null` (`sale.entity.ts:258-260`).
- `cancel()` (`sale.entity.ts:~298`) blocks cancellation when `deliveryStatus === 'SHIPPED' || 'DELIVERED'` (`SaleDeliveredCannotCancelError`).
- Getters: `carrierName` / `trackingRef` / `estimatedDeliveryAt` at `sale.entity.ts:407-416`.
- `setDeliveryMetadata(...)` (`sale.entity.ts:622-630`) mutates the three carrier fields in place — **but note `Sale.toResponse()` does not surface them, and `ISaleRepository.save()` does not persist them (see 1.5).**

### 1.4 How status transitions happen today

- Charge path (`src/sales/sales.service.ts:2968-2989` for the ONLINE/bot arm) calls `persistChargeConfirmation({ ..., channel: 'ONLINE', deliveryStatus: 'PENDING', ... })` — i.e. online sales start `PENDING`, POS sales keep the aggregate default `DELIVERED`.
- `persistChargeConfirmation` (`src/sales/infrastructure/prisma-sale.repository.ts:866-1010`) only writes `deliveryStatus` when `input.deliveryStatus !== undefined` (`prisma-sale.repository.ts:919-920`).
- The only `SHIPPED` transition is in the chatbot service: `src/chatbot-api/application/chatbot-api.service.ts:401-433` (`setDeliveryMetadata`) — it validates the sale is `CONFIRMED`, `PAID`, `ONLINE`, and not yet `DELIVERED`, then does a **direct** `prisma.sale.update` setting `carrierName`, `trackingRef`, `estimatedDeliveryAt`, `deliveryStatus: 'SHIPPED'`.
- There is **no** aggregate method that transitions to `DELIVERED`; the value is only set at creation/charge or by the chatbot metadata update.

### 1.5 SaleRepository port + adapter shape

Port — `src/sales/domain/sale.repository.ts`:

- `export const SALE_REPOSITORY = Symbol('ISaleRepository');` at `sale.repository.ts:385`.
- `ISaleRepository` declares `save`, `findById`, `findDraftResponseById`, `findDraftsByUserId`, `delete`, `findByIdForUpdate`, idempotency `acquire*/mark*`, `runInTransaction`, `allocateNextFolio`, `persistChargeConfirmation`, `persistCancellation`, `persistCollectedPayment(s)`, `updatePaymentReference`, `findManyConfirmed`, `countConfirmed`, `groupByPaymentStatusConfirmed`, `countNotDeliveredConfirmed`, `findOneWithRelations`.
- The `persistChargeConfirmation` delivery type is `'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED'` (`sale.repository.ts:192`); `findOneWithRelations` also types `deliveryStatus` the same way (`sale.repository.ts:316`).

Adapter — `src/sales/infrastructure/prisma-sale.repository.ts`:

- `save()` builds `saleData` at `prisma-sale.repository.ts:101-113` with `status/channel/register/deliveryStatus/customerId/shippingAddressId/sellerUserId/dueDate/confirmedAt/folio/globalPriceListId/priceListExplicitlySet` — **`carrierName`/`trackingRef`/`estimatedDeliveryAt` are absent**, so saving a `Sale` aggregate drops delivery metadata.
- Read mappers (`findById` `prisma-sale.repository.ts:~280`, `findDraftResponseById` `:~420`, `findDraftsByUserId` `:~560`, `findByIdForUpdate` `:~690`) all cast `deliveryStatus`; `findByIdForUpdate` uses the full 4-value cast including `'SHIPPED'` (`prisma-sale.repository.ts:710-714`).
- `findOneWithRelations` (`prisma-sale.repository.ts:1517-1680`) is the confirmed-sale detail read model (see §9).

---

## 2. Bounded-context module structure (canonical example)

The most recent, self-contained, easy-to-mirror example is **`src/admin/payment-details/`**. It shows the full hexagonal slice in one folder.

### 2.1 Domain entity pattern — `src/admin/payment-details/domain/payment-detail.entity.ts`

- Pure class, no Nest/Prisma deps; `private constructor`, `static create(input)` (validates + builds), `static fromPersistence(props)` (no validation), mutators return `this`, `toResponse()` + `toPersistence()` serializers.
- Example (`payment-detail.entity.ts:73-98` create / `:100-108` fromPersistence).

### 2.2 Repository port — `src/admin/payment-details/domain/payment-detail.repository.ts`

- `IPaymentDetailRepository` interface; token `export const PAYMENT_DETAIL_REPOSITORY = Symbol('PAYMENT_DETAIL_REPOSITORY');` (`payment-detail.repository.ts:46`).
- Methods take explicit `tenantId` and return `null`/`[]` on cross-tenant miss.

### 2.3 Prisma adapter — `src/admin/payment-details/infrastructure/prisma-payment-detail.repository.ts`

- `@Injectable()` implements the port; `constructor(private readonly tenantPrisma: TenantPrismaService)`.
- Maps `P2002` → `BusinessRuleViolationError('DUPLICATE_CLABE')`, `P2025` → `EntityNotFoundError`; `toDomain(record)` → `PaymentDetail.fromPersistence(...)`.

### 2.4 Application service — `src/admin/payment-details/admin-payment-detail.service.ts`

- `@Inject(PAYMENT_DETAIL_REPOSITORY)`, reads tenant via `ClsService<TenantClsStore>` (`requireTenantId()`), maps entities to `toResponse()`, cross-tenant → `EntityNotFoundError` (404).

### 2.5 Controller — `src/admin/payment-details/admin-payment-detail.controller.ts`

```ts
@Controller('admin/payment-details')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AdminPaymentDetailController {
  @Post() @HttpCode(HttpStatus.CREATED) @RequirePermissions(['create', 'PaymentDetail']) ...
  @Get() @RequirePermissions(['read', 'PaymentDetail']) ...
  @Patch(':id') @RequirePermissions(['update', 'PaymentDetail']) ...
  @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) @RequirePermissions(['delete', 'PaymentDetail']) ...
}
```

### 2.6 Module wiring — `src/admin/payment-details/admin-payment-detail.module.ts`

```ts
@Module({
  imports: [AuthModule],
  controllers: [AdminPaymentDetailController],
  providers: [
    AdminPaymentDetailService,
    { provide: PAYMENT_DETAIL_REPOSITORY, useClass: PrismaPaymentDetailRepository },
  ],
})
export class AdminPaymentDetailModule {}
```

Nested under `src/admin/admin.module.ts:24-26` (`AdminPaymentDetailModule` import).

### 2.7 Other reference modules

- `src/quotations/quotations.module.ts` — same shape with `QUOTATION_REPOSITORY = Symbol('IQuotationRepository')` (`src/quotations/domain/quotation.repository.ts:143`), imports `AuthModule`, `ProductsModule`, `PromotionsModule`, `MailerModule`, `PdfGenerationModule`, exports `QuotationsService`.
- `src/sales/sales.module.ts` — the large POS module; shows the Symbol-port seam imports (`PromotionsModule`, `AdminPaymentMethodModule`) and `SALE_REPOSITORY` binding.

### 2.8 Provider token conventions (observed)

Mixed but both used. For a new context, pick one and document it:

- `Symbol.for('…')`: `NOTIFICATION_CONFIG_REPOSITORY` (`notification-config.repository.ts:47`), `RECEIPT_REVIEW_REPOSITORY` (`receipt-review.repository.ts:51`), `USER_EMAIL_LOOKUP` (`user-email-lookup.repository.ts:47`), `STOCK_ALERT_STATE_REPOSITORY`, `MAILER` (`mailer.port.ts`).
- `Symbol('…')`: `SALE_REPOSITORY` (`sale.repository.ts:385`), `QUOTATION_REPOSITORY`, `PAYMENT_DETAIL_REPOSITORY`, `PAYMENT_METHOD_REPOSITORY`, `PAYMENT_METHOD_RESOLVER`, `POS_EVALUATE_PROMOTIONS_USE_CASE`.

### 2.9 Abstracted port precedent (for `IRouteOptimizer`)

`src/admin/payment-methods/domain/payment-method.resolver.ts` is the exact pattern: a narrow read-only port (`IPaymentMethodResolver`) + `export const PAYMENT_METHOD_RESOLVER = Symbol('PAYMENT_METHOD_RESOLVER')`, consumed by `SalesModule` via `@Inject` while the concrete adapter lives in the other context. `src/promotions/application/ports/pos-evaluate-promotions.port.ts` (`POS_EVALUATE_PROMOTIONS_USE_CASE`) is the same seam. `IRouteOptimizer` should be declared the same way (port in the `delivery-routes` context, `Symbol` token, default/manual adapter, optionally a swap-in optimized adapter).

---

## 3. RBAC / permissions

### 3.1 Types + registry — `src/auth/authorization/domain/permission.ts`

- `AppActions` = `create | read | update | delete | batch_delete | manage`.
- `AppSubjects` (`permission.ts:~30-56`) currently ends with `... | 'Quotation' | 'PaymentDetail' | 'PaymentMethod' | 'all'`. A new `'DeliveryRoute'` (and possibly `'DeliveryRouteStop'`) must be appended here.
- `PermissionDefinition = { subject; action; description }`.
- `PERMISSION_REGISTRY` is a `readonly PermissionDefinition[]` (starts ~`permission.ts:61`). Adding a new subject means appending CRUD-shaped entries (mirror the `PaymentDetail` block: `read`, `create`, `update`, `delete`).

### 3.2 Seeding — `src/auth/authorization/infrastructure/permission.seeder.ts`

- `PermissionSeeder implements OnApplicationBootstrap` and upserts every `PERMISSION_REGISTRY` entry via `permission.upsert({ where: { subject_action }, ... })` (`permission.seeder.ts:~40-58`), then ensures the global `Super Admin` role and links `manage:all`. Idempotent — no manual seed script needed; new registry entries auto-seed on boot.

### 3.3 Guard + decorator application

- `src/auth/authorization/guards/permissions.guard.ts` reads `PERMISSIONS_KEY` metadata, builds the CASL ability via `CaslAbilityFactory`, and throws `InsufficientPermissionsError` (403) on miss.
- `src/auth/authorization/decorators/require-permissions.decorator.ts` exposes `@RequirePermissions(...permissions: Array<[AppActions, AppSubjects]>)`.
- Controller convention (verified in `sales-query.controller.ts:31-33` and `admin-payment-detail.controller.ts`):

```ts
@Controller('...')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class XController {
  @Get() @RequirePermissions(['read', 'X']) ...
}
```

- `CaslAbilityFactory` (`src/auth/authorization/casl-ability.factory.ts`) flattens `tenantMembership → role → rolePermissions → permission` and `can(action, subject)` each. Super-admin (`isSuperAdmin && tenantId === null`) gets `manage:all`.

---

## 4. Tenant scoping

### 4.1 Allowlist — `src/shared/tenant/tenant-scoped-models.constant.ts`

`TENANT_SCOPED_MODELS = new Set([...])`. Existing entries include `Sale`, `SaleItem`, `Customer`, `CustomerAddress`, `Quotation*`, `NotificationSettings/Recipient/Action`, `StockAlertState`, `PaymentDetail`, `PaymentMethod`, etc. A new `DeliveryRoute` and `DeliveryRouteStop` MUST be added here; otherwise `TenantPrismaService` will not auto-inject `tenantId` and cross-tenant reads/writes become possible.

### 4.2 Extension behavior — `src/shared/prisma/tenant-prisma.factory.ts`

`createTenantScopedPrisma(base, cls)`:

- `$allOperations` no-ops for non-allowlisted models.
- `isSuperAdmin === true && tenantId === null` bypasses scoping.
- No `tenantId` in CLS → throws `Tenant context required`.
- Read ops (`findMany`, `findFirst`, `count`, `aggregate`, `groupBy`) merge `where: { tenantId }`.
- `create` / `createMany` / `upsert` inject `tenantId` into `data`/`create`.
- `update`/`updateMany`/`delete`/`deleteMany` merge `where: { tenantId }`.
- **Nested `include` clauses are NOT recursed** — repos that `include` non-allowlisted junction relations must filter `where: { tenantId }` explicitly (see the repeated comment in `prisma-sale.repository.ts` around `findById`).

### 4.3 Transaction + CLS — `src/shared/prisma/tenant-prisma.service.ts`

- `getClient()` returns a tenant-scoped client, or the ambient tx client when inside `runInTransaction`.
- `runInTransaction(work)` sets the tx client in CLS (`TX_CLIENT_KEY`) and nests safely.
- `isInTransaction()` and `getTenantId()` (`throws 'Tenant context required'`).
- Background flows seed CLS via `TenantRunnerService.runWithTenant(tenantId, fn)` (`src/shared/tenant/tenant-runner.service.ts`), which sets `tenantId`, `userId = 'system'`, `isSuperAdmin = false`, `tenantSlug = null`.

---

## 5. Email + outbox + Inngest pattern

### 5.1 Mailer

- Port `src/notifications/email/mailer.port.ts`: `IMailer.send({ to, subject, html, attachments? })`; token `export const MAILER = Symbol.for('Mailer')` (mailer.port.ts).
- Module `src/notifications/email/mailer.module.ts`: `{ provide: MAILER, useExisting: ResendMailer }`, exports `MAILER`.
- Adapter `src/notifications/email/resend.mailer.ts`: Resend SDK in production; dev-logger fallback (recipients redacted) when `RESEND_API_KEY` unset and `NODE_ENV !== 'production'`; throws in production without key.

### 5.2 Shared outbox primitives — `src/shared/outbox/`

- `outbox-writer.service.ts` — `publish(tx, tenantId, aggregateType, aggregateId, eventType, payload)` creates an `outboxEvent` row `PENDING` in the caller's transaction.
- `outbox-poller.service.ts` — generic `@Interval` poller; claims with `FOR UPDATE SKIP LOCKED` + `lockToken`/`lockedUntil`, **excludes dedicated event types** `'stock.low.detected'` and `'hr.timeoff.requested'`.
- `outbox-dispatcher.service.ts` — generic fire-and-forget `eventEmitter.emit(eventType, payload)` then marks `PUBLISHED` (documented as insufficient for durable sends; dedicated dispatchers exist for that).
- `outbox.module.ts` — exports `OutboxWriterService`.
- `outbox.types.ts` — `OutboxPayload` + `DispatchableOutboxEvent`.

### 5.3 Dedicated outbox poller/dispatcher (the pattern to copy)

`hr-time-off` is the simplest/no-enrichment template; `low-stock` adds enrichment.

- Poller: `src/hr-time-off/outbox/hr-time-off-outbox.poller.ts` — `@Interval(1000)`, throttled by `HR_TIME_OFF_OUTBOX_POLLER_INTERVAL_MS`; claims only `eventType = 'hr.timeoff.requested'`; per-row try/catch.
- Dispatcher: `src/hr-time-off/outbox/hr-time-off-outbox.dispatcher.ts` — **awaits** `inngestService.send('hr/timeoff.requested', payload, idemKey)`, marks `PUBLISHED` only on resolve, backoff+retry to `FAILED` on rejection; `computeIdempotencyKey = ${tenantId}:${aggregateId}`; lock-token compare-and-swap via `updateMany` for stale-worker safety.
- Module: `src/hr-time-off/outbox/hr-time-off-outbox.module.ts` — `ScheduleModule.forRoot()`, `InngestModule`, config-token `useValue` providers.
- These modules are registered only in `src/app.module.ts` (e.g. `HrTimeOffOutboxModule` at `app.module.ts:~56`).

### 5.4 Inngest functions + registration

- `src/hr-time-off/inngest/time-off-notification.functions.ts` — `buildTimeOffNotificationFunctions({ inngestClient, tenantRunner, notificationConfigRepository, userEmailLookup, mailer, appBaseUrl })` returns `[fn]` via `inngestClient.createFunction({ id: 'time-off-request-email', triggers: [{ event: 'hr/timeoff.requested' }], idempotency: 'event.id', retries: 3, concurrency: { limit: 5 } }, handler)`.
  - Handler steps: `load-config` (re-gate via `NotificationConfigRepository.find`), `resolve-recipients` (via `IUserEmailLookup`), `send-email` (`renderToStaticMarkup(<TimeOffRequestEmail .../>)` + `mailer.send`).
  - **Critical CLS ordering:** `tenantRunner.runWithTenant` must be INSIDE each `step.run` callback (documented at `time-off-notification.functions.ts` and `low-stock.functions.ts`).
- Registrar: `src/hr-time-off/inngest/hr-time-off-inngest-registrar.ts` — `OnModuleInit` calls `inngestService.registerFunctions([fn])`; registered as a **top-level provider in `app.module.ts`** (not inside a module) to keep the dep graph at AppModule scope.
- `low-stock` variant `src/stock-alerts/inngest/low-stock.functions.ts` adds `batchEvents` coalescing + a cross-tenant guard in `composeItems` — useful if route stop emails ever coalesce.
- `src/inngest/inngest.service.ts` — `send(name, data, idempotencyKey)` (passes key as Inngest event `id`), `getFunctions()`, `registerFunctions()`, `getClient()`.
- `src/inngest/inngest.controller.ts` — `/api/inngest`, JWT-excluded, `serve()` built in `OnApplicationBootstrap` after registrars run.

### 5.5 React Email templates

Located at `src/notifications/email/templates/*.tsx`:

- `low-stock.email.tsx`
- `time-off-request.email.tsx`
- `quotation-email.tsx`

Rendering is `renderToStaticMarkup(Component(props) as ReactElement)` from `react-dom/server` (not `@react-email/render`, which breaks Jest's CJS transform). A new "arriving soon" template belongs in the same folder and should follow the `BRAND` token/`LOGO_URL` convention in `time-off-request.email.tsx`.

### 5.6 Outbox write-time example (atomic with domain write)

`src/employees/application/employee-time-off.service.ts` `request()` (`employee-time-off.service.ts:~95-160`): inside `tenantPrisma.runInTransaction`, it creates the `EmployeeTimeOff` row, then gates on `notificationConfigRepo.find()` (`enabled && enabledActions.includes('TIME_OFF_REQUESTED')`) and calls `outboxWriter.publish(prisma, tenantId, 'EmployeeTimeOff', created.id, 'hr.timeoff.requested', payload)`. This is the exact template for "mark sale DELIVERED + emit outbox event atomically".

---

## 6. NotificationConfig

### 6.1 Domain — `src/notification-config/domain/notification-config.ts`

```ts
export type NotificationActionKey = 'LOW_STOCK' | 'TIME_OFF_REQUESTED';
export const NOTIFICATION_ACTION_KEYS: readonly NotificationActionKey[] = [
  'LOW_STOCK',
  'TIME_OFF_REQUESTED',
] as const;
export interface NotificationConfigView { enabled; recipients; enabledActions }
```

### 6.2 Adding a new action key

Two coordinated changes:

1. Append the literal to the `NotificationActionKey` union and `NOTIFICATION_ACTION_KEYS` array (`notification-config.ts`).
2. Add a standalone `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS '<KEY>';` migration — see `prisma/migrations/20260717000002_add_time_off_requested/migration.sql` (Postgres `ADD VALUE` cannot run inside a transaction block, so it must be a single statement migration).

### 6.3 Service + DTO

- `src/notification-config/notification-config.service.ts` `replace()` validates action keys (throws `UNKNOWN_ACTION_KEY` 400) and recipient tenant-membership (`INVALID_RECIPIENT` 400).
- `src/notification-config/dto/update-notification-config.dto.ts` accepts `enabledActions: string[]`; the service narrows to the domain type — so a new key is a domain-only change.
- The Inngest functions re-gate at send time via `config.enabledActions.includes('<KEY>')` — a delivery-route email function must do the same with its new key.

For the "next stop arriving soon" email, the most consistent design is a new `NotificationActionKey` (e.g. `DELIVERY_NEXT_STOP`) following `TIME_OFF_REQUESTED`, so tenants opt in via `PUT /notification-config`; alternatively a simpler direct send can skip NotificationConfig — but the established pattern gates all tenant emails through it.

---

## 7. Prisma schema & migrations

### 7.1 Migration naming convention

`prisma/migrations/<YYYYMMDDHHMMSS>_<snake_case_description>/migration.sql` — 14-digit timestamp. Recent examples:

- `20260513230000_outbox_events`
- `20260611045435_add_sale_delivery_and_receipt`
- `20260706202542_low_stock_alerts`
- `20260717000002_add_time_off_requested`
- `20260731230457_add_quotations_tables`
- `20260824225358_add_payment_detail`
- `20260826000001_add_payment_methods`

### 7.2 Enum + model + relation declaration conventions (from `prisma/schema.prisma`)

- Enums are declared in UPPER_SNAKE sections; additive enum values via separate `ALTER TYPE ... ADD VALUE IF NOT EXISTS` migrations.
- Models: `id String @id @default(uuid())`, `tenantId String`, `tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)`, `@@index([tenantId])`, `@@map("table_name")`.
- Ordered child rows use an explicit integer `sortOrder`/position column (see `ProductImage.sortOrder Int @default(0)`) — the `DeliveryRouteStop` ordering column should mirror this.
- Composite uniques use `@@unique([tenantId, ...])`.
- The `Tenant` model lists every relation array explicitly (`prisma/schema.prisma:~300-390`) — a new `deliveryRoutes DeliveryRoute[]` relation must be added there too.

### 7.3 Exact current `SaleDeliveryStatus` enum values

`prisma/schema.prisma:161-165`: `PENDING`, `DELIVERED`, `NOT_APPLICABLE`, `SHIPPED`.

### 7.4 Delivery-related migration evidence

- `20260515034213_add_sale_shipping_address` — added `shippingAddressId` (Sale → CustomerAddress).
- `20260611045435_add_sale_delivery_and_receipt` — `ALTER TYPE "SaleDeliveryStatus" ADD VALUE 'SHIPPED'` + `sales.carrierName/estimatedDeliveryAt/trackingRef` columns.
- `20260611040422_add_customer_delivery_metadata` — customer-side delivery metadata.

---

## 8. Idempotency / events / domain events

### 8.1 Sale idempotency (per-operation slot)

- Model `SaleIdempotency` — `prisma/schema.prisma:924-941`: `@@unique([tenantId, operation, key])`, `requestHash`, `status: IN_FLIGHT|SUCCEEDED|FAILED`, `responseJson`, `saleId?`.
- Adapter pattern — `src/sales/infrastructure/prisma-sale.repository.ts` `acquireIdempotency` / `markIdempotencySucceeded` (private helpers ~`prisma-sale.repository.ts:1730-1830`): `create IN_FLIGHT` → on `P2002` re-read and return `replay | conflict | in_flight | acquired`. Operations: `sale_charge`, `sale_payment`, `sale_cancel`, `bot_sale_register`.
- A route check-in can reuse this slot pattern with a new `operation` (e.g. `route_checkin`) or, more likely, rely on route-state transitions + an idempotent outbox idempotency key (`${tenantId}:${aggregateId}`).

### 8.2 Domain events (in-memory) vs outbox

- `src/sales/domain/events/sale.events.ts` defines past-tense domain event classes (`SaleConfirmedEvent`, `SaleCanceledEvent`, `SaleShippingAddressSetEvent`, …).
- `src/sales/listeners/sale-event.listener.ts` consumes them via `@OnEvent('...')` and currently **only logs** (EventEmitter, not durable).
- Durable async side effects use the **outbox**, not EventEmitter: `OutboxWriterService.publish` inside the same tx (low-stock via `PrismaProductRepository`, HR-time-off via `EmployeeTimeOffService.request`).
- For `delivery-routes`, the "next stop arriving soon" email should be an outbox event written in the same `runInTransaction` as the stop `DELIVERED`/`checked-in` transition, with a dedicated poller/dispatcher + Inngest function (or reuse the generic dispatcher only if fire-and-forget is acceptable — the codebase explicitly migrated away from that for email).

### 8.3 Bot idempotency decorators (context)

`src/chatbot-api/presentation/decorators/idempotency-key.decorator.ts` + `parse-idempotency-key.pipe.ts` exist for bot API idempotency, but the durable idempotency story for route check-ins is the `SaleIdempotency`/outbox pattern above.

---

## 9. Sales list/query & read models (to mirror for route/stop projection)

### 9.1 Detail DTO — `src/sales/dto/sale-detail-response.dto.ts`

- `SaleDetailResponseDto` (`sale-detail-response.dto.ts:~104-127`): `id, folio, status, channel, register, confirmedAt, dueDate, subtotalCents, discountCents, totalCents, paidCents, debtCents, changeDueCents, paymentStatus, deliveryStatus, customer, cashier, seller, items[], payments[], timeline[]`.
- `SaleDetailTimelineEventDto` (`sale-detail-response.dto.ts:1-52`): discriminated union `SALE_REGISTERED | PAYMENT_RECEIVED | PRODUCTS_DELIVERED | COMMENT`.
- `SaleDetailItemDto` and `SaleDetailPaymentDto` shape the nested projections.

### 9.2 Timeline builder — `src/sales/domain/build-sale-timeline.ts`

`buildSaleTimeline({ createdAt, confirmedAt, deliveryStatus, register, cashier, payments, comments })` sorts payments → `PAYMENT_RECEIVED`, prepends `SALE_REGISTERED`, appends `COMMENT`s, and appends `PRODUCTS_DELIVERED` when `deliveryStatus === 'DELIVERED'` (`build-sale-timeline.ts:75-80`). A route/stop read projection can reuse this exact style and add route stop events.

### 9.3 Read-model query — `src/sales/infrastructure/prisma-sale.repository.ts:1517-1680`

`findOneWithRelations(id)` loads `sale.findFirst({ where: { id, tenantId, status: 'CONFIRMED' }, include: { customer, user, seller, items(select…), payments(select… + user) } })` and maps to the detail shape (customer name composition, item NET subtotal + `rewardKind` coercion, payment catalog snapshot extraction). The route stop projection should mirror this: a `findOneWithStops` / route detail read model with tenant-scoped `findFirst` + selected includes.

### 9.4 Detail assembly — `src/sales/sales.service.ts:1452-1519`

`getSaleDetail(saleId)` validates UUID, calls `saleRepo.findOneWithRelations`, loads comments, assembles the `SaleDetailResponseDto`, and calls `buildSaleTimeline`. A route detail service method should follow this shape (read model from repo → domain builder → DTO).

### 9.5 List/query DTOs

- `src/sales/dto/list-sales-query.dto.ts` — `ListSalesDeliveryStatus` enum (`list-sales-query.dto.ts:46`) with `@CsvEnum` multi-value parsing (`deliveryStatus`).
- `src/sales/dto/sales-list-filter.types.ts` — shared filter types (`deliveryStatus?: ListSalesDeliveryStatus[]`).
- Adapter filters in `buildExtendedWhere` (`prisma-sale.repository.ts:1360`): `deliveryStatus: { in: ... }`.

---

## 10. Synthesis — implications for `delivery-routes`

1. **New models.** `DeliveryRoute` (id, tenantId, driverUserId FK→User, status, startedAt, completedAt, timestamps) and `DeliveryRouteStop` (id, tenantId, routeId FK→DeliveryRoute, saleId FK→Sale, sortOrder/position, status PENDING/IN_PROGRESS/COMPLETED/SKIPPED, checkedInAt, completedAt). Both MUST be added to `TENANT_SCOPED_MODELS` and to `Tenant.deliveryRoutes`.
2. **Stop = existing Sale.** Each stop references `Sale` (deliveryStatus `PENDING|SHIPPED` + `shippingAddressId`). The route module should read `Sale.findOneWithRelations`/`shippingAddress` (or a new narrow `ISaleRepository` read method) and, on stop completion, transition `Sale.deliveryStatus` to `DELIVERED` via a new repository write method (the current `save()` does not carry delivery metadata and `setDeliveryMetadata` is chatbot-only).
3. **Email.** On completing a stop, if the NEXT stop's sale has a customer with `email`, emit an outbox event (e.g. `delivery.stop.completed` or `delivery.next.stop.notify`) in the same transaction, then a dedicated poller/dispatcher + Inngest function renders a React Email template via `MAILER`. Optionally gate with a new `NotificationActionKey` (e.g. `DELIVERY_NEXT_STOP`) + `ALTER TYPE` migration, matching `TIME_OFF_REQUESTED`.
4. **Ordering.** Manual ordering is behind `IRouteOptimizer` (a `Symbol` port like `IPaymentMethodResolver`); a default no-op adapter returns the stops in `sortOrder` (or insert order) for MVP; a future adapter can reorder. No GPS in MVP.
5. **Permissions.** Add `'DeliveryRoute'` to `AppSubjects` + `PERMISSION_REGISTRY` (read/create/update/delete), plus any check-in action (e.g. `update` covers check-in). Seed via existing `PermissionSeeder`. A dedicated "driver" role is an admin-role concern, not a permission-seeder concern; the proposal should state whether a new `isSystem` role is seeded or created via `AdminRoleService`.
6. **Read projection.** Mirror `findOneWithRelations` + `buildSaleTimeline` for a `DeliveryRouteDetailResponseDto` with stops and a timeline of check-ins.

---

## Key Learnings

1. `Sale.setDeliveryMetadata` exists on the aggregate but `ISaleRepository.save()` does not persist `carrierName`/`trackingRef`/`estimatedDeliveryAt`, so delivery metadata only persists via the chatbot direct `prisma.sale.update` path.
2. New tenant-scoped Prisma models must be added to the `TENANT_SCOPED_MODELS` allowlist or `TenantPrismaService` will neither filter reads nor attribute writes by `tenantId`.
3. Durable async email in this codebase uses an outbox row written inside `runInTransaction`, then a dedicated poller/dispatcher that awaits `InngestService.send` and marks `PUBLISHED` only on resolve.
4. RBAC subjects and permissions are type-safe in `AppSubjects`/`PERMISSION_REGISTRY` and auto-seed at bootstrap via `PermissionSeeder`, so a new subject needs only registry entries and controller `@RequirePermissions`.
5. Adding a new `NotificationActionKey` requires appending it to the domain union/array plus a standalone `ALTER TYPE ... ADD VALUE IF NOT EXISTS` migration because Postgres cannot run `ADD VALUE` inside a transaction.
