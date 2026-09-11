# Tasks — Protect confirmed sales

Eight focused units implement the five requirements/27 scenarios in `specs/sales/spec.md` per the approved `design.md`: public `Sale.ensureDraft` including the shared `recomputePricingAndPromotions` guard; scoped `saveDraftItems` port requiring BOTH incoming and existing status DRAFT before writes (missing never creates); generic non-DRAFT existing rejects incoming DRAFT and changed item snapshots before any write while preserving generic creation and legitimate metadata saves; persisted delete guard; six specialized workflows unchanged. Tests exist; each unit sequences RED → GREEN → TRIANGULATE → REFACTOR. No runtime/test execution now. Every checkbox is single-line ending with `<!-- sdd-owner: implementation -->` on the same line. Document-line budget is separate from future implementation A+D budget.

## Review Workload Forecast

| Field                                                  | Value                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated changed lines (A+D)                          | **~1,112–1,868** future implementation A+D (production movement counted both ends; tests movement counted where expectations switch). Document lines ~310, not included. Total equals sum of per-unit subtotals below. |
| 400-line budget risk                                   | High                                                                                                                                                                                                                   |
| Chained PRs recommended                                | Yes                                                                                                                                                                                                                    |
| Proposed review slices (1:1 with units, chain pending) | PR 1 = WU1; PR 2 = WU2; PR 3 = WU3; PR 4 = WU4; PR 5 = WU5; PR 6 = WU6; PR 7 = WU7; PR 8 = WU8                                                                                                                         |
| Delivery strategy                                      | feature-branch-chain (resolved for WU1 only)                                                                                                                                                                           |
| Chain strategy                                         | feature-branch-chain                                                                                                                                                                                                   |

```text
Decision needed before apply: No (resolved strategy: feature-branch-chain for WU1)
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
```

Per-unit ranges (A+D, both ends counted for movement and replaced lines; every unit ≤ 400):

| Unit    | Prod A      | Prod D    | Test A       | Test D   | Subtotal        | Upper ≤ 400? |
| ------- | ----------- | --------- | ------------ | -------- | --------------- | ------------ |
| WU1     | 5–8         | 1         | 100–180      | 0        | 106–189         | Yes          |
| WU2     | 12–20       | 3–5       | 220–340      | 0        | 235–365         | Yes          |
| WU3     | 4–8         | 4–8       | 50–80        | 5–10     | 63–106          | Yes          |
| WU4     | 70–100      | 55–75     | 80–150       | 0        | 205–325         | Yes          |
| WU5     | 30–50       | 5–10      | 120–200      | 0        | 155–260         | Yes          |
| WU6     | 40–70       | 0         | 80–150       | 0        | 120–220         | Yes          |
| WU7     | 8–15        | 0         | 80–150       | 0        | 88–165          | Yes          |
| WU8     | 10–18       | 0         | 130–220      | 0        | 140–238         | Yes          |
| **Sum** | **179–289** | **68–99** | **860–1470** | **5–10** | **1,112–1,868** |              |

## Scenario / Requirement Traceability (27 scenarios, 5 requirements)

| Label | Scenario                                                             | Unit(s)            |
| ----- | -------------------------------------------------------------------- | ------------------ |
| R1.1  | addItem rejected for CONFIRMED sale                                  | WU1, WU2           |
| R1.2  | addItem rejected for CANCELED sale                                   | WU1, WU2           |
| R1.3  | updateItemQuantity rejected for CONFIRMED sale                       | WU1, WU2           |
| R1.4  | updateItemQuantity rejected for CANCELED sale                        | WU1, WU2           |
| R1.5  | clearItems rejected for CONFIRMED sale with items                    | WU1, WU2           |
| R1.6  | clearItems rejected for CANCELED sale                                | WU1, WU2           |
| R1.7  | removeItem rejected for CONFIRMED sale                               | WU1, WU2           |
| R1.8  | removeItem rejected for CANCELED sale                                | WU1, WU2           |
| R2.1  | deleteDraft rejected for CONFIRMED sale                              | WU2, WU8           |
| R2.2  | deleteDraft rejected for CANCELED sale                               | WU2, WU8           |
| R3.1  | clearItems on empty CONFIRMED sale is rejected                       | WU1, WU2           |
| R3.2  | clearItems on empty CANCELED sale is rejected                        | WU1, WU2           |
| R4.1  | Guard precedes item replacement on shared persistence path           | WU5, WU7           |
| R4.2  | Guard precedes sale deletion on shared persistence path              | WU8                |
| R4.3  | Legitimate non-DRAFT persistence path remains unblocked              | WU2, WU5, WU7, WU8 |
| R5.1  | Valid DRAFT addItem still accepted                                   | WU3                |
| R5.2  | Valid DRAFT updateItemQuantity still accepted                        | WU3                |
| R5.3  | Valid DRAFT clearItems (including empty) still accepted              | WU3                |
| R5.4  | Valid DRAFT removeItem still accepted                                | WU3                |
| R5.5  | Valid DRAFT deleteDraft still accepted                               | WU2                |
| R5.6  | Valid DRAFT item stacking still accepted                             | WU3                |
| R5.7  | Valid DRAFT invalid quantity rejection preserved                     | WU2                |
| R5.8  | Same-tenant wrong-owner draft mutation still rejected                | WU2                |
| R5.9  | Cross-tenant draft mutation rejected without disclosure              | WU2, WU8           |
| R5.10 | Missing sale on draft mutation still rejected                        | WU2                |
| R5.11 | Legitimate charge confirmation flow remains unchanged                | WU2, WU8           |
| R5.12 | Legitimate cancellation and payment recording flows remain unchanged | WU2, WU8           |

