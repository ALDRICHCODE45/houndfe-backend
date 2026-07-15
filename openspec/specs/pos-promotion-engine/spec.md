# POS Promotion Engine Specification

## Purpose

Define the POS-grade promotion eligibility, per-line and sale-level
application of `PRODUCT_DISCOUNT` + `BUY_X_GET_Y` + `ADVANCED` + `ORDER_DISCOUNT`,
best-wins selection (including the cross-type real per-line total-savings
comparator across `PRODUCT_DISCOUNT` / `BUY_X_GET_Y` / `ADVANCED`, the
`BUY_X_GET_Y` pass ordering between the per-line `PRODUCT_DISCOUNT` and
the sale-level `ORDER_DISCOUNT` passes, and the `ADVANCED` cross-line
pass slotted between `BUY_X_GET_Y` and `ORDER_DISCOUNT`), auto vs
manual opt-in, manual-wins precedence, per-draft veto, the type-aware
100% "free" cap (`BUY_X_GET_Y` and `ADVANCED` both reach 100%;
`> 100` rejected for both), the targeted-required constraint for
`BUY_X_GET_Y`, the disjoint BUY/GET intake guard for `ADVANCED`, the
quantity-only BUY threshold for `ADVANCED`, the `rewardKind = 'advanced'`
wire discriminator distinct from `buy_x_get_y`, the
idempotent-recompute invariant, and the promotion-id audit surface that
connects the rule catalog (`Promotion`) to the POS Sale draft flow.
Tax-agnostic; cents + `Math.round`.

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

The engine MUST match a `PRODUCT_DISCOUNT` promotion against lines using `appliesTo` and `targetItems[].targetId`. `PRODUCTS` matches by productId and CONTINUES to match every variant of that product; `CATEGORIES` matches a line when the line's product `categoryId` equals the target's `targetId`; `BRANDS` matches a line when the line's product `brandId` equals the target's `targetId`; `VARIANTS` matches only by variantId when the line's `variantId` equals the target's `targetId`. A line whose product has a null `categoryId` MUST NOT match any `CATEGORIES` promotion, and a line whose product has a null `brandId` MUST NOT match any `BRANDS` promotion. Non-matching lines are NOT touched.
(Previously: `CATEGORIES`/`BRANDS` engine targeting was DEFERRED — `isSupportedEngineType` returned `false` and `matchTargetTier` returned `null` for them. That deferral is now REMOVED; both are active, normative engine behavior.)

#### Scenario: PRODUCTS targeting matches by product id
- GIVEN `appliesTo = PRODUCTS`, `targetItems = [P1]`
- WHEN the engine evaluates a draft with one P1 line and one P2 line
- THEN only the P1 line is eligible

#### Scenario: CATEGORIES targeting matches by product category id
- GIVEN `appliesTo = CATEGORIES`, `targetItems = [CAT1]`
- AND product PA has `categoryId = CAT1` and product PB has `categoryId = CAT2`
- WHEN the engine evaluates a draft with one PA line and one PB line
- THEN only the PA line is eligible

#### Scenario: BRANDS targeting matches by product brand id
- GIVEN `appliesTo = BRANDS`, `targetItems = [BR1]`
- AND product PA has `brandId = BR1` and product PB has `brandId = BR2`
- WHEN the engine evaluates a draft with one PA line and one PB line
- THEN only the PA line is eligible

#### Scenario: Line whose product has null categoryId does not match a CATEGORIES promo
- GIVEN `appliesTo = CATEGORIES`, `targetItems = [CAT1]`
- AND product PA has `categoryId = null`
- WHEN the engine evaluates a draft with one PA line
- THEN the promotion is NOT eligible for the PA line (silently skipped)

#### Scenario: Line whose product has null brandId does not match a BRANDS promo
- GIVEN `appliesTo = BRANDS`, `targetItems = [BR1]`
- AND product PA has `brandId = null`
- WHEN the engine evaluates a draft with one PA line
- THEN the promotion is NOT eligible for the PA line (silently skipped)

#### Scenario: PRODUCTS still matches every variant of a variant-bearing product
- GIVEN `appliesTo = PRODUCTS`, `targetItems = [P1]`, P1 has variants V-A, V-B
- WHEN the engine evaluates a draft with one V-A line and one V-B line
- THEN both lines are eligible

#### Scenario: VARIANTS matches only the exact variant
- GIVEN `appliesTo = VARIANTS`, `targetItems = [V-A]`, P1 has variants V-A, V-B
- WHEN the engine evaluates a draft with one V-A line and one V-B line
- THEN only the V-A line is eligible

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

When multiple promotions are eligible for the same line or for the same sale, the engine MUST apply only the promotion that gives the highest customer discount in cents. Stacking (summing) MUST NOT occur. Ties resolve by lowest `promotionId` (deterministic). Manual seller free-form discounts are not promotions and are NOT considered in best-wins selection. **Cross-type rule:** when a line is eligible for BOTH a `PRODUCT_DISCOUNT` AND a `BUY_X_GET_Y`, the engine compares REAL per-line TOTAL savings in cents and applies the larger; ties resolve by lowest `promotionId`. A `PRODUCT_DISCOUNT` line's total saving is its per-unit applied discount cents multiplied by line quantity. A `BUY_X_GET_Y` line's total saving is `floor(qty / (N+M)) * M * Math.round((unitPrice * getDiscountPercent) / 100)`. The `BUY_X_GET_Y` pass runs AFTER the per-line `PRODUCT_DISCOUNT` best-wins pass and BEFORE the `ORDER_DISCOUNT` pass, so the post-line subtotal fed to `ORDER_DISCOUNT` already reflects the BUY_X_GET_Y saving.
(Previously: cross-type BUY_X_GET_Y comparison was out of scope; BUY_X_GET_Y itself was rejected at the engine gate. The cross-type best-wins rule now extends to BUY_X_GET_Y and compares real per-line total savings before fixed pass ordering.)

