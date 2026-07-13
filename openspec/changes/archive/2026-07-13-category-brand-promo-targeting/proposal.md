# Proposal: Activate CATEGORIES & BRANDS Targeting in the POS Promotion Engine

## Intent

Activate the two `PromotionTargetType` values `CATEGORIES` and `BRANDS` that are already
reserved in the Postgres enum, the domain entity, the DTO, and the validator — but gated
off in the POS engine. Today `isSupportedEngineType` returns `false` for them and
`matchTargetTier` returns `null` (both unit-tested negative). This change opens that gate
and gives CATEGORIES/BRANDS promos real matching, following the same targeting pattern
PRODUCTS/VARIANTS already use. The result: a cashier can attach a 10% off promo to
"all Acme Brand" or "all Footwear" and have it apply correctly on the next recompute.

## Scope

### In Scope

- POS engine (`pos-evaluate-promotions.use-case.ts`): flip `isSupportedEngineType` to
  accept CATEGORIES/BRANDS; add CATEGORIES/BRANDS branches to `matchTargetTier`; widen
  `LineMatchTier` and `PerLineCandidate.tier` unions; generalize the 2-tier
  `pickBestPerLine` pre-pass to "most-specific tier present wins".
- Port (`pos-evaluate-promotions.port.ts`): add `categoryId: string | null` and
  `brandId: string | null` to `PosEvalLine`.
- Plumber (`sales.service.ts` → `buildPosEvalInput`): batch-resolve productId →
  `{categoryId, brandId}` once per recompute and inject on each line (one additional
  call next to existing `resolvePriceListGlobalIds`).
- New `ProductsService.resolveProductCategoryBrandIds(productIds)` (clone of
  `resolvePriceListGlobalIds`, ~20 lines, tenant-scoped).
- TDD-first test suites: helper tier flips + null guards + precedence ordering;
  engine best-wins/self-heal/precedence; `buildPosEvalInput` wiring spec; resolver spec;
  integration spec on seeded tenant.
- Spec delta: un-defer the CATEGORIES/BRANDS scenarios in
  `openspec/specs/pos-promotion-engine/spec.md:113-128` and add the precedence rule.

### Out of Scope

- Online/cart engine (`evaluate-cart-promotions.use-case.ts` — does not use
  `matchTargetTier`).
