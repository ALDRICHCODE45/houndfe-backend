# Delta for pos-promotion-engine

> Activates the previously DEFERRED `BUY_X_GET_Y` promo TYPE in the POS
> engine. Simple "buy N, get M at a discount" only (3x2-style).
> Targeted + REQUIRED (`appliesTo` + `targetItems`); per-line buy
> counting; `floor(Q/(N+M))` reward groups with CHEAPEST get-units;
> best-wins NO STACKING across `PRODUCT_DISCOUNT` + `BUY_X_GET_Y`;
> pass runs AFTER per-line `PRODUCT_DISCOUNT` best-wins and BEFORE
> `ORDER_DISCOUNT`; `getDiscountPercent=100` (true free) supported;
> AUTOMATIC + MANUAL both wired. Approach A — new per-line
> fixed-cents reward. Online/cart engine is OUT OF SCOPE. No
> `PromotionType` enum / DTO / Prisma / migration change beyond the
> Q1 `validateByType` tightening and the Q6 99→100 cap (the type
> and the three scalar columns pre-exist; `prisma migrate diff` is
> empty).

## MODIFIED Requirements

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

## ADDED Requirements

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

`getDiscountPercent = 100` MUST be accepted for `BUY_X_GET_Y` only; `ADVANCED` MUST remain capped at 99. The `BUY_X_GET_Y` reward path bypasses `SaleItem.applyDiscount`, whose percentage clamp MUST remain unchanged. At 100%, the get-unit surfaces at 0c and the single-line subtotal is NET. `previewTotals.subtotalCents` remains the 3000c pre-discount base, while `previewTotals.discountCents` is 1000c and `previewTotals.totalCents` is the 2000c NET amount. The receipt/detail mapper MUST emit the same 2000c NET line subtotal, 1000c discount, and `rewardKind = 'buy_x_get_y'`.

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
