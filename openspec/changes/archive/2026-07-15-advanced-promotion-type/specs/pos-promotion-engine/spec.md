# Delta Spec: pos-promotion-engine — ADVANCED Promotion Type Activation

**Change binds a single capability.** Modified: `pos-promotion-engine`. New: none.

## Engine seams (per exploration, for traceability — not a design)

| Seam | File:line | Change |
|------|-----------|--------|
| `isSupportedEngineType` | `pos-evaluate-promotions.use-case.ts :536-581` | Admit `ADVANCED` |
| `matchTargetTier` | `use-case.ts :136-199` | Add `side: TargetSide = 'DEFAULT'` parameter |
| `computeAdvancedReward` (NEW, pure) | mirrors `computeBuyXGetYReward :73-100` | Two-sided: BUY count + GET reward |
| `evaluateAdvancedPass` (NEW) | slots between BXGY `:283` and ORDER `:304` | First cross-line pass |
| `recomputePromotions` | `sales.service.ts :479-552` | Route to `applyBuyXGetYReward` |
| `SaleItem` discriminator | `sale-item.entity.ts :413-421, 512` + receipt mapper | New persisted `rewardKind='advanced'` |
| Cross-type comparator | `use-case.ts :900-905` | Extend to 3-way max-savings |
| `validateGetDiscountPercent` | `promotion.entity.ts :180-191` | Lift 99% → 100% (D3 correction) |

## Archive notes (non-requirement edits — archive phase MUST apply)

- **Purpose** (main spec `:10-15`): replace `"ADVANCED stays capped at 99"` with `"ADVANCED now also reaches 100% (true free), reusing BXGY's applyDiscount clamp; >100 still rejected"`.
- **Verification Surface** (main spec `:533`): rewrite `"ADVANCED 100% throws — type-aware cap"` to `"ADVANCED 100% accepted (cap lifted; >100 still rejected)"` and append the new ADVANCED specs listed under ADDED Requirements below.

---

## MODIFIED Requirements

### Requirement: BUY_X_GET_Y "Free" (100%)

`getDiscountPercent = 100` MUST be accepted for BOTH `BUY_X_GET_Y` and `ADVANCED`. Both reward paths bypass `SaleItem.applyDiscount`, whose percentage clamp MUST remain unchanged. At 100%, the get-unit surfaces at 0c and the single-line subtotal is NET. `previewTotals.subtotalCents` remains the pre-discount base, `previewTotals.discountCents` is the full unit discount, and `previewTotals.totalCents` is the NET amount. The receipt/detail mapper MUST emit the same NET line subtotal, full discount, and a `rewardKind` distinguishing the two: `rewardKind = 'buy_x_get_y'` for BUY_X_GET_Y and `rewardKind = 'advanced'` for ADVANCED. A 100% ADVANCED reward MUST reuse the same `applyDiscount` clamp change that BUY_X_GET_Y ships. `> 100` is rejected for both types.

(Previously: `getDiscountPercent = 100` was accepted for `BUY_X_GET_Y` only; `ADVANCED` was capped at 99. Per the D3 product decision, both promotion types now support a true 100% (free) reward; the `ADVANCED` cap is lifted.)

#### Scenario: 100% produces a true free get-unit and partial percentages use the same NET representation
- GIVEN case A is `BUY_X_GET_Y` (buy 2 get 1 at 100%) and case B is `BUY_X_GET_Y` (buy 2 get 1 at 50%), each evaluated independently on a matching single line with qty 3 at 1000c/unit
- WHEN the engine evaluates each case, `previewTotals` runs, and the receipt/detail mapper serializes each line
- THEN case A's get-unit surfaces at 0c; `previewTotals` is `subtotalCents = 3000`, `discountCents = 1000`, `totalCents = 2000`; the receipt line is `subtotalCents = 2000`, `discountCents = 1000`, `rewardKind = 'buy_x_get_y'`
- AND case B's per-unit reward is `Math.round((1000*50)/100)` = 500c; `previewTotals` is `subtotalCents = 3000`, `discountCents = 500`, `totalCents = 2500`; the receipt line is `subtotalCents = 2500`, `discountCents = 500`, `rewardKind = 'buy_x_get_y'`

---

## ADDED Requirements

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

`matchTargetTier` MUST accept a `side: TargetSide` parameter (`DEFAULT | BUY | GET`) and match only target items where `PromotionTargetItem.side === side`. The DEFAULT contract MUST be preserved exactly: existing PRODUCT_DISCOUNT and BUY_X_GET_Y call sites pass `side='DEFAULT'` and behavior is unchanged. `match-target-tier.spec.ts :269-284` (currently asserts BUY/GET are ignored) MUST be rewritten to assert the new side-aware contract.

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

