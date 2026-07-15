# Proposal: Advanced Promotion Type (POS Engine Activation)

Activate the **compound** `ADVANCED` promotion type in the POS engine so the
existing write path (`PromotionType.ADVANCED`, side-aware `PromotionTargetItem`,
`buyQuantity` / `getQuantity` / `getDiscountPercent`, `buyTargetType` /
`getTargetType`, entity + DTO + service CRUD already shipped and tested)
actually applies at sale time. The write path was provisioned during the
multi-tenant foundation and stubbed by the `buy-x-get-y` change; this change
wires the **read/apply half** only.

## Intent

Retail needs **cross-target** promotions the simple BXGY cannot express — e.g.
"buy any 3 from category A, get 1 of product B at 50% off". Today the write
path accepts and validates ADVANCED promotions but the engine
`isSupportedEngineType` rejects them, so they never trigger and never appear
on receipts. This breaks merchant expectations, forces manual cashier workarounds,
and leaves a documented product gap. Activating the engine unlocks the
canonical retail mechanic and brings wire-side semantics in line with what the
CRUD contract already promises.

## Scope

### In Scope

- Admit `ADVANCED` in `isSupportedEngineType` for `buyTargetType` /
  `getTargetType ∈ {PRODUCTS, VARIANTS, CATEGORIES, BRANDS}`.
- Generalize `matchTargetTier` to be **side-aware** (accept a `side`
  parameter: `DEFAULT | BUY | GET`), preserving the current DEFAULT behavior
  for PRODUCT_DISCOUNT / BXGY.
- Add a **pure `computeAdvancedReward` helper** (two-sided: BUY-satisfaction
  count + GET-side reward computation).
- Add a **new cross-line pass** in `evaluate()`: BUY-side condition lines drive
  reward on GET-side line(s). Slotted after the BXGY pass, before ORDER_DISCOUNT.
- Route the ADVANCED result through the existing reward rail:
  `applyBuyXGetYReward` on the GET-side `SaleItem` (reuse proven
  `prePriceCentsBeforeDiscount === unitPriceCents` invariant).
- **Lift the 99% cap** in ADVANCED's `validateGetDiscountPercent` so a
  100% (free) GET reward is valid, reusing the same `applyDiscount` clamp
  BXGY shipped. Update the corresponding entity validation spec.
- Introduce a **new persisted reward discriminator** so the wire can read
  `rewardKind: 'advanced'` (distinct from `buy_x_get_y`). Implies a small
  additive migration (new column on `SaleItem`) and updates to
  `isBuyXGetYReward` / `toResponse` / receipt mapper / `previewTotals`.
- Extend the cross-type best-wins comparator on the GET line so an ADVANCED
  reward competes with PD and BXGY by **maximum total saving** (consistent
  with the existing BXGY cross-type rule).
- **Rewrite** `match-target-tier.spec.ts:269-284` (currently asserts BUY/GET
  are ignored) and add unit + integration specs for the new helper, pass,
  and apply path.
- Update `docs/promotions-frontend.md` to document POS/evaluation semantics
  and the new `rewardKind='advanced'` value.

### Out of Scope (deferred follow-ups)

- **Minimum-amount threshold** on the BUY side (Q7 follow-up; quantity-only
  threshold for this first slice).
- **MANUAL application scope** (Q8) — this change is AUTOMATIC-only; the
  MANUAL candidate surface and self-heal stay untouched.
- **Fixed-amount reward** (e.g. "get $5 off product B") — only the
  percentage reward rail is activated; a fixed-amount variant needs a
  different reward shape and is a separate change.
- BUY/GET targeting the **same entity** (e.g. buy 2 of A, get 1 of A) —
  reduces to BXGY; explicitly out of scope to avoid engine-level overlap
  rules.
- Lifting the existing `rewardDiscountPercent` semantics rail — reused as-is.

## Locked Product Decisions (REQUIREMENTS)

These are the eight decisions from the product question rounds. They are
**locked** and MUST appear in the delta spec verbatim.