#### Scenario: BUY_X_GET_Y beats a smaller per-line PRODUCT_DISCOUNT on the same line
- GIVEN a 1000c/unit line with qty 6, AUTOMATIC `PRODUCT_DISCOUNT` P-A FIXED 100c/unit whose per-line total saving is `100*6` = 600c, and AUTOMATIC `BUY_X_GET_Y` P-B (buy 2 get 1 at 50%) whose per-line total saving is `floor(6/3)*1*Math.round((1000*50)/100)` = 1000c
- WHEN the engine evaluates
- THEN P-B is applied and P-A is NOT (1000c > 600c; no stacking)

#### Scenario: Cross-type comparison uses real per-line totals and lowest-id ties
- GIVEN case A is a 1000c/unit line with qty 3, `PRODUCT_DISCOUNT` P-A FIXED 500c/unit (total `500*3` = 1500c) versus `BUY_X_GET_Y` P-B buy 2 get 1 at 50% (total 500c); AND case B is a 1000c/unit line with qty 6, P-A FIXED 100c/unit (total 600c) versus P-B buy 2 get 1 at 30% (total `floor(6/3)*1*Math.round((1000*30)/100)` = 600c), with `P-B.id < P-A.id`
- WHEN the engine evaluates each case independently
- THEN case A applies P-A (1500c > 500c), while case B applies P-B (600c == 600c; lowest id wins); neither case stacks promotions

#### Scenario: BUY_X_GET_Y pass runs between per-line PRODUCT_DISCOUNT and ORDER_DISCOUNT
- GIVEN line L1 has qty 3 at 1000c/unit with an applied `BUY_X_GET_Y` saving 300c, line L2 has qty 1 at 1000c/unit with an applied `PRODUCT_DISCOUNT` saving 100c, and the sale has an `ORDER_DISCOUNT` PERCENTAGE 10% with `minPurchaseAmountCents = 0`
- WHEN the engine evaluates
- THEN the post-line subtotal fed to `ORDER_DISCOUNT` is `(3000-300)+(1000-100)` = 3600c, so its saving is 360c; the two line promotions remain on different lines and do NOT stack

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

### Requirement: VARIANT-Wins Specificity Precedence

When a sale line is eligible under both a `VARIANTS` target and a `PRODUCTS` target on the same product, the engine MUST apply the `VARIANTS`-matched promotion. This specificity rule overrides best-wins for that line; the `PRODUCTS`-matched promotion MUST NOT be applied to that line. The `VARIANTS` target MUST win regardless of discount value. A `VARIANTS`-targeted MANUAL promotion MUST appear in the targetable/available-for-manual set for drafts whose lines contain the targeted variant.

#### Scenario: VARIANTS wins over PRODUCTS on the same line

- GIVEN P1 has variants V-A, V-B; P-V (`PRODUCTS` on P1, AUTOMATIC, FIXED 50c), P-W (`VARIANTS` on V-A, AUTOMATIC, FIXED 30c)
- WHEN the engine evaluates a draft with one V-A line and one V-B line
- THEN P-W is applied to V-A (more specific, lower discount)
- AND P-V is applied to V-B
- AND P-V is NOT applied to V-A

#### Scenario: VARIANTS wins regardless of discount magnitude

- GIVEN P-V (`VARIANTS` on V-A, FIXED 10c), P-X (`PRODUCTS` on P1, FIXED 500c), P1 has V-A, V-B
- WHEN the engine evaluates a draft with one V-A line priced at 1000c
- THEN P-V is applied to V-A (10c), NOT P-X (500c)

#### Scenario: VARIANTS target on a different variant does not match the line

- GIVEN P-Y (`VARIANTS` on V-B, AUTOMATIC)
- WHEN the engine evaluates a draft with one V-A line and no V-B line
- THEN P-Y is NOT eligible for V-A

#### Scenario: MANUAL VARIANTS-targeted promo is offered for opt-in on matching drafts

- GIVEN P-M (`method = MANUAL`, `VARIANTS` on V-A)
- WHEN the engine evaluates a draft with one V-A line and recompute runs
- THEN P-M appears in the targetable/available-for-manual set

#### Scenario: Opted-in MANUAL VARIANTS-targeted promo survives recompute

- GIVEN the seller has opted in to P-M on a draft with one V-A line
- WHEN a recompute runs, then another runs after the seller adds an unrelated line
- THEN P-M remains applied on V-A across both recomputes

### Requirement: VARIANTS Target Validation

The system MUST reject a `VARIANTS` target whose `targetId` does not reference an existing variant in the same tenant, at create and update time. Validation MUST use the tenant-scoped Prisma client. A rejected request MUST NOT persist the promotion nor any `PromotionTargetItem` row.

#### Scenario: VARIANTS with an existing tenant variant id is accepted

- GIVEN a tenant with variant V-A
- WHEN `POST /promotions` creates a `VARIANTS` promotion with `targetItems = [V-A]`
- THEN the request succeeds and the promotion is persisted

#### Scenario: VARIANTS with a non-existent variant id is rejected

- GIVEN no variant `V-MISSING` exists in the tenant
- WHEN `POST /promotions` creates a `VARIANTS` promotion with `targetItems = [V-MISSING]`
- THEN the request is rejected and no promotion row is created

#### Scenario: VARIANTS with a cross-tenant variant id is rejected

- GIVEN variant V-A belongs to tenant T1 only
- WHEN a request for tenant T2 creates a `VARIANTS` promotion with `targetItems = [V-A]`
- THEN the request is rejected as if V-A did not exist

### Requirement: Specificity Precedence Ladder VARIANT > PRODUCT > {BRAND ≡ CATEGORY}

When a sale line is eligible under more than one targeting tier on the same product, the engine MUST apply only the promotion(s) matched at the MOST SPECIFIC tier present on that line, and MUST NOT apply promotions matched at any broader tier. The tier order, from most to least specific, is: `VARIANTS` (most specific), then `PRODUCTS`, then `BRANDS` and `CATEGORIES` as EQUAL-BROADNESS PEERS (least specific). This specificity rule overrides best-wins across tiers and holds regardless of discount value. Within the single most-specific tier present — including the `BRANDS ≡ CATEGORIES` peer tier when no `VARIANTS` or `PRODUCTS` match exists on the line — the existing best-wins rule decides the winner (highest discount, then lowest id). There is NO `BRANDS`-over-`CATEGORIES` hierarchy; they never win over each other by tier, only by best-wins.

