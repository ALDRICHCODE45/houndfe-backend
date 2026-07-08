# Exploration: low-stock-alerts

**Change**: `low-stock-alerts`
**Phase**: explore (research only — no production code)
**Store**: hybrid (Engram `sdd/low-stock-alerts/explore` + this file)

---

## Problem Framing

The client wants a **one-shot email alert** when a product's stock crosses its
`minQuantity` threshold downward. This is intentionally scoped as the **first
vertical slice** of a reusable **Sistema → Configuración → Notificaciones**
module: per-tenant enable/disable of notifications per module, a per-tenant list
of users to notify, and a per-tenant set of enabled actions/events. Low-stock
email is the first consumer of that config.

Two engines are being introduced greenfield and must be designed for reuse, not
just this feature:
- **Inngest** — mandatory durable-workflow engine (reused across future features).
- **Resend** — email provider (React Email templates acceptable).

Locked business rules (not re-opened here): threshold = existing per-product /
per-variant `minQuantity`; cadence = **edge-triggered** (fire once on downward
crossing, re-arm only after restock back above threshold); recipients = a single
per-tenant user list; provider = Resend.

### Grounding verified against real code (files actually read)

- **Stock model** — `prisma/schema.prisma`: `Product` has `useStock`,
  `quantity`, `minQuantity` (used when `hasVariants=false`), `useLotsAndExpirations`
  (L352–362). `Variant` has its OWN `quantity` + `minQuantity` (L446–447).
  `Lot` has `quantity` + `expirationDate` (L502–521).
- **Stock decrement** — `src/products/infrastructure/prisma-product.repository.ts`
  `decrementStockForCharge` (L175–233) uses **conditional `updateMany`** with
  `quantity: { decrement }` guarded by `quantity: { gte }`. **It does NOT return
  the resulting quantity.** Variant path (L188–205) and product path (L207–231)
  both branch; `useStock:false` products are skipped. `incrementStockForRestock`
  (L235–273) is the restock/re-arm counterpart.
- **Trigger call sites** — `src/sales/sales.service.ts` calls
  `decrementStockForCharge` at **L1643, inside `saleRepo.runInTransaction`
  (opened L1518)** → the decrement happens **inside a DB transaction**.
  `src/orders/orders.service.ts` `decreaseStock` loop at L88–91.
- **Event bus** — `@nestjs/event-emitter` v3 (in-process). Listener pattern in
  `src/orders/listeners/order-event.listener.ts` (`@OnEvent`, injects
  `ProductsService`) and `src/sales/listeners/sale-event.listener.ts`.
  `src/products/domain/events/product.events.ts` already declares
  `ProductStockLowEvent` / `ProductStockDepletedEvent` (currently **not emitted**).
- **Tenancy** — `src/shared/prisma/tenant-prisma.service.ts`: CLS-based tenant
  scoping; `runInTransaction` stashes the tx client in CLS (L34–51). `getTenantId()`
  from CLS. `User ↔ Tenant` is via `TenantMembership` (schema L949+), not a direct FK.
- **CASL** — `src/auth/authorization/domain/permission.ts`: `AppSubjects` string
  union (L19–42) + `PERMISSION_REGISTRY` (L58–420). `SatKey` is the recent
  precedent (L23, L158). `casl-ability.factory.ts` grants `manage:all` to super
  admin (L50) and otherwise maps DB `RolePermission` rows (L65). `permission.seeder.ts`
  seeds the registry + Super Admin **only** — per-role grants come from DB
  `RolePermission` rows, not from a hardcoded "Manager" block.
- **Platform / deps** — `@nestjs/platform-express` (Express), `@nestjs/schedule`
  present, `@prisma/adapter-pg` + `pg`, Jest. **No** email/inngest/queue deps yet.
  `src/main.ts` is a plain `NestFactory.create` bootstrap.

> ⚠️ **Contradiction flag vs. grounding**: the orchestrator note "check whether
> the repository handles Variant quantity too" — **it does** (L188–205). And the
> note framed the decrement as a plain call; in reality **it runs inside an
> interactive Prisma transaction** and **returns void (no post-quantity)**. Both
> facts materially change the trigger design below. Nothing else contradicted.

---

## Area 1 — Inngest ↔ NestJS 11 integration