| # | Decision | Requirement |
|---|----------|-------------|
| D1 | **BUY-side counting** | The engine MUST count the BUY condition across **any combination of products belonging to the BUY target** — i.e. aggregated across all cart lines whose resolved entity matches a BUY-side target item. A single line with `qty ≥ buyQuantity` is one valid path; multiple smaller lines summing to `buyQuantity` is another. |
| D2 | **Reward repeatability** | The GET reward MUST repeat **per satisfied group**: `rewardGroupCount = floor(totalBuyMatchedQty / buyQuantity)`. A cart with 6 matching BUY units and `buyQuantity=3` produces 2 reward applications. |
| D3 | **GET magnitude** | The GET-side discount MUST be a **percentage up to 100%** (100=free, 50=half), reusing the existing `rewardDiscountPercent` field semantics. **True 100% (free) MUST be supported**: the existing 99% cap in `validateGetDiscountPercent` is lifted, reusing the same `applyDiscount` clamp change BXGY shipped, so a 100% ADVANCED reward yields a free GET unit. |
| D4 | **`rewardKind` discriminator** | The wire MUST emit a **new distinct `rewardKind: 'advanced'`** value. The column-derived `isBuyXGetYReward()` cannot tell ADVANCED from BXGY, so a persisted/joined discriminator is required (additive migration). Frontend contract changes to read the new kind; `buy_x_get_y` is **not** reused. |
| D5 | **GET-line stacking** | On a line that can attract multiple promo types (PD, BXGY, ADVANCED), the engine MUST apply the existing **best-wins-by-maximum-total-saving** comparator (consistent with the current cross-type resolution at `use-case.ts:863-927`). |
| D6 | **Application scope** | This slice is **AUTOMATIC-only**. The engine applies the ADVANCED reward when the BUY condition is met. MANUAL candidate surface, self-heal, and cashier selection are **not** extended in this change. |
| D7 | **BUY/GET overlap** | A cart line/quantity consumed to satisfy the BUY condition **MUST NOT** also be the rewarded GET line. BUY-side and GET-side must target **disjoint** entities. (Same-entity on both sides is therefore out of scope — see Out of Scope.) |
| D8 | **Threshold** | The BUY threshold is **quantity only** for this slice. A minimum-amount threshold is a future follow-up. |

## Primary Scenarios

Concrete retail examples the engine MUST handle end-to-end (drives the
Given/When/Then suite in the delta spec).

### S1 — Buy-category → get-product (the canonical case)

> _"Buy 3 from category Home Decor, get 1 of product Maceta-Large at 50% off."_

- Cart: 2 × Vela-A, 1 × Vela-B (all in category Home Decor) + 1 × Maceta-Large.
- BUY-side matching: 3 units (2 Vela-A + 1 Vela-B) all hit category Home Decor.
  D1 satisfied.
- D2: `floor(3/3) = 1` reward group.
- D3: Maceta-Large at 50% off (50% of its own `effectiveUnitPriceCents`).
- D4: receipt `rewardKind: 'advanced'`.
- D5: cross-type — if a 30% PD on Maceta-Large yields less saving, ADVANCED wins.

### S2 — Multi-group repeat (D2)

> _"Buy 6 from category Candles, get 2 of product Holder-X at 30% off" (buy 3, get 1, twice)._

- Cart: 6 × Candle units, 3 × Holder-X.
- D2 produces **2 reward applications** on Holder-X (6 / 3 = 2 groups × 1 unit
  per group = 2 rewarded units).

### S3 — Disjoint entities required (D7)

- An ADVANCED promotion with `buyTargetItems = {A}` and `getTargetItems = {A}`
  is **rejected at promotion intake** as not yet supported (entity error code
  TBD by the spec phase). Self-overlap is out of scope; this is the cheap,
  honest boundary.

### S4 — BUY met, no GET line → no reward

- Cart satisfies BUY target but contains no GET-side line. Engine emits no
  ADVANCED result, no receipt line, no saving. (Degenerate-cart case, mirrors
  the BXGY rule.)