This generalizes the prior binary `VARIANT-wins` precedence. For lines that only carry `VARIANTS`/`PRODUCTS` candidates the outcome is IDENTICAL to the prior behavior (no regression): a `VARIANTS` match still wins over a `PRODUCTS` match on the same line, and `PRODUCTS`-only lines are unaffected.

#### Scenario: VARIANTS wins over BRANDS and CATEGORIES on the same line

- GIVEN P1 has variant V-A with `categoryId = CAT1`, `brandId = BR1`
- AND P-V (`VARIANTS` on V-A, FIXED 10c), P-B (`BRANDS` on BR1, FIXED 500c), P-C (`CATEGORIES` on CAT1, FIXED 500c)
- WHEN the engine evaluates a draft with one V-A line
- THEN P-V is applied to the line (most specific)
- AND neither P-B nor P-C is applied to the line, regardless of their larger discount

#### Scenario: PRODUCTS wins over BRANDS and CATEGORIES on the same line

- GIVEN product P1 has `categoryId = CAT1`, `brandId = BR1`
- AND P-P (`PRODUCTS` on P1, FIXED 10c), P-B (`BRANDS` on BR1, FIXED 500c), P-C (`CATEGORIES` on CAT1, FIXED 500c)
- WHEN the engine evaluates a draft with one P1 line (no variant match)
- THEN P-P is applied to the line (more specific than BRAND/CATEGORY)
- AND neither P-B nor P-C is applied to the line

#### Scenario: BRAND and CATEGORY are peers — best-wins decides, not tier

- GIVEN product P1 has `categoryId = CAT1`, `brandId = BR1`, and no PRODUCTS/VARIANTS promo targets P1
- AND P-C (`CATEGORIES` on CAT1, FIXED 500c) and P-B (`BRANDS` on BR1, FIXED 100c)
- WHEN the engine evaluates a draft with one P1 line
- THEN P-C is applied to the line (higher discount wins the peer tie)
- AND P-B is NOT applied to the line
- AND the outcome would flip if P-B had the higher discount (no BRAND-over-CATEGORY hierarchy)

#### Scenario: VARIANTS/PRODUCTS-only precedence is unchanged (regression guard)

- GIVEN P1 has variants V-A, V-B
- AND P-V (`VARIANTS` on V-A, FIXED 30c), P-Pr (`PRODUCTS` on P1, FIXED 50c)
- WHEN the engine evaluates a draft with one V-A line and one V-B line
- THEN P-V is applied to V-A (variant wins over product, unchanged)
- AND P-Pr is applied to V-B
- AND P-Pr is NOT applied to V-A

### Requirement: CATEGORIES and BRANDS Target Validation

The system MUST reject a `CATEGORIES` target whose `targetId` does not reference an existing `Category`, and a `BRANDS` target whose `targetId` does not reference an existing `Brand`, at create and update time. Because `Category` and `Brand` are GLOBAL models (no tenant scoping), validation MUST use the global Prisma client — it MUST NOT be tenant-scoped. A rejected request MUST fail with `INVALID_TARGET` (HTTP 400) and MUST NOT persist the promotion nor any `PromotionTargetItem` row.

#### Scenario: CATEGORIES with an existing category id is accepted

- GIVEN a `Category` CAT1 exists
- WHEN `POST /promotions` creates a `CATEGORIES` promotion with `targetItems = [CAT1]`
- THEN the request succeeds and the promotion is persisted

#### Scenario: BRANDS with an existing brand id is accepted

- GIVEN a `Brand` BR1 exists
- WHEN `POST /promotions` creates a `BRANDS` promotion with `targetItems = [BR1]`
- THEN the request succeeds and the promotion is persisted

#### Scenario: CATEGORIES with a non-existent category id is rejected

- GIVEN no `Category` `CAT-MISSING` exists
- WHEN `POST /promotions` creates a `CATEGORIES` promotion with `targetItems = [CAT-MISSING]`
- THEN the request is rejected with `INVALID_TARGET` (400) and no promotion row is created

#### Scenario: BRANDS with a non-existent brand id is rejected

- GIVEN no `Brand` `BR-MISSING` exists
- WHEN `POST /promotions` creates a `BRANDS` promotion with `targetItems = [BR-MISSING]`
- THEN the request is rejected with `INVALID_TARGET` (400) and no promotion row is created

### Requirement: BUY_X_GET_Y Targeting Is Required

A `BUY_X_GET_Y` promotion MUST declare an `appliesTo` value of `PRODUCTS`, `VARIANTS`, `CATEGORIES`, or `BRANDS` AND at least one `targetItems[].targetId`. A `BUY_X_GET_Y` promotion without a target MUST be rejected at create and update time with `INVALID_TARGET` (400). The matching predicate reuses the existing tier match logic (`PRODUCTS` matches every variant of a variant-bearing product; `VARIANTS` matches only the exact variant; `CATEGORIES`/`BRANDS` match by product `categoryId`/`brandId`).

#### Scenario: BUY_X_GET_Y without a target is rejected
- GIVEN a `BUY_X_GET_Y` with `appliesTo = null` or `targetItems = []`
- WHEN `POST /promotions` runs
- THEN the request is rejected with `INVALID_TARGET` (400) and no promotion row is created

#### Scenario: Updating BUY_X_GET_Y to clear its target is rejected
- GIVEN an existing `BUY_X_GET_Y` with a valid target
- WHEN `PATCH /promotions/:id` sets `appliesTo = null` or `targetItems = []`
- THEN the request is rejected with `INVALID_TARGET` (400) and the existing promotion row is NOT mutated

#### Scenario: BUY_X_GET_Y with a valid PRODUCTS target is accepted
- GIVEN `BUY_X_GET_Y`, `appliesTo = PRODUCTS`, `targetItems = [P1]`
- WHEN `POST /promotions` runs
- THEN the request succeeds and the promotion is persisted

