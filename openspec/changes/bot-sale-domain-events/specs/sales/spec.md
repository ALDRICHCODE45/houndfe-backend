# Delta for sales

## MODIFIED Requirements

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

### Verification Surface

- `src/sales/sales.service.spec.ts`
- `src/chatbot-api/application/chatbot-api.service.spec.ts`
