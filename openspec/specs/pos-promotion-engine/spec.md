# POS Promotion Engine Specification

## Purpose

Define the POS-grade promotion eligibility, per-line and sale-level
application of `PRODUCT_DISCOUNT` + `ORDER_DISCOUNT`, best-wins selection,
auto vs manual opt-in, manual-wins precedence, per-draft veto, and the
promotion-id audit surface that connects the rule catalog
(`Promotion`) to the POS Sale draft flow. Tax-agnostic; cents + `Math.round`.

## Requirements

### Requirement: Eligibility — Effective Status

The engine MUST consider a promotion eligible only when its effective status resolves to `ACTIVE` at evaluation time. A promotion whose effective status is `SCHEDULED` or `ENDED` MUST NOT apply. The engine MUST re-evaluate effective status against the current time on every recompute (no caching across recomputes).

#### Scenario: SCHEDULED promotion does not apply
- GIVEN a promotion with `startDate` in the future and effective status `SCHEDULED`
- WHEN the engine evaluates a draft containing matching items
- THEN the promotion is NOT in the applied list and NOT in the available-for-manual set

#### Scenario: Active promotion at evaluation time is eligible
- GIVEN a promotion with `startDate` past and `endDate` future, effective status `ACTIVE`
- WHEN the engine evaluates a draft containing matching items
- THEN effective-status does NOT exclude the promotion

### Requirement: Eligibility — Date Window

The engine MUST consider a promotion eligible only if evaluation time is within `[startDate, endDate]` (both inclusive). A null bound is unbounded.

#### Scenario: Before startDate is not eligible
- GIVEN a promotion with `startDate = tomorrow`
- WHEN the engine evaluates a draft at `now`
- THEN the promotion is NOT eligible

#### Scenario: At endDate is still eligible
- GIVEN a promotion with `endDate = now`
- WHEN the engine evaluates a draft at `now`
- THEN the date-window gate does NOT exclude the promotion

### Requirement: Eligibility — Day Of Week

The engine MUST consider a promotion eligible only if today is in `daysOfWeek[]`. An empty `daysOfWeek[]` opens the gate.

#### Scenario: Today not in daysOfWeek is not eligible
- GIVEN `daysOfWeek = [MONDAY, TUESDAY]` and today `WEDNESDAY`
- WHEN the engine evaluates a draft
- THEN the promotion is NOT eligible

#### Scenario: Empty daysOfWeek opens the gate
- GIVEN `daysOfWeek = []`
- WHEN the engine evaluates a draft on any day
- THEN the day-of-week gate does NOT exclude the promotion

### Requirement: Eligibility — Customer Scope With Silent Skips

The engine MUST enforce `customerScope`: `ALL` requires no customer; `REGISTERED_ONLY` and `SPECIFIC` require a customer on the draft. For `SPECIFIC`, the assigned customer MUST be in `customers[]`. When a customer-scope gate fails because no customer is assigned, the engine MUST silently NOT apply (no error, no surfaced blocker) and MUST re-evaluate on each recompute once the gate could be satisfied.

#### Scenario: ALL with no customer is eligible
- GIVEN `customerScope = ALL`
- WHEN the engine evaluates a draft with NO customer assigned
- THEN the customer-scope gate does NOT exclude the promotion

#### Scenario: REGISTERED_ONLY without customer silently skips
- GIVEN `customerScope = REGISTERED_ONLY`
- WHEN the engine evaluates a draft with NO customer assigned
- THEN the promotion is NOT applied and the engine returns no error

#### Scenario: SPECIFIC without customer silently skips, then auto-applies once eligible customer is assigned
- GIVEN `customerScope = SPECIFIC`, `customers = [C1]`, draft with NO customer
- WHEN the engine evaluates the draft before and after `assignCustomer(C1)`
- THEN the first evaluation does NOT apply the promotion
- AND the second evaluation DOES apply the promotion (auto path)

#### Scenario: SPECIFIC with non-listed customer is not eligible
- GIVEN `customerScope = SPECIFIC`, `customers = [C1]`, draft assigned to C2
- WHEN the engine evaluates the draft
- THEN the promotion is NOT eligible

### Requirement: Eligibility — Price Lists

