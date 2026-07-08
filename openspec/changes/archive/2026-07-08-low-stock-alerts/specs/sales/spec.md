# Delta for sales

> This spec MODIFIES the existing `sales` capability. The two changed
> requirements below replace the corresponding requirement blocks in
> `openspec/specs/sales/spec.md` at archive time.

## MODIFIED Requirements

### Requirement: Stock Decrement Returns Threshold Crossings

The system MUST return, from `decrementStockForCharge`, the set of items whose
post-decrement quantity is `<= minQuantity` for the first time within the
current charge. The return shape MUST be
`Array<{ productId: string; variantId: string | null; newQuantity: number; minQuantity: number }>`
(one entry per item that crossed downward into the alert band for the first
time in this transaction). Items that were already alerted prior to this
transaction, items whose `useLotsAndExpirations=true`, and items that did not
cross downward MUST NOT appear in the returned array.
(Previously: `decrementStockForCharge` returned `Promise<void>`.)

#### Scenario: Crossing is reported in the return value
- GIVEN product P (`hasVariants=false`, `minQuantity=3`) at `quantity=5` with no prior alert state
- WHEN `decrementStockForCharge([{ productId: P, quantity: 2 }])` runs in a transaction
- THEN the returned array contains exactly `{ productId: P, variantId: null, newQuantity: 3, minQuantity: 3 }`
- AND the returned array does NOT contain any item whose `newQuantity > minQuantity`

#### Scenario: Already-alerted item is not re-reported
- GIVEN P with `StockAlertState.alerted=true`, `quantity=3`, `minQuantity=3`
- WHEN `decrementStockForCharge([{ productId: P, quantity: 2 }])` runs
- THEN the returned array does NOT contain P (no new crossing; still low, already alerted)

#### Scenario: Variant and product paths both report
- GIVEN V1 (`quantity=5/minQuantity=3`) and P (`quantity=5/minQuantity=3`, `hasVariants=false`, no alert state) in the same call
- WHEN `decrementStockForCharge([{ productId: P1, variantId: V1, quantity: 2 }, { productId: P2, quantity: 2 }])` runs
- THEN the returned array contains two entries: one for V1 with `newQuantity=3`, one for P2 with `newQuantity=3`

#### Scenario: Lots/expiration products excluded from return value
- GIVEN P with `useLotsAndExpirations=true` and a crossing in this transaction
- WHEN `decrementStockForCharge([{ productId: P, quantity: 2 }])` runs
- THEN the returned array does NOT contain P

#### Scenario: Stock-guard failure semantics unchanged
- GIVEN insufficient stock for an item in the adjustments array
- WHEN `decrementStockForCharge` runs
- THEN it throws `STOCK_INSUFFICIENT_AT_CONFIRM`
- AND the transaction is rolled back
- AND no entries are returned (the returned value is observable only on commit)

### Requirement: Sales Orchestrator Dispatches Low-Stock Alerts Via Durable Outbox

The sales decrement path MUST persist `stock.low.detected` events as
PENDING rows in the EXISTING `OutboxEvent` table via `OutboxWriterService.publish`
INSIDE the same transaction as the decrement and the `StockAlertState` atomic
flip (the durable in-tx boundary). The shared generic `OutboxDispatcherService`
MUST NOT claim these rows — it is fire-and-forget and marks rows `PUBLISHED`
unconditionally, so it CANNOT deliver this event durably. A dedicated
`LowStockOutboxPoller` claims ONLY `eventType='stock.low.detected'` PENDING
rows (disjoint from the generic poller's claim set via a single exclusion
predicate `AND "eventType" <> 'stock.low.detected'` on the generic poller),
and a dedicated `LowStockOutboxDispatcher` AWAITs `InngestService.send` and
marks the row `PUBLISHED` only on resolve (on reject it stays `PENDING`,
bumps `retryCount`, stamps `nextAttemptAt` for backoff, and records
`lastError` — the dedicated poller retries; the alert is never lost).
On transaction rollback, the outbox row is discarded with the tx and
zero events ever exist. On transaction commit, the event becomes durable
and is delivered by the dedicated dispatch path. Each event payload MUST
include `tenantId`, `productId`, `variantId | null`, `productName`,
`variantDescription | null`, `newQuantity`, `minQuantity`, `sku`, `category`,
`deepLink`, and `occurredAt`.

#### Scenario: Successful commit dispatches one event per crossing through the dedicated outbox path
- GIVEN a sale that decrements P and V1, both crossing `<= minQuantity` and both winning the `StockAlertState` flip
- WHEN `runInTransaction` resolves successfully
- THEN two PENDING `OutboxEvent` rows of `eventType='stock.low.detected'` exist for this sale
- AND the generic `OutboxPollerService` does NOT claim those rows (disjoint claim set)
- AND the dedicated `LowStockOutboxPoller` claims them and `LowStockOutboxDispatcher` calls `InngestService.send` exactly twice (one per crossing), AWAITING each call
- AND on resolve the dispatcher marks each row `PUBLISHED` exactly once
- AND no Inngest `send` call happens while the transaction is open

#### Scenario: Rollback produces zero dispatches and zero outbox rows
- GIVEN a sale tx that crosses P and V1, then a downstream step throws
- WHEN `runInTransaction` rejects
- THEN no `OutboxEvent` rows of `eventType='stock.low.detected'` survive (the in-tx write is rolled back with the tx)
- AND `LowStockOutboxDispatcher` is never invoked
- AND `InngestService.send` is never called

#### Scenario: No crossings → no outbox rows, no dispatch
- GIVEN a sale that decrements only items staying above their `minQuantity`
- WHEN `runInTransaction` resolves successfully
- THEN zero `OutboxEvent` rows of `eventType='stock.low.detected'` are written
- AND `LowStockOutboxDispatcher` is never invoked and no Inngest invocation is enqueued

#### Scenario: Post-commit send failure keeps the row retryable, not lost
- GIVEN a committed sale with a PENDING `stock.low.detected` outbox row claimed by the dedicated poller
- WHEN `InngestService.send` REJECTS during dispatch
- THEN the dispatcher leaves the row `PENDING`, increments `retryCount`, stamps `nextAttemptAt` for backoff, and records `lastError`
- AND the dedicated poller re-claims the row on the next tick (no lost alert, no silent success)

#### Scenario: Tenant id always in payload
- GIVEN any crossing dispatched by the sales orchestrator
- WHEN the event is sent to Inngest
- THEN the event payload's `tenantId` matches the sale's tenant
- AND no Inngest handler body relies on CLS to resolve tenant context