### Requirement: BUY_X_GET_Y Per-Line Eligibility And Counting

A `BUY_X_GET_Y` promotion is eligible for a sale line only when ALL of: (a) the line matches the promotion's `appliesTo` + `targetItems`; (b) the line's `quantity >= buyQuantity`; (c) the promotion passes existing global gates (status, date window, days of week, customer scope, price lists, min purchase). A non-eligible line is silently skipped. The number of reward groups is `floor(lineQty / (buyQuantity + getQuantity))`. If `floor(...) == 0` (qty `>= buyQuantity` but `< N+M`) the promo yields ZERO reward.

#### Scenario: Line below buyQuantity is not eligible
- GIVEN `BUY_X_GET_Y` (buy 2 get 1 at 50%), a line matching the target with qty 1
- WHEN the engine evaluates
- THEN the line is NOT eligible (no reward)

#### Scenario: Line at buyQuantity but below N+M yields zero reward
- GIVEN `BUY_X_GET_Y` (buy 2 get 1 at 50%), a line matching the target with qty 2
- WHEN the engine evaluates
- THEN the line IS eligible but yields ZERO reward (no full N+M group)

#### Scenario: Line at one full N+M group yields one reward group
- GIVEN `BUY_X_GET_Y` (buy 2 get 1 at 50%), a line matching the target with qty 3 at 1000c/unit
- WHEN the engine evaluates
- THEN the line yields ONE reward group: 1 get-unit at 50% off = `Math.round((1000*50)/100)` = 500c saving

#### Scenario: Line spanning multiple groups yields floor(Q/(N+M)) groups
- GIVEN `BUY_X_GET_Y` (buy 2 get 1 at 50%), a line matching the target with qty 6 at 1000c/unit
- WHEN the engine evaluates
- THEN the line yields TWO reward groups: 2 get-units × 500c = 1000c total per-line saving

### Requirement: BUY_X_GET_Y Cheapest-Unit Reward Selection And Rounding

The M discounted get-units per reward group are the CHEAPEST pre-promotion effective unit-price units of the line. When the line carries a single `effectiveUnitPriceCents` (the common case — same line = same unit price), the per-line saving equals `floor(qty / (N+M)) * M * Math.round((unitPrice * getDiscountPercent) / 100)`. A line that is NOT targeted yields zero reward. Per-unit rounding MUST follow the engine convention: `Math.round((base * percent) / 100)`.

#### Scenario: Per-unit rounding follows Math.round
- GIVEN `BUY_X_GET_Y` (buy 1 get 1 at 33%), a line matching the target with qty 2 at 100c/unit
- WHEN the engine evaluates
- THEN the per-unit reward is `Math.round((100*33)/100)` = 33c; the per-line saving is 33c

#### Scenario: Non-matching line yields zero reward
- GIVEN `BUY_X_GET_Y` (buy 2 get 1 at 50%) on `targetItems = [P1]`, draft has one P1 line (qty 3) and one P2 line (qty 3)
- WHEN the engine evaluates
- THEN the P1 line yields 1 reward group; the P2 line yields ZERO reward (not targeted)

### Requirement: BUY_X_GET_Y "Free" (100%)

`getDiscountPercent = 100` MUST be accepted for BOTH `BUY_X_GET_Y` and `ADVANCED`. Both reward paths bypass `SaleItem.applyDiscount`, whose percentage clamp MUST remain unchanged. At 100%, the get-unit surfaces at 0c and the single-line subtotal is NET. `previewTotals.subtotalCents` remains the pre-discount base, `previewTotals.discountCents` is the full unit discount, and `previewTotals.totalCents` is the NET amount. The receipt/detail mapper MUST emit the same NET line subtotal, full discount, and a `rewardKind` distinguishing the two: `rewardKind = 'buy_x_get_y'` for BUY_X_GET_Y and `rewardKind = 'advanced'` for ADVANCED. A 100% ADVANCED reward MUST reuse the same `applyDiscount` clamp change that BUY_X_GET_Y ships. `> 100` is rejected for both types.
(Previously: `getDiscountPercent = 100` was accepted for `BUY_X_GET_Y` only; `ADVANCED` was capped at 99. Per the D3 product decision, both promotion types now support a true 100% (free) reward; the `ADVANCED` cap is lifted.)

#### Scenario: 100% produces a true free get-unit and partial percentages use the same NET representation
- GIVEN case A is `BUY_X_GET_Y` (buy 2 get 1 at 100%) and case B is `BUY_X_GET_Y` (buy 2 get 1 at 50%), each evaluated independently on a matching single line with qty 3 at 1000c/unit
- WHEN the engine evaluates each case, `previewTotals` runs, and the receipt/detail mapper serializes each line
- THEN case A's get-unit surfaces at 0c; `previewTotals` is `subtotalCents = 3000`, `discountCents = 1000`, `totalCents = 2000`; the receipt line is `subtotalCents = 2000`, `discountCents = 1000`, `rewardKind = 'buy_x_get_y'`
- AND case B's per-unit reward is `Math.round((1000*50)/100)` = 500c; `previewTotals` is `subtotalCents = 3000`, `discountCents = 500`, `totalCents = 2500`; the receipt line is `subtotalCents = 2500`, `discountCents = 500`, `rewardKind = 'buy_x_get_y'`

### Requirement: BUY_X_GET_Y AUTOMATIC And MANUAL Wiring

AUTOMATIC `BUY_X_GET_Y` promotions MUST auto-apply on every recompute, subject to the per-draft veto. MANUAL `BUY_X_GET_Y` promotions MUST appear in `availableManualPromotions` when ANY line in the draft matches the target, and MUST appear in `targetableManualPromotionIds` for a specific line that matches. The seller explicitly opts in via the existing apply action; the opt-in survives recomputes (subject to eligibility re-evaluation). The response DTO wire type for both surfaces MUST include `BUY_X_GET_Y`.

#### Scenario: AUTOMATIC BUY_X_GET_Y auto-applies on recompute
- GIVEN a draft with one matching line (qty 6) and one AUTOMATIC `BUY_X_GET_Y` (buy 2 get 1 at 50%)
- WHEN a recompute runs
- THEN the promo is in the applied list with the per-line saving 1000c

