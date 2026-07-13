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

## Verification Surface

- `src/promotions/application/pos-evaluate-promotions.use-case.spec.ts` (eligibility + best-wins + precedence; C1 price-list resolved-global-id; W3 99% clamp; manual opt-in; veto; manual-wins)
- `src/promotions/application/match-target-tier.spec.ts` (table-driven: VARIANT/PRODUCT/BRAND/CATEGORY tier; null `variantId`/`categoryId`/`brandId` never matches its respective type)
- `src/promotions/application/pos-evaluate-promotions-w4.spec.ts` (VARIANT-wins precedence scenarios 5–9; targetable/available-for-manual for VARIANTS; survives recompute)
- `src/promotions/application/pos-evaluate-promotions-precedence.spec.ts` (NEW — ordinal `maxOrdinal` pre-pass: 4-tier V>P>{B,C}; 3-tier P>{B,C}; 2-tier B≡C best-wins (CAT wins, flips when BRAND>CAT, lowest-id tie); VARIANTS/PRODUCTS-only regression guard)
- `src/promotions/infrastructure/prisma-promotion.repository.spec.ts` (resolve-price-list-global-ids batch; tenant-scoped)
- `src/promotions/domain/promotion-target-variants.spec.ts` (entity accepts `appliesTo='VARIANTS'` + `TargetItemDto` shape)
- `src/promotions/promotions-validate-variants.spec.ts` (`validateTargetIds` VARIANTS branch — accepted / not-found / cross-tenant; tenant-scoped client guard)
- `src/promotions/variant-level-promo-targeting.integration.spec.ts` (live-DB end-to-end sweep on Postgres :5433 — 12 spec-scenario-named cases; real T2 tenant for cross-tenant validation)
- `src/promotions/category-brand-promo-targeting.integration.spec.ts` (NEW — live-DB e2e on Postgres :5433 — 11 spec-scenario-named cases: matcher 2–5, precedence P1–P3, validation V1–V4)
- `src/products/resolve-product-category-brand-ids.spec.ts` (NEW — tenant-scoped resolver: distinct→1 call, empty→0, missing omitted, null preserved, `tenantPrisma.getClient` asserted)
- `src/sales/sales.service.spec.ts` (recompute-on-mutation integration; opt-in persistence; veto persistence through charge tx; W4 stamps `categoryId`/`brandId` per PosEvalLine)
- `src/sales/domain/sale-item.entity.spec.ts` (promotionId audit on line; applyDiscount with promotionId)
- `src/sales/domain/sale.entity.spec.ts` (previewTotals — order-discount-aware subtotal/discount/total; S-1 clamp; appliedOrderPromotion / vetoedPromotionIds / optedInManualPromotionIds fields)
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` (W2: four read mappers load veto + applied-promo + opt-in; opt-in delete-then-createMany save; persistChargeConfirmation item re-write W1)