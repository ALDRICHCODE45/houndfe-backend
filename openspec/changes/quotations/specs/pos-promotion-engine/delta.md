# Delta: POS Promotion Engine — Context Discriminant

## ADDED Requirements

### Requirement: PosEvalInput Context Discriminant
**Status**: ADDED
**Priority**: P0

`PosEvalInput` MUST include a `context` field typed as `'SALE' | 'QUOTATION'`. The field MUST default to `'SALE'` for all existing call sites (backward compatible — no existing code changes required). The engine MUST treat both contexts identically in this slice: the discriminant is a forward-looking gate so future promotion targeting rules can opt in/out per context without code changes.

#### Scenario: context defaults to SALE when omitted
- **GIVEN** an existing call site passes `PosEvalInput` without `context`
- **WHEN** the engine evaluates promotions
- **THEN** `context` resolves to `'SALE'` and behavior is identical to today

#### Scenario: context='QUOTATION' produces same results as context='SALE'
- **GIVEN** any valid promotion evaluation input
- **WHEN** the engine evaluates once with `context='SALE'` and once with `context='QUOTATION'`
- **THEN** the applied promotion list, per-line discounts, and totals are identical between both evaluations

#### Scenario: All existing sale call sites pass without context field
- **GIVEN** the `SalesService.recomputePricingAndPromotions()` call sites (addItem, updateItemQuantity, removeItem, assignCustomer, overrideItemPrice, etc.)
- **WHEN** the engine evaluates (existing code without `context` field)
- **THEN** the evaluation succeeds with `context='SALE'` (default) and all existing sale specs pass unchanged

---

### Requirement: QuotationsService Passes context='QUOTATION'
**Status**: ADDED
**Priority**: P0

`QuotationsService` MUST pass `context: 'QUOTATION'` when calling the promotion engine's `recomputePricingAndPromotions`. This is the only new call site that sets `context` explicitly in this slice.

#### Scenario: QuotationsService recompute sets context=QUOTATION
- **GIVEN** a DRAFT quotation with items and an AUTOMATIC promotion
- **WHEN** `QuotationsService` triggers a promotion recompute (any mutation)
- **THEN** the `PosEvalInput` passed to the engine includes `context: 'QUOTATION'`

---

## Verification Surface

- `src/promotions/application/ports/pos-evaluate-promotions.port.ts` — `PosEvalInput.context` added (optional, defaults to `'SALE'`)
- `src/promotions/application/pos-evaluate-promotions.use-case.ts` — reads `context` field; behavior unchanged for both values
- `src/promotions/application/pos-evaluate-promotions.use-case.spec.ts` — new scenarios: default-to-SALE, QUOTATION==SALE equality
- `src/quotations/application/quotations.service.spec.ts` — asserts `context='QUOTATION'` passed to engine mock
