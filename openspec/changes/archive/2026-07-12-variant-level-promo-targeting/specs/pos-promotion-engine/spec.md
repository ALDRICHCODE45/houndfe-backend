# Delta for pos-promotion-engine

> Adds `VARIANTS` target type (peer of `PRODUCTS`), `VARIANT`-wins
> specificity precedence, and tenant-scoped target-id validation.
> Online/cart engine is OUT OF SCOPE; match predicate is a pure helper
> for later reuse.

## MODIFIED Requirements

### Requirement: PRODUCT_DISCOUNT Matches Target Items

The engine MUST match a `PRODUCT_DISCOUNT` promotion against lines using `appliesTo` and `targetItems[].targetId`. `PRODUCTS` matches by productId and CONTINUES to match every variant of that product; `CATEGORIES` matches by product category id; `BRANDS` matches by product brand id; `VARIANTS` matches only by variantId when the line's `variantId` equals the target's `targetId`. Non-matching lines are NOT touched.
(Previously: no `VARIANTS` type; `PRODUCTS` matched every variant implicitly — preserved.)

#### Scenario: PRODUCTS targeting matches by product id

- GIVEN `appliesTo = PRODUCTS`, `targetItems = [P1]`
- WHEN the engine evaluates a draft with one P1 line and one P2 line
- THEN only the P1 line is eligible

#### Scenario: CATEGORIES targeting matches by category id (DEFERRED — out of scope for this change)

> DEFERRED: `CATEGORIES`/`BRANDS` engine targeting is NOT activated by this
> change and is NOT part of its acceptance contract. `isSupportedEngineType`
> intentionally skips these types today. This scenario documents future
> intended behavior only; it is covered by the separate "activate deferred
> promo types" backlog item, not here. `matchTargetTier` returns `null` for
> `CATEGORIES` in this slice by design.

- GIVEN `appliesTo = CATEGORIES`, `targetItems = [CAT1]`
- WHEN the deferred CATEGORIES engine support is implemented
- THEN only the CAT1 line is eligible

#### Scenario: PRODUCTS still matches every variant of a variant-bearing product

- GIVEN `appliesTo = PRODUCTS`, `targetItems = [P1]`, P1 has variants V-A, V-B
- WHEN the engine evaluates a draft with one V-A line and one V-B line
- THEN both lines are eligible

#### Scenario: VARIANTS matches only the exact variant

- GIVEN `appliesTo = VARIANTS`, `targetItems = [V-A]`, P1 has variants V-A, V-B
- WHEN the engine evaluates a draft with one V-A line and one V-B line
- THEN only the V-A line is eligible

## ADDED Requirements

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