**(a) Mounting the `serve` endpoint.** App is Express (`@nestjs/platform-express`),
so `inngest/express` `serve()` returns an Express handler. Options:
- **A1: Nest controller wrapper** — a `@Controller('api/inngest')` with
  `@All()` that delegates `(req, res)` to the memoized `serve()` handler. Keeps it
  inside Nest DI/lifecycle, testable, respects global prefixes/filters.
- **A2: raw express middleware** in `main.ts` via `app.use('/api/inngest', serve(...))`.
  Simpler but bypasses Nest DI, guards, and CLS middleware ordering.

**Recommendation: A1 (controller wrapper).** CLS tenant middleware and Nest
lifecycle matter here; a controller keeps the endpoint first-class. Exclude the
route from the JWT guard (it authenticates via Inngest signing key, not a user).

**(b) Dev Server vs Cloud.** Use **Inngest Dev Server locally** (`npx inngest-cli
dev`, auto-discovers the serve endpoint, zero cloud account) and **Inngest Cloud
for staging/prod** (signing key + event key via `@nestjs/config`). One client,
env-driven keys. Recommendation: **Dev Server for dev, Cloud for prod.**

**(c) DI bridge (the crux).** Inngest functions are defined outside Nest's DI, but
handlers need repositories + mailer + tenant scoping. Options:
- **C1: capture the Nest app ref** and resolve providers inside handlers.
- **C2: a Nest `InngestService`/registry provider** that OWNS the `Inngest` client
  and builds `createFunction(...)` closures over injected collaborators
  (mailer port, notification-config repo, product repo). The controller asks the
  service for `client` + `functions` and hands them to `serve()`.

**Recommendation: C2 (provider-owned functions).** Functions become closures over
DI-injected ports — clean, unit-testable, no service-locator smell. **Critical
tenant caveat**: CLS tenant context does NOT exist inside an Inngest handler
(no HTTP tenant middleware ran). Every event MUST carry `tenantId` in its payload,
and repositories used inside handlers must accept an explicit tenant (either a
tenant-explicit variant, or run the handler body inside a CLS `runWith({ tenantId })`
seed). Design a small `runWithTenant(tenantId, fn)` helper. This is a
**design-phase decision** and a real risk (see Risks).

**(d) Sending events.** Expose `inngest.send(...)` through the same
`InngestService` (a thin `emit(event)` port) so domain/app services depend on a
Nest port, not the raw SDK. Recommendation: **`InngestService.send()` port**.

---

## Area 2 — Trigger flow (transactional safety)

The decrement runs **inside `saleRepo.runInTransaction`** (sales.service L1518/1643).
Two shapes:
- **B1: direct `inngest.send` in the service** right after decrement — but that
  would be **inside the open transaction**: a network call in a DB tx, and if the
  tx rolls back after send, we've emitted a phantom alert. Rejected.
- **B2: domain event via `@nestjs/event-emitter`, listener calls `inngest.send`** —
  matches the existing `order-event.listener` pattern, decouples sales/orders from
  Inngest. But default EventEmitter emit is synchronous/in-process and, if emitted
  inside the tx, has the same commit-ordering hazard.

**Recommendation: B2 + after-commit dispatch.** Emit an in-process domain event
(e.g. `stock.low.detected`) but **only after the transaction commits**. Because
`runInTransaction` returns a promise that resolves post-commit, the cleanest rule
is: **collect "low-stock crossings" into a buffer during the tx, then emit/send
after `runInTransaction` resolves.** The listener (or the service directly, post-commit)
calls `InngestService.send` with a fully self-contained payload
(`tenantId`, `productId`, `variantId?`, `name`, `newQuantity`, `minQuantity`,
`occurredAt`, and an idempotency seed). Inngest then durably owns retries/sending.
This keeps DB atomicity intact and moves all fragile network work into Inngest.

---

## Area 3 — Edge-trigger state model

We must fire **once** on downward crossing and **re-arm on restock**. The hard
part: `decrementStockForCharge` returns void, and two concurrent sales could both
observe "below threshold". Options:
- **D1: boolean/timestamp column on Product/Variant** (e.g. `lowStockAlertedAt`).
  Cheapest, but pollutes the inventory aggregate and needs a column on both
  `Product` and `Variant`; re-arm = clear on restock-above.
