# Tasks: Bot Sale Domain Events & Invariants

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Implementation: ~102-135 lines; Tests: ~170-260 lines; Total: ~272-395 lines |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR (one cohesive unit) |
| Delivery strategy | single-pr |
| Chain strategy | N/A (within budget) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: N/A
400-line budget risk: Low

### Rationale

The change introduces one new method (`confirmBotSale`) that reuses existing canonical primitives and wires it into the chatbot-api delegation path. All modified files are isolated to the sales and chatbot-api modules with clear boundaries. The implementation is purely additive with zero changes to the existing POS `chargeDraft` path. Test coverage spans unit tests for both services with mocked dependencies. The total estimate (272-395 lines including comprehensive tests) fits comfortably within the 400-line review budget as a single, focused work unit.

## Phase 1: Module Wiring

- [x] 1.1 Add `SalesModule` to `ChatbotApiModule` imports in `src/chatbot-api/chatbot-api.module.ts`

## Phase 2: Core Implementation (TDD - SalesService)

- [x] 2.1 RED: Write failing test for `confirmBotSale` happy path in `src/sales/sales.service.spec.ts` (folio allocated, stock decremented, seller=cashier, dueDate=confirmedAt+15d, exactly one `sale.confirmed` event with plain-object payload, all inside `runInTransaction`)
- [x] 2.2 RED: Write failing test for price validation failure in `src/sales/sales.service.spec.ts` (price mismatch against live catalog rejects sale, no folio consumed, no stock decremented, no outbox event)
- [x] 2.3 RED: Write failing test for `sale.confirmed` payload structure in `src/sales/sales.service.spec.ts` (payload is plain object with saleId, folio, tenantId, actorId, totalCents, paidCents, debtCents, paymentStatus, confirmedAt)
- [x] 2.4 RED: Write failing test for no payment events in `src/sales/sales.service.spec.ts` (CREDIT sale with zero payments emits no `sale.payment.received` or `sale.fully.paid`)
- [x] 2.5 GREEN: Add `confirmBotSale` method to `src/sales/sales.service.ts` with signature: input `{ cashierUserId, customerId, shippingAddressId?, items[] }`, returns `{ saleId, folio, paymentStatus, channel, deliveryStatus, totalCents, paidCents, debtCents, confirmedAt }`
- [x] 2.6 GREEN: Implement price validation against live catalog in `confirmBotSale` (call `productsService.getAvailablePrices` for each item, compare `unitPriceCents` from input, throw on mismatch before any side effects)
- [x] 2.7 GREEN: Wrap `confirmBotSale` logic in `saleRepo.runInTransaction()` to ensure atomicity (stock + sale + outbox in one tenant transaction via CLS)
- [x] 2.8 GREEN: Reuse existing private helpers in `confirmBotSale`: `Sale.create` (CONFIRMED-bound, channel=ONLINE), `saleRepo.save`, `decrementStockForCharge`, `allocateNextFolio(confirmedAt)`, `resolveDueDate(undefined, confirmedAt, 'CREDIT')`, `persistChargeConfirmation`, `publishSaleConfirmedEvent`
- [x] 2.9 GREEN: Ensure `sellerUserId = cashierUserId` in `confirmBotSale` (bot service-user becomes both userId and seller)
- [x] 2.10 GREEN: Ensure `publishSaleConfirmedEvent` payload is plain object with `paymentStatus:'CREDIT'`, `paidCents:0`, `debtCents:totalCents`, `actorId:cashierUserId`

## Phase 3: Integration (TDD - ChatbotApiService)

- [x] 3.1 RED: Write failing delegation test in `src/chatbot-api/application/chatbot-api.service.spec.ts` (`registerBotSale` calls `SalesService.confirmBotSale` with correct mapped input)
- [x] 3.2 RED: Write failing idempotency preservation test in `src/chatbot-api/application/chatbot-api.service.spec.ts` (idempotency reserve→succeed flow unchanged, cached response on replay without re-calling `confirmBotSale`)
- [x] 3.3 GREEN: Inject `SalesService` in `ChatbotApiService` constructor in `src/chatbot-api/application/chatbot-api.service.ts`
- [x] 3.4 GREEN: Modify `registerBotSale` in `src/chatbot-api/application/chatbot-api.service.ts` to delegate to `SalesService.confirmBotSale` after idempotency reserve, map response to `BotSaleResponse`, mark idempotency SUCCEEDED with cache

## Phase 4: Verification & Regression

- [x] 4.1 Run `pnpm run test` and verify all new tests pass
- [x] 4.2 Verify existing `chargeDraft` tests remain green (regression check - POS path untouched)
- [x] 4.3 Verify test coverage for `confirmBotSale` includes all six invariants: folio allocation, stock decrement, price validation, seller assignment, dueDate resolution, outbox emission
- [x] 4.4 Verify idempotency tests in `chatbot-api.service.spec.ts` confirm delegation contract and replay safety