## Conventions

- **Test classification:** _regression baseline_ (passes after prior unit; must stay green), _new failing evidence_ (fails before this unit, passes after), _gate-correctness baseline_ (passes only when the gate is implemented correctly; pins a positive property).
- Public `Sale.ensureDraft()` called directly from service and from `recomputePricingAndPromotions`. No service-side helper.
- Four item callers (`addItem`, `updateItemQuantity`, `clearItems`, `removeItem`) route through `saveDraftItems`; `deleteDraft` keeps `saleRepo.delete`.
- Six specialized contracts (`persistChargeConfirmation`, `persistCancellation`, `persistCollectedPayments`, `persistCollectedPayment`, `updatePaymentReference`, `markSaleDelivered`) are out of every new gate's scope; tests reuse existing fixtures and valid preconditions.
- Per-method missing contracts (preserved): `addItem`/`updateItemQuantity`/`clearItems`/`deleteDraft` → `EntityNotFoundError('Sale', id)`; `removeItem` → `BusinessRuleViolationError('SALE_NOT_FOUND','SALE_NOT_FOUND')`. Cross-tenant: all five return the missing-contract error (no disclosure).
- Commands use Jest file-path focus only (no `--testNamePattern`); `pnpm build` covers TS compile.
- Each unit must compile at completion; previous units' tests must stay green.
- **Single-writer discipline:** WU4 → WU5 → WU6 → WU7 → WU8 share `src/sales/infrastructure/prisma-sale.repository.ts` and its spec file. No parallel writes — each unit lands after the previous; rollback removes only that unit's hunks (and dependent downstream units) without wiping earlier units' changes.

---

## WU1 — Domain guards in Sale entity

- **Start:** `src/sales/domain/sale.entity.ts` has `private ensureDraft()` (~line 762); 4 item methods mutate without lifecycle check.
- **Finish:** `ensureDraft()` is public; 4 item methods call `this.ensureDraft()` first.
- **Depends on:** none.
- **Files:** `src/sales/domain/sale.entity.ts`, `src/sales/domain/sale.entity.spec.ts`.
- **Forecast:** Prod A 5–8 (visibility ≈1 A + 1 D; four guard insertions ≈4 A), Prod D 1, Test A 100–180, Test D 0. **Subtotal 106–189.**
- **Verify:** `pnpm test -- src/sales/domain/sale.entity.spec.ts`; `pnpm build`.
- **Rollback:** revert entity.ts (visibility + 4 guard lines) + entity spec additions.
- **Partial:** not deploy-complete alone — service still calls unguarded `save`; WU2 must land first.

Tasks:

- [x] RED — write failing tests in `src/sales/domain/sale.entity.spec.ts` under `describe('protect-confirmed-sales — domain guards', …)` for R1.1–R1.8 (one `it` per operation × status) and R3.1/R3.2 (empty-clear × status). Build non-DRAFT sale via `Sale.fromPersistence`; assert `BusinessRuleViolationError('SALE_NOT_DRAFT','SALE_NOT_DRAFT')` plus zero item mutation. New failing evidence. <!-- sdd-owner: implementation -->
- [x] GREEN — change `private ensureDraft()` to `ensureDraft()` in `src/sales/domain/sale.entity.ts` (~line 762). Insert `this.ensureDraft();` as the first statement of `addItem` (before `SaleItem.create`), `updateItemQuantity`, `clearItems`, `removeItem`. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE — per-method check: forbidden op on non-DRAFT leaves items array reference and length unchanged. Regression baseline for pre-existing tests must stay green. <!-- sdd-owner: implementation -->
- [x] REFACTOR — guard insertions one-line each; no service-side helper, no traceability comment. Pre-existing tests remain green. <!-- sdd-owner: implementation -->

---

## WU2 — Service guards, recompute guard, port + mock wiring, R5 mock-boundary

