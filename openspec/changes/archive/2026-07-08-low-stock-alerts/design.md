# Design: Low-Stock Email Alerts

## Technical Approach

Edge-triggered low-stock detection ships as the first consumer of a reusable
per-tenant **notification-config** module, driven by **Inngest** (durable
workflow) + **Resend** (email). The detection is atomic and transactional: the
decrement itself reports downward crossings via a guarded
`UPDATE ... RETURNING`, a `StockAlertState` row provides the one-shot/re-arm
machine through a conditional flip in the SAME transaction, and — critically —
the enriched `stock.low.detected` event is written to the EXISTING
`OutboxEvent` table IN the same transaction (durable boundary, finding #10). A
DEDICATED awaited relay (isolated from the generic fire-and-forget dispatcher)
drains PENDING `stock.low.detected` rows AFTER commit and **awaits**
`InngestService.send`, marking the row `PUBLISHED` only on success — so a
post-commit send failure stays `PENDING` and is retried, never lost. Inngest
coalesces near-simultaneous crossings per tenant into ONE email.

**Security & isolation are load-bearing here** (see the dedicated section
below): the four new models are registered in `TENANT_SCOPED_MODELS`, every raw
statement carries an explicit `"tenantId"` predicate, and the `/api/inngest`
endpoint is protected ONLY by Inngest signature verification because there is no
global `APP_GUARD`.

Two new hexagonal modules mirror `src/sat-catalog/` exactly (domain port + DI
token + Prisma adapter + service + controller + DTOs): `src/notification-config/`
and `src/stock-alerts/`. Inngest is bridged into Nest DI via an `InngestModule`
that owns the client and builds `createFunction(...)` closures over injected
ports; a controller mounts `serve()`.

**Grounding correction (verified against real code):** `decrementStockForCharge`
has TWO call sites, BOTH in `sales.service.ts` (L1643 charge-confirm, L1918
online-credit sale) plus the `products.service.ts` wrapper (L100–108).
`orders.service.ts` (L90) calls `decreaseStock`, a DIFFERENT method — it is NOT
a call site and is out of scope (matches proposal "orders path deferred"). The
orchestrator note about orders is inaccurate; honoring real code.

## Resolved Decisions

### Decision 1 — Tenant context in Inngest handlers: `runWithTenant(tenantId, fn)` seeding CLS

**Choice**: A `TenantRunnerService` (in `src/shared/tenant/`) exposes
`runWithTenant<T>(tenantId, fn)` which opens a fresh `cls.run()` scope, seeds
`tenantId`/`userId=SYSTEM`/`isSuperAdmin=false`, then invokes `fn`. Every Inngest
step body that touches a tenant-scoped repo is wrapped in it.

```ts
async runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return this.cls.run(async () => {
    this.cls.set('tenantId', tenantId);
    this.cls.set('userId', SYSTEM_ACTOR_ID);
    this.cls.set('isSuperAdmin', false);
    return fn();          // TenantPrismaService.getClient() now resolves tenantId
  });
}
```

**Alternatives**: tenant-explicit repository variants (a parallel `*ByTenant`
method set). **Rejected**: doubles the repo surface, invites drift, and breaks
the "reuse existing tenant-scoped repos" property. **Rationale**: `getClient()`
already reads `tenantId` from CLS (`tenant-prisma.service.ts:53`); seeding CLS is
the smallest change that makes ALL existing tenant repos work unchanged inside a
handler. Seeding happens at the TOP of each `step.run` body, before any repo
call. This directly satisfies the stock-alerts spec "handler uses ONLY the
payload's tenantId and does NOT call getTenantId() from CLS" — CLS is seeded from
the payload, never inherited from a request.

### Decision 2 — Alert epoch source: integer counter column

**Choice**: `StockAlertState.alertEpoch Int @default(0)`, incremented in the
arm→alert flip. Idempotency seed = `${tenantId}:${productId}:${variantId ?? ''}:${alertEpoch}`.

**Alternatives**: timestamp. **Rejected**: same-millisecond collisions on
concurrent flips, requires an injectable clock to test deterministically.
**Rationale**: the counter is monotonic, collision-free, and testable with no
clock injection. Re-arm (restock) does NOT reset it; only the next arm→alert flip
increments it, so each distinct crossing episode gets a unique epoch → retries of
the same crossing collapse, a genuinely new crossing does not.

### Decision 3 — Coalescing: Inngest `batchEvents` keyed by tenant, 60s window

**Choice**: The send function declares
`batchEvents: { maxSize: 50, timeout: '60s', key: 'event.data.tenantId' }`. One
function run receives `events[]` (all same tenant) and renders ONE email listing
every distinct item.

**Alternatives**: `debounce` (drops all-but-last, loses items — wrong for
"list BOTH") or manual fan-in via a buffer table. **Rejected**: debounce loses
data; a buffer table reinvents what batching gives free. **Rationale**:
`batchEvents` groups DISTINCT items into one run while the upstream atomic flip
guarantees one-shot-per-item (only genuine crossings ever emit an event, so batch
members are inherently distinct + already de-duplicated at source). A single
crossing still yields a one-item batch → one email. `60s` is the default
(proposal R7); a per-action override is additive later.

### Decision 4 — Inngest function step boundaries

Four durable steps, each wrapped in `runWithTenant(event tenantId)`:

1. `step.run('load-config')` — read `NotificationSettings.enabled` +
   `NotificationAction` for `LOW_STOCK`; return `{ enabled }`. Short-circuit
   (return) if master OFF or `LOW_STOCK` not enabled.
2. `step.run('resolve-recipients')` — `NotificationRecipient` → `User.email`
   where `isActive`, deduped. Short-circuit if empty.
3. `step.run('compose-items')` — dedupe batch events by `itemKey`
   (`productId:variantId`), build item view-models from payload fields (already
   self-contained).
4. `step.run('send-email')` — `MAILER.send(recipients, renderLowStock(items))`
   exactly once.

Config: `{ id: 'low-stock-email', retries: 3, concurrency: { limit: 5 } }`.
Each `step.run` is a durable checkpoint; a retry after a partial failure re-runs
only the failed step, and the DB flip prevents duplicate emails at the source.

### Decision 5 — Decrement → post-quantity: single guarded `UPDATE ... RETURNING`

**Choice**: Replace the two `updateMany` branches with raw guarded
`UPDATE ... RETURNING` statements via `$queryRaw`. The returned row yields
`newQuantity` atomically with the guard.

**Product path** (mirrors real guards `prisma-product.repository.ts:207-231`):

```sql
UPDATE products
   SET quantity = quantity - $n
 WHERE id = $productId
   AND "tenantId" = $tenantId          -- finding #3: raw stmt not covered by $extends
   AND "useStock" = true               -- finding #7: preserve stock guard
   AND quantity >= $n
RETURNING quantity AS "newQuantity", "minQuantity", "useLotsAndExpirations";
```

- **Zero rows** ⇒ run the non-stock fallback (finding #7): `SELECT id FROM
  products WHERE id=$productId AND "tenantId"=$tenantId AND "useStock"=false`.
  If a row exists ⇒ `continue` (skip silently, no throw, no crossing — services /
  non-inventoried items). Only if NO non-stock row exists ⇒ throw
  `STOCK_INSUFFICIENT_AT_CONFIRM`.

**Variant path** (finding #9 — `Variant` has NO `useStock` /
`useLotsAndExpirations`; verified `schema.prisma:435-460`):

```sql
UPDATE variants
   SET quantity = quantity - $n
 WHERE id = $variantId AND "productId" = $productId
   AND "tenantId" = $tenantId
   AND quantity >= $n
RETURNING quantity AS "newQuantity", "minQuantity";
```

Zero rows ⇒ throw `STOCK_INSUFFICIENT_AT_CONFIRM` (variants have no non-stock
mode). **Lots exclusion for variants**: verified from `schema.prisma:352` —
`useStock`/`useLotsAndExpirations`/`quantity`/`minQuantity` apply ONLY when the
product has no variants, so a variant-bearing product cannot use lots. The
variant path therefore needs no lots check and does NOT reference the
nonexistent columns.

**Downward-crossing gate (finding #8 — PRE quantity is required).** Firing on
`newQuantity <= minQuantity && alerted=false` is WRONG: it fires on items already
at/below min (created below min, or `minQuantity` raised later). The PRE value is
free: `pre = newQuantity + $n`. The flip runs ONLY when a genuine downward
crossing occurred:

```
pre > minQuantity  &&  newQuantity <= minQuantity  &&  !useLotsAndExpirations
```

(`pre = newQuantity + adjustment.quantity`; product path also requires
`!useLotsAndExpirations`, variant path is inherently lots-free). Only then
`INSERT ... ON CONFLICT DO NOTHING` the armed `StockAlertState` row and run the
conditional flip; `count === 1` ⇒ this tx owns the crossing ⇒ enrich, write the
outbox row (below), and push to the return array. Example: `qty=2,min=3`,
`alerted=false`, sale of 1 ⇒ `new=1, pre=3`; `3 > 3` is false ⇒ NO fire (was
already low). Genuine crossing `qty=5,min=3`, sale 2 ⇒ `new=3, pre=5`; `5 > 3 &&
3 <= 3` ⇒ fire.

**New return type** (replaces `Promise<void>`):

```ts
type StockCrossing = {
  productId: string;
  variantId: string | null;
  newQuantity: number;
  minQuantity: number;
};
decrementStockForCharge(adjustments): Promise<StockCrossing[]>;
```

**Alternatives**: read-back after `updateMany`. **Rejected**: extra round-trip
and a race window between decrement and read. **Rationale**: `RETURNING` is one
atomic statement — no window, correct under concurrency, and keeps the existing
`gte` guard. `updateMany` in Prisma Client cannot RETURNING, so `$queryRaw` is
required (the repo already uses raw guards idiomatically).

**Coordinated call-site + spec changes** (all move together, strict TDD):
- `products/domain/product.repository.ts` — port signature → `Promise<StockCrossing[]>`.
- `products/infrastructure/prisma-product.repository.ts` — `decrementStockForCharge`
  raw UPDATE RETURNING (tenant + useStock guard, non-stock fallback, PRE gate) +
  flip + IN-tx outbox write; `incrementStockForRestock` raw UPDATE RETURNING +
  strict `>` re-arm.
- `products/products.service.ts:100-108` — wrapper returns the array.
- `sales/sales.service.ts:1643` and `:1918` — capture returned crossings; both
  still inside `runInTransaction`. (Note: the enriched event + outbox write happen
  at the repo/flip site inside the tx, so the buffer is only for the return
  contract; no in-tx network call.)
- `prisma-product.repository.spec.ts:82` — assert returned crossings, tenant-guard
  isolation, non-stock skip, PRE-gate, re-arm strict boundary.
- `products.service.spec.ts:30`, `sales.service.spec.ts` (all
  `decrementStockForCharge.mockResolvedValue(undefined)` sites) → `mockResolvedValue([])`.

## The Atomic One-Shot Flip

```sql
-- inside the same tx as the decrement, ONLY when the downward-crossing gate
-- (pre > minQty && newQty <= minQty && !lots) is true — see Decision 5.
INSERT INTO stock_alert_states (id, "tenantId", "productId", "variantKey", ...)
VALUES (..., false, 0) ON CONFLICT DO NOTHING;         -- ensure row exists, armed

UPDATE stock_alert_states
   SET alerted = true, "alertEpoch" = "alertEpoch" + 1, "alertedAt" = now()
 WHERE "tenantId" = $1 AND "productId" = $2 AND "variantKey" = $3
   AND alerted = false
RETURNING "alertEpoch";                                 -- rowcount===1 ⇒ we own it
```

Two concurrent sales both cross: the first `UPDATE` locks the row and flips
(`count=1`, emits); the second sees `alerted=true` (`count=0`, emits nothing).

**Isolation level (finding #11).** The flip is correct under the connection
default **READ COMMITTED**: the losing tx re-reads the committed `alerted=true`
and its guarded `UPDATE` matches zero rows (`count=0`). Do NOT run this under
REPEATABLE READ / SERIALIZABLE — those would surface a serialization failure
(Prisma `P2034`) on the loser instead of a clean `count=0`, changing the
contract. `runInTransaction` (`tenant-prisma.service.ts:43`) uses the default
isolation, so no change is needed; the design pins it explicitly and forbids
raising it for this path.

**Re-arm (finding #6 — STRICT `>`).** Re-arm lives in
`incrementStockForRestock`. With the inclusive `<=` alert band, using `>=` would
cause a spurious SECOND alert on restock-to-min-then-sell, so re-arm MUST require
`newQuantity > minQuantity` (STRICT). The current restock path
(`prisma-product.repository.ts:235-273`) uses `updateMany` and returns no
quantity, so re-arm needs its OWN raw `UPDATE ... RETURNING`:

```sql
-- product re-arm (variant re-arm mirrors this without useStock)
UPDATE products
   SET quantity = quantity + $n
 WHERE id = $productId AND "tenantId" = $tenantId AND "useStock" = true
RETURNING quantity AS "newQuantity", "minQuantity";
```

The re-arm flip is an **app-side conditional** on the RETURNING values —
`newQuantity`/`minQuantity` come from the product/variant row, they are NOT
columns on `stock_alert_states`, so the guard is evaluated in the service, not in
the flip's `WHERE`:

```ts
// STRICT '>' — restock-to-exactly-min does NOT re-arm (Decision above)
if (newQuantity > minQuantity) {
  // UPDATE stock_alert_states SET alerted = false
  //  WHERE "tenantId" = $1 AND "productId" = $2 AND "variantKey" = $3
}
```

```sql
-- the re-arm flip itself — no phantom columns in the predicate:
UPDATE stock_alert_states
   SET alerted = false
 WHERE "tenantId" = $1 AND "productId" = $2 AND "variantKey" = $3;
```

The row stays; `alertEpoch` is preserved (only the next arm→alert flip
increments it). Restock-to-min-exactly (`new == min`) does NOT re-arm, so a
later drop cannot double-fire.

## Security & Isolation (gate blockers)

### Tenant-scoping allowlist — register all 4 new models (finding #1, BLOCKER)

`createTenantScopedPrisma` (`tenant-prisma.factory.ts:28`) is **allowlist-based
and FAILS OPEN**: any model NOT in `TENANT_SCOPED_MODELS`
(`tenant-scoped-models.constant.ts`) bypasses the `where.tenantId` injection
entirely (`if (!model || !TENANT_SCOPED_MODELS.has(model)) return query(args)`).
The 4 new models are absent → cross-tenant leak on every normal-client read.
**MUST register all four** in `TENANT_SCOPED_MODELS`:

```ts
'NotificationSettings', 'NotificationRecipient',
'NotificationAction', 'StockAlertState',
```

- `NotificationSettings/Recipient/Action` are read/written via the normal
  tenant-scoped client (config controller/service) → registration is what scopes
  them.
- `StockAlertState` flips run via `$queryRaw` (which bypasses `$extends` — hence
  the explicit `"tenantId" = $1` in every raw statement above), but any
  non-raw access (upsert/read in specs, the ON CONFLICT seed if done via Client)
  MUST also be scoped, so it is registered too.

**Test seam (required isolation spec):** seed `StockAlertState` for T1, then under
T2 CLS context assert a repo query returns ZERO T1 rows; likewise a T2
`GET /notification-config` never observes T1 config rows.

### Inngest serve endpoint auth (finding #2, CRITICAL)

`JwtAuthGuard` is per-controller opt-in and there is **NO global `APP_GUARD`** in
`app.module.ts`. The `/api/inngest` controller is JWT-excluded, so its ONLY
protection is Inngest **signature verification** inside `serve()`. `serve()` MUST
reject unsigned requests outside dev. Therefore the signing key must be present
and validated. Add to the Joi `validationSchema` (`app.module.ts:44`), using the
existing `Joi.object({...})` shape (the schema currently has NO `NODE_ENV` entry).
`NODE_ENV` itself is made **`.required()`** — because every fail-closed conditional
below is keyed on it, a silent `.default('development')` would let an unset
`NODE_ENV` degrade a deployed environment to dev posture (unsigned `/api/inngest`,
PII dev-logger). Requiring it makes an unset value fail validation at boot:

```ts
NODE_ENV: Joi.string()
  .valid('development', 'test', 'staging', 'production')
  .required(),                 // NO silent default: an unset NODE_ENV must NOT
                               // resolve to 'development'. Every fail-closed item
                               // below keys on NODE_ENV, so a missing value would
                               // degrade a DEPLOYED env to dev posture (unsigned
                               // /api/inngest, PII dev-logger). Requiring it makes
                               // an unset env fail Joi at boot instead — fail-closed.
INNGEST_SIGNING_KEY: Joi.string().when('NODE_ENV', {
  is: Joi.valid('staging', 'production'),
  then: Joi.required(),        // fail-closed: app won't boot unsigned in prod/staging
  otherwise: Joi.optional(),   // dev uses the Inngest Dev Server
}),
INNGEST_EVENT_KEY: Joi.string().when('NODE_ENV', {
  is: Joi.valid('staging', 'production'),
  then: Joi.required(),
  otherwise: Joi.optional(),
}),
RESEND_API_KEY: Joi.string().when('NODE_ENV', {
  is: Joi.valid('production'),
  then: Joi.required(),        // finding #4: no dev-logger fallback in prod
  otherwise: Joi.optional(),
}),
```

## Data Model (schema.prisma additions)

```prisma
enum NotificationActionKey {
  LOW_STOCK            // only key shipped in v1; reserves space for future
}

model NotificationSettings {
  id        String   @id @default(uuid())
  tenantId  String   @unique
  enabled   Boolean  @default(false)          // master toggle; default OFF
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@map("notification_settings")
}

model NotificationRecipient {
  id       String @id @default(uuid())
  tenantId String
  userId   String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user     User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([tenantId, userId])
  @@index([tenantId])
  @@map("notification_recipients")
}

model NotificationAction {
  id       String                @id @default(uuid())
  tenantId String
  action   NotificationActionKey
  tenant   Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@unique([tenantId, action])
  @@index([tenantId])
  @@map("notification_actions")
}

model StockAlertState {
  id         String   @id @default(uuid())
  tenantId   String
  productId  String
  variantId  String?
  variantKey String                            // = variantId ?? '__PRODUCT__'
  alerted    Boolean  @default(false)
  alertEpoch Int      @default(0)
  alertedAt  DateTime?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  tenant     Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@unique([tenantId, productId, variantKey])  // NULL-safe uniqueness via sentinel
  @@index([tenantId])
  @@map("stock_alert_states")
}
```

**`variantKey` rationale**: Postgres treats multiple `NULL`s as distinct, so a
`@@unique([tenantId, productId, variantId])` would NOT enforce one row per
product-level item. A non-null `variantKey` (variantId or `'__PRODUCT__'`
sentinel) guarantees exactly one state row per item and makes `ON CONFLICT`
deterministic. Add matching back-relations on `Tenant`/`User`.

### Migration plan (⚠ pre-existing drift mitigation)

Confirmed drift: migration `20260527060716_add_employee_emergency_contacts` created
`employee_emergency_contacts.updatedAt NOT NULL`, but the current
`EmployeeEmergencyContact` model (schema L1392–1405) has NO `updatedAt`. A naive
`prisma migrate dev` will emit a `DROP COLUMN "updatedAt"` for that table.
**Mitigation** (pick one, do NOT ship the drop):
1. Preferred — add `updatedAt DateTime @updatedAt` back to the
   `EmployeeEmergencyContact` model so schema matches the live DB (no drop), then
   generate the low-stock migration cleanly; OR
2. Generate with `--create-only`, then hand-edit the SQL to DELETE the
   `ALTER TABLE employee_emergency_contacts DROP COLUMN "updatedAt"` line before
   applying.

The apply/tasks phase MUST assert the generated migration touches ONLY the five
new objects (`notification_settings`, `notification_recipients`,
`notification_actions`, `stock_alert_states`, `NotificationActionKey`) and never
`employee_emergency_contacts`.

**Note (finding #10):** the durable dispatch boundary REUSES the existing
`OutboxEvent` model / `outbox_events` table (`schema.prisma:852`) — NO new model
is introduced, so the object count stays at FIVE. Do not add an alerts-specific
outbox table.

## Module / File Structure

```
src/notification-config/
  domain/
    notification-config.repository.ts      # port + NOTIFICATION_CONFIG_REPOSITORY token
    notification-config.ts                 # aggregate view type
  infrastructure/
    prisma-notification-config.repository.ts
    prisma-notification-config.repository.spec.ts
  dto/
    update-notification-config.dto.ts      # enabled, recipientUserIds[], enabledActions[]
  notification-config.controller.ts        # GET/PUT /notification-config (+ .spec)
  notification-config.service.ts           # read/overwrite + unknown-key 400 (+ .spec)
  notification-config.module.ts

src/stock-alerts/
  domain/
    stock-alert-state.repository.ts         # port: flip + rearm + STOCK_ALERT_STATE_REPOSITORY
    stock-crossing.ts                       # StockCrossing + LowStockEventPayload types
  infrastructure/
    prisma-stock-alert-state.repository.ts  # ON CONFLICT + conditional flip (+ .spec)
  inngest/
    low-stock.functions.ts                  # createFunction(...) closures (+ .spec, fake client)
  outbox/
    low-stock-outbox.poller.ts              # @Interval claims ONLY eventType='stock.low.detected' PENDING rows (+ .spec)
    low-stock-outbox.dispatcher.ts          # AWAITS InngestService.send; marks PUBLISHED only on resolve, else PENDING for retry (+ .spec)
  stock-alerts.module.ts

src/inngest/
  inngest.service.ts                        # owns Inngest client + send() + registered functions
  inngest.controller.ts                     # @All('api/inngest') -> serve() (JWT-excluded)
  inngest.module.ts

src/notifications/email/
  mailer.port.ts                            # MAILER token + { send(to[], subject, html) }
  resend.mailer.ts                          # Resend adapter (prod-only dev logger fallback, redacted)
  templates/low-stock.email.tsx             # React Email template
```

Reuses `src/shared/outbox/*` `OutboxWriterService.publish(tx, ...)` for the in-tx
WRITE (unchanged — it is correct/atomic with the flip). It does NOT reuse the
generic `OutboxDispatcherService` for delivery: that dispatcher uses
`eventEmitter.emit()` (fire-and-forget — it does NOT await async `@OnEvent`
listeners) and marks the row `PUBLISHED` unconditionally, so a failed post-commit
send would be swallowed and the row never retried. This change adds a **dedicated,
isolated dispatch path** (`src/stock-alerts/outbox/*`) for `stock.low.detected`
ONLY — see "Durable dispatch flow" below. The shared dispatcher's behavior for all
other consumers is left untouched.

## Inngest + Resend Wiring

- **`InngestService`** (provider): constructs `new Inngest({ id, schemas, eventKey })`,
  exposes `send(name, data)` (the domain port called by the dedicated dispatcher) and
  `getFunctions()` returning the `createFunction(...)` closures built over injected
  `NotificationConfigRepository`, `MailerPort`, and `TenantRunnerService`.
- **`InngestController`** `@All('api/inngest')` delegates `(req, res)` to a memoized
  `serve({ client, functions, signingKey })` from `inngest/express`. Excluded from
  `JwtAuthGuard` (authenticated by Inngest signing key). Mounted normally through
  Nest so CLS middleware still wraps it.
- **Env** (`@nestjs/config`): `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — REQUIRED
  in staging/prod via the Joi conditionals above (fail-closed if missing). Local =
  Inngest Dev Server, both optional.
- **Durable dispatch flow (finding #10 — OUTBOX in-tx boundary).** When the flip
  wins (`count===1`) INSIDE the tx, the repo enriches the crossing with
  `productName`, `variantDescription`, `sku`, `category`, `deepLink` (a
  tenant-scoped read, bounded — only on a crossing) and calls
  `OutboxWriterService.publish(tx, tenantId, 'StockAlert', '<productId>:<variantKey>',
  'stock.low.detected', payload)` — the same tx as the decrement + flip. The flip
  and the outbox row are therefore ATOMIC: rollback discards BOTH (zero phantom
  events, satisfies the sales rollback scenario); commit makes the event durable.

  **Dedicated awaited dispatch (Approach A — isolated from the shared dispatcher).**
  The generic `OutboxDispatcherService` cannot deliver this event durably: it calls
  `eventEmitter.emit()` (does NOT await async `@OnEvent` listeners,
  `outbox-dispatcher.service.ts:19`) then marks the row `PUBLISHED` unconditionally
  (`:21-31`). A post-commit `InngestService.send` rejection would run detached from
  that `try/catch` and be swallowed — row `PUBLISHED`, alert lost. So this change
  routes `stock.low.detected` through a DEDICATED path and keeps the shared
  dispatcher's fire-and-forget semantics UNCHANGED for every other consumer:

  1. **Claim disjointness (one predicate on the generic poller).** The generic
     `OutboxPollerService.claimBatch` (`outbox-poller.service.ts:44-88`) selects all
     `status='PENDING'` rows with no `eventType` filter. Add a single exclusion
     predicate `AND "eventType" <> 'stock.low.detected'` to its claim query so it
     NEVER routes the dedicated type into the fire-and-forget dispatcher. This scopes
     what the generic poller CLAIMS; it does NOT change the generic dispatcher's
     marking behavior for any other event type.
  2. **Dedicated poller.** `LowStockOutboxPoller` (`@Interval`, same
     `FOR UPDATE SKIP LOCKED` + `lockedUntil`/`nextAttemptAt` mechanics as the
     generic poller) claims ONLY `status='PENDING' AND "eventType"='stock.low.detected'`.
     The two pollers therefore claim DISJOINT row sets — `SKIP LOCKED` plus the
     mutually-exclusive `eventType` predicates guarantee no double-processing.
  3. **Dedicated dispatcher (the awaited flip).** `LowStockOutboxDispatcher.dispatch`
     **`await`s** `InngestService.send(...)`. On resolve it marks the row `PUBLISHED`
     exactly once (`publishedAt = now`, `lockToken/lockedUntil = null`). On reject it
     mirrors the generic dispatcher's catch — increment `retryCount`, set `PENDING`
     (or `FAILED` at `maxRetries`), stamp `nextAttemptAt` for backoff, record
     `lastError`. Because the send is AWAITED, a post-commit failure actually lands
     in the catch and the row stays `PENDING` → the dedicated poller retries → the
     alert is NEVER lost. This removes the `EventEmitter` hop entirely for this type,
     which is exactly what makes the durability claim TRUE.
- **Idempotency wiring (finding #5).** The idempotency seed
  `${tenantId}:${productId}:${variantKey}:${alertEpoch}` is stored on the outbox
  payload and bound to the Inngest event `id` in the `send` call
  (`InngestService.send('stock/low.detected', { id: seed, data: payload })`), and
  the low-stock function declares `idempotency: 'event.data.idempotencyKey'`. So a
  poller REPLAY (row re-drained after a send that succeeded but failed to mark
  PUBLISHED) or an Inngest retry collapses to ONE email — Inngest dedupes by event
  `id`. **Test seam:** replay the same outbox row / re-deliver the same event `id`
  ⇒ mailer invoked exactly once.
- **Resend (finding #4 — no PII leak).** `MAILER` port; `ResendMailer` uses
  `RESEND_API_KEY` + `MAIL_FROM`. The dev logger fallback is **gated on
  `NODE_ENV !== 'production'`**: it logs the rendered HTML but **omits/redacts
  recipient addresses**. In production, a missing `RESEND_API_KEY` **fails fast**
  (guaranteed present by the Joi `required` conditional above) — the app never
  logs email bodies or silently swallows sends in prod. React Email renders
  `templates/low-stock.email.tsx`.

## CASL

- `permission.ts`: add `'NotificationConfig'` to `AppSubjects`; add registry rows
  `{ NotificationConfig, read }` and `{ NotificationConfig, update }`.
- `permission.seeder.ts` already upserts every `PERMISSION_REGISTRY` row
  idempotently by `subject_action` — no seeder code change needed beyond the two
  registry entries (satisfies "seeded idempotently" scenario).
- Grants ride on DB `RolePermission` rows (no hardcoded role); super admin covered
  by `manage:all`. Controller guards:
  `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` with
  `@RequirePermissions(['read','NotificationConfig'])` on GET and
  `(['update','NotificationConfig'])` on PUT — mirrors `SatCatalogController`.

## Env Vars

| Var | Dev | Staging/Prod |
|---|---|---|
| `INNGEST_SIGNING_KEY` | optional (Dev Server) | **required** (fail-closed; signs `/api/inngest`) |
| `INNGEST_EVENT_KEY` | optional | **required** |
| `RESEND_API_KEY` | optional (redacted dev logger) | **required in prod** (no fallback) |
| `MAIL_FROM` | optional | required in prod |
| `APP_WEB_URL` | optional | required in prod (deep-link base) |

All required-in-prod vars are enforced by the Joi `when('NODE_ENV', ...)`
conditionals in `app.module.ts` (see Security & Isolation).

## Test Strategy (spec scenario → test seam)

| Spec scenario | Seam |
|---|---|
| Crossing reported / already-alerted not re-reported / lots excluded | `prisma-stock-alert-state.repository.spec.ts` + repo spec against test DB; assert `StockCrossing[]` |
| Two concurrent sales → one alert (unit) | repo spec: two flips on same key, assert `count===1` then `count===0` |
| **Genuinely-concurrent two-tx (finding #11)** | integration spec against test DB: two real overlapping transactions decrement the same item; assert exactly one wins under READ COMMITTED (`count=0` on loser, NOT `P2034`) |
| **Tenant isolation on state (finding #1)** | isolation spec: seed `StockAlertState`/config for T1; under T2 CLS assert zero T1 rows via repo + `GET /notification-config` |
| **Raw decrement tenant guard (finding #3)** | repo spec: a cross-tenant `productId` cannot be decremented (raw WHERE carries `"tenantId"`) |
| **Non-stock skip preserved (finding #7)** | repo spec: `useStock=false` product ⇒ `continue`, no throw, no crossing |
| **PRE-gate no false fire (finding #8)** | repo spec: item created below min (`qty=2,min=3`) sale of 1 ⇒ no crossing; `qty=5→3` ⇒ crossing |
| **Re-arm strict `>` (finding #6)** | repo spec: restock-to-exactly-min does NOT re-arm; restock above min then sell re-fires once |
| **Durable outbox / lost-on-dispatch-failure (finding #10)** | repo spec: flip + `stock.low.detected` outbox row written in same tx; rollback ⇒ zero rows. Dedicated-dispatcher spec: `InngestService.send` REJECTS ⇒ row stays `PENDING`, `retryCount` incremented, `nextAttemptAt` bumped (dedicated poller retries, no lost alert); `send` RESOLVES ⇒ row marked `PUBLISHED` exactly once |
| **Generic dispatcher untouched** | poller spec: generic `claimBatch` never claims a `stock.low.detected` row (exclusion predicate); a non-alert PENDING row still flows through the fire-and-forget dispatcher unchanged |
| **Idempotent replay (finding #5)** | dedicated-dispatcher spec: re-drain same outbox row / re-deliver same Inngest event `id` ⇒ mailer invoked once |
| After-commit dispatch / rollback → zero events | `sales.service.spec.ts`: fake `InngestService`, assert `send` called AFTER `runInTransaction` resolves and never on reject (invocationCallOrder) |
| Coalescing / short-circuit / recipients | `low-stock.functions.spec.ts`: fake Inngest client + fake `MAILER` + fake config repo; assert mailer invoked once / never |
| Config read/update/403/400 | `notification-config.controller.spec.ts` + `.service.spec.ts` |
| Permission seeded idempotently | `permission.seeder` spec: run twice, one row each |
| Boundary `qty<=min` inclusive | repo spec parametrized on quantities |
| Prod fail-closed env (findings #2, #4) | app-bootstrap spec: `NODE_ENV=production` without `INNGEST_SIGNING_KEY`/`RESEND_API_KEY` ⇒ Joi validation throws |

Injectables: `SYSTEM_ACTOR_ID` const, `TenantRunnerService` (fakeable), fake
Inngest client, `MAILER` port, tenant-explicit test setup. No wall-clock needed
(counter epoch removes clock dependence).

## Risks / Tradeoffs

- **R-A** `$queryRaw` UPDATE RETURNING loses Prisma type-safety on that statement
  — mitigate with a typed row cast + focused repo spec.
- **R-B** `batchEvents` adds up to 60s latency before send — acceptable for a
  low-stock digest; documented default, per-action override later.
- **R-C** Enrichment read now happens IN-tx (only when a crossing wins the flip),
  so the outbox payload is self-contained. It is a bounded, tenant-scoped read
  that marginally lengthens the tx only on genuine crossings — acceptable, and it
  is what makes the outbox row durable + rollback-safe.
- **R-D** Migration drift on `employee_emergency_contacts` — mitigated above;
  MUST be verified in tasks/apply. Object count stays FIVE (outbox reused).
- **R-E** Durability is guaranteed by a DEDICATED dispatch path, not the generic
  fire-and-forget dispatcher. The generic `OutboxDispatcherService` `emit`s without
  awaiting and marks `PUBLISHED` unconditionally, so it CANNOT deliver this event
  durably. `stock.low.detected` is instead claimed by `LowStockOutboxPoller` and
  delivered by `LowStockOutboxDispatcher`, which **`await`s** `InngestService.send`
  and marks the row `PUBLISHED` ONLY on resolve; on failure the row stays `PENDING`
  and the dedicated poller retries with backoff (no lost alert). Idempotency via the
  Inngest event `id` (the `${tenantId}:${productId}:${variantKey}:${alertEpoch}`
  seed) makes a poller replay collapse to exactly one email. The generic poller
  excludes this `eventType` (one claim predicate); the generic dispatcher is
  untouched.
- **R-F** Greenfield surface > 400-line budget — tasks phase slices into chained
  work units (schema+migration+tenant-model registration / notification-config+CASL /
  Inngest+serve+Joi-env / StockAlertState+decrement/re-arm raw rewrite /
  email+coalescing / outbox-dispatch glue+tests).

## Tech Debt / Out-of-Scope

- **Shared `OutboxDispatcherService` fire-and-forget (PRE-EXISTING systemic risk —
  NOT fixed here).** `outbox-dispatcher.service.ts:17-31` emits via
  `eventEmitter.emit()` (async `@OnEvent` listeners run detached, un-awaited) and
  marks the row `PUBLISHED` unconditionally. Any EXISTING async consumer of the
  generic dispatcher whose listener throws AFTER the emit has its failure swallowed
  with the row already `PUBLISHED` — a latent lost-message risk for the whole
  outbox. This change deliberately does NOT touch that behavior; it isolates
  `stock.low.detected` onto a dedicated awaited path instead. The systemic fix
  (make the generic dispatcher await handlers, or move all consumers to
  awaited-dispatch) is flagged for a SEPARATE investigation and is OUT OF SCOPE for
  low-stock-alerts.

## Open Questions

- None blocking. `MAIL_FROM` verified sender domain is an apply-time input (dev
  fallback covers verify).
