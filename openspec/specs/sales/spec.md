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

### Requirement: Draft Mutations Trigger Recompute

The system MUST trigger a recompute of all eligible AUTOMATIC promotions on every draft mutation that can change eligibility or totals: `addItem`, `updateItemQuantity`, `removeItem`, `assignCustomer`, `overrideItemPrice`, `applyItemDiscount` (manual), and `removeItemDiscount` (manual). The recompute MUST run inside the same call as the mutation (no async, no deferred job). The recompute MUST be idempotent: running it twice in a row with no state change MUST yield the same applied list and totals.

#### Scenario: addItem triggers recompute
- GIVEN an open draft with one line and an eligible AUTOMATIC `PRODUCT_DISCOUNT` (10%)
- WHEN `addItem` adds a new matching line
- THEN the response totals reflect the promo applied to BOTH lines

#### Scenario: updateItemQuantity triggers recompute
- GIVEN a line priced at 1000c, qty=1, and an AUTOMATIC 10% `PRODUCT_DISCOUNT`
- WHEN `updateItemQuantity` changes qty to 3
- THEN the line-level discount and totals reflect 10% on the new qty

#### Scenario: assignCustomer triggers recompute
- GIVEN a draft with no customer, with both ALL-scope and REGISTERED_ONLY-scope promotions eligible
- WHEN `assignCustomer` is called
- THEN the REGISTERED_ONLY-scope promo (if best-wins) is now applied to the recomputed totals

#### Scenario: removeItem triggers recompute
- GIVEN a draft with two lines and an `ORDER_DISCOUNT` min-purchase gate that depended on both lines' subtotal
- WHEN `removeItem` removes one line
- THEN the recompute re-evaluates the `ORDER_DISCOUNT` gate against the new subtotal

#### Scenario: Recompute is idempotent
- GIVEN a draft in any state
- WHEN two recomputes run back-to-back with no mutations between
- THEN the applied list and totals are identical

### Requirement: chargeDraft Totals Consistent With getSaleDetail

The system MUST compute `chargeDraft` totals from the current item state (post-recompute) such that the totals persisted on confirmation equal the totals returned by `getSaleDetail` immediately before charge. Any recompute MUST run before `chargeDraft` validates totals so the charged amount reflects the current applied promotions.

#### Scenario: chargeDraft totals match getSaleDetail
- GIVEN a draft with one line priced at 1000c, qty=1, and an eligible AUTOMATIC `PRODUCT_DISCOUNT` 10%
- WHEN `getSaleDetail` is called and then `chargeDraft` runs immediately
- THEN the persisted sale's totals equal the `getSaleDetail` totals (line discount 100c, subtotal 1000c, total 900c)

#### Scenario: Recompute before chargeDraft picks up new state
- GIVEN a draft with a line priced at 1000c, qty=1, and an eligible AUTOMATIC `PRODUCT_DISCOUNT` 10% applied
- WHEN the seller updates the line qty to 3 and then calls `chargeDraft`
- THEN the charged totals reflect the recomputed state (10% applied to the new qty)

### Requirement: Price-List Override Re-Runs Recompute Without Wiping Promo Discounts

The system MUST, on `overrideItemPrice`, re-run the recompute for the affected line and MUST NOT clear that line's existing promotion-driven discount fields. If an automatic promotion still best-wins on the new effective price, the line retains the promotion-driven discount on top of the new price. A seller manual free-form discount is removed only by an explicit `removeItemDiscount` call, NOT by `overrideItemPrice`.

#### Scenario: Price-list override re-applies auto-promo on the new price
- GIVEN a draft with one line, no current discount, default price 1000c, and an AUTOMATIC 10% `PRODUCT_DISCOUNT` on that product
- WHEN `overrideItemPrice` sets the line's price-list price to 2000c
- THEN the recompute runs and the line ends at 1800c (10% off 2000c)

#### Scenario: Price-list override preserves an already-applied auto-promo on the new price
- GIVEN a draft with one line priced at 1000c with an applied AUTOMATIC 10% `PRODUCT_DISCOUNT` (unit = 900c)
- WHEN `overrideItemPrice` changes the line to a new price-list price of 2000c
- THEN the recompute runs and the line ends at 1800c (10% off the new 2000c) — NOT at 2000c

