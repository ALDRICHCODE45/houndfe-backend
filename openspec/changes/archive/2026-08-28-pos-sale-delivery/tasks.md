# Tasks: POS sale "for delivery" at charge time (`pos-sale-delivery`)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~140 additions (3 DTO + ~10 entity + ~10 service + ~115 tests), 0 deletions |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | single-pr |
| Chain strategy | stacked-to-main |

```text
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low
```

The change is additive (no schema, no migration, no CASL, no repository signature). Total scope is one DTO field, one small aggregate method, three small `chargeDraft` edits, and two test files. Estimated additions stay well under the 400-line threshold, so a single PR stacked to main is the right delivery shape.

---

## Phase 1 — DTO field

### [x] 1.1 Add `delivery` field to `ChargeSaleDto` <!-- sdd-owner: implementation -->

- **Files**
  - `src/sales/dto/charge-sale.dto.ts` — add `IsBoolean` to the existing `class-validator` import (`:2-12`); add `@IsOptional() @IsBoolean() delivery?: boolean` after `dueDate` (`:54-56`).
- **Change**
  - Import: extend the existing `class-validator` import list to also include `IsBoolean`.
  - Field: place the new `delivery?: boolean` property immediately after `dueDate` inside `ChargeSaleDto`, matching the existing `@IsOptional()` ordering used by every other charge-dto field.
- **Spec scenarios satisfied**
  - "Delivery flag omitted reproduces today's behavior" (DTO accepts the missing field).
  - "Delivery flag `true` is accepted at the DTO layer".
  - "Delivery flag `false` is accepted and behaves like omission".
  - "Non-boolean delivery value is rejected at the DTO layer" (class-validator will reject `"yes"` etc. with the standard 400).
- **Verification**
  - `pnpm test src/sales/dto` if any nested spec exists; otherwise type-check via `pnpm build` is sufficient for this step.
- **Rollback boundary**: remove the new field and its `IsBoolean` import — no other surface is touched.

---

## Phase 2 — Domain aggregate (`Sale.markForDelivery`)

### [x] 2.1 RED — add failing unit tests for `markForDelivery` <!-- sdd-owner: implementation -->

- **Files**
  - `src/sales/domain/sale.entity.spec.ts` — add a `describe('markForDelivery', ...)` block adjacent to the existing `describe('setShippingAddress', ...)` (the `setShippingAddress` block starts near `:645`).
- **Tests** (RED first — expect compile/test failure until 2.2 lands)
  1. Draft + non-null `shippingAddressId` → sets `sale.deliveryStatus === 'PENDING'`.
  2. Draft + null `shippingAddressId` → throws `BusinessRuleViolationError` with code `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`; `deliveryStatus` is unchanged.
  3. Non-draft (e.g. `CONFIRMED`) → throws `SALE_NOT_DRAFT` (re-uses the existing `ensureDraft()` contract).
- **Spec scenarios satisfied**
  - "Route check-in still flips PENDING to DELIVERED" (guard contract).
  - The domain guard behind the "Flag true + non-null address persists PENDING" and "Flag true + null address fails with 422 and no persistence" scenarios.
- **Verification (RED)**
  - `pnpm test src/sales/domain/sale.entity.spec.ts` → 3 failures referencing `markForDelivery` is not a function. Expected and required for RED.
- **Rollback boundary**: drop the new `describe` block; nothing else references the method yet.

### [x] 2.2 GREEN — implement `Sale.markForDelivery()` <!-- sdd-owner: implementation -->

- **Files**
  - `src/sales/domain/sale.entity.ts` — add the method immediately after `setShippingAddress` (the `setShippingAddress` method closes near `:727`); `BusinessRuleViolationError` is already imported at `:1-4`.
- **Contract** (mirrors `setShippingAddress` + `markDelivered`)
  ```ts
  markForDelivery(): void {
    this.ensureDraft();
    if (this._shippingAddressId === null) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY',
        'SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY',
      );
    }
    this._deliveryStatus = 'PENDING';
  }
  ```
- **Spec scenarios satisfied** (entity-level)
  - "Flag true + non-null address persists PENDING and stays route-eligible" (domain pre-condition).
  - "Flag true + null address fails with 422 and no persistence" (error code contract).
  - "Route check-in still flips PENDING to DELIVERED" (the method only sets `PENDING`; the existing `markDelivered` owns the flip).
- **Verification (GREEN)**
  - `pnpm test src/sales/domain/sale.entity.spec.ts` → all three Phase 2.1 tests pass; existing `setShippingAddress` / cancel guard tests remain green.
- **Rollback boundary**: remove the method body; revert Phase 2.1 tests.

---

## Phase 3 — `chargeDraft` service edits

### [x] 3.1 RED — extend `chargeDraft` tests for the delivery flag <!-- sdd-owner: implementation -->

- **Files**
  - `src/sales/sales.service.spec.ts` — add tests to the existing `describe('chargeDraft', ...)` block (starts near `:1693`).