The engine MUST consider a promotion eligible for a given line only if the line's `appliedPriceListId` is in the promotion's `priceLists[]`. An empty `priceLists[]` opens the gate (any line, including lines without a price list, is eligible). Lines without an `appliedPriceListId` are eligible against an open gate and ineligible against a restricted gate.

#### Scenario: Open price-list gate
- GIVEN `priceLists = []` and a line with no `appliedPriceListId`
- WHEN the engine evaluates that line
- THEN the price-list gate does NOT exclude it

#### Scenario: Restricted gate rejects non-listed item
- GIVEN `priceLists = [PL1]` and a line with `appliedPriceListId = PL2`
- WHEN the engine evaluates that line
- THEN the promotion is NOT eligible for that line

#### Scenario: Restricted gate rejects line with no price list
- GIVEN `priceLists = [PL1]` and a line with no `appliedPriceListId`
- WHEN the engine evaluates that line
- THEN the promotion is NOT eligible for that line

### Requirement: Eligibility — ORDER_DISCOUNT Minimum Purchase

The engine MUST consider an `ORDER_DISCOUNT` promotion eligible only if the draft's pre-promo subtotal in cents is `>= minPurchaseAmountCents`. A null `minPurchaseAmountCents` opens the gate.

#### Scenario: Subtotal below minimum excludes the promo
- GIVEN `minPurchaseAmountCents = 10000` and a draft subtotal of 9000c
- WHEN the engine evaluates the draft
- THEN the promotion is NOT eligible

#### Scenario: Subtotal at minimum is eligible
- GIVEN `minPurchaseAmountCents = 10000` and a draft subtotal of 10000c
- WHEN the engine evaluates the draft
- THEN the min-purchase gate does NOT exclude the promotion

### Requirement: PRODUCT_DISCOUNT Matches Target Items

The engine MUST match a `PRODUCT_DISCOUNT` promotion against lines using `appliesTo` and `targetItems[].targetId`. `PRODUCTS` matches by productId; `CATEGORIES` matches by product category id; `BRANDS` matches by product brand id. Non-matching lines are NOT touched.

#### Scenario: PRODUCTS targeting matches by product id
- GIVEN `appliesTo = PRODUCTS`, `targetItems = [P1]`
- WHEN the engine evaluates a draft with one line for P1 and one line for P2
- THEN only the P1 line is eligible for the promotion

#### Scenario: CATEGORIES targeting matches by category id
- GIVEN `appliesTo = CATEGORIES`, `targetItems = [CAT1]`
- WHEN the engine evaluates a draft with one line for a CAT1 product and one line for a CAT2 product
- THEN only the CAT1 line is eligible

### Requirement: PRODUCT_DISCOUNT Computed On Effective Per-Line Price

The engine MUST compute a `PRODUCT_DISCOUNT` per-line discount against the line's effective per-line unit price at evaluation time (price-list and CUSTOM overrides respected). The discount MUST be rounded to whole cents using `Math.round`. The final discounted unit price MUST be `>= 1` cent.

#### Scenario: PERCENTAGE on top of price-list price
- GIVEN a line priced at 1000c (price-list override) and an eligible 10% `PRODUCT_DISCOUNT`
- WHEN the engine computes the per-line discount
- THEN the line discount is 100c and the resulting unit price is 900c

#### Scenario: FIXED on top of effective price
- GIVEN a line priced at 1500c and an eligible FIXED 200c `PRODUCT_DISCOUNT`
- WHEN the engine computes the per-line discount
- THEN the line discount is 200c and the resulting unit price is 1300c

#### Scenario: Floor of 1 cent is preserved
- GIVEN a line priced at 5c and a FIXED 100c `PRODUCT_DISCOUNT`
- WHEN the engine computes the per-line discount
- THEN the resulting unit price is `>= 1c` (no negative or zero price)

### Requirement: ORDER_DISCOUNT Applied At Sale Level

The engine MUST apply an eligible `ORDER_DISCOUNT` to the whole draft subtotal (post per-line promos) and MUST NOT mutate per-line `unitPriceCents`. The applied order discount MUST be recorded as a sale-level record identifiable by `promotionId`.

#### Scenario: PERCENTAGE order discount on subtotal
- GIVEN an `ORDER_DISCOUNT` (PERCENTAGE 10%) eligible on a post-line-promo subtotal of 5000c
- WHEN the engine applies the promotion
- THEN the sale-level order discount is 500c and no `unitPriceCents` is changed