### S5 — Best-wins against PD/BXGY (D5)

- A 20% PRODUCT_DISCOUNT on the GET line + a 50% ADVANCED on the same line.
  Engine picks **ADVANCED** because its per-line total saving is greater.
- Tie → lowest promotion id wins (same tie-breaker BXGY uses).

## Technical Approach

Reuse the BXGY reward rail and add a side-aware compound pass (Approach A
from the exploration, validated by the locked decisions).

| Seam | Change | Why |
|------|--------|-----|
| `isSupportedEngineType` (`use-case.ts:536-581`) | Admit `ADVANCED` for the four `buyTargetType`/`getTargetType` values. | Engine gate. |
| `matchTargetTier` (`use-case.ts:136-199`) | Add a `side: TargetSide = 'DEFAULT'` parameter; thread through the existing 4-tier ladder. | The pivot: turns the DEFAULT matcher into a BUY-side / GET-side matcher with one change, no duplication. Rewrites `match-target-tier.spec.ts:269-284`. |
| `computeAdvancedReward` (new, pure helper) | Mirror `computeBuyXGetYReward:73-100` shape: takes aggregated BUY counts + GET-side line(s), returns `{ rewardGroupCount, perUnitCents, lineIds }`. | Pure, unit-testable, reusable by a future cart engine. |
| `evaluateAdvancedPass` (new pass in `evaluate()`) | Cross-line pass: aggregate BUY-side matches, call `computeAdvancedReward`, emit a `PosEvalBuyXGetYLineResult`-shaped result on the GET line. Slots after BXGY (`:283`), before ORDER_DISCOUNT (`:304`). | New structural pattern — every existing pass is single-line; this one is the first cross-line. |
| `recomputePromotions` (`sales.service.ts:479-552`) | Route the new result through `applyBuyXGetYReward` on the GET-side `SaleItem`. | Reuses the proven rail (`prePriceCentsBeforeDiscount === unitPriceCents`, idempotent recompute). |
| `SaleItem` reward discriminator (D4) | New persisted column (e.g. `rewardKind` enum) or join-based discriminator. Update `isBuyXGetYReward`, `toResponse` (`:413-421, 512`), confirmed-sale receipt mapper, `previewTotals`. | D4: cannot reuse `buy_x_get_y` on the wire. |
| Cross-type best-wins comparator | Extend to include the ADVANCED contributor by max total saving. | D5. |
| `validateGetDiscountPercent` (ADVANCED entity) + spec | Lift the 99% cap to allow 100% (free); reuse BXGY's `applyDiscount` clamp so the reward yields a free GET unit. | D3 true-free. |
| Tests | Rewrite `match-target-tier.spec.ts:269-284`; add helper spec, engine pass spec, sales apply integration spec; idempotent recompute spec. | Strict TDD (BXGY precedent). |

## Capabilities (contract for sdd-spec)

### Modified Capabilities

- `pos-promotion-engine`: the engine spec un-defers ADVANCED, adds the
  side-aware matcher, cross-line pass, percentage-reward semantics, 99% cap
  preservation, and the AUTOMATIC-only scope. **This is the single spec
  the change touches.** The sales wire contract is a sub-section of this
  capability's `rewardKind` rule, not a new capability.

### New Capabilities

- **None.** No new bounded context. ADVANCED reuses the existing promotion
  catalog, targeting model, sales apply rail, and receipt mapper — only
  with a new result kind and a new wire discriminator value.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Modified | `isSupportedEngineType`, `matchTargetTier` (side parameter), new `computeAdvancedReward` helper, new `evaluateAdvancedPass` pass. |
