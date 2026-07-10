# Stock Alerts Specification

## Purpose

Define edge-triggered low-stock detection, the `StockAlertState` re-arm
machine, the durable outbox-based dispatch into Inngest, and the coalesced
Resend email send. Owns the one-shot guarantee on downward crossing,
re-arm on restock above `minQuantity`, and the durable post-commit dispatch
that survives post-commit send failures via the dedicated outbox path.

## Requirements

### Requirement: One-Shot Edge Trigger At Or Below Min Quantity

The system MUST fire exactly one alert on transition from `quantity > minQuantity`
to `quantity <= minQuantity`. `hasVariants=false` tracks at product level; products
with variants track per variant. Lots/expiration items MUST be excluded. Re-arm
MUST occur only after quantity returns strictly above `minQuantity`.

Re-arm applies to BOTH the restock path AND the direct product/variant edit
path (`update` / `updateVariant`) whenever the resulting `quantity > minQuantity`
STRICTLY. On the edit path the write and the re-arm MUST commit atomically in
the same transaction, MUST share the caller's `tenantId`, MUST use the correct
simple-vs-variant key (`variantId` for variant rows, `'__PRODUCT__'` for
simple-product rows), and MUST NEVER call `seedAndFlip`. Edits MUST NOT re-arm
when the resulting `quantity <= minQuantity`, MUST NOT seed a `StockAlertState`
row, and MUST NOT run alert logic for non-stock products (`useStock = false`).
The STRICT `>` boundary, the ambient-transaction guard, and the tenant scope are
shared with the restock contract and SHALL NOT diverge.

#### Scenario: First crossing fires one alert
- GIVEN P (`hasVariants=false`, `qty=10`, `min=3`, no prior alert)
- WHEN a sale drops P to `qty=3`
- THEN ONE `stock/low.detected` event emits for P
- AND `StockAlertState(tenantId, P, null).alerted=true`

#### Scenario: Variant path tracks per variant
- GIVEN V1 (`qty=10/min=3`) and V2 (`qty=5/min=2`) on P
- WHEN a sale drops V1 to `qty=3` and V2 to `qty=2`
- THEN two events emit (one per variant); both rows `alerted=true`

#### Scenario: Subsequent sale while low does NOT re-fire
- GIVEN P `alerted=true`, `qty=3`, `min=3`
- WHEN a sale drops P to `qty=1`
- THEN no new event emits and `alerted` stays `true`

#### Scenario: Restock re-arms; later drop re-fires
- GIVEN P `alerted=true`, `qty=3`, `min=3`
- WHEN restock lifts P to `qty=10` then a later sale drops P to `qty=3`
- THEN `alerted` toggles `false` then `true`
- AND exactly ONE new event emits on the second drop

#### Scenario: Boundary inclusive at minQuantity
- GIVEN P at `qty=4`, `min=3`, armed
- WHEN a sale drops P to `qty=3`
- THEN one alert fires (`3 <= 3` inclusive)

#### Scenario: Lots/expiration products excluded
- GIVEN P with `useLotsAndExpirations=true` crossing
- WHEN the sale tx completes
- THEN no event emits and no `StockAlertState` row is written

#### Scenario: Edit raises simple product above min → rearm → later drop re-fires
- GIVEN a simple product P (`hasVariants=false`) with
  `StockAlertState(tenantId, P, null).alerted=true`, `quantity=3`,
  `minQuantity=3`
- WHEN `update(id, { quantity: 10 })` runs
- THEN `StockAlertState(tenantId, P, null).alerted` becomes `false`
- AND a later sale dropping P to `quantity=3` emits ONE new
  `stock/low.detected` event for P and flips `alerted` back to `true`

#### Scenario: Edit raises variant above min → rearm with variantId key
- GIVEN a variant V1 on P with
  `StockAlertState(tenantId, P, V1.id).alerted=true`, `quantity=3`,
  `minQuantity=3`
- WHEN `updateVariant(productId, V1.id, { quantity: 10 })` runs
- THEN `StockAlertState(tenantId, P, V1.id).alerted` becomes `false`
  (keyed by `variantId`, NOT by `'__PRODUCT__'`)
- AND a later sale dropping V1 to `quantity=3` emits ONE new event
  scoped to V1

#### Scenario: Edit lowers minQuantity only → rearm fires
- GIVEN a simple product P with `alerted=true`, `quantity=5`,
  `minQuantity=5`