#### Scenario: Price-list override does NOT clear a manual free-form discount
- GIVEN a draft with one line and a seller manual 100c discount applied (unit = 900c from a 1000c baseline)
- WHEN `overrideItemPrice` sets the line's price-list price to 2000c
- THEN the manual 100c discount is preserved (the operator must call `removeItemDiscount` explicitly to clear it)

### Requirement: Manual Apply And Remove Endpoints For MANUAL Promotions

The system MUST expose endpoints to list applicable MANUAL promotions for a draft, apply a MANUAL promotion (records it on the draft so future recomputes include it), and remove a MANUAL promotion. The apply/remove actions update the per-draft applied-promotion set; they MUST NOT mutate the promotion catalog.

#### Scenario: List applicable MANUAL promotions
- GIVEN a draft with two lines, each matching a different MANUAL `PRODUCT_DISCOUNT` (10% and 20%)
- WHEN the seller requests the list of applicable MANUAL promotions
- THEN the response includes both promotions with their computed per-line discount values

#### Scenario: Apply MANUAL promotion
- GIVEN a draft with one line and one eligible MANUAL `PRODUCT_DISCOUNT` P-M (10%)
- WHEN the seller applies P-M
- THEN the line ends at 90% of its baseline and subsequent recomputes keep P-M applied (subject to eligibility re-evaluation)

#### Scenario: Remove MANUAL promotion
- GIVEN P-M applied on the draft
- WHEN the seller removes P-M
- THEN the line returns to its baseline (no discount) and the P-M record is no longer on the draft

### Requirement: Remove Endpoint For AUTOMATIC Promotions Feeds The Veto Set

The system MUST expose an endpoint to remove an auto-applied AUTOMATIC promotion from a draft. Calling that endpoint MUST add the promotion's id to the draft's veto set so subsequent recomputes do not re-apply it. The endpoint MUST NOT mutate the promotion catalog.

#### Scenario: Removing an auto-applied AUTOMATIC promo adds to veto set
- GIVEN a draft with one line, an eligible AUTOMATIC `PRODUCT_DISCOUNT` P-A (10%) auto-applied
- WHEN the seller calls the remove endpoint for P-A
- THEN P-A is no longer applied, P-A is in the draft's veto set, and a subsequent recompute does NOT re-apply P-A

#### Scenario: Removing an auto-applied AUTOMATIC promo does NOT mutate the catalog
- GIVEN a draft with an auto-applied AUTOMATIC promo P-A
- WHEN the seller calls the remove endpoint for P-A
- THEN `Promotion.status`, `Promotion.method`, and any other catalog fields on P-A are unchanged

## Verification Surface

- `src/sales/sales.service.spec.ts` (draft recompute triggers + charge totals + manual endpoints + veto set)
- `src/sales/sales.controller.spec.ts` (list-applicable, apply-manual, remove-manual, remove-applied routes)
- `src/sales/domain/sale.entity.spec.ts` (previewTotals — order-discount-aware subtotal/discount/total; S-1 clamp)
- `src/sales/domain/sale-item.entity.spec.ts` (promotionId audit on line, applyDiscount with promotionId)
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` (W2: four read mappers load veto + applied-promo; opt-in load+save; persistChargeConfirmation item re-write W1; findDraftResponseById C2 order-discount totals)
- `src/chatbot-api/application/chatbot-api.service.spec.ts`
- `src/products/infrastructure/prisma-product.repository.spec.ts` (decrement return shape + PRE-gate + re-arm + outbox-in-tx)
- `src/products/products.service.spec.ts` (wrapper return)
- `src/promotions/application/pos-evaluate-promotions.use-case.spec.ts` (eligibility + best-wins + precedence; C1 price-list resolved-global-id; W3 99% clamp; manual opt-in; veto; manual-wins)
- `src/promotions/infrastructure/prisma-promotion.repository.spec.ts` (resolve-price-list-global-ids batch; tenant-scoped)
- `src/stock-alerts/outbox/low-stock-outbox.poller.spec.ts` (disjoint claim)
- `src/stock-alerts/outbox/low-stock-outbox.dispatcher.spec.ts` (await + retry + FAILED exit + missing-tenantId branch)
- `src/shared/outbox/outbox-poller.service.spec.ts` (exclusion predicate)
- `prisma/e4-concurrent-stock-alert.spec.ts` (real-DB concurrent collapse)
- `prisma/promotions-in-sale-migration-drift.spec.ts` (additivity + zero drift across 2 migrations)
- `src/shared/prisma/tenant-isolation.spec.ts` (cross-tenant isolation)