- **Start:** WU1 complete. Three item service methods (`addItem`, `updateItemQuantity`, `clearItems`) plus `deleteDraft` lack lifecycle guard; `removeItem` already has its inline `SALE_NOT_FOUND → SALE_NOT_DRAFT → SALE_UPDATE_FORBIDDEN` guard (existing convention, not a new assumption); `recomputePricingAndPromotions` clears discounts without lifecycle check. Port has no `saveDraftItems`; typed mock matches the current port.
- **Finish:** `addItem`/`updateItemQuantity`/`clearItems`/`deleteDraft` call `sale.ensureDraft()` after the ownership check; `removeItem` reorders to `missing → ownership → lifecycle` (`SALE_UPDATE_FORBIDDEN` preserved). `recomputePricingAndPromotions` calls `sale.ensureDraft()` first. Port gains `saveDraftItems(sale: Sale): Promise<Sale>`; typed mock returns `jest.fn()`; Prisma adapter stub delegates to `save` (partial protection until WU5).
- **Depends on:** WU1.
- **Files:** `src/sales/domain/sale.repository.ts`, `src/sales/sales.service.ts`, `src/sales/infrastructure/prisma-sale.repository.ts` (stub), `src/sales/sales.service.spec.ts`.
- **Forecast:** Prod A 12–20, Prod D 3–5, Test A 220–340 (includes the direct recompute RED test), Test D 0. **Subtotal 235–365.**
- **Verify:** `pnpm test -- src/sales/sales.service.spec.ts`; `pnpm build`.
- **Rollback:** revert the four files; entity guards stay.
- **Partial:** stub `saveDraftItems` does NOT gate persistence; service rejection is the only protection until WU5.

Tasks:

