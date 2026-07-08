# Sales Specification

## Purpose

Define sale lifecycle, domain rules, reporting semantics, and API surfaces for the sales domain. Canceled sales are first-class queryable entities, excluded from CONFIRMED-scoped reporting and KPI/revenue queries, but available when explicitly filtered.

## Requirements

### Requirement: Bot Sale Registration

The system MUST confirm bot-created sales through `SalesService.confirmBotSale()` when `registerBotSale` is called, and it MUST apply the full sale contract: shared folio allocation, stock decrement, price validation, seller assignment, and credit `dueDate` assignment (`confirmedAt` + 15 days).
(Previously: `registerBotSale` wrote the sale directly with Prisma and skipped domain invariants.)

#### Scenario: Successful bot sale applies all invariants
- GIVEN a validated bot cart with items, customer, and cashier/seller identity
- WHEN `registerBotSale` creates the sale through the sales domain
- THEN the sale is confirmed as `ONLINE` and `CREDIT`
- AND a shared POS folio is assigned
- AND stock is decremented for each item
- AND `sellerUserId` is assigned
- AND `dueDate` is set to `confirmedAt` plus 15 days

#### Scenario: Price mismatch is rejected before persistence
- GIVEN at least one submitted item price differs from the authoritative sale price
- WHEN `SalesService.confirmBotSale()` validates the cart
- THEN the sale is rejected
- AND no folio is consumed
- AND no stock is decremented
- AND no outbox event is written

#### Scenario: Credit sale keeps the default due date rule
- GIVEN a bot-created sale is confirmed as credit
- WHEN the sale is persisted
- THEN the stored `dueDate` is present
- AND it equals the confirmation time plus 15 days

### Requirement: Bot Sale Event Emission

The system MUST emit exactly one `sale.confirmed` outbox event for a successful bot sale, and the payload MUST be a plain object. The system MUST NOT emit `sale.payment.received` or `sale.fully.paid` at creation time.
(Previously: bot sales emitted no domain/outbox events.)

#### Scenario: sale.confirmed is written with a plain JSON payload
- GIVEN a bot sale is confirmed successfully
- WHEN the outbox event is written
- THEN the event type is `sale.confirmed`
- AND the payload includes `saleId`, `folio`, `tenantId`, `actorId`, `totalCents`, `paidCents`, `debtCents`, `paymentStatus`, and `confirmedAt`
- AND the payload is a plain object suitable for JSON storage

#### Scenario: No payment events are emitted at creation
- GIVEN a bot sale is confirmed with zero payments
- WHEN the sale completion events are published
- THEN `sale.payment.received` is not emitted
- AND `sale.fully.paid` is not emitted

### Requirement: Bot Sale Idempotency

The system MUST keep idempotency ownership in `ChatbotApiService`, and a repeated `registerBotSale` request with the same idempotency key MUST return the cached result without re-confirming the sale.
(Previously: idempotency was already present in the chatbot path and must remain unchanged.)

#### Scenario: Duplicate request replays safely
- GIVEN a prior `registerBotSale` call already succeeded for the same idempotency key
- WHEN the bot retries the same request
- THEN the cached response is returned
- AND `SalesService.confirmBotSale()` is not called again
- AND no duplicate stock, folio, or event side effects occur

#### Scenario: First successful replay stays stable
- GIVEN the original bot sale succeeded
- WHEN the same request is replayed again later
- THEN the original sale id and response values are returned
- AND the sale is not duplicated

### Requirement: Canceled Sales Remain Queryable But Are Excluded From CONFIRMED Reporting

The system MUST exclude CANCELED sales from KPI, revenue, and other CONFIRMED-scoped listing queries. The system MUST still return CANCELED sales when a caller explicitly filters by CANCELED status.

#### Scenario: Confirmed reporting excludes canceled sales
- GIVEN sales include both CONFIRMED and CANCELED records
- WHEN KPI or revenue queries run
- THEN CANCELED sales are excluded

#### Scenario: Listing by CANCELED returns canceled sales
- GIVEN canceled sales exist for the tenant
- WHEN a list request filters by CANCELED status
- THEN the response includes the canceled sales
- AND it does not drop CANCELED from the filter

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

## Verification Surface

- `src/sales/sales.service.spec.ts`
- `src/chatbot-api/application/chatbot-api.service.spec.ts`
- `src/products/infrastructure/prisma-product.repository.spec.ts` (decrement return shape + PRE-gate + re-arm + outbox-in-tx)
- `src/products/products.service.spec.ts` (wrapper return)
- `src/stock-alerts/outbox/low-stock-outbox.poller.spec.ts` (disjoint claim)
- `src/stock-alerts/outbox/low-stock-outbox.dispatcher.spec.ts` (await + retry + FAILED exit + missing-tenantId branch)
- `src/shared/outbox/outbox-poller.service.spec.ts` (exclusion predicate)
- `prisma/e4-concurrent-stock-alert.spec.ts` (real-DB concurrent collapse)
- `src/shared/prisma/tenant-isolation.spec.ts` (cross-tenant isolation)