#### Scenario: FIXED order discount on subtotal
- GIVEN an `ORDER_DISCOUNT` (FIXED 250c) eligible on a post-line-promo subtotal of 1000c
- WHEN the engine applies the promotion
- THEN the sale-level order discount is 250c

### Requirement: Best-Wins Selection Per Line And Per Sale

When multiple promotions are eligible for the same line (`PRODUCT_DISCOUNT`) or for the same sale (`ORDER_DISCOUNT`), the engine MUST apply only the promotion that gives the highest customer discount in cents. Stacking (summing) MUST NOT occur. Ties resolve by lowest `promotionId` (deterministic). Manual seller free-form discounts are not promotions and are NOT considered in best-wins selection.

#### Scenario: Best of two PRODUCT_DISCOUNT promos on the same line
- GIVEN a line priced at 1000c and two eligible AUTOMATIC `PRODUCT_DISCOUNT` promos: P-A (PERCENTAGE 10% → 100c) and P-B (FIXED 200c → 200c)
- WHEN the engine selects best-wins for that line
- THEN P-B is applied and P-A is NOT; the final line price is 800c (no stacking to 700c)

#### Scenario: Best of two ORDER_DISCOUNT promos on the same sale
- GIVEN a draft subtotal of 5000c and two eligible `ORDER_DISCOUNT` promos: P-X (PERCENTAGE 10% → 500c) and P-Y (FIXED 300c → 300c)
- WHEN the engine selects best-wins for the sale
- THEN P-X is applied and P-Y is NOT

#### Scenario: Tie resolves by lowest promotionId
- GIVEN a line priced at 1000c and two eligible AUTOMATIC `PRODUCT_DISCOUNT` promos P-A and P-Z, each offering FIXED 100c, with `P-A.id < P-Z.id`
- WHEN the engine selects best-wins
- THEN P-A is applied

### Requirement: AUTOMATIC Promotions Auto-Apply

The engine MUST include all currently-eligible `method = AUTOMATIC` promotions in best-wins selection for every recompute (subject to the per-draft veto). The engine MUST NOT include `method = MANUAL` promotions in the applied list unless explicitly opted in.

#### Scenario: AUTOMATIC promotion auto-applies on recompute
- GIVEN a draft with one line and one eligible `method = AUTOMATIC` `PRODUCT_DISCOUNT` (10%)
- WHEN a recompute runs
- THEN the promotion is in the applied list

#### Scenario: MANUAL promotion does NOT auto-apply
- GIVEN a draft with one line and one eligible `method = MANUAL` `PRODUCT_DISCOUNT` (10%)
- WHEN a recompute runs without an explicit opt-in for that promotion
- THEN the promotion is NOT in the applied list and IS listed in the available-for-manual set

### Requirement: MANUAL Promotions Require Explicit Opt-In

The engine MUST treat `method = MANUAL` promotions as eligible candidates for opt-in but MUST NOT apply them to totals until the seller explicitly invokes an apply action for that promotion on that draft. An applied MANUAL promotion persists across recomputes (subject to eligibility re-evaluation) until the seller explicitly removes it.

#### Scenario: Seller opts in to MANUAL promo, recompute persists
- GIVEN a draft with one line and one eligible MANUAL `PRODUCT_DISCOUNT` (10%)
- WHEN the seller applies the MANUAL promo and a recompute runs (no other changes)
- THEN the MANUAL promo is still applied

#### Scenario: Eligibility loss invalidates a previously applied MANUAL promo
- GIVEN a draft with an applied MANUAL `PRODUCT_DISCOUNT` (10%) and that promotion now has `endDate = yesterday`
- WHEN a recompute runs
- THEN the MANUAL promo is NOT applied (date-window gate fails)

### Requirement: Manual Free-Form Discount Precedence

The engine MUST NOT touch a line that already has a seller manual free-form discount applied. On recompute, auto-promo eligibility for that line is still computed and best-wins is still run, but the line's existing manual discount is preserved and the auto-promo is NOT folded into that line. The per-draft veto set, however, still records the auto-promo as "applicable but not applied" if best-wins would otherwise have selected it on that line.