- **Tests** (RED first — fail until 3.2 / 3.3 land)
  1. `delivery: true` + non-null `shippingAddressId` → `saleRepo.persistChargeConfirmation` is called with `deliveryStatus: 'PENDING'`; no error thrown.
  2. `delivery: true` + null `shippingAddressId` → throws an error with code `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`; `persistChargeConfirmation` is **not** called; no folio allocation (`allocateNextFolio`) is invoked; no outbox publisher (`publishSaleConfirmedEvent`) runs; no stock decrement (`decrementStockForCharge`) runs.
  3. `delivery` omitted (current behavior baseline) → `persistChargeConfirmation` is called **without** a `deliveryStatus` field OR with `deliveryStatus: 'DELIVERED'` depending on the chosen wire shape (pick whichever the implementation in 3.3 uses; the test must match that implementation exactly).
  4. `delivery: false` + non-null address → same observable behavior as case 3.
  5. Idempotency hash includes the flag:
     - Same key + same `delivery` value replays the cached payload (no second `persistChargeConfirmation`).
     - Same key + flipped flag (e.g. prior `true`, retry `false`) → throws `IDEMPOTENCY_KEY_CONFLICT` (HTTP 409 discipline enforced by `acquireChargeIdempotency`); the original row is NOT overwritten.
- **Spec scenarios satisfied**
  - "Flag true + non-null address persists PENDING and stays route-eligible".
  - "Flag true + null address fails with 422 and no persistence".
  - "Omitted flag reproduces today's DELIVERED outcome" + "Explicit `false` flag reproduces today's DELIVERED outcome".
  - "Same key + same delivery value replays the cached result" + "Same key + flipped delivery returns IDEMPOTENCY_KEY_CONFLICT" + "Same key + omitted delivery after a delivered charge is rejected".
- **Verification (RED)**
  - `pnpm test src/sales/sales.service.spec.ts -t chargeDraft` → the five new tests fail; pre-existing chargeDraft tests stay green.
- **Rollback boundary**: drop the new `it(...)` blocks; service behavior is unchanged.

### [x] 3.2 GREEN — call `sale.markForDelivery()` and add the flag to the `requestHash` <!-- sdd-owner: implementation -->

- **Files**
  - `src/sales/sales.service.ts` — two edits inside `chargeDraft`:
    1. **`requestHash` payload** (`:2416-2425`) — extend the `JSON.stringify` input:
       ```ts
       JSON.stringify({
         saleId,
         actorId,
         payments: hashPayments,
         dueDate: dto.dueDate ?? null,
         delivery: dto.delivery ?? false,
       })
       ```
       The `?? false` normalization is intentional: `JSON.stringify` drops `undefined`, so omitting/`undefined` must hash identically to explicit `false` (ADR-4).
    2. **`markForDelivery()` call** — immediately after the DRAFT guard (`:2474-2478`) and **before** `recomputePricingAndPromotions` / `previewTotals` / `decrementStockForCharge` / `persistChargeConfirmation`. Order matters: the guard must throw before any stock/folio side effect runs.
       ```ts
       if (dto.delivery === true) {
         sale.markForDelivery();
       }
       ```
- **Spec scenarios satisfied**
  - "Charge idempotency hash includes delivery flag" (the hash inclusion).
  - "Flag true + null address fails with 422 and no persistence" (the guard placement).
- **Verification (GREEN after both 3.2 and 3.3)**
  - `pnpm test src/sales/sales.service.spec.ts -t chargeDraft` → Phase 3.1 cases 1, 2, and 5 become green.
- **Rollback boundary**: revert the `requestHash` literal and remove the `if (dto.delivery === true)` block.

### [x] 3.3 GREEN — pass `deliveryStatus` explicitly to `persistChargeConfirmation` <!-- sdd-owner: implementation -->

- **Files**
  - `src/sales/sales.service.ts` — extend the `persistChargeConfirmation` call inside `chargeDraft` (`:2605-2636`) with a single property:
    ```ts
    deliveryStatus: sale.deliveryStatus,
    ```
    Read from the aggregate (not re-derive from `dto.delivery`) so the aggregate is the single source of truth. Mirrors `confirmBotSale` at `:2976-2978`.
- **Rationale (carried from ADR-2)**: `persistChargeConfirmation` builds its update payload conditionally and only writes fields the caller explicitly provides (`prisma-sale.repository.ts:946-947`). Omitting `deliveryStatus` would keep the draft's `DELIVERED`; the explicit pass-through is what flips it to `PENDING`.
- **Spec scenarios satisfied**
  - "Flag true + non-null address persists PENDING and stays route-eligible" (`PENDING` actually reaches the row).
  - "Omitted flag reproduces today's DELIVERED outcome" + "Explicit `false` flag reproduces today's DELIVERED outcome" (no `markForDelivery()` call → aggregate keeps seeded `DELIVERED`).
- **Verification (GREEN)**
  - `pnpm test src/sales/sales.service.spec.ts -t chargeDraft` → all five Phase 3.1 tests pass; existing `confirmBotSale` tests stay green (they pass `deliveryStatus` directly and are unaffected by reading from the aggregate here).
