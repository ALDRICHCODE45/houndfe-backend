# Exploration: advanced-promotion-type

Ground a future proposal for the **DEFERRED** promotion type `ADVANCED` — a compound
**buy-target → get-target** promotion where the "buy" side and the "get" side may target
**different** entities (canonical example, `docs/promotions-frontend.md:307`: _"Compra 2 velas y
lleva 1 maceta al 50%"_ — buy 2 of product A, get 1 of product B at 50% off).

This is a codebase investigation. It reports the current reality and the gap; it does **not**
design the solution. The prior change `buy-x-get-y` (BXGY) shipped the _simple_ same-target
"buy N get M" mechanic end-to-end and **explicitly deferred** ADVANCED
(`openspec/changes/archive/2026-07-13-buy-x-get-y/exploration.md:307-315`).

> **Headline finding:** ADVANCED is **not** a green-field feature. The **entire write path**
> (Prisma schema + migration, `PromotionType` enum, entity types + validation, DTO, service
> CRUD with BUY/GET side-target resolution and validation, response round-trip) **already exists
> and is unit-tested**. The gap is **purely the POS evaluation engine + the sales reward
> application** — the read/apply half was intentionally left un-wired, exactly like BXGY before
> it was activated.

---

## Current State (verified — file:line confirmed)

### A. Persistence & schema — ALL pre-exist (no base-field migration expected)

| Artifact | Location | Status |
|---|---|---|
| `enum PromotionType { … ADVANCED }` | `prisma/schema.prisma:66-71` | present |
| `buyQuantity / getQuantity / getDiscountPercent Int?` (shared BXGY+ADVANCED) | `schema.prisma:1095-1097` | present |
| `buyTargetType / getTargetType PromotionTargetType?` (**ADVANCED only**) | `schema.prisma:1099-1101` | present |
| `enum TargetSide { DEFAULT BUY GET }` | `schema.prisma:112-116` | present |
| `PromotionTargetItem.side TargetSide @default(DEFAULT)` + `@@unique([promotionId, side, targetType, targetId])` | `schema.prisma:1128, 1136` | present |
| `SaleItem.rewardDiscountPercent Int?` (persisted reward %) | `schema.prisma:728` | present |
| Enum value + all columns in the **applied** migration | `prisma/migrations/20260502052444_multi_tenant_foundation/migration.sql:17, 425-429` | applied |

The `side`/`buyTargetType`/`getTargetType`/quantity columns were provisioned ahead of time (during
the multi-tenant foundation migration). A base-field migration is therefore **not expected** — a
`prisma migrate diff` zero-drift check should be part of any future verify (mirrors the BXGY
zero-migration outcome).

### B. Domain entity — ADVANCED construction & validation are COMPLETE

`src/promotions/domain/promotion.entity.ts`:
- `PromotionType` union includes `ADVANCED` (`:6-10`); `TargetSide = 'DEFAULT' | 'BUY' | 'GET'` (`:25`).
- Fields `buyTargetType` / `getTargetType` on props, create params, constructor, and `toResponse`
  (`:84-85, 114-115, 248-249, 274-275, 325-326, 418-419`).
- `validateByType` has a **complete `ADVANCED` case** (`:491-512`): _requires_ `buyQuantity`,
  `getQuantity`, `getDiscountPercent`; _forbids_ `appliesTo`, `discountType`, `discountValue`,
  `minPurchaseAmountCents`; and is the **only** type that does **not** forbid
  `buyTargetType`/`getTargetType`.
- `validateGetDiscountPercent` caps ADVANCED at **99** (vs **100** for BXGY) — `:180-191`, esp `:184`.
  **ADVANCED cannot express a true-free (100%) get-unit today.** (Open question — is this intended?)
- Tested: `promotion.entity.spec.ts:248-298` (ADVANCED create, optional side types, 100% rejected,
  forbidden-field guards).

### C. DTO — ADVANCED intake is COMPLETE

`src/promotions/dto/create-promotion.dto.ts`:
- `PromotionTypeEnum.ADVANCED` (`:22`).
- `buyTargetType` / `getTargetType` (`:161-167`), plus dedicated nested `BuyTargetItemDto` /
  `GetTargetItemDto` (`:69-77`) and the arrays `buyTargetItems[]` / `getTargetItems[]` (`:169-179`).
- Note: `getDiscountPercent` DTO validator is `@Min(0) @Max(100)` (`:153-157`) — looser than the
  entity's ADVANCED 99 cap; the entity is the tighter gate.

### D. Service CRUD — the BUY/GET side split is fully wired & validated

`src/promotions/promotions.service.ts`:
- `resolveTargetItems` (`:378-450`) maps `dto.targetItems → side=DEFAULT`,
  `dto.buyTargetItems → side=BUY` (`:409-427`), `dto.getTargetItems → side=GET` (`:429-447`),
  de-dupes on `side:targetType:targetId` (`duplicate_target`), and validates every id exists
  (`validateTargetIds :639-703`).
- `assertAdvancedSideTargets` (`:598-633`) enforces: if `buyTargetType` set → at least one BUY
  target; if `getTargetType` set → at least one GET target (`advanced_missing_targets`). Called on
  **create** (`:129-133`) and **update** (`:231-235`).
- `buildTargetResolutionInput` (`:525-578`) round-trips BUY/GET side items back into
  `buyTargetItems`/`getTargetItems` on partial update; `enrichVariantTargetItems` handles all
  sides (`:307`).
- Tested: `promotions.service.spec.ts:442` (persist ADVANCED BUY/GET shapes), `:1035` (update
  side-target completeness), `:1591` (create side-target validation), `:1780` (VARIANTS both sides).

**Net:** an ADVANCED promotion can be **created, updated, persisted, validated, and read back
today**. It is simply **never evaluated**.

### E. The POS engine — ZERO ADVANCED handling (the gap)

`src/promotions/application/pos-evaluate-promotions.use-case.ts`:
- `isSupportedEngineType` (`:536-581`) returns `true` only for `ORDER_DISCOUNT`,
  `PRODUCT_DISCOUNT`, and `BUY_X_GET_Y`. **ADVANCED falls through to `false`** — it never enters
  any candidate set. This gate is consulted in `passesPromotionWideGates` and the MANUAL
  candidate/self-heal loops.
- `matchTargetTier` (`:136-199`) **hardcodes `const side = 'DEFAULT'` (`:145`)** and matches only
  DEFAULT-side target items. It is structurally blind to BUY/GET. This is **locked by test**:
  `match-target-tier.spec.ts:269-284` asserts BUY/GET rows are ignored.
- `evaluate()` (`:240-500`) runs exactly three single-line/per-sale passes: per-line
  `PRODUCT_DISCOUNT` best-wins (`pickBestPerLine :587`), the BXGY per-line pass
  (`evaluateBuyXGetYPass :863`), and per-sale `ORDER_DISCOUNT` best-wins (`pickBestOrderPromo :738`).
  **There is no cross-line "buy-side condition → get-side reward" pass.**
- The BXGY reward helper `computeBuyXGetYReward` (`:73-100`) is **single-line, same-price** — the
  reward rides the same line's own `effectiveUnitPriceCents`. It cannot express a reward that
  lands on a **different** line than the one carrying the buy-condition.

### F. Targeting abstraction — single-sided today, but the seam exists

- The engine input carries per-line resolved `productId` / `variantId` / `categoryId` / `brandId`
  (`ports/pos-evaluate-promotions.port.ts:28-58`), and `matchTargetTier` already resolves the
  4-tier specificity ladder (VARIANT > PRODUCT > {CATEGORY, BRAND}) — `use-case.ts:122-199, 659-676`.
- Crucially, `matchTargetTier`'s target-item shape **already includes `side`**
  (`{ side, targetType, targetId }`, `:137`) — it simply filters to `'DEFAULT'`. **Making it
  side-aware (accept a `side` parameter) is the single most important extension seam** — it turns
  the existing DEFAULT matcher into a reusable BUY-side / GET-side matcher without duplicating the
  tier logic.

### G. Sales surface plumbing — the reward rail exists (built for BXGY)

- `SalesService.recomputePromotions` (`src/sales/sales.service.ts:479-552`) clears prior
  promo-sourced discounts then routes each engine line result by `kind`: `buy-x-get-y` →
  `SaleItem.applyBuyXGetYReward` (`:515-524`), else → `SaleItem.applyDiscount` (`:526-538`).
- `SaleItem.applyBuyXGetYReward` (`sale-item.entity.ts:362-394`, input `ApplyBuyXGetYRewardInput
  :68-85`) stores a **whole-line cents reward `R`** in `discountAmountCents`, keeps `unitPriceCents`
  full, sets `prePriceCentsBeforeDiscount = unitPriceCents` (the EQUAL invariant), and stamps
  `rewardDiscountPercent` verbatim.
- `isBuyXGetYReward()` (`:413-421`) is a **column-derived discriminator** (`promotionId` set,
  `discountAmountCents>0`, `prePrice === unitPrice`). `rewardKind` is **derived, not stored**:
  `toResponse` emits `rewardKind: isBxgy ? 'buy_x_get_y' : null` (`:512`) and the confirmed-sale
  receipt mapper does the same (`sale.repository.ts:286`, `prisma-sale.repository.ts` mapper).
- **Wire-compat consequence:** an ADVANCED reward that reuses this rail would be **indistinguishable
  from BXGY** at the persistence layer (same columns, `prePrice===unitPrice`). Distinguishing it on
  the wire requires either a `Promotion.type` join in the mapper, a new persisted discriminator, or
  accepting `buy_x_get_y` as a generic "reward line" kind. This is a real decision (see Q9).

### H. Best-wins / cross-type resolution — where ADVANCED must slot

- Per-line PRODUCT_DISCOUNT best-wins (max discount, ties → lowest id) runs first; the BXGY pass
  then does **cross-type TOTAL-saving best-wins**, replacing a line's PD result iff the BXGY
  line-total saving is larger (`use-case.ts:283, 863-927`, comparator `:900-905`); ORDER_DISCOUNT
  runs last on the post-line subtotal. An ADVANCED reward lands on the **GET-side** line and must
  therefore participate in that line's best-wins — but its _eligibility_ is decided by a
  **different** (BUY-side) line, which no current pass models.

### I. Docs

- `docs/promotions-frontend.md` documents the ADVANCED **CRUD contract** thoroughly: type intro
  (`:29, 68`), field matrix (`:198-224`), the "7.4 Promoción avanzada" payload example
  (`:299-322`), and error codes `duplicate_target` / `advanced_missing_targets` (`:567-568`).
  **There is no documented POS/evaluation semantics** — how the compound promo actually applies in
  a sale is unspecified (the product gap this exploration surfaces).
- `docs/promotions-in-sale-frontend-prompt.md:31, 241` still lists BXGY **and** ADVANCED as
  "deferred / do NOT build" — stale for BXGY (now shipped); ADVANCED remains genuinely deferred.

---

## Gap Analysis — exists vs. what ADVANCED needs

| Layer | Exists today | ADVANCED still needs |
|---|---|---|
| Prisma schema / migration | ✅ enum, quantities, `buyTargetType`/`getTargetType`, `TargetSide`, `side` column | Likely **nothing** (verify zero-drift). Only if a new persisted reward discriminator is chosen (Q9). |
| Entity types + validation | ✅ full `ADVANCED` case, side types, round-trip | Possibly lift 99→100 cap **iff** "free" is wanted (Q7). |
| DTO | ✅ ADVANCED enum, buy/get target arrays & types | Nothing (unless new fields surface from product round). |
| Service CRUD (write) | ✅ side resolution + `assertAdvancedSideTargets` + tests | Nothing structural. |
| **POS engine** | ❌ ADVANCED rejected; matcher is DEFAULT-only; no compound pass | **Gate flip; side-aware matcher; new pure compound reward helper; new cross-line pass; best-wins integration.** |
| **Port / result contract** | ❌ no ADVANCED result kind | Reuse `PosEvalBuyXGetYLineResult` **or** add a `kind:'advanced'` result; possibly `side` on `PosEvalLine` matching. |
| **Sales apply** | ⚠️ `applyBuyXGetYReward` rail exists | Route the ADVANCED result to a reward on the **GET** line; decide `rewardKind` discriminator (reuse vs new). |
| Wire (`rewardKind`) | ⚠️ derived `buy_x_get_y` only | Decide reuse vs new `advanced` kind → frontend + mapper + `previewTotals` impact. |
| Spec | ⚠️ `pos-promotion-engine/spec.md` defers ADVANCED | Un-defer + Given/When/Then scenarios for the compound mechanic. |
| Tests | ✅ write-path specs exist | New helper spec, engine spec, integration spec; **update** `match-target-tier.spec.ts:269-284` (the "ignores BUY/GET" assertion). |
| MANUAL surface | ⚠️ wire type is `PRODUCT_DISCOUNT`/`ORDER_DISCOUNT`/`BUY_X_GET_Y` | Add `ADVANCED` wire type iff MANUAL is in scope (Q8). |

---

## Extension Seams (the exact functions/interfaces a future implementation touches)

1. `pos-evaluate-promotions.use-case.ts` → `isSupportedEngineType` (`:536-581`) — admit `ADVANCED`
   for `buyTargetType`/`getTargetType ∈ {PRODUCTS, VARIANTS, CATEGORIES, BRANDS}`.
2. `matchTargetTier` (`:136-199`) — **generalize the hardcoded `side='DEFAULT'` into a parameter**
   (`matchTargetTier(targetItems, line, side)`), preserving the DEFAULT contract. This is the pivot
   that unlocks BUY-side and GET-side matching from one helper.
3. A **new pure exported helper** — `computeAdvancedReward(...)` — mirroring `computeBuyXGetYReward`
   (`:73-100`) but two-sided: given BUY-side satisfaction across matching lines and the GET-side
   line(s), compute the reward group count and the per-GET-unit / whole-line cents reward. Pure,
   unit-testable, reusable by the future cart engine.
4. A **new pass in `evaluate()`** — a cross-line ADVANCED pass. Unlike every existing pass it reads
   one set of lines (BUY-side) to decide and writes to another (GET-side). Natural slot: after the
   BXGY pass (`:283`) and before ORDER_DISCOUNT (`:304`), so the post-line subtotal reflects it.
5. `ports/pos-evaluate-promotions.port.ts` — `PosEvalLineResult` union: reuse
   `PosEvalBuyXGetYLineResult` (`:104-122`) or add `PosEvalAdvancedLineResult` (`kind:'advanced'`).
6. `sales.service.ts` `recomputePromotions` (`:512-539`) — route the ADVANCED result kind to the
   reward path; `SaleItem.applyBuyXGetYReward` (`:362-394`) reused, or a new `applyAdvancedReward`.
7. `sale-item.entity.ts` `isBuyXGetYReward()` / `toResponse().rewardKind` (`:413-421, 512`) and the
   confirmed receipt mapper — the `rewardKind` discriminator decision (Q9).

---

## Open Questions / Product Ambiguities (MUST be resolved in the propose round)

The engine cannot infer these; they are genuine product decisions. The compound (cross-line)
nature makes several of them **harder than their BXGY equivalents**.

- **Q1 — BUY-side counting (per-line vs aggregated).** BXGY chose _per-line_. But ADVANCED's BUY
  side can target a category/brand spanning many lines. Is "buy N" satisfied by a single BUY-side
  line with `qty ≥ buyQuantity`, or **aggregated** across all BUY-side-matching lines? This is the
  central compound-mechanic decision.
- **Q2 — Reward-group repeatability.** With BUY-side satisfied, how many GET rewards trigger — one,
  `floor(totalBuyQty / buyQuantity)`, or capped by GET-side available quantity? How do buy-side and
  get-side quantities compose into "groups"?
- **Q3 — Which GET-side units are discounted, and how many.** `getQuantity` per group, on which GET
  line(s), and (if multiple) cheapest-first? One reward line or multiple?
- **Q4 — Reward base.** `getDiscountPercent` applies to the **GET-unit's own** pre-promotion
  `effectiveUnitPriceCents` (field semantics imply this; confirm). This is where ADVANCED genuinely
  differs from BXGY — buy-price and get-price are decoupled.
- **Q5 — BUY/GET overlap & self-reference.** May BUY and GET target the **same** entity (e.g. buy 2
  of A, get 1 of A)? If so, how does it differ from BXGY, and how are units partitioned to avoid
  double-counting a line as both condition and reward?
- **Q6 — Degenerate carts.** BUY satisfied but no GET-side line in cart → no reward (like a MANUAL
  BXGY with no matching line)? GET-side present but BUY unsatisfied → nothing? GET-side qty <
  `getQuantity` → partial or none?
- **Q7 — "Free" (100%).** ADVANCED is capped at **99%** today (entity `:184`). Intended (no free
  get), or lift to 100 like BXGY (which required lifting `applyDiscount`'s clamp + invariant)?
- **Q8 — AUTOMATIC vs MANUAL.** BXGY does both and surfaces MANUAL candidates. Is ADVANCED
  AUTOMATIC-only, or also MANUAL (needs `ADVANCED` wire type in the candidate mapper + self-heal +
  the `unitsNeeded`/`eligible` hint, which is inherently two-sided for ADVANCED)?
- **Q9 — `rewardKind` wire contract.** Reuse `buy_x_get_y` (frontend renders identically; but a
  50%-off maceta is _not_ a 2x1) or introduce `rewardKind='advanced'` (honest, but touches the
  derived discriminator, the receipt mapper, `previewTotals`, and the frontend)?
- **Q10 — Precedence & stacking.** How does an ADVANCED reward on a GET line compete with a
  PRODUCT_DISCOUNT / BXGY on that same line (extend cross-type best-wins by per-line cents)? What if
  a line is a BUY-target of one promo and a GET-target of another? Can two ADVANCED promos stack?
- **Q11 — Precedence ordering.** Where does the ADVANCED pass sit relative to PRODUCT_DISCOUNT,
  BXGY, and ORDER_DISCOUNT in the `evaluate()` chain?

---

## Risk / Complexity Notes

- **New structural pattern (highest-risk item):** every existing engine pass is single-line or
  per-sale. ADVANCED introduces **cross-line coupling** (a condition on one line drives a reward on
  another). This breaks the current mental model and is the core new work — not a branch flip.
- **`matchTargetTier` contract change:** generalizing the hardcoded DEFAULT side must preserve the
  PRODUCT_DISCOUNT/BXGY DEFAULT behavior exactly. `match-target-tier.spec.ts:269-284` currently
  _asserts_ BUY/GET are ignored — that test must be rewritten as part of the change, carefully.
- **Wire compatibility (`rewardKind`):** the column-derived `isBuyXGetYReward()` cannot tell
  ADVANCED from BXGY. Reusing the rail silently tags ADVANCED as `buy_x_get_y`; a distinct
  `advanced` kind requires a persisted or joined discriminator and ripples to the frontend.
- **Best-wins interaction:** a GET line can simultaneously attract a PD, a BXGY, and an ADVANCED
  reward; the single-winner-per-line rule needs an extended, well-specified comparator.
- **Migration risk: low.** Base columns pre-exist; expect zero drift. Risk re-appears only if Q9
  forces a new persisted discriminator column.
- **99%-cap asymmetry:** ADVANCED (99) vs BXGY (100) is already baked into the entity and DTO; any
  "free" decision (Q7) reopens the `applyDiscount` clamp surface BXGY already touched.
- **Idempotent recompute:** the cross-line reward must clear/re-apply byte-stably across repeated
  `recomputePromotions` (the BXGY rail already converges; a cross-line reward must too).
- **Config vs session TDD:** `openspec/config.yaml apply.tdd:false`, but the BXGY predecessor ran
  strict RED/GREEN TDD. Follow strict TDD; the write-path specs already exist as anchors.

---

## Candidate Approaches (no final decision — seed for design)

### Approach A — Reuse the BXGY reward rail + a new side-aware compound pass (recommended direction)

Generalize `matchTargetTier` to be side-aware; add a pure `computeAdvancedReward` helper; add a
cross-line ADVANCED pass that (1) checks BUY-side satisfaction, (2) computes the reward, (3) emits
it on the GET-side line via the existing `PosEvalBuyXGetYLineResult` kind, applied through the
existing `applyBuyXGetYReward`.
- **Pros:** reuses the proven reward rail, sales apply path, `previewTotals`, and receipt wire; no
  base migration; smallest sales blast radius.
- **Cons:** the cross-line pass is genuinely new; `rewardKind` conflation with BXGY must be
  resolved (Q9); best-wins on the GET line gets a third contributor.
- **Effort:** Medium-High.

### Approach B — Dedicated ADVANCED result kind + reward path

Introduce `kind:'advanced'` in the port, a distinct `applyAdvancedReward` on `SaleItem`, and a
distinct `rewardKind='advanced'` discriminator.
- **Pros:** honest semantics end-to-end; no BXGY conflation; room for ADVANCED-specific rules
  (e.g. keep the 99 cap, distinct receipt copy).
- **Cons:** larger new surface — port kind, entity method, receipt mapper, `previewTotals`, frontend
  contract, more tests; likely a persisted discriminator (small migration).
- **Effort:** High.

### Approach C — Order-level fold (rejected direction, documented for completeness)

Compute the total ADVANCED saving and fold it into the sale-level ORDER_DISCOUNT channel.
- **Pros:** no per-line/cross-line model change; smallest engine surface.
- **Cons:** semantically wrong (product-scoped saving in an order-scoped channel); collides with the
  single `pickBestOrderPromo` winner; destroys per-line receipt attribution. BXGY rejected this for
  the same reasons.
- **Effort:** Low, but poor fit — flag for rejection.

**Recommendation:** carry **Approach A's direction** into propose (side-aware `matchTargetTier`, a
pure `computeAdvancedReward`, a new cross-line pass, reuse of the reward rail), but the propose
**question round MUST run first** — Q1 (buy-side counting), Q2 (group repeatability), Q9
(`rewardKind`), and Q10 (precedence) materially change the shape and could tip the choice toward B.

---

## Ready for Proposal

**Yes.** Intake is free (schema/enum/DTO/entity/service/write-path all pre-exist and are tested);
the weight is entirely in the **engine + sales-apply half** plus a genuine **product-decision round
(Q1–Q11)**. Recommended next phase: **sdd-propose** — run the question round first, then bound scope
around Approach A (side-aware matcher + pure compound helper + new cross-line pass + reward-rail
reuse) with an explicit `rewardKind` decision. Expect a chained/stacked delivery (the BXGY
predecessor exceeded the 400-line review budget; ADVANCED's cross-line pass is comparable or heavier).