#### Scenario: Auto-promo does NOT override a manual-discounted line
- GIVEN a line priced at 1000c with a seller manual 100c discount applied (unit = 900c) and an eligible AUTOMATIC `PRODUCT_DISCOUNT` (10%)
- WHEN a recompute runs
- THEN the line's discount stays at 100c (manual) and the auto-promo is NOT applied to that line

#### Scenario: Manual-wins precedence survives subsequent recomputes
- GIVEN the previous scenario's state
- WHEN the seller adds another line and recompute runs
- THEN the original manual-discounted line still has the manual 100c discount and the new line is evaluated normally against auto-promos

### Requirement: Per-Draft Veto Of Auto-Applied Promotions

The engine MUST maintain a per-draft set of `promotionId`s that the seller has explicitly removed from the auto-apply path. On every recompute, after eligibility and best-wins selection, the engine MUST exclude any `method = AUTOMATIC` promotion whose id is in the draft's veto set. The veto MUST persist across recomputes for the same draft until the seller reactivates the promotion. Removing an auto-promo MUST NOT also remove a `MANUAL` promotion that happens to share the same id namespace.

#### Scenario: Removed auto-promo is excluded from next recompute
- GIVEN a draft with one line, an eligible AUTOMATIC `PRODUCT_DISCOUNT` P-A (10%) auto-applied, and the seller explicitly removes P-A
- WHEN a recompute runs
- THEN P-A is NOT in the applied list for that draft

#### Scenario: Removed auto-promo stays excluded until reactivated
- GIVEN P-A is in the draft's veto set
- WHEN the seller adds another line and recompute runs
- THEN P-A is still NOT applied and other eligible auto-promos are still evaluated normally

#### Scenario: Removing an auto-promo does NOT remove a MANUAL promo
- GIVEN a draft with both an AUTOMATIC promo P-A and a separately opted-in MANUAL promo P-M
- WHEN the seller removes P-A from auto-apply
- THEN P-M stays applied and only P-A is added to the veto set

### Requirement: Audit — Promotion ID On Line And Sale-Level Record

When a `PRODUCT_DISCOUNT` is applied to a line, the engine MUST record the promotion's id on the line's audit surface (line-level). When an `ORDER_DISCOUNT` is applied, the engine MUST record a sale-level applied-promotion record referencing the promotion's id. Audit fields MUST persist across recomputes for as long as the promotion is applied.

#### Scenario: PRODUCT_DISCOUNT audit on the line
- GIVEN a draft with one line and an eligible AUTOMATIC `PRODUCT_DISCOUNT` P-P (10%)
- WHEN the promotion is applied
- THEN the line carries `promotionId = P-P.id` in its audit surface

#### Scenario: ORDER_DISCOUNT audit at sale level
- GIVEN a draft subtotal of 5000c and an eligible AUTOMATIC `ORDER_DISCOUNT` P-O (10%)
- WHEN the promotion is applied
- THEN a sale-level applied-promotion record exists referencing `promotionId = P-O.id` and no line carries that `promotionId`

#### Scenario: Removed auto-promo clears the line audit link
- GIVEN P-P applied on a line with `promotionId = P-P.id`
- WHEN the seller removes P-P and recompute runs
- THEN the line's `promotionId` is no longer `P-P.id`

## Verification Surface

- `src/promotions/application/pos-evaluate-promotions.use-case.spec.ts` (eligibility + best-wins + precedence; C1 price-list resolved-global-id; W3 99% clamp; manual opt-in; veto; manual-wins)
- `src/promotions/infrastructure/prisma-promotion.repository.spec.ts` (resolve-price-list-global-ids batch; tenant-scoped)
- `src/sales/sales.service.spec.ts` (recompute-on-mutation integration; opt-in persistence; veto persistence through charge tx)
- `src/sales/domain/sale-item.entity.spec.ts` (promotionId audit on line; applyDiscount with promotionId)
- `src/sales/domain/sale.entity.spec.ts` (previewTotals — order-discount-aware subtotal/discount/total; S-1 clamp; appliedOrderPromotion / vetoedPromotionIds / optedInManualPromotionIds fields)
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` (W2: four read mappers load veto + applied-promo + opt-in; opt-in delete-then-createMany save; persistChargeConfirmation item re-write W1)