#### Scenario: MANUAL BUY_X_GET_Y appears in availableManualPromotions when ANY matching line
- GIVEN a draft with one P1 line (qty 3) and one MANUAL `BUY_X_GET_Y` (buy 2 get 1 at 50%, target P1)
- WHEN a recompute runs without an explicit opt-in
- THEN the promo is in `availableManualPromotions` and NOT in the applied list

#### Scenario: MANUAL BUY_X_GET_Y appears in targetableManualPromotionIds for a specific matching line
- GIVEN a draft with one P1 line (qty 3) and one MANUAL `BUY_X_GET_Y` (buy 2 get 1 at 50%, target P1)
- WHEN a recompute runs
- THEN `targetableManualPromotionIds` includes the promo id for the P1 line

#### Scenario: Opted-in MANUAL BUY_X_GET_Y survives recompute
- GIVEN a seller has opted in to a MANUAL `BUY_X_GET_Y` on a draft with one matching line
- WHEN two consecutive recomputes run
- THEN the MANUAL promo remains applied across both (subject to eligibility re-evaluation)

### Requirement: BUY_X_GET_Y Idempotent Recompute

`recomputePromotions` MUST clear the prior `BUY_X_GET_Y` reward and re-apply the new one on every recompute. Two or more consecutive recomputes on the same draft MUST produce identical totals (no compounding). The per-line saving, line `discountCents`, and `previewTotals` (subtotalCents / discountCents / totalCents) MUST be byte-equal across recomputes.

#### Scenario: Five recomputes converge to identical totals
- GIVEN a draft with a matching line and a `BUY_X_GET_Y` auto-applied
- WHEN `recomputePromotions` runs five times consecutively
- THEN the fifth run's `subtotalCents`, `discountCents`, and `totalCents` equal the first run's exactly (no compounding)

### Requirement: ADVANCED Eligibility — Engine Gate

The engine MUST admit a `PromotionType = ADVANCED` promotion into the candidate set when `buyTargetType` and `getTargetType` each resolve to `PRODUCTS`, `VARIANTS`, `CATEGORIES`, or `BRANDS`. ADVANCED promotions with null buy/get target types or unsupported values MUST be silently skipped at the engine gate. When admitted, the promotion participates in side-aware targeting and the cross-line ADVANCED pass.

#### Scenario: ADVANCED with PRODUCTS buys and CATEGORIES gets is admitted
- GIVEN an ADVANCED promotion with `buyTargetType=PRODUCTS`, `getTargetType=CATEGORIES`, valid `buyQuantity`, `getQuantity`, `getDiscountPercent`
- WHEN the engine evaluates a draft
- THEN the promotion is in the candidate set and proceeds to targeting

#### Scenario: ADVANCED with null target type is silently skipped
- GIVEN an ADVANCED promotion with `buyTargetType = null`
- WHEN the engine evaluates a draft
- THEN the promotion is NOT in the candidate set and no error is surfaced

### Requirement: ADVANCED Side-Aware Target Tier Match

`matchTargetTier` MUST accept a `side: TargetSide` parameter (`DEFAULT | BUY | GET`) and match only target items where `PromotionTargetItem.side === side`. The DEFAULT contract MUST be preserved exactly: existing PRODUCT_DISCOUNT and BUY_X_GET_Y call sites pass `side='DEFAULT'` and behavior is unchanged. `match-target-tier.spec.ts :269-284` (previously asserted BUY/GET are ignored) MUST be rewritten to assert the new side-aware contract.

#### Scenario: BUY-side items match only when side=BUY
- GIVEN a target list with `{side=BUY, targetId=P1}` and `{side=GET, targetId=P2}`
- WHEN `matchTargetTier(items, line, 'BUY')` runs against a P1 line
- THEN it returns a BUY-side match (P1 hit); `'GET'` returns a GET-side match (P2 hit); `'DEFAULT'` returns null

#### Scenario: DEFAULT-side matcher unchanged for PRODUCT_DISCOUNT / BUY_X_GET_Y
- GIVEN a target list with `{side=DEFAULT, targetId=P1}` only
- WHEN `matchTargetTier(items, line, 'DEFAULT')` runs against a P1 line
- THEN it returns a DEFAULT-side match; PRODUCT_DISCOUNT and BUY_X_GET_Y existing specs pass unchanged

### Requirement: ADVANCED — BUY-Side Aggregated Counting (D1)

The engine MUST count the BUY condition aggregated across all cart lines whose resolved entity (VARIANT > PRODUCT > {CATEGORY, BRAND}) matches a BUY-side target item. `totalBuyMatchedQty` is the sum of matching-line quantities. Both paths satisfy the BUY condition: (a) a single line with `qty >= buyQuantity`; (b) multiple smaller lines summing to `buyQuantity`. Lines are not consumed until D2 computes reward groups. Out-of-target lines do NOT contribute.

#### Scenario: S1 — Multiple small BUY lines summing to N (canonical category→product)
- GIVEN ADVANCED (buy 3 from category Home Decor, get 1 of product Maceta-Large at 50%) and a draft with 2 × Vela-A + 1 × Vela-B (all in Home Decor) + 1 × Maceta-Large at 1000c/unit
- WHEN the engine evaluates
- THEN `totalBuyMatchedQty = 3` (Vela-A + Vela-B aggregated); BUY satisfied
- AND `floor(3/3) = 1` reward group applies 50% off Maceta-Large: `Math.round((1000*50)/100) = 500c` saving

#### Scenario: Single BUY line at or above buyQuantity
- GIVEN ADVANCED (buy 3 from CAT1, get 1 of P1 at 50%) and a draft with one CAT1-matching line at qty 5 + one P1 line
- WHEN the engine evaluates
- THEN `totalBuyMatchedQty = 5`; `floor(5/3) = 1` reward group

#### Scenario: Out-of-target lines do not contribute
- GIVEN ADVANCED (buy 3 from CAT1) and a draft with 2 × CAT1 + 2 × CAT2 + 1 × P1
- WHEN the engine evaluates
- THEN `totalBuyMatchedQty = 2`; BUY unsatisfied; no reward

