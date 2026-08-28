# Sales Specification

## Purpose

Define sale lifecycle, domain rules, reporting semantics, and API surfaces for the sales domain. Canceled sales are first-class queryable entities, excluded from CONFIRMED-scoped reporting and KPI/revenue queries, but available when explicitly filtered.

## Requirements

### Requirement: Bot Sale Registration

The system MUST confirm bot-created sales through `SalesService.confirmBotSale()` when `registerBotSale` is called. The system MUST apply the full sale contract: shared folio allocation, stock decrement, list-price validation, seller assignment, credit `dueDate` assignment (`confirmedAt` + 15 days), and server-side re-evaluation of promotions with the real POS engine (`recomputePricingAndPromotions`). The system MUST compute `subtotalCents = Σ(item.originalPriceCents · quantity)` (pre-promo baseline), `totalCents = Σ(item.unitPriceCents · quantity)` (post-engine), and `discountCents = subtotalCents − totalCents` (always ≥ 0). The system MUST persist `discountCents` on the Sale (not hardcoded `0`) and MUST surface `discountCents` on `ConfirmBotSaleResult`.
(Previously: `confirmBotSale` validated prices against list only and hardcoded `discountCents=0`, so promo-discounted bot sales were impossible through the API.)

#### Scenario: Successful bot sale applies all invariants
- GIVEN a validated bot cart with items, customer, and cashier/seller identity, and any AUTOMATIC promotion eligible on the items
- WHEN `registerBotSale` creates the sale through the sales domain
- THEN the sale is confirmed as `ONLINE` and `CREDIT`
- AND a shared POS folio is assigned
- AND stock is decremented for each item
- AND `sellerUserId` is assigned
- AND `dueDate` is set to `confirmedAt` plus 15 days
- AND the POS engine re-evaluates the sale
- AND `discountCents` is persisted as the engine-computed value
- AND `totalCents` reflects post-engine line totals

#### Scenario: Price mismatch is rejected before persistence
- GIVEN at least one submitted item price differs from the authoritative list price
- WHEN `SalesService.confirmBotSale()` validates the cart
- THEN the sale is rejected with `PRICE_OUT_OF_DATE`
- AND no folio is consumed
- AND no stock is decremented
- AND no outbox event is written
- AND the POS engine is not invoked

#### Scenario: Credit sale keeps the default due date rule
- GIVEN a bot-created sale is confirmed as credit
- WHEN the sale is persisted
- THEN the stored `dueDate` is present
- AND it equals the confirmation time plus 15 days

#### Scenario: No promotion applicable persists discountCents=0
- GIVEN a bot cart whose items have no eligible promotion
- WHEN `registerBotSale` runs
- THEN the engine runs and produces no applied promotion
- AND `discountCents=0` is persisted
- AND `totalCents = subtotalCents`

#### Scenario: Eligible promotion is re-evaluated and persisted
- GIVEN a bot cart with an AUTOMATIC 10% `PRODUCT_DISCOUNT` on the item at 1000c
- WHEN `registerBotSale` runs
- THEN `discountCents=100c` is persisted
- AND `totalCents=900c` is persisted
- AND the re-evaluation result is the source of truth (bot-supplied totals are not trusted)

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

The system MUST keep idempotency ownership in `ChatbotApiService`. A repeated `registerBotSale` request with the same idempotency key and identical payload MUST return the cached result without re-confirming the sale (preserves replay semantics). The system MUST acquire the idempotency slot atomically using the `create → P2002 → re-read` pattern, distinguishing `replay` (matching hash + SUCCEEDED + cached response), `conflict` (slot exists but hash mismatches → `IDEMPOTENCY_KEY_CONFLICT`, 409), and `in_flight` (slot exists with matching hash but `status=IN_FLIGHT` → `IDEMPOTENCY_KEY_IN_FLIGHT`, 409). The `requestHash` MUST be `SHA-256(JSON.stringify(canonicalPayload))` over `{ cashierUserId, customerId, shippingAddressId, items: [{productId, variantId, quantity, unitPriceCents}] }` with items sorted ascending by `(productId, variantId)`. The system MUST reject empty or missing idempotency keys at the DTO layer with `400 INVALID_IDEMPOTENCY_KEY` before any DB read.
(Previously: idempotency was an out-of-transaction upsert with `update: {}` that silently absorbed the unique-constraint loss and never compared `requestHash`, allowing two concurrent same-key requests to create duplicate sales.)

