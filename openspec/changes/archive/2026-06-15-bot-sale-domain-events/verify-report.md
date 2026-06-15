# Verification Report: bot-sale-domain-events

## Verdict

**PASS_WITH_WARNINGS**

The implementation satisfies the required bot sale domain invariants at runtime through targeted unit coverage and passes build. The full Jest suite still fails only on the known pre-existing missing local `nest-practice` database integration tests.

Two warnings remain: live-catalog price validation currently runs before `saleRepo.runInTransaction()` rather than inside the transaction described by the design, and strict TDD RED-first history is not independently provable from the available commits because tests and implementation are in the same feature commit.

## Completeness

| Dimension | Status | Evidence |
|---|---:|---|
| Tasks | PASS | All OpenSpec tasks are checked. Implementation exists in `src/sales/sales.service.ts`, `src/chatbot-api/application/chatbot-api.service.ts`, `src/chatbot-api/chatbot-api.module.ts`; tests exist in the required surfaces. |
| Spec requirements | PASS | Required scenarios have passing targeted tests. |
| Design coherence | PASS_WITH_WARNINGS | Core architecture is implemented, but price validation is outside the transaction boundary. |
| Strict TDD | PASS_WITH_WARNINGS | Behavioral tests are meaningful and passed; historical RED-first proof is incomplete from commit evidence. |

## Runtime Evidence

| Command | Result | Notes |
|---|---:|---|
| `pnpm run test -- sales.service.spec.ts chatbot-api.service.spec.ts service-auth.guard.spec.ts` | PASS | 3 suites passed, 149 tests passed. |
| `pnpm build` | PASS | Nest build completed successfully. |
| `pnpm run test` | FAIL (environment) | 115 suites passed, 2 suites failed, 1183 tests passed, 10 failed. Failures are Prisma integration tests requiring missing database `nest-practice`: `promotions/infrastructure/prisma-promotion.repository.integration.spec.ts`, `shared/prisma/tenant-isolation.spec.ts`. These are known pre-existing DB-environment failures and are not attributed to this change. |

## Per-Invariant Compliance Matrix

| Invariant | Implementation Evidence | Test Evidence | Status |
|---|---|---|---:|
| 1. Folio allocation, shared POS sequence | `confirmBotSale()` calls `saleRepo.allocateNextFolio(confirmedAt)` and persists the folio via `persistChargeConfirmation`. | `sales.service.spec.ts` asserts `folio: 'A-2606-000001'` is persisted and returned. | PASS |
| 2. Stock decrement | `confirmBotSale()` calls `productsService.decrementStockForCharge()` with product/variant/quantity for each item. | Happy-path spec asserts exact stock decrement call. Price-mismatch spec asserts no stock decrement on stale price. | PASS |
| 3. `sale.confirmed` outbox event, plain object, same transaction | `confirmBotSale()` calls `publishSaleConfirmedEvent()` after `persistChargeConfirmation()` inside `saleRepo.runInTransaction()`; payload is an object literal. | Tests assert exactly one outbox call, event type `sale.confirmed`, required payload fields, and `Object.getPrototypeOf(payload) === Object.prototype`; no payment/fully-paid events. | PASS |
| 4. Credit dueDate assignment | `confirmBotSale()` calls canonical `resolveDueDate(undefined, confirmedAt, 'CREDIT')` and sends due date to `persistChargeConfirmation`. | Test derives expected due date from persisted `confirmedAt` and asserts +15 days. | PASS |
| 5. Live-catalog price validation | `confirmBotSale()` calls `productsService.getApplicablePrices(productId, variantId, quantity)` and rejects when no candidate price matches `unitPriceCents`. | Price-mismatch spec asserts `PRICE_OUT_OF_DATE` and no save, stock, folio, confirmation, or outbox side effects. | PASS_WITH_WARNING |
| 6. Seller assignment | `confirmBotSale()` assigns seller on the aggregate and persists `sellerUserId: cashierUserId`. | Happy-path spec asserts `sellerUserId: 'user-bot-cashier'` in persisted confirmation. | PASS |
| Idempotency preserved on `registerBotSale` | `registerBotSale()` checks cached `SUCCEEDED` idempotency response, reserves slot, delegates to `SalesService.confirmBotSale()`, then stores response. | `chatbot-api.service.spec.ts` asserts delegation mapping and cached replay without re-calling `confirmBotSale()`. | PASS |
| POS `chargeDraft` path unchanged/regression | Existing `chargeDraft` method remains present and continues using canonical POS flow. | Existing `chargeDraft` specs in `sales.service.spec.ts` passed in targeted run. | PASS |