| `src/promotions/application/match-target-tier.spec.ts` | Modified | Rewrite the BUY/GET-ignored assertion to assert the new side-aware behavior. |
| `src/promotions/domain/` promotion entity (`validateGetDiscountPercent`) + its spec | Modified | Lift the 99% cap so an ADVANCED reward can be 100% (free), reusing BXGY's `applyDiscount` clamp; still reject `> 100`. |
| `src/sales/sales.service.ts` (`recomputePromotions :479-552`) | Modified | Route ADVANCED result to `applyBuyXGetYReward` on the GET line. |
| `src/sales/domain/sale-item.entity.ts` (`isBuyXGetYReward :413-421`, `toResponse :512`) | Modified | Discriminator update (or new method) so wire can emit `rewardKind: 'advanced'`. |
| `src/sales/infrastructure/persistence/sale.repository.ts` + `prisma-sale.repository.ts` | Modified | Confirmed-receipt mapper reads the new discriminator. |
| `prisma/schema.prisma` | New additive column (D4) | Small additive migration: new `rewardKind` enum + column on `SaleItem` (nullable for non-reward rows; BXGY rows populated, non-reward rows null). Verify zero-drift everywhere else. |
| `prisma/migrations/` | New migration file | The D4 additive migration. |
| `docs/promotions-frontend.md` | Modified | Document POS/evaluation semantics and the new `rewardKind='advanced'` value (currently documents CRUD only). |
| `docs/promotions-in-sale-frontend-prompt.md` | Modified | Remove ADVANCED from the "deferred / do NOT build" list (`:31, 241`). |
| New specs under `src/promotions/application/__tests__/` and `src/sales/__tests__/` | New | Helper, pass, apply, idempotent recompute specs. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cross-line coupling breaks the single-line pass mental model. | High | Pure `computeAdvancedReward` helper + a single new pass with explicit boundary; mirror BXGY test layering. Strict TDD with Given/When/Then scenarios per locked decision. |
| `matchTargetTier` contract change silently regresses PD/BXGY. | Medium | Rewrite `:269-284` to assert side-aware behavior; preserve DEFAULT contract; run the full existing engine + sales suite unchanged. |
| `rewardKind` discriminator migration touches mapper, `previewTotals`, and frontend contract. | Medium | Additive column (nullable, BXGY rows populated by backfill in the same migration); staged rollout; deprecation window for the implicit `buy_x_get_y` on ADVANCED-shaped rows. |
| GET-line best-wins gets a third contributor (PD, BXGY, ADVANCED). | Medium | Extend the existing comparator (`:900-905`) to a 3-way max-savings comparison with the same tie-breaker (lowest id). |
| BUY/GET overlap on the same entity behaves like BXGY but routes to ADVANCED — semantic confusion. | Low (out of scope by D7) | Reject same-entity at promotion intake (entity error). Document explicitly. |
| Idempotent recompute breaks on the cross-line reward. | Medium | Reuse `applyBuyXGetYReward`'s proven recompute path; add a focused idempotence spec (re-evaluate N times, byte-equal result). |
| Lifting the 99% cap could regress ADVANCED entity validation. | Medium | Reuse BXGY's proven `applyDiscount` clamp; update `validateGetDiscountPercent` spec RED-first; assert 100% yields a free GET unit and `> 100` is still rejected. |
| Delivery exceeds the 400-line review budget (BXGY precedent did). | High | Recommend **chained delivery** in `sdd-tasks`: (1) side-aware `matchTargetTier` + helper + engine pass unit tests; (2) sales apply + discriminator + integration; (3) wire/frontend + docs. Each slice autonomous, independently revertable. |
| Strict TDD discipline drifts (config `apply.tdd:false`). | Medium | Follow the BXGY strict TDD precedent: RED test first, GREEN impl, REFACTOR. |

## Rollback Plan

1. **Application-level rollback (fast).** Revert the engine PR; the
   `isSupportedEngineType` gate returns to rejecting `ADVANCED`. Existing
   `PRODUCT_DISCOUNT` / `BUY_X_GET_Y` / `ORDER_DISCOUNT` behavior is
   untouched (all changes are additive on the engine and reward rail).
2. **Wire-level rollback.** The new `rewardKind: 'advanced'` value is
   additive; existing `buy_x_get_y` payloads remain valid. Frontend
   treats unknown kinds as "generic reward" (already the fallback for
   `null`).
