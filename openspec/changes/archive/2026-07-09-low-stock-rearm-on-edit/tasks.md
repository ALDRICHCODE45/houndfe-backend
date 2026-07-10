# Tasks: Re-arm Low-Stock Alert on Product/Variant Edit

STRICT TDD — RED → GREEN per behavior. Adapter mirrors `incrementStockForRestock`; service wraps persistence tails in `runInTransaction`. 8 spec scenarios → 1:1 to tests.

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: not applicable
400-line budget risk: Low

~340–380 lines. Delivery: single-pr (branch + work-unit commits, no PRs). Split: not needed.

Work units: (1) Adapter port+impl+7 tests, (2) Service wrap+reroute+change-gate+7 tests, (3) full-suite green.

## Phase 1: Adapter

- [x] 1.1 `src/products/domain/product.repository.ts`: add `rearmAlertAfterEdit(item: { productId; variantId?: string|null }): Promise<void>` to `IProductRepository`
- [x] 1.2 RED `prisma-product.repository.spec.ts` — append `describe('rearmAlertAfterEdit — ambient-tx guard')`: throws on `isInTransaction()===false`, no `getClient()` call (Sc.7)
- [x] 1.3 RED product-path STRICT `>`: SELECT gates `"useStock"=true`; calls `alertState.rearm({tx, tenantId, productId, variantId:null})` (Sc.1)
- [x] 1.4 RED product-path STRICT `==`: no `rearm` (Sc.4)
- [x] 1.5 RED product-path 0 rows: no throw, no `rearm` (Sc.6 + Sc.8 simple)
- [x] 1.6 RED variant-path STRICT `>`: SELECT JOINs `products p ON p."useStock"=true AND p."tenantId"=v."tenantId"`; calls `rearm({..., variantId})` (Sc.2)
- [x] 1.7 RED variant-path parent `useStock=false`: JOIN gates it out, 0 rows, no `rearm` (Sc.8 variant)
- [x] 1.8 GREEN implement in `prisma-product.repository.ts`: mirror restock guard, `getClient()`+`getTenantId()`, two-branch SELECT, STRICT `>` gate, `alertState.rearm({tx:prisma, tenantId, productId, variantId: variantId ?? null})`

## Phase 2: Service wrap

- [x] 2.1 RED `update` with qty OR min: ONE `runInTransaction` holding `getClient().priceList.updateMany` + `productRepo.save` + (conditional) `getClient().variant.updateMany{minQuantity:0}` + `rearmAlertAfterEdit({productId: id, variantId: null})`; validation runs BEFORE wrap
- [x] 2.2 RED `update` with neither qty nor min: `rearmAlertAfterEdit` never called
- [x] 2.3 RED `update`: `alertState.seedAndFlip` mock never invoked under any edit permutation (Sc.5)
- [x] 2.4 RED `updateVariant` with qty OR min: `getClient().variant.update` + `rearmAlertAfterEdit({productId, variantId})` inside ONE `runInTransaction`; validation runs BEFORE wrap; `.then(enrichVariantCostResponse)` preserved
- [x] 2.5 RED `updateVariant` with neither qty nor min: `rearmAlertAfterEdit` never called
- [x] 2.6 RED `updateVariant` on parent `useStock=false`: rearm SELECT 0 rows ⇒ no `rearm` (Sc.8 service)
- [x] 2.7 GREEN `products.service.ts` ~665–691: re-route L673 (`priceList.updateMany`) and L687 (`variant.updateMany`) to `tenantPrisma.getClient()`; wrap all persistence + rearm in `tenantPrisma.runInTransaction`; gate rearm on `dto.quantity !== undefined || dto.minQuantity !== undefined`
- [x] 2.8 GREEN `updateVariant` ~834: re-route `this.prisma.variant.update` to `tenantPrisma.getClient().variant.update`; wrap variant.update + rearm in `tenantPrisma.runInTransaction`; gate rearm on qty/min presence

## Phase 3: Verification

- [x] 3.1 Run `pnpm run test`; confirm baseline 1506 green, zero new failures, all 8 edit-path scenarios pass

## Scenario coverage

| # | Spec scenario | Tests |
|---|---------------|-------|
| 1 | Edit raises simple → rearm | 1.3, 2.1 |
| 2 | Edit raises variant → rearm with variantId | 1.6, 2.4 |
| 3 | Edit lowers minQuantity only → rearm (RESULTING pair) | 2.1, 2.4 |
| 4 | stock == min → NO rearm (STRICT `>`) | 1.4 |
| 5 | Downward → no seedAndFlip, no event | 2.3 |
| 6 | No pre-existing alert-state row → harmless no-op | 1.5 |
| 7 | Ambient-tx guard throws; service wraps it | 1.2, 2.1, 2.4 |
| 8 | useStock=false → no alert logic, no error | 1.5, 1.7, 2.6 |