BUY-side and GET-side target items MUST be disjoint. An ADVANCED promotion with `buyTargetItems` and `getTargetItems` referencing the SAME entity (any combination of product/variant/category/brand) MUST be rejected at promotion intake (create AND update) with an entity error (code TBD by sdd-design). The engine MUST NEVER receive a same-entity ADVANCED promotion — the engine is free of overlap/partition logic by construction.

#### Scenario: S3 — Same entity on BUY and GET is rejected at intake
- GIVEN an ADVANCED create/update where `buyTargetItems = [P1]` and `getTargetItems = [P1]`
- WHEN `POST /promotions` (or PATCH) runs
- THEN the request is rejected with the entity error (code TBD) and no promotion row is persisted

#### Scenario: Cross-entity BUY/GET is accepted at intake
- GIVEN an ADVANCED create with `buyTargetItems = [CAT1]` and `getTargetItems = [P1]`
- WHEN `POST /promotions` runs
- THEN the promotion is persisted

### Requirement: ADVANCED — Quantity-Only Threshold (D8)

The BUY-side threshold MUST be quantity only. A minimum-amount threshold (`minPurchaseAmountCents` on the BUY side) is a future follow-up and MUST NOT be added in this slice. The engine MUST NOT read or write any BUY-side `minPurchaseAmountCents` for ADVANCED. The entity's ADVANCED case (`:491-512`) already forbids `minPurchaseAmountCents`; the engine respects that.

#### Scenario: Quantity threshold is the only BUY-side gate
- GIVEN an ADVANCED promotion with `buyQuantity=3` and no minimum-amount field
- WHEN the engine evaluates
- THEN the BUY condition gates on `totalBuyMatchedQty >= 3` only

### Requirement: ADVANCED Cross-Line Pass Placement

The ADVANCED pass MUST run AFTER the BUY_X_GET_Y pass and BEFORE the ORDER_DISCOUNT pass in `evaluate()` (between `use-case.ts :283` and `:304`). The pass aggregates BUY-side matches across the whole draft, calls `computeAdvancedReward`, and emits a line result on each affected GET-side line. The result rides the existing `applyBuyXGetYReward` rail; the only difference from BUY_X_GET_Y is the discriminator (D4) and the cross-line eligibility source.

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

---

## Verification Surface (new specs)

- `src/promotions/application/pos-evaluate-promotions.advanced-helper.spec.ts` (NEW — pure `computeAdvancedReward`: single-group, S2 multi-group, zero-group, 100% true-free, >100 rejected, rounding, multi-getQuantity)
- `src/promotions/application/pos-evaluate-promotions.advanced.spec.ts` (NEW — engine pass: gate admits 4 buys × 4 gets target types; side-aware `matchTargetTier`; cross-line aggregated BUY counting; degenerate-cart; 100% yields free GET)
- `src/promotions/application/match-target-tier.spec.ts` (MODIFY `:269-284` — rewrite BUY/GET-ignored assertion to side-aware contract)
- `src/promotions/domain/promotion.entity.spec.ts` (MODIFY — `validateGetDiscountPercent` ADVANCED case: 100 accepted; 101 still rejected; cap lifted)
- `src/promotions/promotions-validate-side-disjoint.spec.ts` (NEW — S3 same-entity rejected at intake; cross-entity accepted)
- `src/sales/sales.service.spec.ts` (extend — ADVANCED `recomputePromotions` routes to `applyBuyXGetYReward`; idempotent 5× byte-equal; `rewardKind='advanced'` on line)
- `src/sales/domain/sale-item.entity.spec.ts` (extend — `rewardKind='advanced'` on `toResponse`; `applyBuyXGetYReward` reused with `rewardKind` set)
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` (extend — confirmed-receipt mapper emits `rewardKind='advanced'`)
- `src/sales/sale.entity.spec.ts` (extend — `previewTotals` for ADVANCED 100% yields totalCents=0 on GET line; multi-group 600c saving)
- `src/promotions/advanced-promotion-type.integration.spec.ts` (NEW — live-DB e2e on Postgres :5433 — spec-scenario-named cases covering S1, S2, S3, S4, S5, plus the 100% free scenario)
- `docs/promotions-frontend.md` (MODIFY — document POS/evaluation semantics + new `rewardKind='advanced'` value)
- `docs/promotions-in-sale-frontend-prompt.md` (MODIFY — remove ADVANCED from deferred list at `:31, 241`)