3. **Migration rollback.** The D4 additive migration is a nullable column
   + enum extension — reversible by a follow-up migration dropping the
   column. No destructive changes to existing data.
4. **Per-slice rollback (chained delivery).** If delivery is split into
   the three slices above, each PR is independently revertable; rolling
   back slice 1 disables the new pass while keeping the discriminator
   (a no-op pass) and keeping BXGY untouched.

## Dependencies

- **Predecessor:** `buy-x-get-y` (BXGY) — provides the reward rail,
  `applyBuyXGetYReward`, `isBuyXGetYReward`, `PosEvalBuyXGetYLineResult`,
  and the cross-type best-wins comparator that this change extends.
- **Schema:** `PromotionType.ADVANCED`, `TargetSide`, `buyQuantity` /
  `getQuantity` / `getDiscountPercent`, `buyTargetType` / `getTargetType`,
  `Side` column on `PromotionTargetItem` — all pre-existing in
  `prisma/schema.prisma:66-71, 1095-1101, 112-116, 1128-1136` and applied
  in `20260502052444_multi_tenant_foundation/migration.sql`.
- **Frontend:** Contract change for `rewardKind='advanced'` is a
  breaking read; coordinate with the frontend team in sdd-tasks (low
  blast radius — add a case, fall through to existing reward rendering
  for unknown values).

## Success Criteria

- [ ] `isSupportedEngineType` admits `ADVANCED` for the four
      `buyTargetType` / `getTargetType` values; existing PD / BXGY /
      ORDER_DISCOUNT engine specs pass unchanged.
- [ ] `matchTargetTier` is side-aware; `match-target-tier.spec.ts:269-284`
      is rewritten to assert the new contract; all prior DEFAULT-match
      scenarios still pass.
- [ ] `computeAdvancedReward` is exported, pure, and unit-tested for
      single-group, multi-group (D2), disjoint-entity, and degenerate-cart
      cases.
- [ ] `evaluateAdvancedPass` runs after the BXGY pass and before
      ORDER_DISCOUNT; the cross-line pass is covered by an integration
      spec.
- [ ] D1 — BUY-side matching aggregates across all lines whose resolved
      entity hits a BUY-side target item (verified by a "many small
      lines summing to N" scenario).
- [ ] D2 — `floor(totalBuyMatchedQty / buyQuantity)` reward groups
      applied (verified by a "buy 6, get 1" scenario producing 2 reward
      applications).
- [ ] D3 — GET-side discount is `rewardDiscountPercent` of the GET
      unit's own `effectiveUnitPriceCents`; **100% (free) is supported**
      (99% cap lifted, BXGY `applyDiscount` clamp reused; `> 100` still rejected).
- [ ] D4 — Wire emits `rewardKind: 'advanced'` distinct from
      `buy_x_get_y`; covered by a `toResponse` + confirmed-receipt spec.
- [ ] D5 — On a line attracting PD + BXGY + ADVANCED, the highest total
      saving wins; tie → lowest promotion id (existing tie-breaker).
- [ ] D6 — MANUAL candidate surface and self-heal are **not** modified;
      ADVANCED applies AUTOMATIC only (regression spec confirms MANUAL
      path is unchanged).
- [ ] D7 — Same-entity BUY + GET is rejected at promotion intake; engine
      never sees it.
- [ ] D8 — Threshold is quantity only; no minimum-amount code path is
      added.
- [ ] `pnpm test` passes; `pnpm build` passes; `prisma migrate diff`
      shows zero drift outside the additive D4 migration.
- [ ] Idempotent `recomputePromotions`: re-evaluating a draft N times
      yields byte-equal `SaleItem` rows.
- [ ] Chained delivery recommended in `sdd-tasks` (forecast the
      400-line review budget; expect it to be high).
- [ ] `docs/promotions-frontend.md` documents the POS/evaluation
      semantics and the new `rewardKind='advanced'` value.