- **Rollback boundary**: remove the `deliveryStatus` property; behavior returns to today's implicit inheritance.

---

## Phase 4 — Verification gate

### [x] 4.1 Run the full test suite and build <!-- sdd-owner: implementation -->

- **Command(s)**
  - `pnpm test`
  - `pnpm build`
- **Expected result**
  - `pnpm test`: every spec green, including the new `markForDelivery` and `chargeDraft` coverage and the unchanged `confirmBotSale` / `persistChargeConfirmation` / `markDelivered` references.
  - `pnpm build`: zero TypeScript errors. (No DTO import was renamed; the new aggregate method is referenced by `chargeDraft`; the `requestHash` literal adds a JSON property only.)
- **Spec scenarios satisfied** — full coverage (test command is the canonical evidence gate per `openspec/config.yaml`).
- **Rollback boundary**: if either gate fails, identify the failing phase and revert that work unit (Phases 1–3 are independently reverted).

### [x] 4.2 Post-apply bounded review <!-- sdd-owner: parent -->

- Inspect the applied diff against `openspec/changes/pos-sale-delivery/design.md` ADR-1 through ADR-5; confirm the five ADRs land as written and that no `SHIPPED` writer, CASL action, or repository signature was touched.
- Confirm that all acceptance criteria in `proposal.md` (six bullets) map to at least one passing test in `src/sales/sales.service.spec.ts` or `src/sales/domain/sale.entity.spec.ts`.
- Mark this SDD change ready for archive per `openspec/config.yaml → archive` rules.

---

## Work-unit summary (commit/PR mapping)

Each phase above is a self-contained work unit; per `work-unit-commits`, tests stay with their behavior commit and the parent gating action is recorded separately. Recommended commit sequence:

1. `feat(sales): add optional delivery flag to ChargeSaleDto` (Phase 1).
2. `feat(sales): add Sale.markForDelivery domain guard with tests` (Phase 2.1 + 2.2).
3. `feat(sales): honor delivery flag in chargeDraft (idempotency hash + aggregate call + persistChargeConfirmation pass-through) with tests` (Phases 3.1 + 3.2 + 3.3).
4. `chore(sales): verify pos-sale-delivery with pnpm test + pnpm build` (Phase 4.1 evidence).

All four land together as a single PR (~140 additions, well under the 400-line budget) stacked to `main`; the post-apply bounded review (Phase 4.2) is the only parent-owned action.


---

## Apply progress (`sdd-apply` phase)

| Work unit | Status | Notes |
|-----------|--------|-------|
| Phase 1.1 — DTO `delivery` field | done | `IsBoolean` added to imports; field placed after `dueDate`; `pnpm build` clean |
| Phase 2.1 — RED `markForDelivery` tests | done | 3 tests added in `sale.entity.spec.ts` next to `setShippingAddress`; RED confirmed by failure on `is not a function` |
| Phase 2.2 — GREEN `markForDelivery` impl | done | method placed after `setShippingAddress` per design ADR-1; 111/111 entity tests |
| Phase 3.1 — RED `chargeDraft` tests | done | 5 tests inside the `chargeDraft` describe |
| Phase 3.2 — GREEN `markForDelivery` call + `requestHash` | done | call placed after DRAFT guard and before pricing recompute; `delivery: dto.delivery ?? false` added to `requestHash` |
| Phase 3.3 — GREEN `deliveryStatus` pass-through | done | `deliveryStatus: sale.deliveryStatus` added to the `persistChargeConfirmation` input, ADR-2 style |
| Phase 4.1 — full test + build gate | done | `pnpm test` 2940/2940; `pnpm build` clean |
| Phase 4.2 — bounded review | parent | deferred; not in sdd-apply scope |

### Final test summary

- `sale.entity.spec.ts`: 111 passed (108 baseline + 3 new `markForDelivery` tests)
- `sales.service.spec.ts`: 236 passed (231 baseline + 5 new pos-sale-delivery tests; one pre-existing WU2 legacy-hash assertion updated to reflect the new ADR-4 hash literal)
- Full project suite: 2940 passed / 2940 total
- `pnpm build`: zero TypeScript errors

### Deviations from ADRs / tasks

None. All five ADRs land as written. No CASL/permission change, no schema/migration/repository signature, no `SHIPPED` writer, no `ListSalesDeliveryStatus` widening.

### Files changed (apply evidence)

- `src/sales/dto/charge-sale.dto.ts`
- `src/sales/domain/sale.entity.ts`
- `src/sales/domain/sale.entity.spec.ts`
- `src/sales/sales.service.ts`
- `src/sales/sales.service.spec.ts`

### Rollback boundary

Per-task rollback boundaries from `tasks.md` apply. The WU2 legacy-hash test edit is the only test wording that became stale because of the additive `delivery` field in the JSON literal; reverting the service-side `requestHash` change alone would re-break that test, so any rollback must restore both halves together.