- BUY_X_GET_Y and ADVANCED mechanics (change #2b).
- `SaleItem` snapshot columns, schema/migration, backfill.
- Frontend / admin UI changes.
- Tenant-scoping of Category/Brand validation (they are global models — leave as-is).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pos-promotion-engine`: the `PRODUCT_DISCOUNT Matches Target Items` requirement
  changes — un-defer CATEGORIES/BRANDS scenarios (lines 123-128), add the
  `VARIANT > PRODUCT > {BRAND ≡ CATEGORY}` precedence rule, add the null-category/
  null-brand guard scenario.

## Approach (locked decisions)

1. **Precedence**: `VARIANT > PRODUCT > {BRAND ≡ CATEGORY}`. Most-specific-tier-present
   wins; BRAND and CATEGORY are equal-broad peers; in-tier ties go to best-wins
   (highest discount, then lowest id). Generalize the existing binary pre-pass at
   `pickBestPerLine :412-423` from "has VARIANT? → keep only VARIANT" to "keep only
   the top tier that has any candidate".
2. **Null guard**: a line whose product has `categoryId = null` (or `brandId = null`)
   does NOT match a CATEGORIES (or BRANDS) promo. Silent ignore, mirroring the
   `variantId != null` guard at `matchTargetTier :84`.
3. **Data source**: resolve at eval time, live. New
   `ProductsService.resolveProductCategoryBrandIds(distinctProductIds)` (clone of
   `resolvePriceListGlobalIds :2463-2480`); `buildPosEvalInput` calls it and stamps
   each `PosEvalLine`. No `SaleItem` columns. No migration.
4. **Scope**: POS engine only.
5. **Validation**: `validateTargetIds` CATEGORIES/BRANDS branches at
   `promotions.service.ts:542-554` already exist and use global `this.prisma` —
   keep as-is. Missing id → `INVALID_TARGET` (400). Do NOT tenant-scope.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Modified | Gate flip (:335-350); match branches (:76-105); union widening (:65, :136); pre-pass generalization (:412-423) |
| `src/promotions/application/ports/pos-evaluate-promotions.port.ts` | Modified | Add `categoryId`/`brandId` to `PosEvalLine` (:28-41) |
| `src/sales/sales.service.ts` | Modified | Wire resolver into `buildPosEvalInput` (:591-624) |
| `src/products/products.service.ts` | Modified | New `resolveProductCategoryBrandIds` (~20 lines, clone :2463-2480) |
| `openspec/specs/pos-promotion-engine/spec.md` | Delta MODIFY | Un-defer :113-128; add precedence + null-guard scenarios |
| Test suites | New/Modified | match-target-tier, engine spec, sales.service, resolver, integration |
| Postgres enum, entity, DTO, `validateTargetIds`, `SaleItem` | None | All already support CATEGORIES/BRANDS |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Null categoryId/brandId accidentally matches via `==` | Low | Mirror `variantId != null` guard at top of new branches; unit-test null-line cases |
| Pre-pass regression: a legacy VARIANTS-only promo now drops PRODUCT candidates it shouldn't (or vice-versa) | Low | Test with the exact predecessor fixture set; precedence test fixture covers 2-tier + 3-tier + 4-tier |
| Resolution N+1 if we forget to dedupe productIds | Low | Clone `resolvePriceListGlobalIds` verbatim — already a single `IN (...)` over distinct productIds |
| Tenant-scoping regression on validation (someone "fixes" it to `tenantClient`) | Low | Comment at the branch + test fixture with global Category id against a tenant |
| `config.yaml` says `apply.tdd:false` but session mandates strict TDD | Low | Follow strict TDD; note in proposal; reconcile config in this change |
| Self-heal `targetableManualPromotionIds` loop sees CATEGORIES/BRANDS for the first time | Low | Covered by flipping `isSupportedEngineType` (consulted at :270, :280); add self-heal test for both types |

## Rollback Plan

Revert the feature branch commit(s). Engine gate returns `false` for CATEGORIES/BRANDS
again, `matchTargetTier` returns `null`, `PosEvalLine` loses the two new fields, and
`buildPosEvalInput` stops calling the resolver. No DB change, no data migration, no
backfill, no API contract change — existing CATEGORIES/BRANDS promos simply degrade
to "not eligible" exactly as today. Single revert; no compensating writes.

## Dependencies

- Existing `resolvePriceListGlobalIds` pattern (`ProductsService :2463-2480`) — same
  batch-resolve shape is the template.
- Existing `validateTargetIds` CATEGORIES/BRANDS branches
  (`promotions.service.ts:542-554`) — no new validation work.
- Existing `PromotionTargetType` Postgres enum, domain entity union, DTO enum — no
  schema/DTO work.

## Success Criteria

- [ ] A `PRODUCT_DISCOUNT` promo with `appliesTo = CATEGORIES` and a single category id
      applies only to lines whose product belongs to that category on the next
      recompute.
- [ ] Same for `appliesTo = BRANDS`.
- [ ] A line with `product.categoryId = null` never matches any CATEGORIES promo
      (verified by integration test).
- [ ] Precedence test: a VARIANTS-targeting promo beats a same-line BRANDS-targeting
      promo and a same-line CATEGORIES-targeting promo (VARIANT is the most specific
      tier); a PRODUCTS-targeting promo beats same-line BRANDS/CATEGORIES promos.
      BRAND and CATEGORY are PEERS (`≡`): when a BRANDS promo and a CATEGORIES promo
      both apply to the same line with no higher tier present, the winner is decided
      by best-wins (highest discount, then lowest id) — NOT by any BRAND-over-CATEGORY
      hierarchy.
- [ ] Existing VARIANTS and PRODUCTS promo tests still pass unchanged.
- [ ] No DB migration introduced. `prisma migrate diff` against current schema is
      empty.