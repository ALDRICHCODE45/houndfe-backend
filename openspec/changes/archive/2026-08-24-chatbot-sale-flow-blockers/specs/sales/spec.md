# Delta for sales

## MODIFIED Requirements

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

## Verification Surface

- `src/sales/sales.service.ts` — `confirmBotSale` invokes
  `recomputePricingAndPromotions`, computes `subtotalCents` /
  `discountCents` / `totalCents`, passes `discountCents` to
  `persistChargeConfirmation`, and includes it in the `sale.confirmed`
  outbox payload.
- `src/sales/sales.service.spec.ts` — promotion re-evaluation
  scenarios: no-promo (discountCents=0), AUTOMATIC promo applied,
  ORDER_DISCOUNT, BXGY / ADVANCED, requestHash mismatch, re-quote
  match / mismatch, empty-key rejection, reorder-tolerant hash,
  concurrent duplicate prevention.
- `src/sales/infrastructure/prisma-sale.repository.ts` — new
  `acquireSaleRegistrationIdempotency(key, requestHash)` /
  `markSaleRegistrationIdempotencySucceeded(token, saleId, payload)`
  methods mirroring the POS charge pattern with
  `operation='bot_sale_register'`.
- `src/sales/sales.repository.interface.ts` — extended
  `ISaleRepository` with the two new method signatures.
- `src/sales/domain/sale.entity.ts` — `ConfirmBotSaleResult` exposes
  `discountCents`.
- `src/chatbot-api/application/chatbot-api.service.ts` — `registerBotSale`
  builds the canonical payload, hashes it, calls
  `acquireSaleRegistrationIdempotency`, branches on the four outcomes,
  and stamps SUCCEEDED on success.
- `src/chatbot-api/application/chatbot-api.service.spec.ts` —
  scenarios: replay (existing tests stay green), conflict, in_flight,
  requestHash mismatch, retry-after-in-flight, concurrent
  duplicate prevention.
