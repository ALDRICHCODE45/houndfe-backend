# Proposal: Activate BUY_X_GET_Y in the POS Promotion Engine

## Intent

Activate the DEFERRED `PromotionType` `BUY_X_GET_Y` in the POS promotion engine. The
type is already wired through `PromotionType` union (`promotion.entity.ts:6-10`),
`PromotionTypeEnum` (`create-promotion.dto.ts:18-23`), Prisma `enum PromotionType`
(`schema.prisma:66-70`), the three scalar columns `buyQuantity`/`getQuantity`/
`getDiscountPercent` (`schema.prisma:1091-1093`), `validateByType` BUY_X_GET_Y case
(`promotion.entity.ts:464-486`), and round-trip persistence — but **consumed nowhere**.
Today `isSupportedEngineType` (`pos-evaluate-promotions.use-case.ts:381-407`) rejects
it, so a cashier cannot apply a "buy 2 get 1 at 50%" promo. This change accepts the
**simple** "buy N, get M at a discount" mechanic (3x2-style) only.

## Why Now

Next backlog step after the targeting deltas (`variant-level-promo-targeting`,
`category-brand-promo-targeting`) are complete. Unlocks a **new discount MECHANIC**
(class `conditional + partial-quantity`), not a targeting delta. The representational
gap (Discovery #4) is unavoidable and gets harder to retro-fit once more pass types
land, so now is the cheapest moment.

## Scope

### In Scope

- Engine gate flip in `isSupportedEngineType` to accept `BUY_X_GET_Y`.
- New **pure exported helper** (`computeBuyXGetYReward` / similar) — buy/get eligibility
  + reward-unit computation, mirroring `matchTargetTier` (pure, unit-testable, reused by
  the future cart engine).
- New **BUY_X_GET_Y evaluation pass** in `evaluate()` running **after** the per-line
  `PRODUCT_DISCOUNT` best-wins pass (`:208-215`) and **before** the `ORDER_DISCOUNT`
  pass (`:236-241`) — feeds ORDER_DISCOUNT the post-line saving.
- New/adapted `PosEvalLineResult` shape to express a per-line **fixed-cents** reward
  (partial-quantity) — addresses the representational gap.
- Entity change: a `SaleItem`/`Sale` path for the line-level fixed-cents reward so
  `previewTotals` reflects it (`sale.entity.ts:492-526`).
- Tighten `validateByType` BUY_X_GET_Y case to **require** `appliesTo` + `targetItems`
  (Q1 closes current validation gap).
- Extend `getDiscountPercent` cap **99 → 100** + adjust `SaleItem.applyDiscount`
  percentage clamp (`1..99 → 1..100`) and the `baseline - discount >= 1` invariant
  (`sale-item.entity.ts:267`, `:302-309`) so 100% = true free (Q6).
- MANUAL wiring: extend manual-candidate mapper + self-heal loop
  (`availableManualPromotions :250`, `targetableManualPromotionIds :316`, `:326`) and the
  response DTO wire type — currently hard-map type to `'PRODUCT_DISCOUNT'|'ORDER_DISCOUNT'`.
- Spec un-defer BUY_X_GET_Y in `openspec/specs/pos-promotion-engine/spec.md` + add
  scenarios for counting, cheapest-unit selection, precedence, "free", MANUAL, rounding,
  insufficient qty.
- TDD-first tests: pure-helper spec, engine spec, sales.service spec, integration sweep
  on a seeded tenant.

### Out of Scope (Non-Goals)

- `ADVANCED` (compound BUY-side target → GET-side target via `buyTargetType`/
  `getTargetType`/`side=BUY|GET`) — separate future change.
- Online/cart engine (`evaluate-cart-promotions.use-case.ts`) — untouched (the new
  helper is designed for future reuse there but not wired in).
- Any frontend work.
- No `PromotionType` enum / DTO / Prisma enum / migration change beyond the Q1
  `validateByType` tightening and the Q6 99→100 cap (no `ADD VALUE` migration — the
  enum value is already in `migration.sql:17`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pos-promotion-engine`: un-defer BUY_X_GET_Y scenarios. The `Engine Supports Types`
  requirement changes to include `BUY_X_GET_Y`. The `BUY_X_GET_Y Evaluation` block
  becomes ADD (new requirement with Given/When/Then scenarios for Q1–Q9). The
  `Product Discount Precedence` requirement gains the "no stacking; best-wins across
  types, ties → lowest id" clause.

## Approach (recommended default — design finalizes)

**Approach A** — new/adapted per-line **fixed-cents** reward result + new pure exported
helper + new evaluation pass. The helper computes eligibility (per-line qty ≥
buyQuantity, target match) and selects the cheapest M units per reward group
(`floor(Q/(N+M))` groups). The new pass emits an `amount`-type per-line result whose
total cents = Σ over discounted get-units (`Math.round((effectivePrice * getPercent) /
100)`), applied via a new line-level reward path on `SaleItem`/`Sale`.

- **Why not B (line splitting):** mutating cart line structure from the engine blows up
  item-id-keyed veto/opt-in bookkeeping and the idempotent recompute — high regression
  blast radius across ~1600 sale tests.
- **Why not C (order-level fold):** semantically wrong (product-scoped, not
  order-scoped); collides with the single `pickBestOrderPromo` channel; hides per-line
  receipt attribution.

## Locked Product Decisions (NON-NEGOTIABLE — spec/design MUST honor)

| # | Decision | Verbatim rule |
|---|----------|---------------|
| Q1 | Targeting | **TARGETED + REQUIRED.** Reuse DEFAULT-side `appliesTo` + `targetItems` (PRODUCTS / VARIANTS / CATEGORIES / BRANDS). Tighten `validateByType` to require a target for `BUY_X_GET_Y`. |
| Q2 | Buy counting | **PER LINE.** A single line must have `qty >= buyQuantity`. Not aggregated across lines. |
| Q3 | Reward groups + units | **REPEATABLE** — `floor(Q/(N+M))` groups. The M discounted "get" units are the **CHEAPEST** units. |
| Q4 | Discount base | **DERIVED** — `%` applies to the **get-unit's pre-promotion effective unit price**. (Design confirms.) |
| Q5 | Precedence | **BEST-WINS, NO STACKING.** Per-line saving compared; larger wins, ties → lowest id. BUY_X_GET_Y pass runs **after** PRODUCT_DISCOUNT best-wins, **before** ORDER_DISCOUNT. |
| Q6 | "Free" (100%) | **EXTEND** — allow `getDiscountPercent=100`. Lift `SaleItem.applyDiscount` clamp `1..99 → 1..100` and reconsider the `baseline - discount >= 1` invariant at `:267`. |
| Q7 | AUTOMATIC vs MANUAL | **BOTH.** AUTOMATIC auto-applies; MANUAL appears in `availableManualPromotions` / `targetableManualPromotionIds` (extend mapper + self-heal + response DTO wire type). |
| Q8 | Rounding | **MIRROR engine** — `Math.round((base * percent) / 100)` per unit (matches `sale.entity.ts:309`, `:511`). |
| Q9 | Insufficient qty | **NO reward** until a full N+M group exists (`qty < N+M` yields nothing). |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Modified | Gate flip (`:381-407`); new BUY_X_GET_Y evaluation pass; ordering vs PRODUCT_DISCOUNT/ORDER_DISCOUNT passes; pure helper (co-located or sibling file) |
| `src/promotions/application/ports/pos-evaluate-promotions.port.ts` | Modified | New/adapted `PosEvalLineResult` shape (or sibling result type) for fixed-cents reward |
| `src/sales/sales.service.ts` | Modified | `recomputePromotions` (`:478-570`) clear/re-apply the new result kind idempotently |
| `src/sales/domain/sale-item.entity.ts` | Modified | Apply path for fixed-cents reward (or new method); clamp 1..99→1..100 at `:302-309`; reconsider `:267` invariant |
| `src/sales/domain/sale.entity.ts` | Modified | `previewTotals` (`:492-526`) reflects line-level fixed-cents reward |
| `src/promotions/domain/promotion.entity.ts` | Modified | `validateByType` BUY_X_GET_Y case requires `appliesTo` + `targetItems` (Q1); `validateGetDiscountPercent` cap 99→100 (Q6) |
| `src/promotions/dto/create-promotion.dto.ts` | Modified | `@Max(99) → @Max(100)` on `getDiscountPercent` (`:155-156`) |
| `src/promotions/promotions.service.ts` | Modified | Manual-candidate mapper + self-heal loop wire type gains `BUY_X_GET_Y` |
| `openspec/specs/pos-promotion-engine/spec.md` | Delta MODIFY/ADD | Un-defer BUY_X_GET_Y scenarios + Q1–Q9 scenario coverage |
| Test suites | New/Modified | Pure-helper spec; engine spec (eligibility / counting / precedence / rounding / MANUAL / self-heal); sales.service spec; integration sweep |
| Postgres enum, Prisma columns, `SaleItem` snapshot cols | None | All pre-exist; no `ADD VALUE`, no schema/migration change |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Representational gap** is structural — Approach A needs a new line-discount path on `SaleItem`/`Sale`; wrong shape forces re-design mid-apply | Med-High | Lock Approach A in design with a spike + failing TDD test for the new result kind BEFORE wiring the pass. Mirror existing `applyDiscount` tests. |
| **"Free" (100%)** lifts a clamp + invariant in `applyDiscount` — regression surface for existing PRODUCT_DISCOUNT/ORDER_DISCOUNT paths | Med | Mirror engine rounding at `:309`; add unit tests for 100% off + baseline-discount==0 path; integration sweep on existing fixtures. |
| **Precedence** — BUY_X_GET_Y adds a third dimension to the single-winner model; a same-line PRODUCT_DISCOUNT + BUY_X_GET_Y must compare **per-line savings** (cents), not discount % | Med | Q5 rule explicit; best-wins comparator compares cents; add precedence fixtures with mixed types + ties → lowest id. |
| **MANUAL wiring** ripples through manual-candidate mapper, self-heal loop, response DTO wire type, and `targetableManualPromotionIds` semantics | Med | All four sites updated in one TDD pass; tests cover opted-in + self-heal + recompute persistence. |
| **Idempotent recompute** — new discount must clear/re-apply cleanly; a misstep compounds across recomputes | Med | Mirror existing `promotionId != null` clear logic in `recomputePromotions`; test 5× recompute convergence. |
| **Validation gap (Q1)** — tightening `validateByType` to require a target may reject existing rows in the DB | Low | All BUY_X_GET_Y rows in the wild already target (data convention); migration check + integration sweep on seeded tenant catches it before merge. |
| **Predecessor precedent (CATEGORIES/BRANDS)**: precedent was 225-350 authored lines — this is materially heavier (representation + 9 decisions + 100% gate change) | High | Tasks phase splits into chained work units (see Delivery). |

## Rollback Plan

Revert the feature branch commit(s). Engine gate returns `false` for `BUY_X_GET_Y` →
no new pass runs → no fixed-cents rewards emitted → `recomputePromotions` applies
nothing new. The `validateByType` tightening rejects newly-built untargeted promos at
creation but does NOT mutate persisted rows; no backfill, no data migration, no API
contract change. The 99→100 cap is the only field-level change — relaxing it back is a
trivial one-line revert. Single revert; no compensating writes.

## Dependencies

- Existing `matchTargetTier` pattern (`pos-evaluate-promotions.use-case.ts:76-105`) —
  template for the new pure helper.
- Existing `applyDiscount` flow (`sale-item.entity.ts:248-282`) — template for the
  fixed-cents reward path.
- Existing `previewTotals` math (`sale.entity.ts:492-526`) — must integrate line-level
  fixed-cents rewards into `subtotalCents` / `discountCents` / `totalCents`.
- Existing manual-candidate mapper (`port.ts:93`) + self-heal loop (`:316`, `:326`) —
  extend, don't replace.

## Success Criteria

- [ ] `BUY_X_GET_Y` promo with `appliesTo=PRODUCTS` (or `VARIANTS` / `CATEGORIES` / `BRANDS`) and a single target id applies only to matching lines.
- [ ] Untarged BUY_X_GET_Y is rejected at creation by `validateByType` (Q1).
- [ ] Per-line counting: a line with `qty >= buyQuantity` triggers; aggregated lines do not (Q2).
- [ ] `floor(qty / (N+M))` reward groups; the M discounted "get" units are the cheapest (Q3).
- [ ] BUY_X_GET_Y beats / loses to a same-line PRODUCT_DISCOUNT by per-line cents saving; ties → lowest id wins (Q5).
- [ ] BUY_X_GET_Y pass feeds ORDER_DISCOUNT the post-line subtotal (runs between the two existing passes).
- [ ] `getDiscountPercent=100` produces a true zero-cost get-unit; `applyDiscount` clamp and baseline invariant adjusted (Q6).
- [ ] AUTOMATIC BUY_X_GET_Y auto-applies; MANUAL appears in `availableManualPromotions` and survives `targetableManualPromotionIds` self-heal (Q7).
- [ ] Per-unit rounding is `Math.round((effectivePrice * getDiscountPercent) / 100)` (Q8).
- [ ] `qty < N+M` yields zero reward (Q9).
- [ ] Existing PRODUCT_DISCOUNT / ORDER_DISCOUNT / VARIANTS / CATEGORIES / BRANDS tests pass unchanged.
- [ ] No `PromotionType` enum / Prisma migration change. `prisma migrate diff` against current schema is empty (Q1 validation tightening + Q6 cap are code-only).
- [ ] Idempotent recompute: 5× `recomputePromotions` on the same sale converges to the same totals.

## Delivery Note (size forecast)

**Likely exceeds the 400-line review budget** — this is the **highest-complexity
change in the promotions series** (representation gap + 9 locked decisions + 100%
gate change + MANUAL wiring + spec un-defer). **Solo dev = NO PRs.** Deliver as a
dedicated branch with well-structured **conventional work-unit commits** (one
helper / one pass / one apply / one spec delta), merged to main locally.

Tasks phase MUST split into chained/stacked work units — forecast seeds:

1. Pure helper (RED-first, no engine wiring).
2. Result-contract change + port + engine gate flip + new pass.
3. Entity / apply path + `previewTotals` integration.
4. `SalesService.recomputePromotions` wiring + idempotent clear/re-apply.
5. Q1 `validateByType` tightening + Q6 99→100 cap.
6. MANUAL surface (mapper + self-heal + response DTO).
7. Spec un-defer + integration sweep + zero-migration check.