- WHEN `update(id, { quantity: 5, minQuantity: 3 })` runs (quantity
  unchanged, `minQuantity` lowered)
- THEN `StockAlertState(tenantId, P, null).alerted` becomes `false`
  because the resulting `5 > 3` holds; the decision depends on the
  RESULTING pair, not on which field was edited

#### Scenario: Edit leaves stock == min → NO rearm (STRICT > boundary)
- GIVEN a simple product P with `alerted=true`, `quantity=5`,
  `minQuantity=3`
- WHEN `update(id, { quantity: 3 })` runs (resulting `stock == min`)
- THEN `StockAlertState(tenantId, P, null).alerted` stays `true`
  (STRICT `>` — equality does NOT rearm)

#### Scenario: Manual downward edit lands stock <= min → no seedAndFlip, no event
- GIVEN a simple product P with `quantity=10`, `minQuantity=3`, no
  pre-existing `StockAlertState` row
- WHEN `update(id, { quantity: 2 })` runs (manual downward edit lands
  `2 <= 3`)
- THEN `seedAndFlip` is NEVER called
- AND no `stock/low.detected` event is written to the outbox
- AND no `StockAlertState` row is seeded for P (edits MUST NOT seed)

#### Scenario: No pre-existing alert-state row → rearm is a harmless no-op
- GIVEN a simple product P with no `StockAlertState` row (never
  alerted) and `minQuantity=3`
- WHEN `update(id, { quantity: 10 })` runs (resulting `10 > 3`)
- THEN the rearm `UPDATE` matches 0 rows and does not throw
- AND no `StockAlertState` row is created as a side effect of the edit

#### Scenario: Ambient-tx guard throws outside runInTransaction; service wraps it
- GIVEN the rearm-bearing repository method
- WHEN it is called outside `tenantPrisma.runInTransaction(...)` (i.e.
  `isInTransaction()` returns `false`)
- THEN the method throws (mirroring the restock guard)
- AND `ProductsService` always wraps persistence + rearm in a single
  `runInTransaction` so write and rearm commit atomically; a partial
  commit is impossible

#### Scenario: useStock = false → no alert logic runs, no error
- GIVEN a product P with `useStock=false` and `minQuantity=0`
- WHEN `update(id, { quantity: 5, useStock: false })` runs
- THEN no alert state machine code path runs on the edit (no rearm, no
  `seedAndFlip`)
- AND no error is thrown

### Requirement: After-Commit Dispatch With No Phantom Alerts

`stock/low.detected` MUST be persisted in the EXISTING `OutboxEvent` table
INSIDE the transaction that performs the decrement + atomic flip, and MUST be
delivered by the dedicated `LowStockOutboxPoller` / `LowStockOutboxDispatcher`
STRICTLY AFTER the transaction commits. On rollback, NO `OutboxEvent` row
survives (in-tx write is discarded with the tx), NO event is delivered, and
NO Inngest invocation is enqueued.

#### Scenario: Commit writes durable outbox rows that the dedicated dispatcher drains
- GIVEN a sale crossing P and V1 in-tx and both winning the flip
- WHEN `runInTransaction` resolves
- THEN two PENDING `OutboxEvent` rows of `eventType='stock.low.detected'` exist
- AND the generic `OutboxPollerService` does NOT claim those rows (disjoint claim)
- AND the dedicated poller + dispatcher deliver exactly two `stock/low.detected` events to `InngestService.send`

#### Scenario: Rollback produces zero events and zero outbox rows
- GIVEN a sale crossing P and V1 in-tx, then a downstream throw
- WHEN `runInTransaction` rejects
- THEN zero `OutboxEvent` rows of `eventType='stock.low.detected'` survive
- AND `LowStockOutboxDispatcher` is never invoked
- AND `InngestService.send` is never called

#### Scenario: No in-tx network call
- GIVEN a successful tx crossing P
- WHEN the dedicated dispatcher runs
- THEN the `InngestService.send` call happens strictly AFTER `runInTransaction` resolves

### Requirement: Concurrent Crossings Collapse To One Alert

Two concurrent sales dropping the same item from above `minQuantity` to
`<= minQuantity` MUST produce exactly ONE alert. Atomicity MUST come from a
conditional `updateMany` on `StockAlertState` in the same transaction; the
`count === 1` row wins.