### Requirement: ADVANCED — Per-Group Reward Repeatability (D2)

The number of reward applications MUST equal `rewardGroupCount = floor(totalBuyMatchedQty / buyQuantity)`. Each application discounts `getQuantity` GET units at `getDiscountPercent` of the GET unit's own `effectiveUnitPriceCents`. Reward cents: `floor(...) * getQuantity * Math.round((effectiveUnitPriceCents * getDiscountPercent) / 100)`. `floor(...) == 0` yields zero reward.

#### Scenario: S2 — Six matched BUY units and buyQuantity=3 yield 2 reward applications
- GIVEN ADVANCED (buy 3 from category Candles, get 1 of Holder-X at 30%) and a draft with 6 × Candle units + 3 × Holder-X at 1000c/unit
- WHEN the engine evaluates
- THEN `rewardGroupCount = floor(6/3) = 2`
- AND 2 reward applications on Holder-X: `2 * 1 * Math.round((1000*30)/100) = 600c` total saving
- AND the Holder-X line carries `rewardKind = 'advanced'`

#### Scenario: BUY count below buyQuantity yields zero reward groups
- GIVEN ADVANCED (buy 3 from CAT1) and a draft with 2 × CAT1 + 1 × P1
- WHEN the engine evaluates
- THEN `rewardGroupCount = floor(2/3) = 0`; no reward; `rewardKind` stays null

### Requirement: ADVANCED — GET-Side Magnitude Up To and Including 100% (D3, true-free)