- **D2: separate `StockAlertState` table** keyed by `(tenantId, productId, variantId)`
  with `alerted Boolean` / `alertedAt`. Keeps inventory clean, extensible to lots
  later, natural home for future per-channel state.
- **D3: derive it** from sales history — rejected (expensive, racy, no clean
  "already alerted" truth).

**Concurrency**: whichever store, the flip to "alerted" must be **atomic and
conditional** so exactly one concurrent transaction wins the alert. The pattern:
after decrement, do a single guarded write that (a) reads/sets alerted state and
(b) only "wins" when it transitions `armed → alerted` AND `newQuantity <
minQuantity` AND previous state was armed. With D2 this is an
`updateMany({ where: { ...key, alerted: false }, data: { alerted: true } })`
returning `count === 1` as the "I own the alert" signal — same idiom already used
for stock guards in the repo. To get `newQuantity` reliably, the decrement step
needs to **return post-values** (raw `UPDATE ... RETURNING quantity`, or a
read-back inside the tx). Re-arm: `incrementStockForRestock` path resets
`alerted=false` when quantity climbs back `>= minQuantity`.

**Recommendation: D2 (`StockAlertState` table) with a conditional atomic flip
inside the same transaction as the decrement**, and extend the decrement to return
post-quantities. Clean aggregate, concurrency-safe, forward-compatible with lots
and multiple channels. Per-tenant by construction.

---

## Area 4 — Notification config data model (per-tenant, extensible)

Target UI: master on/off, multi-select "Usuarios a notificar", collapsible
"Acciones a notificar" grouped by module. Proposed shape:
- **`NotificationSettings`** — one row per tenant: `tenantId @unique`,
  `enabled Boolean` (master toggle), timestamps. (Master switch.)
- **`NotificationRecipient`** — join table `(tenantId, userId)` → the single
  per-tenant recipient list. FK to `User`. (One list, all enabled notifications.)
- **`NotificationAction`** — enabled actions/events: `(tenantId, action)` where
  `action` is an **enum** (`NotificationActionKey`), shipping only
  `LOW_STOCK` now, but enum-driven so `LEAD_CREATED`, `RECRUITMENT_*` slot in later.
  A `module` grouping (enum or derived) supports the collapsible-by-module UI.

**Forward-compat**: keeping recipients in their own table (not embedded) means a
future `NotificationActionRecipient (tenantId, action, userId)` can be added
**additively** for per-action recipients without rewriting the single-list model —
resolution just prefers per-action rows when present, else falls back to the global
list. Enum + join tables keep it generic across modules while shipping only
low-stock now.

**Recommendation**: the three tables above (`NotificationSettings`,
`NotificationRecipient`, `NotificationAction`) + `NotificationActionKey` enum,
all per-tenant. DDD: `notification-config` bounded context with a repository port
+ Prisma adapter, mirroring existing modules.

---

## Area 5 — Recipients resolution + Resend send

Flow, as the final Inngest steps (each `step.run` is a durable checkpoint):
1. `step.run('load-config')` — read `NotificationSettings` (master `enabled`) and
   `NotificationAction` for `LOW_STOCK`; **short-circuit** if disabled.
2. `step.run('resolve-recipients')` — `NotificationRecipient` → `User.email`
   (filter `isActive`, dedupe). Must run tenant-scoped (payload `tenantId`).
3. `step.run('send-email')` — Resend send (React Email template), tenant + product
   context. Wrap in a mailer port so Resend is swappable and testable.

**Dedupe / no double-send**: two layers. (a) The **edge-trigger atomic flip**
(Area 3) already guarantees a single crossing emits a single event. (b) Add an
**Inngest `idempotency` key** on the function derived from the crossing identity
(e.g. `event.data.tenantId + productId + variantId + alertEpoch`), where
`alertEpoch` is a monotonically-increasing counter/timestamp bumped on each
arm→alert transition. This makes retries/duplicate events collapse to one send.
Configure `retries` + a `concurrency` limit to protect Resend.

**Recommendation**: config-gated 3-step Inngest function, mailer port over Resend,
idempotency key = crossing identity + alert epoch.

---

## Area 6 — CASL / permissions