## Findings

### CRITICAL

None.

### WARNING

1. **Price validation is outside `saleRepo.runInTransaction()`**  
   Evidence: `src/sales/sales.service.ts` validates `productsService.getApplicablePrices()` at lines 1648-1665, then opens `saleRepo.runInTransaction()` at line 1667. The design says the whole confirmation flow, including price validation, should be inside one transaction. Functional side effects are still protected, and the stale-price test asserts no side effects, but there is a race window where catalog prices can change between validation and confirmation.

2. **Strict TDD RED-first history is not independently provable from the available commits**  
   Evidence: recent history shows `5244710 feat(chatbot-api): confirm bot sales through sales domain` containing the implementation/test work, followed by docs and guard-spec fix commits. The tests are meaningful and passed, but the commit history does not expose separate failing RED commits or another durable artifact proving tests failed before implementation.

### SUGGESTION

1. Add a focused unit assertion that `getApplicablePrices()` runs under the same transaction callback, if the design intends price validation to be transaction-scoped. Today the tests assert side effects happen after `runInTransaction()` was invoked, but not that price validation is inside the callback.

## Spec Compliance

| Requirement / Scenario | Runtime Coverage | Status |
|---|---|---:|
| Bot Sale Registration: successful bot sale applies all invariants | `confirms bot sale in one transaction with stock, folio, seller attribution, and default credit due date` | PASS |
| Bot Sale Registration: price mismatch rejected before persistence | `rejects stale bot prices before stock, folio, persistence, or outbox side effects` | PASS |
| Bot Sale Registration: credit due date rule | Same happy-path test asserts +15 days | PASS |
| Bot Sale Event Emission: plain JSON payload | `publishes a plain-object sale.confirmed payload with the required fields` | PASS |
| Bot Sale Event Emission: no payment events at creation | `emits only sale.confirmed for zero-payment credit bot sales` | PASS |
| Bot Sale Idempotency: duplicate request replays safely | `returns cached response without creating a duplicate sale on idempotency replay` | PASS |
| Bot Sale Idempotency: first successful replay stable | Delegation + cached replay tests cover response stability for `saleId` and cached payload path | PASS |

## Design Coherence

| Decision | Status | Notes |
|---|---:|---|
| `SalesService.confirmBotSale()` is single source for bot sale confirmation | PASS | `registerBotSale()` delegates to `SalesService.confirmBotSale()`. |
| Reuse canonical primitives | PASS | Reuses stock decrement, folio allocation, due-date helper, confirmation persistence, and sale-confirmed publisher. |
| Single transaction for sale side effects and outbox | PASS | Save, stock decrement, folio allocation, confirmation persistence, and outbox publish run inside `saleRepo.runInTransaction()`. |
| Price validation transaction placement | WARNING | Price validation runs before transaction, not inside as designed. |
| `sale.confirmed` only | PASS | No payment/fully-paid events are emitted for bot credit sale. |
| Seller identity = `cashierUserId` | PASS | Both aggregate assignment and persisted confirmation use `cashierUserId`. |
| `chargeDraft` untouched | PASS | Existing chargeDraft tests pass. |

## Final Verdict

**PASS_WITH_WARNINGS** — No blocking correctness defects were found for the required invariants. Address the transaction-placement warning if the design requires price validation to be race-free inside the same unit of work, and preserve better RED-first evidence in future strict TDD changes.