#### Scenario: Two concurrent sales, one item, one alert
- GIVEN P at `qty=10`, `min=3`, no `StockAlertState` row
- WHEN two sales concurrently drop P each by 5
- THEN one transaction sees `count === 1` and emits the event
- AND the other sees `count === 0` and emits nothing

### Requirement: Coalesced Email For Near-Simultaneous Crossings

Distinct crossings within the same batching window MUST be grouped into ONE
email per tenant. A single crossing still produces ONE email. Coalescing MUST
NOT re-send an item already alerted in that window.

#### Scenario: Two distinct crossings produce one email
- GIVEN T with notifications enabled, recipient `u@t`
- WHEN P and V1 cross `<= minQuantity` within the batching window
- THEN ONE email is sent to `u@t` listing BOTH; mailer invoked once

#### Scenario: Already-alerted item not re-sent in same window
- GIVEN P `alerted=true` from a prior crossing; V1 crosses within that window
- WHEN the next coalesced email composes
- THEN V1 is included and P is NOT re-listed

### Requirement: Email Content Contains Full Item Context

The email MUST contain per item: product name, variant description (when
applicable), current quantity, `minQuantity`, SKU/code, category, and a deep
link to the product detail page.

#### Scenario: Required fields present per item
- GIVEN P "Aspirina", SKU `7501`, category "Analgésicos", variant V1 "Caja 20"
- WHEN the email renders for P and V1
- THEN body includes "Aspirina", "Caja 20", current qty, `minQuantity`, `7501`, "Analgésicos", deep link

### Requirement: Recipients Are Active Users From The Tenant List

Recipients MUST resolve from `NotificationRecipient` rows: each `User.email`,
filter `isActive=true`, dedupe.

#### Scenario: Active users with emails become recipients
- GIVEN T recipients for `u1` (active, `u1@t`) and `u2` (active, `u2@t`)
- WHEN recipients resolve
- THEN email is sent to `["u1@t","u2@t"]`

#### Scenario: Inactive excluded; duplicates deduped
- GIVEN `u1` (active, `u1@t`), `u2` (`isActive=false`), duplicate row for `u1`
- WHEN recipients resolve
- THEN only `u1@t` receives the email (once)

### Requirement: Disabled Configuration Short-Circuits The Send

If `NotificationSettings.enabled=false`, `LOW_STOCK` missing from
`enabledActions`, OR `NotificationRecipient` is empty, the Inngest function
MUST short-circuit: no mailer call, no Resend call.

#### Scenario: Master OFF or action OFF short-circuits
- GIVEN T with `enabled=false` (or `enabled=true` with `enabledActions:[]`)
- WHEN a T crossing emits
- THEN the function exits at load-config and no mailer call occurs

#### Scenario: Empty recipients short-circuit
- GIVEN T with `enabled=true`, `LOW_STOCK` enabled, recipients `[]`
- WHEN a T crossing emits
- THEN the function exits at load-config and no email sends

### Requirement: Tenant Isolation For Alerts And Sends

`StockAlertState`, event payloads, and resolved recipients MUST be strictly
scoped to the payload's `tenantId`. Handlers MUST NOT read state for any other
tenant.

#### Scenario: Tenant id required in every payload
- GIVEN an Inngest event for a crossing
- WHEN the handler begins
- THEN the handler uses ONLY the payload's `tenantId` and does NOT call `getTenantId()` from CLS

#### Scenario: Cross-tenant state lookup impossible
- GIVEN T1 with `StockAlertState(alerted=true)` for P
- WHEN an event for T2 referencing the same product id is processed
- THEN T2's flow does not observe T1's state and no send occurs for T1's recipients

## Verification Surface

- `src/stock-alerts/infrastructure/prisma-stock-alert-state.repository.spec.ts`
- `src/stock-alerts/infrastructure/prisma-user-email-lookup.repository.spec.ts`
- `src/stock-alerts/inngest/low-stock.functions.spec.ts`
- `src/stock-alerts/outbox/low-stock-outbox.poller.spec.ts`
- `src/stock-alerts/outbox/low-stock-outbox.dispatcher.spec.ts`
- `src/shared/outbox/outbox-poller.service.spec.ts` (disjoint claim predicate)
- `src/shared/prisma/tenant-isolation.spec.ts` (cross-tenant isolation)
- `prisma/prisma-stock-alert-state.repository.integration.spec.ts`
- `prisma/e4-concurrent-stock-alert.spec.ts` (real-DB concurrent collapse)