Follow the `SatKey` precedent exactly:
- Add **`NotificationConfig`** to `AppSubjects` (`permission.ts` L19–42).
- Add registry rows: `read` + `update` (and optionally `manage`) for
  `NotificationConfig` in `PERMISSION_REGISTRY`. Seeder upserts them idempotently
  on bootstrap (`permission.seeder.ts`).
- Grant to **Manager/Admin** via DB `RolePermission` rows (the factory maps DB
  grants at `casl-ability.factory.ts` L65; super admin gets it free via `manage:all`).
- Guard the config controller with `@RequirePermissions` (`permissions.guard.ts`).

**Recommendation**: `read` + `update` on `NotificationConfig`, Manager/Admin
grants. Read-mostly subject; no per-record conditions needed for the first slice.

---

## Area 7 — First-slice scope (IN / OUT)

**IN**
- Per-tenant `NotificationSettings` + `NotificationRecipient` +
  `NotificationAction(LOW_STOCK)` tables/enum + repo/adapter.
- CRUD API the Notificaciones UI consumes (get/update config, set recipients,
  toggle actions) with CASL `NotificationConfig`.
- Inngest wired into Nest (controller serve endpoint + `InngestService` +
  DI-bridged functions), Dev Server for local.
- Edge-triggered low-stock detection for **product-level and variant-level** stock,
  with `StockAlertState` + atomic flip + re-arm on restock; decrement extended to
  return post-quantities.
- After-commit event → `inngest.send` → config-gated Resend email (React Email).

**OUT (explicitly deferred)**
- **Lots/expiration alerts** (`Lot` model) — out of first slice; call out as next.
- **Per-action recipients** (model stays additive-ready).
- **Other modules** (leads, recruitment) — enum reserves space only.
- **In-app / push / SMS channels**, digest/batch mode, quiet hours.
- **Orders path** (`orders.service` `decreaseStock`) — can reuse the same emitter
  later; first slice focuses on the POS charge (sales) path unless proposal widens it.

---

## Open Questions (for propose/design)

1. **Post-quantity retrieval**: extend `decrementStockForCharge` to return
   `{ productId, variantId, newQuantity, minQuantity }[]`, or do a tenant-scoped
   read-back inside the tx? (Affects repo signature + its spec.)
2. **Tenant context inside Inngest handlers**: confirm the `runWithTenant` seeding
   approach vs. tenant-explicit repository variants.
3. **Where the crossing is detected**: in the repo (returning crossings) vs. in
   the service after read-back. Repo-returns keeps it atomic with the guard.
4. **Alert epoch source** for idempotency: counter column vs. timestamp.
5. **Does the first slice include the orders path**, or sales-only?
6. **Resend from-domain / verified sender + env config** ownership.
7. **`@nestjs/schedule` is present** — any need for a periodic reconciliation/digest,
   or is pure edge-trigger sufficient for v1? (Recommend edge-only for v1.)

---

## Risks

- **R1 (High) — Tenant context loss in Inngest handlers.** CLS tenant middleware
  never runs for Inngest HTTP callbacks. If a handler uses a tenant-scoped repo
  without seeding `tenantId`, it will throw "Tenant context required" or, worse,
  leak across tenants. Mitigation: `tenantId` in every payload + `runWithTenant`.
- **R2 (High) — Transaction/commit ordering.** Sending events inside the open
  charge transaction risks phantom alerts on rollback and network-in-tx latency.
  Mitigation: buffer crossings, emit/send strictly after commit.
- **R3 (Medium) — Concurrency double-fire.** Two simultaneous sales both crossing
  the threshold. Mitigation: atomic conditional flip (`updateMany ... count===1`)
  + Inngest idempotency key.
- **R4 (Medium) — Decrement returns void today.** Edge detection needs post-values;
  changing the repo signature touches `prisma-product.repository.spec.ts` and both
  call sites. Strict TDD applies.
- **R5 (Medium) — Greenfield infra surface.** Inngest + Resend + new tables + CASL
  subject in one slice is broad; likely exceeds the 400-line review budget →
  flag chained/stacked PRs at tasks phase (config module, Inngest bridge,
  detection+state, email send as separable work units).
- **R6 (Low) — Existing unused `ProductStockLowEvent`** may tempt reuse; verify it
  carries enough (`tenantId`, variant, minQuantity) or replace it.
```