#### Scenario: Duplicate request replays safely
- GIVEN a prior `registerBotSale` call already succeeded for the same idempotency key with matching payload
- WHEN the bot retries the same request
- THEN the cached response is returned
- AND `SalesService.confirmBotSale()` is not called again
- AND no duplicate stock, folio, or event side effects occur

#### Scenario: First successful replay stays stable
- GIVEN the original bot sale succeeded
- WHEN the same request is replayed again later
- THEN the original sale id and response values are returned
- AND the sale is not duplicated

#### Scenario: Same key + different payload returns 409 IDEMPOTENCY_KEY_CONFLICT
- GIVEN key K already has a SUCCEEDED row with `requestHash=H1`
- WHEN the bot retries with key K and a payload that hashes to H2
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_CONFLICT`
- AND no sale is created or modified
- AND no folio, stock, or outbox side effects occur

#### Scenario: Same key + IN_FLIGHT returns 409 IDEMPOTENCY_KEY_IN_FLIGHT
- GIVEN key K currently has a row with `status=IN_FLIGHT` and `requestHash=H`
- WHEN the bot retries with key K and a payload that hashes to H
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_IN_FLIGHT`
- AND the original in-flight request can complete and stamp SUCCEEDED

#### Scenario: Concurrent same-key requests do not create duplicate sales
- GIVEN two requests R1 and R2 arrive concurrently with key K and identical payload
- WHEN both run through `registerBotSale`
- THEN exactly one acquire returns `acquired` and proceeds to
  `confirmBotSale`
- AND the other returns `replay` (after the first succeeds) or
  `in_flight` (before the first succeeds)
- AND exactly one Sale row exists for key K
- AND exactly one folio is allocated
- AND stock is decremented exactly once

#### Scenario: Empty idempotency key is rejected at the DTO
- GIVEN the `X-Idempotency-Key` header is missing or empty
- WHEN the request reaches the DTO validator
- THEN the response is `400 INVALID_IDEMPOTENCY_KEY`
- AND no DB read or write occurs

#### Scenario: Item order does not affect the hash
- GIVEN key K succeeded with payload P whose items are
  `[{productId=A}, {productId=B}]`
- WHEN the bot retries with the same payload P reordered as
  `[{productId=B}, {productId=A}]`
- THEN `requestHash` is identical between the two payloads
- AND the retry replays (not conflict)

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

### Requirement: Charge Resolves a Custom Method and Snapshots the Catalog

The system MUST accept an optional `paymentMethodId` (uuid) on
`ChargeSaleDto` and on each `ChargePaymentEntryDto`. When the field
is present, the system MUST resolve the referenced `PaymentMethod`
scoped to the caller's tenant, MUST reject the request if the row
does not exist, does not belong to the tenant, or is inactive
(`isActive=false`), and MUST verify that if a base-category `method`
is also supplied on the same entry, it matches the row's
`category` exactly (case-insensitive). The persisted
`SalePayment.method` MUST be the resolved base category. The system
MUST write a catalog snapshot to `SalePayment.metadataJson` under
the dedicated key `catalog` with the shape
`{ paymentMethodId, name, subtitle? }` (subtitle omitted when null).
Requests without `paymentMethodId` MUST behave exactly as today —
no `catalog` key is written.

#### Scenario: Charge with valid active paymentMethodId persists snapshot

- GIVEN tenant T has an active `PaymentMethod` PM with
  `name="Mercado Pago"`, `category="transfer"`, `subtitle="Link"`,
  `isActive=true`
- WHEN a caller in T charges a draft sale with a payment entry
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM.id }`
- THEN a `SalePayment` row is created with `method="TRANSFER"`,
  `amountCents=1000`, and
  `metadataJson.catalog = { paymentMethodId: PM.id, name: "Mercado Pago", subtitle: "Link" }`

#### Scenario: Charge with mismatched method is rejected

- GIVEN tenant T has an active `PaymentMethod` PM with
  `category="transfer"`
- WHEN a caller in T charges with
  `{ method: "cash", amountCents: 1000, paymentMethodId: PM.id }`
- THEN the request is rejected with `400 PAYMENT_METHOD_CATEGORY_MISMATCH`
- AND no `SalePayment` is written

#### Scenario: Charge with inactive paymentMethodId is rejected

- GIVEN tenant T has a `PaymentMethod` PM with `isActive=false`
- WHEN a caller in T charges with
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM.id }`
- THEN the request is rejected with `409 INACTIVE_PAYMENT_METHOD`
- AND no `SalePayment` is written

