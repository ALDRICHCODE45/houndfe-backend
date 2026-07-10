# Tasks: Connect Promotions Rule Catalog to POS Sale Flow

## Forecast

~720 lines.
Decision needed before apply: No
Chained work-slices recommended: Yes
Chain strategy: chained work-slices
400-line budget risk: High

## DEFERRED (first slice)

CATEGORIES (spec.md:119-122) + BRANDS (spec.md:112) - need SaleItem category/brand snapshot columns (separate additive change).

## Branch Strategy

Solo dev, no PRs. Each unit = branch off main, 1 work-unit commit, merge. Rollback = git revert. Branches: `feat/promo-sale-u{1..6}-*`. Baseline green at 1.6; recheck every boundary.

## Work Unit 1 - Migration + Schema

Rollback: prisma migrate resolve --rolled-back.

- [x] 1.1 RED assert sale_items.promotionId nullable + sale_promotion_applied + sale_promotion_vetoes exist with FKs.
- [x] 1.2 GREEN prisma/schema.prisma: SaleItem.promotionId String? FK SetNull + SalePromotionApplied + SalePromotionVeto + back-relations.
- [x] 1.3 pnpm prisma migrate dev --name promotions_in_sale; capture baseline.
- [x] 1.4 RED migration down drops column + tables idempotently on populated seed.
- [x] 1.5 Apply up, snapshot, down, re-snapshot; zero unrelated-row loss.
- [x] 1.6 Boundary pnpm run test; zero new failures.

## Work Unit 2 - Port + Engine (unwired)

Rollback: delete use-case + port.

- [ ] 2.1 RED eligibility: status, date window, dayOfWeek, customerScope, priceList, minPurchase.
- [ ] 2.2 RED (C1) price-list matches only via resolved appliedGlobalPriceListId.
- [ ] 2.3 RED (W3) 100% PERCENTAGE: ranked == applied, both clamped 99.
- [ ] 2.4 RED best-wins tiebreak; manual opt-in; veto; manual-wins precedence.
- [ ] 2.5 GREEN ports/pos-evaluate-promotions.port.ts (types + Symbol).
- [ ] 2.6 GREEN PosEvaluatePromotionsUseCase.evaluate.
- [ ] 2.7 RED resolvePriceListGlobalIds batch (distinct ids, one query).
- [ ] 2.8 GREEN add resolver to ProductsService; wire + export in promotions.module.ts.
- [ ] 2.9 Boundary pnpm run test.

## Work Unit 3 - Entity + Repository Persistence

Rollback: revert field additions + repo branches.

- [ ] 3.1 RED SaleItem.applyDiscount accepts promotionId; getter + toResponse expose it.
- [ ] 3.2 GREEN extend SaleItemProps/ctor/toResponse/applyDiscount + getter.
- [ ] 3.3 RED Sale getters appliedOrderPromotion, vetoedPromotionIds, optedInManualPromotionIds; previewTotals() (C2).
- [ ] 3.4 GREEN add fields + SaleFromPersistenceProps defaults (null/[]) + fromPersistence maps them + previewTotals() helper.
- [ ] 3.5 RED (W2) four read mappers load veto + applied-promo + promotionId.
- [ ] 3.6 GREEN extend findById / findByIdForUpdate / findDraftResponseById / findDraftsByUserId; extend save (delete+createMany veto/applied-promo + promotionId).
- [ ] 3.7 RED integration: veto persists (persist -> findById -> engine -> excluded).
- [ ] 3.8 Boundary pnpm run test.

## Work Unit 4 - Wire Recompute into Draft Mutations

Rollback: drop recomputePromotions calls; Unit 3 state stays but ignored.

- [ ] 4.1 RED addItem recomputes; AUTOMATIC auto-applies; idempotent double-run = same output.
- [ ] 4.2 RED recompute triggers on updateItemQuantity / removeItem / assignCustomer (SPECIFIC auto after assign).
- [ ] 4.3 GREEN private recomputePromotions(sale) per design: batch resolve, PosEvalInput, engine.evaluate, clear prior auto-promo if promotionId != null, apply, set/clear sale.appliedOrderPromotion.
- [ ] 4.4 GREEN inject POS_EVALUATE_PROMOTIONS_USE_CASE; wire into addItem (610), updateItemQuantity (675), removeItem, assignCustomer (1234) before saleRepo.save.
- [ ] 4.5 RED (C2) findDraftResponseById returns totalCents/discountCents adjusted by order discount (not 0).
- [ ] 4.6 GREEN spread previewTotals() over toResponse() in findDraftResponseById.
- [ ] 4.7 Boundary pnpm run test.

## Work Unit 5 - Charge + Override + Inline Totals

Rollback: drop charge re-write + recompute; Unit 4 mutations still work.

- [ ] 5.1 RED overrideItemPrice re-applies auto-promo on new price; manual-discount preserved.
- [ ] 5.2 GREEN call recomputePromotions after sale.overrideItemPrice (~1042) before saleRepo.save.
- [ ] 5.3 RED charge recompute picks up qty change between recompute and charge.
- [ ] 5.4 RED (C2) ORDER_DISCOUNT charged totalCents equals getSaleDetail total.
- [ ] 5.5 GREEN findByIdForUpdate loads veto + applied-promo + opt-in; call recomputePromotions inside charge tx (tenant tx client).
- [ ] 5.6 GREEN (W1) tenant+tx-scoped SaleItem re-write inside runInTransaction, before persistChargeConfirmation.
- [ ] 5.7 GREEN inline totals (1568-1579) include orderDiscountCents (sale.appliedOrderPromotion?.discountAmountCents ?? 0); flow into persistChargeConfirmation.
- [ ] 5.8 RED (W1) integration: post-charge SaleItem rows assert promotionId/discountAmountCents match engine output.
- [ ] 5.9 Boundary pnpm run test.

## Work Unit 6 - Manual Endpoints + Veto + DTOs + CASL

Rollback: delete routes + DTOs + service methods.

- [ ] 6.1 RED GET /sales/:id/applicable-promotions returns MANUAL promos with discount.
- [ ] 6.2 RED POST /sales/:id/manual-promotions/:promotionId opts-in; recompute keeps applied.
- [ ] 6.3 RED DELETE /sales/:id/manual-promotions/:promotionId removes opt-in.
- [ ] 6.4 RED DELETE /sales/:id/promotions/:promotionId (auto) adds to veto; recompute excludes.
- [ ] 6.5 RED REMOVE does NOT mutate Promotion.status/method/discountValue.
- [ ] 6.6 GREEN DTOs: list-applicable, apply-manual, remove-manual, remove-applied.
- [ ] 6.7 GREEN controller routes + update:Sale CASL guard; service methods (list/apply/remove for manual; remove for auto) mutate state, then recomputePromotions + save.
- [ ] 6.8 Boundary pnpm run test + smoke revert (comment out calls; app boots; no-op).