The GET-side discount MUST be a percentage reusing `rewardDiscountPercent` semantics (0–100 inclusive; 100 = free, 50 = half off). `100` MUST be accepted for ADVANCED (D3 lifts the prior 99% cap, reusing BXGY's `applyDiscount` clamp change) — a 100% reward yields a free GET unit at 0c. `> 100` is still rejected. The percentage is computed against the GET unit's own `effectiveUnitPriceCents` (price-list and CUSTOM overrides respected). Per-unit rounding: `Math.round((base * percent) / 100)`.

#### Scenario: 100% ADVANCED yields a true free GET unit
- GIVEN ADVANCED (buy 3 from CAT1, get 1 of P1 at 100%) and a draft with 3 × CAT1 units + 1 × P1 at 1000c/unit
- WHEN the engine evaluates and `previewTotals` runs
- THEN the P1 get-unit surfaces at 0c
- AND `previewTotals` for the P1 line is `subtotalCents = 1000`, `discountCents = 1000`, `totalCents = 0`
- AND the receipt line carries `rewardKind = 'advanced'`

#### Scenario: >100 is still rejected for ADVANCED
- GIVEN an ADVANCED promotion attempt with `getDiscountPercent = 101`
- WHEN the create/update validation runs
- THEN the request is rejected and no promotion row is created

### Requirement: ADVANCED — `rewardKind: 'advanced'` Wire Discriminator (D4)

The wire MUST emit a new distinct `rewardKind: 'advanced'` value on `SaleItem.toResponse` and the confirmed-sale receipt mapper. The column-derived `isBuyXGetYReward()` cannot distinguish ADVANCED from BUY_X_GET_Y (both reuse `prePriceCentsBeforeDiscount === unitPriceCents`, `discountAmountCents > 0`, `promotionId` set); a new persisted or joined discriminator is required (additive migration: new `rewardKind` enum + nullable column on `SaleItem`). `buy_x_get_y` MUST NOT be reused for ADVANCED-shaped rows. `null` is still emitted for non-reward rows.

#### Scenario: ADVANCED reward emits rewardKind=advanced on the wire
- GIVEN an ADVANCED promotion auto-applies (D1+D2 satisfied)
- WHEN the sales apply path serializes the GET-side `SaleItem`
- THEN `toResponse().rewardKind === 'advanced'` and the confirmed-sale receipt mapper emits `rewardKind: 'advanced'` on the same line

#### Scenario: BUY_X_GET_Y rows still emit rewardKind=buy_x_get_y (no regression)
- GIVEN an auto-applied BUY_X_GET_Y
- WHEN the sales apply path serializes the line
- THEN the line carries `rewardKind: 'buy_x_get_y'` (unchanged)

### Requirement: ADVANCED — GET-Line Best-Wins By Maximum Total Saving (D5)

On a line that simultaneously attracts `PRODUCT_DISCOUNT`, `BUY_X_GET_Y`, and `ADVANCED`, the engine MUST apply the highest per-line total saving in real cents (3-way cross-type rule, extended from the existing BUY_X_GET_Y cross-type comparator at `use-case.ts :900-905`). Ties resolve by lowest `promotionId`. The comparator MUST NOT stack winners on a line.

#### Scenario: S5 — ADVANCED 50% beats 20% PRODUCT_DISCOUNT on the same line
- GIVEN a P1 line at 1000c/unit, an AUTOMATIC 20% PRODUCT_DISCOUNT (saving 200c) and an ADVANCED reward on the same P1 of 50% (saving 500c)
- WHEN the engine evaluates
- THEN the ADVANCED reward wins (500c > 200c); the line carries `rewardKind = 'advanced'`; the PRODUCT_DISCOUNT is NOT applied to the line

#### Scenario: Cross-type tie → lowest promotionId wins
- GIVEN a P1 line where PRODUCT_DISCOUNT and ADVANCED produce the SAME per-line total saving, with `P-advanced.id < P-pd.id`
- WHEN the engine evaluates
- THEN P-advanced wins (lowest id tie-breaker); no stacking

### Requirement: ADVANCED — AUTOMATIC-Only Scope (D6)

ADVANCED promotions MUST apply AUTOMATIC only in this slice. The MANUAL candidate surface, self-heal, cashier selection, and `availableManualPromotions` / `targetableManualPromotionIds` arrays MUST NOT be extended for ADVANCED. A `method = MANUAL` ADVANCED promotion MUST be silently skipped at the engine gate.

#### Scenario: AUTOMATIC ADVANCED auto-applies
- GIVEN a draft satisfying D1+D2 for an AUTOMATIC ADVANCED promotion
- WHEN a recompute runs
- THEN the ADVANCED reward is in the applied list

#### Scenario: MANUAL ADVANCED is silently skipped (no manual surface)
- GIVEN a draft satisfying D1+D2 for a `method = MANUAL` ADVANCED promotion
- WHEN a recompute runs
- THEN the promo is NOT in the applied list and is NOT in `availableManualPromotions`; no error is surfaced

### Requirement: ADVANCED — Disjoint BUY/GET Entities (D7)

BUY-side and GET-side target items MUST be disjoint. An ADVANCED promotion with `buyTargetItems` and `getTargetItems` referencing the SAME entity (any combination of product/variant/category/brand) MUST be rejected at promotion intake (create AND update) with an entity error (code `advanced_overlapping_targets`). The engine MUST NEVER receive a same-entity ADVANCED promotion — the engine is free of overlap/partition logic by construction. Cross-entity overlap (e.g. BUY=PRODUCTS:P where P ∈ GET=CATEGORIES:C with P as the single cart line) MUST be excluded from the GET pool by an engine-level `buyMatchedItemIds` partition so the same cart line/quantity cannot satisfy BUY and also be the rewarded GET line.

#### Scenario: S3 — Same entity on BUY and GET is rejected at intake
- GIVEN an ADVANCED create/update where `buyTargetItems = [P1]` and `getTargetItems = [P1]`
- WHEN `POST /promotions` (or PATCH) runs
- THEN the request is rejected with `advanced_overlapping_targets` and no promotion row is persisted

#### Scenario: Cross-entity BUY/GET is accepted at intake
- GIVEN an ADVANCED create with `buyTargetItems = [CAT1]` and `getTargetItems = [P1]`
- WHEN `POST /promotions` runs
- THEN the promotion is persisted

#### Scenario: Engine partition excludes BUY-matched lines from the GET pool on cross-entity overlap
- GIVEN an ADVANCED promotion with BUY=PRODUCTS:P and GET=CATEGORIES:C, and P ∈ C; the cart has a single P line
- WHEN the engine evaluates
- THEN no ADVANCED result is emitted (no double benefit); the same promotion on a disjoint cart (P line + Q line with Q ∈ C) rewards Q correctly and P stays un-rewarded

### Requirement: ADVANCED — Quantity-Only Threshold (D8)

The BUY-side threshold MUST be quantity only. A minimum-amount threshold (`minPurchaseAmountCents` on the BUY side) is a future follow-up and MUST NOT be added in this slice. The engine MUST NOT read or write any BUY-side `minPurchaseAmountCents` for ADVANCED. The entity's ADVANCED case (`:491-512`) already forbids `minPurchaseAmountCents`; the engine respects that.

#### Scenario: Quantity threshold is the only BUY-side gate
- GIVEN an ADVANCED promotion with `buyQuantity=3` and no minimum-amount field
- WHEN the engine evaluates
- THEN the BUY condition gates on `totalBuyMatchedQty >= 3` only

### Requirement: ADVANCED Cross-Line Pass Placement

The ADVANCED pass MUST run AFTER the BUY_X_GET_Y pass and BEFORE the ORDER_DISCOUNT pass in `evaluate()` (between `use-case.ts :283` and `:304`). The pass aggregates BUY-side matches across the whole draft, calls `computeAdvancedReward`, and emits a line result on each affected GET-side line. The result rides the existing `applyBuyXGetYReward` rail; the only difference from BUY_X_GET_Y is the discriminator (D4) and the cross-line eligibility source. A zero-or-negative reward MUST be skipped (no downstream throw).

#### Scenario: ADVANCED saving flows into ORDER_DISCOUNT's subtotal
- GIVEN a draft with an ADVANCED reward on a GET line, a BUY_X_GET_Y on a different line, and an ORDER_DISCOUNT eligible on the post-line subtotal
- WHEN the engine evaluates
- THEN ORDER_DISCOUNT's base subtotal reflects BOTH the BXGY saving AND the ADVANCED saving

### Requirement: ADVANCED Idempotent Recompute

`recomputePromotions` MUST clear prior ADVANCED rewards and re-apply the new one on every recompute (mirroring BUY_X_GET_Y). Two or more consecutive recomputes on the same draft MUST produce byte-equal `SaleItem` rows — `rewardKind`, `discountAmountCents`, `unitPriceCents`, `prePriceCentsBeforeDiscount`, `rewardDiscountPercent` identical — and byte-equal `previewTotals` (no compounding).

#### Scenario: Five recomputes converge to identical totals
- GIVEN a draft with an auto-applied ADVANCED reward
- WHEN `recomputePromotions` runs five times consecutively
- THEN the fifth run's `previewTotals.subtotalCents`, `discountCents`, `totalCents` and per-line `rewardKind` / `discountAmountCents` equal the first run's exactly

### Requirement: ADVANCED Degenerate Cart — BUY Met, No GET Line

A draft that satisfies the BUY-side condition but contains no line whose resolved entity matches a GET-side target item MUST emit NO ADVANCED result, NO receipt line, NO saving. The engine silently skips. Mirrors the BUY_X_GET_Y rule for non-matching lines.

#### Scenario: S4 — BUY met but no GET line → no reward
- GIVEN an ADVANCED promotion (buy 3 from CAT1, get 1 of P1 at 50%) and a draft with 3 × CAT1 units and NO P1 line
- WHEN the engine evaluates
- THEN no ADVANCED result is emitted; no receipt line is produced; `previewTotals` reflects no saving; no error

## Verification Surface

- `src/promotions/application/pos-evaluate-promotions.use-case.spec.ts` (eligibility + best-wins + precedence; C1 price-list resolved-global-id; W3 99% clamp; manual opt-in; veto; manual-wins)
- `src/promotions/application/match-target-tier.spec.ts` (table-driven: VARIANT/PRODUCT/BRAND/CATEGORY tier; null `variantId`/`categoryId`/`brandId` never matches its respective type)
- `src/promotions/application/pos-evaluate-promotions-w4.spec.ts` (VARIANT-wins precedence scenarios 5–9; targetable/available-for-manual for VARIANTS; survives recompute)
- `src/promotions/application/pos-evaluate-promotions-precedence.spec.ts` (NEW — ordinal `maxOrdinal` pre-pass: 4-tier V>P>{B,C}; 3-tier P>{B,C}; 2-tier B≡C best-wins (CAT wins, flips when BRAND>CAT, lowest-id tie); VARIANTS/PRODUCTS-only regression guard)
- `src/promotions/application/pos-evaluate-promotions.buy-x-get-y-helper.spec.ts` (NEW — pure `computeBuyXGetYReward`: qty3/1000c/2+1/50, multi-group qty6/9/7, zero-group qty1 & qty2, 100% true-free, 33%/17% rounding, non-round 777c)
- `src/promotions/application/pos-evaluate-promotions.buy-x-get-y.spec.ts` (NEW — engine pass: gate admits 4 appliesTo tiers; per-line counting + rounding + non-match; short-circuit on `hasManualDiscount`; cross-type total-saving best-wins (Q5) + ties→lowest id; pass-order L1+L2→ORDER 360c)
- `src/promotions/infrastructure/prisma-promotion.repository.spec.ts` (resolve-price-list-global-ids batch; tenant-scoped)
- `src/promotions/domain/promotion-target-variants.spec.ts` (entity accepts `appliesTo='VARIANTS'` + `TargetItemDto` shape)
- `src/promotions/promotions-validate-variants.spec.ts` (`validateTargetIds` VARIANTS branch — accepted / not-found / cross-tenant; tenant-scoped client guard)
- `src/promotions/domain/promotion.entity.spec.ts` (BXGY 100% accepted; ADVANCED 100% accepted — cap lifted (D3); `> 100` rejected for both types; `validateByType` requires target for BXGY; ADVANCED forbids `minPurchaseAmountCents` for D8)
- `src/promotions/dto/create-promotion.dto.spec.ts` (NEW — `getDiscountPercent` DTO bound 100 ok / 101 rejected)
- `src/promotions/variant-level-promo-targeting.integration.spec.ts` (live-DB end-to-end sweep on Postgres :5433 — 12 spec-scenario-named cases; real T2 tenant for cross-tenant validation)
- `src/promotions/category-brand-promo-targeting.integration.spec.ts` (NEW — live-DB e2e on Postgres :5433 — 11 spec-scenario-named cases: matcher 2–5, precedence P1–P3, validation V1–V4)
- `src/promotions/buy-x-get-y.integration.spec.ts` (NEW — live-DB e2e on Postgres :5433 — 18 spec-scenario-named cases: BW-1..3, T-1..3, E-1..4, R-1..2, F-1 (2 sub-cases), M-1..4, I-1)
- `src/promotions/advanced-promotion-type.integration.spec.ts` (NEW — live-DB e2e on Postgres :5433 — spec-scenario-named cases covering S1, S2, S3, S4, S5, plus the 100% free scenario, plus ORDER_DISCOUNT subtotal flow-through)
- `src/promotions/application/pos-evaluate-promotions.advanced-helper.spec.ts` (NEW — pure `computeAdvancedReward`: single-group, S2 multi-group, zero-group, 100% true-free, rounding, multi-`getQuantity`, multi-GET-line lowest-`itemId` allocation)
- `src/promotions/application/pos-evaluate-promotions.advanced.spec.ts` (NEW — engine pass: gate admits 4 buys × 4 gets target types; side-aware aggregated BUY counting (D1); degenerate-cart; 100% yields free GET; best-wins 3-way (D5); tie→lowest id; zero-skip; BUY/GET partition on cross-entity overlap (4R))
- `src/promotions/application/match-target-tier.spec.ts` (rewrite `:269-284` — replace "BUY/GET ignored" with side-aware BUY/GET/DEFAULT contract)
- `src/promotions/promotions-validate-side-disjoint.spec.ts` (NEW — D7 same-entity BUY/GET rejected at intake on create + update; cross-entity accepted; error code `advanced_overlapping_targets`)
- `src/products/resolve-product-category-brand-ids.spec.ts` (NEW — tenant-scoped resolver: distinct→1 call, empty→0, missing omitted, null preserved, `tenantPrisma.getClient` asserted)
- `src/sales/sales.service.spec.ts` (recompute-on-mutation integration; opt-in persistence; veto persistence through charge tx; W4 stamps `categoryId`/`brandId` per PosEvalLine; BXGY idempotent recompute 5× byte-equal; MANUAL BXGY candidate + targetable + opt-in survival; ADVANCED `recomputePromotions` routes to `applyBuyXGetYReward` with `rewardKind='advanced'`; ADVANCED idempotent 5× byte-equal)
- `src/sales/domain/sale-item.entity.spec.ts` (promotionId audit on line; applyDiscount with promotionId; BXGY `applyBuyXGetYReward` / `isBuyXGetYReward` discriminator + guard rails; WU8 draft `toResponse()` NET `subtotalCents` + `rewardKind`; ADVANCED `rewardKind='advanced'` on `toResponse`; full-line free apply at qty=1 R==line → no throw, NET=0)
- `src/sales/domain/sale.entity.spec.ts` (previewTotals — order-discount-aware subtotal/discount/total; S-1 clamp; appliedOrderPromotion / vetoedPromotionIds / optedInManualPromotionIds fields; BXGY 100% previewTotals 3000/1000/2000, BXGY 50% 3000/500/2500, multi-group qty6 6000/1000/5000; ADVANCED 100% previewTotals totalCents=0 on the GET line at qty=1; S2 multi-group 600c saving)
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` (W2: four read mappers load veto + applied-promo + opt-in; opt-in delete-then-createMany save; persistChargeConfirmation item re-write W1; BXGY receipt mapper NET subtotal + `rewardKind='buy_x_get_y'`; PD/manual regression `rewardKind=null`; ADVANCED confirmed-receipt mapper emits `rewardKind='advanced'`; all four draft reload mappers forward `rewardKind` (4R))