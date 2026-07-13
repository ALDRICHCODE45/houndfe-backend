# Delta for pos-promotion-engine

> Activates the previously DEFERRED `CATEGORIES` and `BRANDS` engine
> targeting (peers of each other, broader than `PRODUCTS`). Adds the
> `VARIANT > PRODUCT > {BRAND ≡ CATEGORY}` specificity ladder and the
> null-category/null-brand no-match guard. Category/brand are resolved
> LIVE from the line's product at eval time (no snapshot, no migration).
> Target-id validation is GLOBAL (Category/Brand have no tenant). Online/
> cart engine is OUT OF SCOPE.

## MODIFIED Requirements

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

## ADDED Requirements

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