- [x] RED — in `src/sales/sales.service.spec.ts` add `saveDraftItems: jest.fn()` to `makeMockSaleRepo`. Write failing tests under `describe('protect-confirmed-sales — service guards', …)` for R1.1–R1.8. For addItem (R1.1/R1.2) and updateItemQuantity (R1.3/R1.4), additionally assert the service guard fires before the dependent call: monkey-patch `productsService.getProductInfoForSale` (addItem) or `productsService.checkStockAvailability` (updateItemQuantity) to throw on call and assert `SALE_NOT_DRAFT` rejection surfaces before the throw. For clearItems (R1.5/R1.6) and removeItem (R1.7/R1.8) assert only the rejection code plus zero item mutation (those two methods have no product-service dependent call to test against; removeItem's existing inline guard already throws before the engine call). Lifecycle assertions pass after WU1 entity guards (regression baseline); before-dependent-call assertions for addItem/updateItemQuantity are new failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — write failing tests for R2.1/R2.2 (`deleteDraft` against CONFIRMED/CANCELED returns `BusinessRuleViolationError`; `expect(saleRepo.delete).not.toHaveBeenCalled()`). New failing evidence. <!-- sdd-owner: implementation -->
- [x] RED — write tests for R3.1/R3.2 (empty non-DRAFT `clearItems` rejects; rejection code plus zero item mutation). Regression baseline after WU1 entity guard. Note: before the routing switch the service does not call `saveDraftItems` for non-DRAFT, so assertions about whether `saveDraftItems` was or was not called are trivially satisfied; the only meaningful assertions are the rejection code and zero item mutation. <!-- sdd-owner: implementation -->
- [x] RED — write R5.5/R5.7/R5.8/R5.9/R5.10 baseline tests and R5.11/R5.12 mock-boundary tests reusing existing fixtures. R5.5 valid DRAFT `deleteDraft` asserts `expect(saleRepo.delete).toHaveBeenCalled()` (no saveDraftItems expectation; deleteDraft uses `saleRepo.delete`). R5.7 DRAFT invalid quantity asserts rejection before persistence. R5.8 same-tenant wrong-owner asserts the existing ownership `BusinessRuleViolationError` message before persistence. R5.9 cross-tenant `findById → null` asserts the per-method missing-contract error with no disclosure. R5.10 missing asserts the per-method contract distinction. R5.11 charge service starts from a valid DRAFT ready for confirmation; assert `persistChargeConfirmation` is invoked and no `SALE_NOT_DRAFT` surfaces. R5.12 cancel/payment starts from a CONFIRMED; assert `persistCancellation` / `persistCollectedPayments` are invoked. Regression baseline after WU1. <!-- sdd-owner: implementation -->
- [x] GREEN — add `saveDraftItems(sale: Sale): Promise<Sale>;` to `ISaleRepository` in `src/sales/domain/sale.repository.ts` (immediately under `save`). Add stub `async saveDraftItems(sale: Sale): Promise<Sale> { return this.save(sale); }` to `PrismaSaleRepository` in `src/sales/infrastructure/prisma-sale.repository.ts`. <!-- sdd-owner: implementation -->
- [x] GREEN — in `src/sales/sales.service.ts` insert `sale.ensureDraft();` directly after the ownership check in `addItem`, `updateItemQuantity`, `clearItems`, `deleteDraft`. In `removeItem` reorder the existing three-line guard to `missing → ownership → lifecycle` (`SALE_UPDATE_FORBIDDEN` preserved). R1.x/R2.x/R3.x RED tests turn green; pre-existing service tests stay green. <!-- sdd-owner: implementation -->
- [x] RED — write a failing test for the shared recompute guard: build a non-DRAFT sale (CONFIRMED or CANCELED) with one item carrying a discount, invoke `recomputePricingAndPromotions` via a typed test-only probe (declare a narrow local interface `RecomputeProbe` in the test file exposing the private method by signature, then narrow-cast the service instance to it — NOT `as any`); assert `BusinessRuleViolationError('SALE_NOT_DRAFT','SALE_NOT_DRAFT')`, `expect(posEvaluateUseCase.evaluate).not.toHaveBeenCalled()`, and the item's `discountAmountCents` is unchanged. New failing evidence. Place the test BEFORE the GREEN guard implementation. <!-- sdd-owner: implementation -->
- [x] GREEN — insert `sale.ensureDraft();` as the first statement of `recomputePricingAndPromotions` in `src/sales/sales.service.ts` (before the discount-clear loop and before `evaluatePromotionsForSale`). Future verification covers the recompute RED test turning green; the existing public-method paths (addItem/updateItemQuantity/removeItem) call recompute after the service guard fires, so the guard is also exercised by those tests as defense-in-depth. <!-- sdd-owner: implementation -->
- [x] REFACTOR — service guard insertions stay inline `sale.ensureDraft();`; the recompute guard is also inline. No helper. Pre-existing service tests remain green. <!-- sdd-owner: implementation -->

---

## WU3 — Routing switch (save → saveDraftItems) + valid item mutation baseline

- **Start:** WU2 complete. Service item callers route via `saleRepo.save`; `saveDraftItems` exists in the port but is unused by callers.
- **Finish:** the four item callers (`addItem`, `updateItemQuantity`, `clearItems`, `removeItem`) call `saleRepo.saveDraftItems(sale)`; `deleteDraft` keeps `saleRepo.delete`. R5.1/R5.2/R5.3/R5.4/R5.6 baseline tests pass with the new `saveDraftItems` expectation.
- **Depends on:** WU2.
- **Files:** `src/sales/sales.service.ts`, `src/sales/sales.service.spec.ts`.
- **Forecast:** Prod A 4–8 (four swap edits), Prod D 4–8, Test A 50–80, Test D 5–10. **Subtotal 63–106.**
- **Verify:** `pnpm test -- src/sales/sales.service.spec.ts`; `pnpm build`.
- **Rollback:** revert the swap edits + revert the test expectation updates.
- **Partial:** persistence layer not yet gated; routing switch alone is not deploy-complete.

Tasks:

- [x] RED — in `src/sales/sales.service.spec.ts` write R5.1/R5.2/R5.3/R5.4/R5.6 valid-item-mutation tests asserting `expect(saleRepo.saveDraftItems).toHaveBeenCalled()` AND `expect(saleRepo.save).not.toHaveBeenCalled()`. These fail until the routing switch lands. Do NOT extend this expectation to R5.5 (`deleteDraft` uses `saleRepo.delete`), R5.7 (invalid quantity throws before persistence), R5.8/R5.9/R5.10 (rejected before persistence). This RED runs BEFORE the GREEN switch. <!-- sdd-owner: implementation -->
- [x] GREEN — switch the four item callers from `await this.saleRepo.save(sale);` to `await this.saleRepo.saveDraftItems(sale);` in `addItem`, `updateItemQuantity`, `clearItems`, `removeItem` (`deleteDraft` continues with `saleRepo.delete`). R5.1/R5.2/R5.3/R5.4/R5.6 RED tests turn green. <!-- sdd-owner: implementation -->
- [x] REFACTOR — confirm the Part A baseline tests (R5.1/R5.2/R5.3/R5.4/R5.6) align with the new routing; Part B tests (R5.5/R5.7/R5.8/R5.9/R5.10) keep their existing assertions unchanged. <!-- sdd-owner: implementation -->

---

## WU4 — Repository projection refactor (extract `toWriteRow`) + characterization tests

- **Start:** WU3 complete. `PrismaSaleRepository.save` inlines the `createMany` payload; `saveDraftItems` stub delegates to `save`.
- **Finish:** a private `toWriteRow(item, saleId, tenantId)` produces the same `Prisma.SaleItemCreateManyInput` payload currently emitted inline. `save` body replaces the inline literal with `sale.items.map((i) => this.toWriteRow(i, sale.id, tenantId))`. Column schema is read from the actual current save projection (no hand-maintained list). No behavior change. Characterization tests pin current behavior before and after refactor.
- **Depends on:** WU3.
- **Files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`.
- **Forecast:** Prod A 70–100, Prod D 55–75 (inline `createMany` data moved out, both ends counted; the actual source projection is ≈60 lines), Test A 80–150, Test D 0. **Subtotal 205–325.**
- **Verify:** `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts`; `pnpm build`.
- **Rollback:** revert `toWriteRow` extraction + characterization tests. `save` returns to its inline form.
- **Partial:** pure refactor (no new gate). Required by WU5/WU6/WU7 to reuse the projection.

Tasks:

- [x] RED — in `prisma-sale.repository.spec.ts` add a characterization test asserting the current `save` payload: configure `makeMockPrisma` to capture the `createMany` call; assert the captured payload's first row matches every column currently emitted by the inline `createMany` (including `tenantId`, id/parent, pricing, discount/reward fields, timestamps). Regression baseline before refactor. <!-- sdd-owner: implementation -->
- [x] GREEN — extract `private toWriteRow(item: SaleItem, saleId: string, tenantId: string): Prisma.SaleItemCreateManyInput` returning the exact payload the inline `createMany` builds. Required behavior: normalize `priceSource` and `rewardKind` to their uppercase Prisma forms; preserve `discountType` in its existing lowercase Prisma form (`amount` | `percentage`); use `saleId` from the outer aggregate parameter, not from the entity. Replace the inline literal in `save` with `sale.items.map((i) => this.toWriteRow(i, sale.id, tenantId))`. Do NOT introduce a hand-maintained column list. <!-- sdd-owner: implementation -->
- [x] REFACTOR — keep the existing `prisma.sale.update` / `prisma.sale.create` branching inline inside `save`; no extra helper. Characterization test passes; pre-existing `save` tests stay green. <!-- sdd-owner: implementation -->

---

## WU5 — Repository intent gates (DRAFT intent + forged gate)

- **Start:** WU4 complete. `save` writes via `toWriteRow`; `saveDraftItems` stub delegates to `save`. Both share the inline item-recreate path.
- **Finish:** private `writeImpl(sale, intent: 'DRAFT'|'GENERIC')` entered by both `save` (intent `GENERIC`) and `saveDraftItems` (intent `DRAFT`). Before any write, load persisted status via the tenant-scoped client. Persisted items are NOT loaded here (WU7 loads them). DRAFT intent matrix:
  - existing DRAFT + incoming DRAFT → proceed
  - existing non-DRAFT (CONFIRMED/CANCELED) + incoming DRAFT → reject `SALE_NOT_DRAFT`
  - existing DRAFT + incoming non-DRAFT (CONFIRMED/CANCELED, identical items) → reject `SALE_NOT_DRAFT` (incoming-status gate)
  - existing missing → reject `EntityNotFoundError('Sale', sale.id)`, never create
  - GENERIC forged gate: existing non-DRAFT + incoming DRAFT (identical items) → reject `SALE_NOT_DRAFT`
  - GENERIC legitimate paths: existing non-DRAFT + incoming non-DRAFT (identical items) → proceed; existing missing + any incoming → create (openDraft / generic creation preserved).
- **Depends on:** WU4.
- **Files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`.
- **Forecast:** Prod A 30–50, Prod D 5–10, Test A 120–200, Test D 0. **Subtotal 155–260.**
- **Verify:** `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts`; `pnpm build`.
- **Rollback:** revert `writeImpl`; stub re-delegates to `save`. Service guards remain.
- **Partial:** identity-keyed snapshot compare is in WU7. Deploy requires WU5 + WU7 + WU8.

Tasks:

- [ ] RED — in `prisma-sale.repository.spec.ts` add tests for the DRAFT intent matrix: existing DRAFT + incoming CONFIRMED (identical items) and existing DRAFT + incoming CANCELED (identical items) reject `SALE_NOT_DRAFT`; existing CONFIRMED + incoming DRAFT and existing CANCELED + incoming DRAFT reject `SALE_NOT_DRAFT`; existing missing rejects `EntityNotFoundError('Sale', sale.id)` with no `prisma.sale.create` call; existing DRAFT + incoming DRAFT happy path proceeds (regression baseline after WU4 refactor). New failing evidence. <!-- sdd-owner: implementation -->
- [ ] RED — add tests for the GENERIC intent forged gate: existing non-DRAFT + incoming DRAFT + identical items rejects `SALE_NOT_DRAFT` with no `createMany`/`update`/`updateMany` called. New failing evidence. <!-- sdd-owner: implementation -->
- [ ] RED — add tests for GENERIC legitimate paths (regression baseline): existing non-DRAFT + incoming non-DRAFT + identical items proceeds; existing missing + any incoming → `prisma.sale.create` invoked. <!-- sdd-owner: implementation -->
- [ ] GREEN — add private `writeImpl(sale, intent)` that loads persisted status via `prisma.sale.findUnique({ where: { id: sale.id }, select: { id: true, status: true } })`, applies the DRAFT intent matrix and the GENERIC forged gate, then reuses the existing create-or-update + `deleteMany`/`createMany` via `toWriteRow`. Rewire `save(sale) => this.writeImpl(sale,'GENERIC')` and `saveDraftItems(sale) => this.writeImpl(sale,'DRAFT')`. Persisted items remain unloaded at this stage (WU7 loads them). <!-- sdd-owner: implementation -->
- [ ] TRIANGULATE — verify promotion junction tables (veto / opt-in / applied-promo) reconcile for both intents; verify the pre-write `findUnique` uses the tenant-scoped client (configure `makeMockPrisma` so a persisted row whose tenantId differs from `getTenantId` returns `null`; the DRAFT-intent case rejects with `EntityNotFoundError`, no create or update). <!-- sdd-owner: implementation -->
- [ ] REFACTOR — inline `prisma.sale.update` / `prisma.sale.create` branching stays inside `writeImpl`; no extra helper. Pre-existing `save` tests stay green. <!-- sdd-owner: implementation -->

---

## WU6 — Repository snapshot equality helper (pure normalized comparison, complete unit tests)

- **Start:** WU5 complete. `writeImpl` applies the intent gate; no snapshot compare exists.
- **Finish:** pure `snapshotItemsEqual(incoming, persisted, saleId, tenantId)` returns `true` ONLY when both sides project to the same normalized representation with matching cardinality: identity-keyed by `id`, every mapped column equivalent, order-independent, with null / date / enum parity, AND no missing or extra ids on either side. The helper returns `false` on any missing or extra mapping, on any per-id value mismatch across every mapped column, and never falls back to reference equality. `toWriteRow` provides the incoming projection (already extracted in WU4). A typed `toPersistedRow(rawPersistedRow)` provides the persisted projection — raw Prisma rows are NEVER fed through the domain projection; the persisted side is normalized separately and uses the SAME column schema as the incoming side (including id / parent / `tenantId` fields as emitted, nulls preserved, dates as ISO, enums in canonical Prisma form). Test-only access to the private helper uses a narrow local typed adapter in the spec file (no `as any`, no production code API change).
- **Depends on:** WU5 (serial, single-writer; WU6 must wait for WU5's `writeImpl` skeleton to land on the same `prisma-sale.repository.ts` shared file).
- **Files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`.
- **Forecast:** Prod A 40–70, Prod D 0, Test A 80–150, Test D 0. **Subtotal 120–220.**
- **Verify:** `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts`; `pnpm build`.
- **Rollback:** revert `toPersistedRow` + `snapshotItemsEqual`. `writeImpl` keeps the WU5 intent gate; snapshot compare block removed.
- **Partial:** helper exists but is not yet wired. Deploy requires WU5 + WU6 + WU7 + WU8.

Tasks:

- [ ] RED — in `prisma-sale.repository.spec.ts` add `describe('snapshotItemsEqual — pure comparison', …)` cases (no `writeImpl` involvement; access the private helper via a narrow local typed adapter in the test file, no `as any`): equivalent domain-lowercase vs persisted-uppercase enum values compare equal after canonical projection (e.g., domain `priceSource: 'price_list'` equals persisted `'PRICE_LIST'`); genuinely different enum values reject (e.g., `'PRICE_LIST'` vs `'CUSTOM'`, `'BUY_X_GET_Y'` vs `'ADVANCED'`); null-vs-null parity; `Date` ISO parity; identity-keyed equivalence with shuffled order (same ids, same columns → equal); missing-id on incoming side (incoming id not in persisted → not equal); missing-id on persisted side (persisted id not in incoming → not equal); every mapped column parametrized individually (parametrize over the columns the projection actually emits — pricing, discount, reward, image, name, parent, `tenantId`, timestamps) → one column differs → not equal. Independent persisted snapshots (different object refs from `sale.items`); no reference equality shortcut. Gate-correctness baseline. <!-- sdd-owner: implementation -->
- [ ] RED — add `describe('snapshotItemsEqual — independent-snapshot mutable-bypass', …)`: independent persisted snapshot; mutate only the incoming side between calls and verify the helper returns `false`. The persisted snapshot stays unchanged (different object). Gate-correctness baseline. <!-- sdd-owner: implementation -->
- [ ] GREEN — declare a typed `PersistedItemSnapshot` shape covering every column the current save projection emits (id / parent / `tenantId` / pricing / discount / reward / timestamps as appropriate), in normalized form. Declare a typed `PrismaSaleItemRow` for the raw persisted row shape. Add `private toPersistedRow(row)` normalizing raw Prisma to `PersistedItemSnapshot`. Add `private snapshotItemsEqual(incoming, persisted, saleId, tenantId)` mapping incoming via `toWriteRow` and persisted via `toPersistedRow`, grouping both by `id`, returning `false` on size mismatch or any per-id value mismatch across every mapped column. Same normalized column representation on both sides. <!-- sdd-owner: implementation -->
- [ ] REFACTOR — `toPersistedRow` and `snapshotItemsEqual` are the only new helpers. No `normalizeItemForCompare`. No BigInt handling (mapped columns are not BigInt). Pre-existing `save` tests stay green. <!-- sdd-owner: implementation -->

---

## WU7 — Repository wire snapshot equality into writeImpl('GENERIC')

- **Start:** WU5 + WU6 complete. `writeImpl('GENERIC')` performs create-or-update + item recreate; the WU5 forged gate runs; `snapshotItemsEqual` exists but is not wired.
- **Finish:** `writeImpl('GENERIC')` explicitly bypasses the snapshot compare in two cases: (a) existing row missing (creation preserved — `prisma.sale.create` runs); (b) existing row status is DRAFT (the WU5 intent gate already accepted). Only the existing-non-DRAFT branch invokes `snapshotItemsEqual`. On mismatch in that branch, reject `SALE_NOT_DRAFT`. The wire runs AFTER the WU5 forged gate, BEFORE any `deleteMany`/`createMany`/`update`/`updateMany` and BEFORE any promotion-junction reconciliation. On rejection: zero writes (no `deleteMany`, no `createMany`, no `update`, no `updateMany`, no promotion-junction reconciliation).
- **Depends on:** WU5, WU6.
- **Files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`.
- **Forecast:** Prod A 8–15, Prod D 0, Test A 80–150, Test D 0. **Subtotal 88–165.**
- **Verify:** `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts`; `pnpm build`.
- **Rollback:** remove the wire-in + persisted-items load; `writeImpl` keeps WU5 gates.
- **Partial:** delete lifecycle not yet gated (WU8). Deploy requires WU5 + WU6 + WU7 + WU8.

Tasks:

- [ ] RED — in `prisma-sale.repository.spec.ts` add `describe('writeImpl GENERIC — snapshot compare wired', …)` cases: (existing non-DRAFT branch) existing non-DRAFT + incoming non-DRAFT + independent persisted snapshot differing on one mapped column rejects `SALE_NOT_DRAFT` with NO writes invoked at all (assert zero `deleteMany`/`createMany`/`update`/`updateMany` plus no promotion-junction reconciliation on `veto`/`optIn`/`applied`); (existing non-DRAFT branch) independent persisted snapshot matching every column proceeds, single `createMany` invoked; (existing missing branch) incoming creates without compare firing — assert `prisma.sale.create` invoked, no `findUnique`/`findFirst` snapshot load; (existing DRAFT branch) incoming updates proceed without compare firing — assert `prisma.sale.update` + `deleteMany` + `createMany` invoked; (non-DRAFT metadata-save unchanged) when independent persisted snapshot differs only on a non-item column (i.e., a column on the sale row, not in the items projection), the item compare is NOT the gate — confirm no false-positive rejection; (mutable-bypass) independent persisted snapshot, mutate only incoming side after the read, assert compare rejects. Parametrize over the columns the projection actually emits. New failing evidence for the wire-in cases; regression baseline for the bypass and metadata-save cases. <!-- sdd-owner: implementation -->
- [ ] GREEN — extend `writeImpl('GENERIC')`: after the WU5 forged gate, load persisted items (separate read from the WU5 status load) only when `existing !== null && existing.status !== 'DRAFT'`; in that branch call `snapshotItemsEqual` and throw `SALE_NOT_DRAFT` on `false`. On rejection, return before any write. Existing DRAFT and existing missing both skip the compare (preserved creation + preserved DRAFT update flows). <!-- sdd-owner: implementation -->
- [ ] REFACTOR — kept inline inside `writeImpl`; no extra helper. Pre-existing `save` tests stay green. <!-- sdd-owner: implementation -->

---

## WU8 — Repository delete lifecycle pre-check + specialized-contract regression

- **Start:** WU7 complete. `PrismaSaleRepository.delete(id)` calls `prisma.sale.delete({ where: { id } })` with no lifecycle pre-check.
- **Finish:** `delete(id)` reads persisted status via the tenant-scoped client before deletion; non-DRAFT rejects `SALE_NOT_DRAFT` with no `prisma.sale.delete` call; missing row still surfaces Prisma `P2025` from the existing `prisma.sale.delete`. The six specialized contracts keep their existing code paths; tests reuse existing valid fixtures and verify outcomes/side effects unchanged on their existing valid preconditions (charge from a valid DRAFT; cancellation and payment collection from a CONFIRMED; payment reference update on an existing payment; delivery flip from a CONFIRMED). Cross-tenant returns `null` from the lookup and surfaces `P2025` from the existing `prisma.sale.delete` (no disclosure).
- **Depends on:** WU7.
- **Files:** `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.spec.ts`.
- **Forecast:** Prod A 10–18, Prod D 0, Test A 130–220, Test D 0. **Subtotal 140–238.**
- **Verify:** `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts`; full `pnpm test`; `pnpm build`.
- **Rollback:** revert `delete` lifecycle read + specialized-contract regression tests. Service guards + WU5/WU7 gates remain.
- **Verification-eligible:** this unit completes the work-unit chain. After all units land, run final verification (see Final verification section). No deploy readiness until verification confirms the full suite and TS compile pass.

Tasks:

- [ ] RED — in `prisma-sale.repository.spec.ts` add `describe('delete — lifecycle protection', …)`: `delete('CONFIRMED-sale-id')` and `delete('CANCELED-sale-id')` reject `BusinessRuleViolationError('SALE_NOT_DRAFT','SALE_NOT_DRAFT')` with `prisma.sale.delete` not called; `delete('DRAFT-sale-id')` calls `prisma.sale.delete` once. Configure `makeMockPrisma` so `prisma.sale.findFirst` returns the desired `{ id, status }`. New failing evidence. <!-- sdd-owner: implementation -->
- [ ] RED — add `describe('delete — missing row surfaces P2025', …)` regression baseline: `findFirst` returns `null`, `prisma.sale.delete` is called and throws `P2025`, repo re-throws. <!-- sdd-owner: implementation -->
- [ ] GREEN — modify `async delete(id: string)` in `PrismaSaleRepository` (`src/sales/infrastructure/prisma-sale.repository.ts`, line ≈2019): before `prisma.sale.delete`, call `prisma.sale.findFirst({ where: { id, tenantId: this.requireTenantId() }, select: { id: true, status: true } })`. If row exists AND `status !== 'DRAFT'` → `throw new BusinessRuleViolationError('SALE_NOT_DRAFT','SALE_NOT_DRAFT')`. If row missing, fall through to the existing `prisma.sale.delete({ where: { id } })` so `P2025` still surfaces. <!-- sdd-owner: implementation -->
- [ ] TRIANGULATE — reuse existing valid fixtures and existing describe blocks in `prisma-sale.repository.spec.ts` for the six specialized contracts (`persistChargeConfirmation`, `persistCancellation`, `persistCollectedPayments`, `persistCollectedPayment`, `updatePaymentReference`, `markSaleDelivered`). Verify existing outcomes/side effects are unchanged when invoked with their existing valid inputs (charge from a valid DRAFT; cancellation and payment collection from a CONFIRMED; payment reference update on an existing payment; delivery flip from a CONFIRMED). Reuse existing fixtures; do not invent new Prisma calls or scenarios. None of these tests assert `SALE_NOT_DRAFT` thrown by the gate — the specialized contracts remain unblocked on their existing valid preconditions. <!-- sdd-owner: implementation -->
- [ ] TRIANGULATE — add a cross-tenant delete test: configure `makeTenantPrismaMock` so `prisma.sale.findFirst` returns `null` for the given id under the current tenant; `delete('sale-id')` falls through to `prisma.sale.delete` which throws `P2025`. Cross-tenant no-disclosure contract preserved. <!-- sdd-owner: implementation -->
- [ ] REFACTOR — lifecycle read stays inline inside `delete`; no extra helper. Pre-existing tests stay green. <!-- sdd-owner: implementation -->

---

## Out of scope (explicit non-goals — do NOT add tasks)

- Concurrency / stale-write / optimistic locking.
- Refunds / refund-settlement semantics.
- Reports, analytics, historical-debt redesign.
- Schema migrations, history backfills, event sourcing.
- New historical correction workflows or repair of previously corrupted rows.
- Branch / PR creation, commits, pushes.
- Child subagents, runtime harness execution, RDD receipts, delivery-gate tasks.

## Final verification (future, do not execute)

- `pnpm test -- src/sales/domain/sale.entity.spec.ts` (WU1 coverage)
- `pnpm test -- src/sales/sales.service.spec.ts` (WU2 + WU3 coverage)
- `pnpm test -- src/sales/infrastructure/prisma-sale.repository.spec.ts` (WU4–WU8 coverage)
- `pnpm test` (full Jest unit suite)
- `pnpm build` (TS compile; port interface change propagates cleanly)
- Manual scenario walkthrough against R1.1–R5.12 — every scenario has at least one passing test across the three spec files (verification step, not a current claim).
