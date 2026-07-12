# Proposal: Variant-Level Promotion Targeting (POS)

## Intent

A POS promotion with `appliesTo=PRODUCTS` implicitly hits every variant of that product. Sellers cannot scope a promo to one variant without faking a product. The engine input already carries `variantId` per line (`PosEvalLine.variantId` -> `sales.service.ts:614`); the gap is a missing match predicate and a missing target type.

## Scope

### In Scope
- New `VARIANTS` on `PromotionTargetType`; `targetId` carries a `variantId`. Teach BOTH match sites in `pos-evaluate-promotions.use-case.ts` (`pickBestPerLine` :328-334 AND `targetableManualPromotionIds` :225-237).
- **VARIANT-wins precedence**: when PRODUCTS and VARIANTS targets both match the same line, the VARIANTS target wins -- explicit specificity, not blind best-wins.
- Extend `validateTargetIds` (`promotions.service.ts:528-580`) with `case VARIANTS` -> `tenantClient.variant.findUnique` (tenant-scoped). Extend DTOs.
- `ALTER TYPE PromotionTargetType ADD VALUE VARIANTS` migration as its own step.
- Spec delta: MODIFY `PRODUCT_DISCOUNT Matches Target Items` (`openspec/specs/pos-promotion-engine/spec.md:113-125`) + new precedence requirement.

### Out of Scope (Non-Goals)
Online/cart engine deferred; match predicate factored as a pure helper so it is reusable there later. Also deferred: BUY_X_GET_Y, ADVANCED, CATEGORIES, BRANDS, priority/stacking, usage limits, tax, frontend.

## Capabilities

### New Capabilities
- `variant-targeted-promotions`: target one variant; VARIANT-wins over a same-product PRODUCTS target; existing PRODUCTS targets on variant-bearing products continue to hit all variants.

### Modified Capabilities
- `pos-promotion-engine`: match rule adds VARIANTS + the specificity rule.

## Approach

Additive, minimal surface (Approach A from exploration). Reuse the polymorphic `PromotionTargetItem` row (`targetId = variantId`); both match predicates gain one clause. Precedence runs in a pre-pass before best-wins: VARIANTS-eligible promo on a matching variant wins over any PRODUCTS-eligible promo on the same line. PRODUCTS-only eligibility is unchanged.

## Affected Areas

- `src/promotions/application/pos-evaluate-promotions.use-case.ts` -- both match sites + `isSupportedEngineType` + precedence pre-pass.
- `src/promotions/domain/promotion.entity.ts:15` -- union gains `VARIANTS`.
- `src/promotions/dto/create-promotion.dto.ts` + update DTO -- enum + `TargetItemDto` accept VARIANTS.
- `src/promotions/promotions.service.ts:528-580` -- VARIANTS case in `validateTargetIds` (tenant-scoped).
- `prisma/schema.prisma:89-93` + new migration -- `ADD VALUE VARIANTS` as its own step.
- `openspec/specs/pos-promotion-engine/spec.md:113-125` -- delta MODIFY.

## Risks

- **Two match sites must both learn VARIANTS** -- else opted-in MANUAL variant promos get pruned by self-heal (Med). Ship bug #2911 first.
- **Postgres enum-add gotcha** (add+use in same tx fails) (Med). Migration emits `ADD VALUE` as its own step.
- **VARIANTS validation must use `tenantClient`**, not global (Low). Symmetric with PRODUCTS branch.

## Backward Compatibility

PRODUCTS targets on a variant-bearing product CONTINUE to apply to all variants. Zero data migration. No re-config. `@@unique([promotionId, side, targetType, targetId])` unchanged.

## Rollback Plan

Drop the additive migration (unused enum value stays; `down` reverts only code). Revert match predicates + DTO enum. Existing rows untouched.

## Success Criteria

- [ ] Variant-targeted promo applies only to its exact variant; product-targeted promo on the same product still applies to other variants.
- [ ] VARIANTS wins over PRODUCTS on the same line regardless of discount value.
- [ ] Opted-in MANUAL variant-targeted promo survives a recompute.
- [ ] `validateTargetIds` rejects cross-tenant / non-existent variant ids; accepts valid ones.
- [ ] Migration applies and rolls back cleanly on a populated DB.

## First-Slice Budget

~220-280 net changed lines. **Within the 400-line review budget** -- single PR, no chained slices.
