# Tasks: Variant-Level Promotion Targeting (POS)

## Forecast

~230–290 net changed lines.
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: n/a (solo dev, work-unit commits)
400-line budget risk: Low

Branch `feat/variant-level-promo-targeting`; one commit per work unit; rollback = `git revert <sha>`. Pre-flight: confirm bug #2911.

## Work Unit 1 — Schema & Migration

- [x] 1.1 RED `prisma migrate dev --create-only` emits ONLY `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';`.
- [x] 1.2 GREEN `prisma/schema.prisma:89-93` — add `VARIANTS` to `enum PromotionTargetType`.
- [x] 1.3 Apply/rollback on `.env.test` postgres (port 5433); snapshot `pg_type`; confirm zero row loss.
- [x] 1.4 Boundary `pnpm test:unit` — zero new failures.

## Work Unit 2 — Domain Entity & DTO Enum

- [x] 2.1 RED `PromotionTargetType` accepts `'VARIANTS'`; `createPromotion({appliesTo:'VARIANTS', targetItems:[{targetType:'VARIANTS', targetId:'V-A'}]})` does not throw. `PromotionTargetTypeEnum.VARIANTS` exists.
- [x] 2.2 GREEN `src/promotions/domain/promotion.entity.ts:15` — add `'VARIANTS'`.
- [x] 2.3 GREEN `src/promotions/dto/create-promotion.dto.ts:35-39` + `update-promotion.dto.ts` — add `VARIANTS`.
- [x] 2.4 Boundary `pnpm test:unit` — zero new failures.

## Work Unit 3 — Shared `matchTargetTier` Helper

- [x] 3.1 RED `pos-evaluate-promotions.use-case.spec.ts` table-driven: `'VARIANT'` on VARIANTS-`line.variantId`; `'PRODUCT'` on PRODUCTS-`line.productId`; `null` on neither; null `variantId` never matches VARIANTS; CATEGORIES/BRANDS → `null`; combined VARIANTS+V-B + PRODUCTS+P1 promo on V-A line → `'VARIANT'`. *(Scenarios 1, 2, 3, 4, 7.)*
- [x] 3.2 GREEN export `matchTargetTier(targetItems, line): 'VARIANT'|'PRODUCT'|null` from `pos-evaluate-promotions.use-case.ts`; side literal `'DEFAULT'`.
- [x] 3.3 Boundary `pnpm test:unit -- pos-evaluate-promotions.use-case.spec` — green.

## Work Unit 4 — Wire Match Sites & Precedence

- [x] 4.1 RED `targetableManualPromotionIds` (`:225-237`) — replace inline predicate with `matchTargetTier(...) !== null`; opted-in MANUAL VARIANTS promo on V-A draft appears in result.
- [x] 4.2 RED `pickBestPerLine` (`:328-334`) — replace `targetsProduct` with `tier = matchTargetTier(...)`; collect `{promo, tier, discountCents}`.
- [x] 4.3 RED precedence pre-pass — any candidate `tier==='VARIANT'` ⇒ drop `tier==='PRODUCT'` candidates.
- [x] 4.4 RED `isSupportedEngineType` (`:282-290`) — true for `appliesTo='VARIANTS'`.
- [x] 4.5 RED regression — opted-in MANUAL VARIANTS promo survives second recompute after unrelated line added; PRODUCTS on P1 (V-A, V-B) applies to both lines. *(Scenarios 5, 6, 8, 9.)*
- [x] 4.6 GREEN wire all; best-wins (`:374-389`) untouched.
- [x] 4.7 Boundary `pnpm test:unit` — scenarios 1–9 green.

## Work Unit 5 — `validateTargetIds` VARIANTS Branch

- [x] 5.1 RED `promotions.service.spec.ts` — VARIANTS with existing tenant variant id accepted (10); non-existent variant id → `InvalidArgumentError('Variant with id \'V-MISSING\' not found', 'INVALID_TARGET')`, no rows persisted (11); cross-tenant variant id rejected as not found (12).
- [x] 5.2 GREEN `src/promotions/promotions.service.ts:528-580` — add `case 'VARIANTS'` via `tenantClient.variant.findMany({where:{id:{in:uniqueIds}}, select:{id:true}})`; add `'Variant'` to entity-name ternary.
- [x] 5.3 Boundary `pnpm test:integration` (port 5433, `.env.test`) — green.

## Work Unit 6 — End-to-End Integration Sweep

- [x] 6.1 RED 12 spec-scenario-named integration cases driving `PosEvaluatePromotionsUseCase` end-to-end on a seeded tenant; all pass.
- [x] 6.2 Boundary `pnpm test:unit && pnpm test:integration` — green, zero new lint warnings.
- [x] 6.3 `git diff --stat`; assert ≤ 400 changed lines.

## DEFERRED — out of slice (NOT gaps)

CATEGORIES/BRANDS targeting (needs `SaleItem` category/brand snapshot columns); online/cart engine `evaluate-cart-promotions.use-case.ts` (out-of-scope); BUY_X_GET_Y, ADVANCED, priority/stacking, usage limits, tax, frontend.
