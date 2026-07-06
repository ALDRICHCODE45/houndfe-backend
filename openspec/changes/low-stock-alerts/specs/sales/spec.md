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

### Requirement: Sales Orchestrator Dispatches Low-Stock Alerts Only After Commit

The sales orchestrator MUST buffer crossings during the `runInTransaction`
body and MUST emit `stock/low.detected` events strictly AFTER `runInTransaction`
resolves. The dispatch MUST NOT happen before commit; the dispatch MUST NOT
happen inside the open transaction. Each event payload MUST include
`tenantId`, `productId`, `variantId | null`, `productName`, `variantDescription | null`,
`newQuantity`, `minQuantity`, `sku`, `category`, `deepLink`, and `occurredAt`.

#### Scenario: Successful commit dispatches one event per crossing
- GIVEN a sale that decrements P and V1, both crossing `<= minQuantity`
- WHEN `runInTransaction` resolves successfully
- THEN the orchestrator emits exactly two `stock/low.detected` events
- AND each event payload contains `tenantId`, `productId`/`variantId`, `newQuantity`, `minQuantity`, `sku`, `category`, `deepLink`, and `occurredAt`
- AND the events are delivered to `InngestService.send` AFTER the commit (no in-tx network call)

#### Scenario: Rollback produces zero dispatches
- GIVEN a sale tx that crosses P and V1, then a downstream step throws
- WHEN `runInTransaction` rejects
- THEN the orchestrator's catch path does NOT call `InngestService.send`
- AND zero `stock/low.detected` events exist for this sale

#### Scenario: No crossings → no dispatch
- GIVEN a sale that decrements only items staying above their `minQuantity`
- WHEN `runInTransaction` resolves successfully
- THEN the orchestrator emits zero `stock/low.detected` events
- AND no Inngest invocation is enqueued

#### Scenario: Tenant id always in payload
- GIVEN any crossing dispatched by the sales orchestrator
- WHEN the event is sent to Inngest
- THEN the event payload's `tenantId` matches the sale's tenant
- AND no Inngest handler body relies on CLS to resolve tenant context