# Tasks: Activate CATEGORIES & BRANDS Targeting in POS Promotion Engine

> Branch `feat/category-brand-promo-targeting`. One commit per work unit. No PRs (solo dev). Strict TDD (RED first; `apply.tdd:false` overridden). No migration.

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: n/a solo-dev work-unit commits
400-line budget risk: Medium (max=W5 ~500–700 LOC; cf. 24f063b=866)

### Work Units (commit / test / harness / rollback)

1. `feat(engine): add CATEGORIES/BRANDS branches + null guards to matchTargetTier` — Test `match-target-tier.spec.ts`. Harness N/A (pure). Rollback: revert `use-case.ts:65,76-105` + `port.ts:28-41`.
2. `feat(engine): widen LineMatchTier + ordinal pre-pass + CATEGORIES/BRANDS gate` — Test `pos-evaluate-promotions.use-case.spec.ts pos-evaluate-promotions-w4.spec.ts`. Harness N/A. Rollback: revert `use-case.ts:65,131-137,335-350,412-423`.
3. `feat(products): add resolveProductCategoryBrandIds tenant-scoped resolver` — Test `resolve-product-category-brand-ids.spec.ts`. Harness N/A. Rollback: revert `products.service.ts` resolver (~20 LOC).
4. `feat(sales): stamp categoryId/brandId onto PosEvalLine in buildPosEvalInput` — Test `sales.service.spec.ts`. Harness N/A (W5 e2e). Rollback: revert `sales.service.ts:591-628`; null=pre-change.
5. `test(promotions): e2e integration sweep for category/brand targeting` — Test `jest:e2e:integration <new>.integration.spec.ts`. Harness test-DB :5433; `migrate diff` MUST be empty. Rollback: delete new spec; W1–W4 unaffected.

## Phase 1: W1 — Port + matcher

- [x] 1.1 RED: `match-target-tier.spec.ts` — CATEGORIES+`line.categoryId==='CAT1'`→`'CATEGORY'`; null-guard+`null`→`null`; mirror BRANDS/`brandId`.
- [x] 1.2 GREEN: add `categoryId?: string|null; brandId?: string|null` to `PosEvalLine` in `ports/pos-evaluate-promotions.port.ts` (~28-41).
- [x] 1.3 GREEN: widen `matchTargetTier` `line` to `{productId; variantId; categoryId?; brandId?}`; CATEGORIES+BRANDS branches after PRODUCTS w/ `!= null` guards in `pos-evaluate-promotions.use-case.ts` (~76-105).
- [x] 1.4 VERIFY: `pnpm jest match-target-tier.spec.ts` green; VARIANTS/PRODUCTS cases still pass.

## Phase 2: W2 — Union + ordinal pre-pass + gate

- [x] 2.1 RED: NEW `pos-evaluate-promotions-precedence.spec.ts` — 4-tier V>P>{B,C}; 3-tier P>{B,C}; 2-tier B≡C best-wins (discount, lowest id); assert VARIANTS/PRODUCTS-only fixtures unchanged.
- [x] 2.2 RED: extend `pos-evaluate-promotions-w4.spec.ts` — `isSupportedEngineType` true for PRODUCT_DISCOUNT+`CATEGORIES`/`BRANDS`; `targetableManualPromotionIds` retains opted-in CATEGORIES/BRANDS MANUAL with matching line.
- [x] 2.3 GREEN: widen `LineMatchTier` (`:65`) + `PerLineCandidate.tier` (`:136`) add `'BRAND'|'CATEGORY'`.
- [x] 2.4 GREEN: replace binary `hasVariantTier` pre-pass with ordinal `maxOrd` (V=3,P=2,B=1,C=1) → keep `c` where `ORD[c.tier]===maxOrd` (`:412-423`).
- [x] 2.5 GREEN: gate flip `isSupportedEngineType` to accept `CATEGORIES`/`BRANDS` (`:342-349`).
- [x] 2.6 VERIFY: engine sweep green; VARIANTS/PRODUCTS-only regression guard.

## Phase 3: W3 — Resolver

- [x] 3.1 RED: NEW `resolve-product-category-brand-ids.spec.ts` (clone `resolve-price-list-global-ids.spec.ts`) — distinct→1, empty→0, missing omitted, null preserved, `tenantPrisma.getClient` asserted.
- [x] 3.2 GREEN: add `resolveProductCategoryBrandIds(productIds)` to `ProductsService` (clone `:2463-2480`, select `id,categoryId,brandId`).
- [x] 3.3 VERIFY: `pnpm jest resolve-product-category-brand-ids.spec.ts` green.

## Phase 4: W4 — buildPosEvalInput wiring

- [x] 4.1 RED: extend `sales.service.spec.ts` — `buildPosEvalInput` calls resolver once with distinct productIds; stamps `categoryId`/`brandId` per line.
- [x] 4.2 GREEN: in `buildPosEvalInput` (`:591-628`), distinct productIds → resolver → stamp each line from map (null when omitted).
- [x] 4.3 VERIFY: `pnpm jest sales.service.spec.ts` green; typecheck passes.

## Phase 5: W5 — e2e + un-defer + no-migration

- [x] 5.1 NEW `src/promotions/category-brand-promo-targeting.integration.spec.ts` (DB-backed integration spec; integration jest config testMatch picks up `*.integration.spec.ts` under `src/`) — matcher scenarios 2–5, precedence P1–P3, validation V1–V4. `resetAndSeedBaseline()` in afterEach.
- [x] 5.2 VERIFY un-defer: `specs/pos-promotion-engine/spec.md` — DEFERRED REMOVED + 1 MODIFIED + 2 ADDED + 15 scenarios (spec phase wrote it).
- [x] 5.3 VERIFY no-migration: `pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma` returns "No difference detected."
- [x] 5.4 VERIFY: filtered unit + integration spec runs all green (326 unit + 11 integration).