#### Scenario: Charge with foreign-tenant paymentMethodId is rejected

- GIVEN `PaymentMethod` PM1 belongs to tenant T1
- WHEN a caller in tenant T2 charges with
  `paymentMethodId: PM1.id`
- THEN the request is rejected with `404 PAYMENT_METHOD_NOT_FOUND`
- AND no `SalePayment` is written

#### Scenario: Charge with unknown paymentMethodId is rejected

- GIVEN no `PaymentMethod` exists with the supplied id
- WHEN a caller charges with that `paymentMethodId`
- THEN the request is rejected with `404 PAYMENT_METHOD_NOT_FOUND`

#### Scenario: Charge without paymentMethodId behaves as today

- GIVEN any caller
- WHEN the caller charges with `{ method, amountCents }` and no
  `paymentMethodId`
- THEN the resulting `SalePayment` has no `catalog` key in
  `metadataJson` and behaves identically to the pre-change behavior

#### Scenario: Charge entry without paymentMethodId keeps legacy reference

- GIVEN a caller supplies
  `{ method: "cash", amountCents: 1000, reference: "TX-1" }`
- WHEN the charge is persisted
- THEN the resulting `SalePayment` has
  `metadataJson.reference = "TX-1"` (or the row's `reference`
  column populated, matching today's behavior) and no `catalog` key

### Requirement: Sale Detail and Timeline Expose the Custom Method Name

The system MUST extend `SaleDetailPaymentDto` with optional fields
`paymentMethodId`, `paymentMethodName`, and
`paymentMethodSubtitle`, populated from the snapshot at
`metadataJson.catalog` when present. The system MUST surface these
fields on the `PAYMENT_RECEIVED` timeline event in
`build-sale-timeline.ts`. The system MUST render the custom name
(and `subtitle` when present) on the receipt PDF template
`pdf-generation/templates/shared/payments-list.tsx`, preferring
the snapshot over the base-category label map. When the snapshot
is absent (legacy rows, base-category-only charges), the existing
base-category label MUST remain the fallback.

#### Scenario: Custom name appears on sale detail

- GIVEN a `SalePayment` with
  `metadataJson.catalog = { paymentMethodId, name: "Mercado Pago", subtitle: "Link" }`
- WHEN a caller reads `GET /sales/:id` (sale detail)
- THEN the corresponding entry in `payments[]` includes
  `paymentMethodId`, `paymentMethodName = "Mercado Pago"`, and
  `paymentMethodSubtitle = "Link"`
- AND `method` remains `"TRANSFER"` (the base category)

#### Scenario: Custom name appears on the PAYMENT_RECEIVED timeline

- GIVEN the same `SalePayment` as above
- WHEN the sale timeline is built
- THEN the `PAYMENT_RECEIVED` event exposes the custom name (and
  subtitle when present) to clients
- AND the base-category label is still resolvable as a fallback

#### Scenario: Custom name appears on the receipt PDF

- GIVEN a sale with a custom-method `SalePayment`
- WHEN the receipt PDF is rendered
- THEN the payments list displays the custom name (and subtitle
  when present) instead of the base-category label

#### Scenario: Legacy rows fall back to base-category label

- GIVEN a `SalePayment` without a `catalog` key in `metadataJson`
- WHEN the sale detail, timeline, or receipt is rendered
- THEN the base-category label is used
- AND `paymentMethodId / paymentMethodName / paymentMethodSubtitle`
  are absent or `null` on the wire

### Requirement: POS Sale Delivery Flag At Charge Time

The `ChargeSaleDto` SHALL accept an optional `delivery?: boolean`. The field SHALL be omitted-safe (no field, `undefined`, or `false` all reproduce today's behavior) and SHALL be validated by the DTO layer as a boolean when present. The field SHALL NOT add a new CASL action or permission; the existing `update:Sale` permission on the charge route SHALL continue to govern access.

#### Scenario: Delivery flag omitted reproduces today's behavior

- GIVEN a valid POS draft with non-null `shippingAddressId`
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with no `delivery` field
- THEN the request is accepted
- AND the confirmed sale is persisted with the same `deliveryStatus` the draft had at charge time
- AND no `delivery` field is required at the DTO layer

#### Scenario: Delivery flag `true` is accepted at the DTO layer

- GIVEN a POS draft ready to charge
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with `{ "delivery": true }`
- THEN the DTO layer accepts the payload
- AND service-layer business rules apply (address required; see other requirements)

#### Scenario: Delivery flag `false` is accepted and behaves like omission

- GIVEN a POS draft with non-null `shippingAddressId`
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with `{ "delivery": false }`
- THEN the request is accepted
- AND the confirmed sale is persisted with the same `deliveryStatus` the draft had at charge time

#### Scenario: Non-boolean delivery value is rejected at the DTO layer

- GIVEN any POS draft
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with `{ "delivery": "yes" }`
- THEN the request is rejected with a 400 class-validator error
- AND no business logic runs
- AND no persistence occurs

### Requirement: Delivery Flag With Shipping Address Confirms Sale As PENDING

When the charge request carries `delivery: true` AND the loaded draft has a non-null `shippingAddressId`, the confirmed sale SHALL persist `deliveryStatus: 'PENDING'` (overriding the draft's default `'DELIVERED'`), SHALL keep `channel: 'POS'` unchanged, and SHALL satisfy the existing `DeliveryRoute.create`/`addStop` eligibility check (`deliveryStatus ∈ {PENDING, SHIPPED}` AND non-null `shippingAddressId`). After confirmation, route check-in flips `PENDING → DELIVERED` via the existing `Sale.markDelivered()` path; this change SHALL NOT introduce any other transition out of `PENDING`.

#### Scenario: Flag true + non-null address persists PENDING and stays route-eligible

- GIVEN a POS draft in `DRAFT` state with non-null `shippingAddressId`
- WHEN the cashier charges the draft with `{ "delivery": true }` and the call succeeds
- THEN the persisted sale row has `deliveryStatus = 'PENDING'`
- AND the row has `channel = 'POS'`
- AND `DeliveryRoute.create` accepts the sale id (eligibility check passes)
- AND `DeliveryRoute.addStop` accepts the sale id (eligibility check passes)

#### Scenario: Route check-in still flips PENDING to DELIVERED

- GIVEN a POS sale confirmed as `deliveryStatus: 'PENDING'` by this feature
- WHEN the route check-in calls `Sale.markDelivered()`
- THEN the sale transitions to `deliveryStatus: 'DELIVERED'`
- AND no other transition out of `PENDING` is introduced by this change

### Requirement: Delivery Flag Without Shipping Address Is Rejected Before Persistence

When the charge request carries `delivery: true` AND the loaded draft has a null or absent `shippingAddressId`, the charge SHALL fail with a 422 business-rule error using a clear, dedicated error code (`SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`), SHALL NOT call `persistChargeConfirmation`, and SHALL NOT mutate the draft row or any payment/outbox/folio/stock side effect.

#### Scenario: Flag true + null address fails with 422 and no persistence

- GIVEN a POS draft in `DRAFT` state with `shippingAddressId = null`
- WHEN the cashier charges the draft with `{ "delivery": true }`
- THEN the request is rejected with HTTP 422 and error code `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`
- AND `persistChargeConfirmation` is NOT called
- AND no folio is allocated
- AND no stock is decremented
- AND no outbox event is written
- AND the draft row is unchanged

#### Scenario: Flag true + address field absent behaves like null

- GIVEN a POS draft with no `shippingAddressId` column value at all (treated as null)
- WHEN the cashier charges the draft with `{ "delivery": true }`
- THEN the request is rejected with HTTP 422 and error code `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`
- AND `persistChargeConfirmation` is NOT called

### Requirement: Omitted Or False Delivery Flag Preserves Today Behavior Exactly

When `delivery` is omitted, `undefined`, or `false`, the charge path SHALL produce a confirmed sale whose `deliveryStatus` equals whatever the draft carried at the moment of charge (today: `'DELIVERED'`, inherited from `Sale.create` and `PrismaSaleRepository.save`). The flag SHALL NOT cause any change to the persisted `channel`, the existing `chargeDraft` totals invariants, or any other side effect of the charge path.

#### Scenario: Omitted flag reproduces today's DELIVERED outcome

- GIVEN a POS draft whose `deliveryStatus = 'DELIVERED'` at the moment of charge (today's seeded default)
- WHEN the cashier charges the draft with no `delivery` field
- THEN the confirmed sale row has `deliveryStatus = 'DELIVERED'`
- AND `channel = 'POS'`
- AND the sale is NOT eligible for `DeliveryRoute.create`/`addStop` (today's outcome)

#### Scenario: Explicit `false` flag reproduces today's DELIVERED outcome

- GIVEN the same preconditions as the omitted-flag scenario
- WHEN the cashier charges the draft with `{ "delivery": false }`
- THEN the confirmed sale row has `deliveryStatus = 'DELIVERED'`
- AND the sale is NOT eligible for `DeliveryRoute.create`/`addStop`

### Requirement: Charge Idempotency Hash Includes Delivery Flag

The charge `requestHash` SHALL include the `delivery` flag value (normalized: omitted/undefined → a sentinel equivalent to `false`). A retry with the same idempotency key but a changed `delivery` value SHALL NOT silently replay a stale non-delivery result: it MUST be treated as a payload mismatch and rejected with `IDEMPOTENCY_KEY_CONFLICT` (HTTP 409) following the same `requestHash` comparison discipline already established for the bot sale idempotency surface.

#### Scenario: Same key + same delivery value replays the cached result

- GIVEN a prior successful charge with key K, `delivery: true`, and persisted `deliveryStatus: 'PENDING'`
- WHEN the cashier retries the same request with key K and `delivery: true`
- THEN the cached response is returned
- AND no second charge confirmation runs

#### Scenario: Same key + flipped delivery returns IDEMPOTENCY_KEY_CONFLICT

- GIVEN a prior successful charge with key K, `delivery: true`, and a stored `requestHash` that includes `delivery: true`
- WHEN the cashier retries with key K and `delivery: false`
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_CONFLICT`
- AND no second charge confirmation runs
- AND the original `deliveryStatus: 'PENDING'` row is NOT overwritten with `'DELIVERED'`

#### Scenario: Same key + omitted delivery after a delivered charge is rejected

- GIVEN a prior successful charge with key K, no `delivery` field, and `deliveryStatus: 'DELIVERED'`
- WHEN the cashier retries with key K and `{ "delivery": true }`
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_CONFLICT`
- AND the original row is NOT flipped to `'PENDING'`

### Requirement: Charge Route Authorization Unchanged

The charge route SHALL continue to require only the existing `update:Sale` CASL permission. This change SHALL NOT introduce a new `AppActions` entry (e.g. no `deliver:Sale`, no `charge:Sale`), SHALL NOT add a registry/seed row, and SHALL NOT change `CaslAbilityFactory` wiring. A caller with `update:Sale` MAY set `delivery: true`; a caller without `update:Sale` SHALL still be rejected with the existing 403 path.

#### Scenario: Caller with update:Sale can flag a sale for delivery

- GIVEN a caller whose granted permissions include `update:Sale`
- WHEN the caller charges a draft with `{ "delivery": true }` and a non-null `shippingAddressId`
- THEN the request is authorized
- AND the sale is persisted as `PENDING`

#### Scenario: Caller without update:Sale cannot flag a sale for delivery

- GIVEN a caller whose granted permissions do NOT include `update:Sale`
- WHEN the caller calls `POST /sales/drafts/:id/charge` with `{ "delivery": true }`
- THEN the request is rejected by the existing permissions guard
- AND the flag value has no effect on the outcome

#### Scenario: No new CASL permission is added

- GIVEN the codebase at the time this delta is applied
- WHEN the registry, `AppActions`, the permission seeding list, and `CaslAbilityFactory` are inspected
- THEN no new entry referencing delivery or charge-by-flag is present

### Requirement: SHIPPED SHALL NOT Be Written For POS Sales

The `PENDING → SHIPPED` transition SHALL remain bot/ONLINE-only. The charge path for POS sales SHALL NOT write `deliveryStatus: 'SHIPPED'` directly. POS sales flagged for delivery SHALL remain `channel: 'POS'` after charge; the existing chatbot `setDeliveryMetadata` guard (which requires `channel === 'ONLINE'`) SHALL continue to reject any attempt to move a POS sale to `SHIPPED`.

#### Scenario: Charge path does not write SHIPPED for POS sales

- GIVEN any POS draft
- WHEN the charge path runs (with or without `delivery: true`)
- THEN the persisted `deliveryStatus` is one of `'PENDING'` or `'DELIVERED'`
- AND `'SHIPPED'` is NEVER written by this change

#### Scenario: Existing chatbot guard continues to reject SHIPPED on POS sales

- GIVEN a POS sale confirmed by this feature with `deliveryStatus: 'PENDING'` and `channel: 'POS'`
- WHEN the chatbot `setDeliveryMetadata` path is invoked for that sale
- THEN the request is rejected with `SALE_DELIVERY_NOT_READY`
- AND `deliveryStatus` stays `'PENDING'`

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