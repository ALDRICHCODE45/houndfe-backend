# Exploration: buy-x-get-y

Activate the DEFERRED promotion **TYPE** `BUY_X_GET_Y` in the POS promotion engine. Today
only `PRODUCT_DISCOUNT` and `ORDER_DISCOUNT` are accepted engine types; `isSupportedEngineType`
rejects `BUY_X_GET_Y` and `ADVANCED`. This change accepts and evaluates the *simple* "buy N,
get M at a discount" (3x2-style) mechanic **only**.

**Scope lock:** POS engine only (`pos-evaluate-promotions.use-case.ts`). OUT of scope:
`ADVANCED` (compound BUY-side → GET-side targeting — a separate future change), the online/cart
engine (`evaluate-cart-promotions.use-case.ts`), and any frontend work.

> **This is materially more complex than the two predecessor changes** (`variant-level-promo-targeting`,
> `category-brand-promo-targeting`). Those were *targeting* changes: a new match branch on an
> existing uniform per-line discount mechanic. `BUY_X_GET_Y` is a **fundamentally different
> mechanic** (conditional, partial-quantity) that the current result model **cannot represent**
> without a new output shape. See Discovery #2 — it is the crux of this change.

---

## Prior-assumption corrections (verified against the real repo)

The brief carried several assumptions about the DTO. Reading the code, **three are wrong** and
must not be carried into propose/spec:

1. **`side=BUY/GET`, `buyTargetType`, `getTargetType`, `buyTargetItems`, `getTargetItems` are
   NOT BUY_X_GET_Y fields — they are `ADVANCED`-only.**
   - In `create-promotion.dto.ts` the BUY-target/GET-target fields (`buyTargetType`
     `:161-163`, `getTargetType` `:165-167`, `buyTargetItems` `:169-173`, `getTargetItems`
     `:175-179`) sit under the explicit `// ── ADVANCED only ──` banner (`:159`).
   - The entity's `validateByType` **FORBIDS** `buyTargetType`/`getTargetType` for
     `BUY_X_GET_Y` (`promotion.entity.ts:483-484`) and only permits them for `ADVANCED`
     (`:487-508`).
   - There is **no `side` field on `CreatePromotionDto` at all.** `side` exists only on the
     persistence relation `PromotionTargetItem.side` (`TargetSide = DEFAULT|BUY|GET`,
     `schema.prisma:1124`, entity `:25`). BUY/GET sides are the ADVANCED data model; the simple
     mechanic never populates them.
2. **The only BUY_X_GET_Y-specific fields are three scalars:** `buyQuantity`, `getQuantity`,
   `getDiscountPercent` (DTO `:141-157`, entity `:464-486`, schema `:1091-1093`). All three are
   **required** for `BUY_X_GET_Y` (entity `requireField` `:465-471`).
3. **`BUY_X_GET_Y` has no dedicated target fields — it (optionally) reuses the PRODUCT_DISCOUNT
   targeting**: `appliesTo` + `targetItems` (DEFAULT side). See Discovery #3; whether targeting
   is required is an OPEN PRODUCT QUESTION.

---

## Current State (verified — file:line confirmed)

### 1. The engine gate — the exact rejection point

`src/promotions/application/pos-evaluate-promotions.use-case.ts` → `isSupportedEngineType`
(**lines 381-407**, not 335-350 as the brief estimated — the file grew with the CATEGORIES/BRANDS
change):

```ts
private isSupportedEngineType(promo: Promotion): boolean {
  if (promo.type === 'ORDER_DISCOUNT') return true;
  if (
    promo.type === 'PRODUCT_DISCOUNT' &&
    (promo.appliesTo === 'PRODUCTS' || promo.appliesTo === 'VARIANTS' ||
     promo.appliesTo === 'CATEGORIES' || promo.appliesTo === 'BRANDS')
  ) {
    return true;
  }
  return false;   // <- BUY_X_GET_Y and ADVANCED fall through to here
}
```

`BUY_X_GET_Y` never matches either branch → `false`. The helper is consulted in **four** places
(all key off this one method): `passesPromotionWideGates` (`:355`), the
`availableManualPromotions` filter (`:250`), and twice in the `targetableManualPromotionIds`
self-heal loop (`:316`, `:326`). Unlike the targeting changes, **flipping the gate alone is NOT
enough** — there is no evaluation path for the type once it passes (Discovery #2).

### 2. Per-line and per-sale evaluation are the only two passes today

`evaluate()` (`:192-345`) does exactly two discount passes plus bookkeeping:
- **Per-line best-wins** over `PRODUCT_DISCOUNT` only (`:208-215` → `pickBestPerLine`
  `:413-503`). Explicit `if (promo.type !== 'PRODUCT_DISCOUNT') continue;` at `:443`.
- **Per-sale best-wins** over `ORDER_DISCOUNT` only (`:236-241` → `pickBestOrderPromo`
  `:564-620`). Explicit `if (promo.type !== 'ORDER_DISCOUNT') continue;` at `:576`.

There is **no third pass** and no place a `BUY_X_GET_Y` promotion is considered. Adding one is
new structural work, not a branch tweak.

### 3. Targeting for BUY_X_GET_Y: reuses DEFAULT-side `appliesTo` + `targetItems` — but is UNVALIDATED

`validateByType` for `BUY_X_GET_Y` (`:464-486`) requires the three scalars and forbids
`discountType`, `discountValue`, `minPurchaseAmountCents`, `buyTargetType`, `getTargetType`. It
does **NOT require and does NOT forbid `appliesTo` / `targetItems`.** So the simple mechanic can
carry DEFAULT-side `targetItems` (the same `matchTargetTier` a PRODUCT_DISCOUNT uses) — the
schema comment `// PRODUCT_DISCOUNT + BUY_X_GET_Y` above `appliesTo` (`schema.prisma:1087-1088`)
confirms this was the intent — but nothing enforces that a BUY_X_GET_Y actually declares a
target. An untargeted BUY_X_GET_Y is currently constructible. This is an OPEN QUESTION + a
likely validation gap (Q1).

### 4. THE REPRESENTATIONAL GAP — the current line result cannot express partial-quantity

This is the single most important finding. The per-line result applies a **uniform** discount
across **every unit** of a line:
- `PosEvalLineResult` (`ports/pos-evaluate-promotions.port.ts:71-79`) = `{ discountType:
  'amount'|'percentage', discountValue, ... }` — a per-unit discount with no quantity selector.
- It is applied via `SaleItem.applyDiscount` (`sale-item.entity.ts:248-282`), which sets
  `_unitPriceCents = baseline - discountAmountCents` — i.e. the discount hits the **unit price**,
  so every unit of the line is discounted equally.
- Totals scale the discounted unit price across the **whole** quantity: `subtotalCents =
  unitPriceCents × quantity` (`sale.entity.ts:508-513`, `previewTotals`).

`BUY_X_GET_Y` needs to discount only **some** units — e.g. buy 2 get 1 at 100% off = 1 of every
3 units discounted, 2 undiscounted. **The current `PosEvalLineResult` + `SaleItem.applyDiscount`
model has no way to say "discount M of N units."** Resolving this representation is the core of
the change, not the gate flip. (See Approaches.)

### 5. "Free" is not representable — `getDiscountPercent` caps at 99

`getDiscountPercent` is validated `0..99` (entity `validateGetDiscountPercent` `:180-187`; DTO
`@Min(0) @Max(99)` `:155-156`). A classic 3x2 ("buy 2 get 1 **free**") needs 100%. Today the
max is 99% off. `SaleItem.applyDiscount`'s percentage path also clamps to 1..99 and rejects
`baseline - discount < 1` (`:267`, `:302-309`), so a truly-free unit is doubly blocked. Whether
"free" = 99% (visible rounding loss) or the field/gates must be extended to 100 is a PRODUCT +
technical decision (Q6).

### 6. Domain, DTO, Prisma enum, and migration ALL already carry BUY_X_GET_Y

- `PromotionType` union (`promotion.entity.ts:6-10`) and `PromotionTypeEnum`
  (`create-promotion.dto.ts:18-23`) both include `BUY_X_GET_Y`.
- Entity `validateByType` has a complete `BUY_X_GET_Y` case (`:464-486`) — construction &
  validation already work today.
- Prisma `enum PromotionType` (`schema.prisma:66-70`) + columns `buyQuantity`/`getQuantity`/
  `getDiscountPercent` (`:1091-1093`) exist; the enum + columns are in the applied migration
  (`20260502052444_multi_tenant_foundation/migration.sql:17,425-427`). **No migration is
  expected** (confirm with `prisma migrate diff` in verify — mirrors the predecessor's zero-drift
  check).
- **Persistence round-trips the three fields today** (props → entity `:81-83,267-269`, toResponse
  `:411-413`). They are persisted but never consumed by the engine.

### 7. Recompute application path (where a result would land)

`SalesService.recomputePromotions` (`sales.service.ts:478-570`): builds input
(`buildPosEvalInput` `:600+`), calls the engine, clears prior promo-sourced discounts, applies
each `result.lines[]` via `item.applyDiscount(...)`, and sets/clears the order promo. Any new
BUY_X_GET_Y output must fit into (or extend) this apply loop and the `previewTotals` math.

---

## Affected Areas (anticipated — bounded in propose/design)

- `src/promotions/application/pos-evaluate-promotions.use-case.ts` — **core.**
  `isSupportedEngineType` gate (`:381-407`); a **new BUY_X_GET_Y evaluation pass** + pure helper;
  interaction ordering with the existing per-line PRODUCT_DISCOUNT pass.
- `src/promotions/application/ports/pos-evaluate-promotions.port.ts` — **likely a new result
  shape** (or an extension of `PosEvalLineResult`) to express partial-quantity / per-line
  cents-amount discounts (Discovery #4).
- `src/sales/sales.service.ts` (`recomputePromotions` `:478-570`) — apply the new result kind.
- `src/sales/domain/sale-item.entity.ts` and/or `sale.entity.ts` — **possibly** a new
  `applyDiscount`-style path or a fixed-cents line discount so `previewTotals` reflects it
  (depends on chosen approach).
- `openspec/specs/pos-promotion-engine/spec.md` — delta `MODIFY`/`ADD` (un-defer BUY_X_GET_Y,
  add scenarios).
- **Tests (TDD, the bulk):** new pure-helper spec for the buy/get computation; engine spec
  (eligibility, counting, precedence vs PRODUCT_DISCOUNT, rounding, MANUAL opt-in, self-heal);
  possibly entity specs for a new discount path; integration sweep on a seeded tenant.
- **Likely NO change:** Prisma schema/migration, `PromotionType`/`PromotionTypeEnum`, entity
  `validateByType` (unless Q1/Q6 force a validation tightening or a 100% cap change).

---

## CORE MECHANIC QUESTIONS (do NOT decide here — for the propose question round)

These are genuine product decisions the engine cannot infer. They must be resolved before design.

- **Q1 — Targeting model.** Is BUY_X_GET_Y **targeted** (DEFAULT-side `appliesTo` + `targetItems`,
  reusing `matchTargetTier`) or **untargeted** (whole-cart)? If targeted, must a target be
  **required** (validation gap in `validateByType`, Discovery #3)? Which target types are allowed
  (PRODUCTS/VARIANTS/CATEGORIES/BRANDS)?
- **Q2 — Buy-quantity counting.** Is the "buy N" counted **per line** (a single line must have
  qty ≥ N) or **aggregated across all lines** matching the buy-target? How do mixed-price lines
  in the same target set combine?
- **Q3 — Which units get the discount, and how many "reward groups".** For a line/target with
  qty Q, buyQuantity=N, getQuantity=M: how many reward groups trigger? (e.g. floor(Q / (N+M))?
  floor(Q/N)? capped at one?) Which of the Q units are the discounted "get" units — the cheapest,
  the most expensive, or arbitrary?
- **Q4 — Discount is a % off the get-units** (`getDiscountPercent`), confirmed by the field. But
  on **which price** — the get-unit's own `effectiveUnitPriceCents`? (Relevant when buy-target
  and get-target differ in price — though in the simple mechanic they share the DEFAULT target
  set.)
- **Q5 — Precedence & stacking vs the per-line PRODUCT_DISCOUNT best-wins pass.** If a line is
  eligible for BOTH a PRODUCT_DISCOUNT and a BUY_X_GET_Y, which wins — or do they stack? How does
  BUY_X_GET_Y interact with the ORDER_DISCOUNT pass (before/after in the subtotal chain)? Does
  the existing "best-wins, ties → lowest id" rule extend to BUY_X_GET_Y, and across types?
- **Q6 — "Free" representation.** Is `getDiscountPercent=99` acceptable as "free-ish", or must
  the field + `SaleItem.applyDiscount` gates be extended to 100% (with the `baseline - discount
  >= 1` invariant `:267` reconsidered)?
- **Q7 — AUTOMATIC vs MANUAL.** Does BUY_X_GET_Y run as AUTOMATIC (auto-applied) and/or MANUAL
  (seller opt-in, appears in `availableManualPromotions` / `targetableManualPromotionIds`)? The
  self-heal loop and manual-candidate mapper currently hard-map type to
  `'PRODUCT_DISCOUNT'|'ORDER_DISCOUNT'` (`:258-261`, port `:93`) — BUY_X_GET_Y would need a wire
  representation there if MANUAL is in scope.
- **Q8 — Result reflection & rounding.** How does the discount surface in the sale draft
  (per-line `discountAmountCents`? a synthetic line? order-level amount?) so `previewTotals`
  (`sale.entity.ts:492-526`) reports `subtotalCents`/`discountCents`/`totalCents` correctly? What
  rounding rule for the per-unit % (mirror `Math.round((baseline * percent) / 100)` at `:309`,
  `:511`)?
- **Q9 — Insufficient quantity.** If a line has qty ≥ buyQuantity but < buyQuantity+getQuantity
  (not enough units to give the reward), does the promo apply partially, not at all, or discount
  the available get-units? (Standard 3x2: no reward until the full group exists.)

---

## Approaches (the real decision: HOW partial-quantity is represented)

All three flip the gate identically; they differ on the OUTPUT model (Discovery #4). This is a
seed for design — not a final pick.

### Approach A — New result kind: per-line **fixed-cents** discount (RECOMMENDED direction)

Add a BUY_X_GET_Y evaluation pass that computes the reward as a **fixed cents amount** on the
line (Σ over discounted get-units), emitted as an `amount`-type per-line result (reusing the
existing `discountType:'amount'` path in `applyDiscount`, which already sets a cents discount on
the unit... **but** `applyDiscount` divides nothing — it subtracts the amount from the *unit*
price, so a whole-line fixed amount would need either a per-unit amortized amount or a new
line-level `discountAmountCents` field that bypasses the per-unit model).

- **Pros:** conceptually simple; keeps the discount on the same line; one number.
- **Cons:** `SaleItem.applyDiscount` is **per-unit** (`_unitPriceCents = baseline - amount`), so
  a line-total amount does not fit cleanly — likely needs a new line-discount path on the entity
  or a synthetic amortization. Rounding when the reward doesn't divide evenly across units.
- **Effort:** Medium.

### Approach B — Line splitting (separate the discounted get-units into their own line)

Split an eligible line into buy-units (full price) + get-units (discounted), so the existing
uniform per-unit model applies correctly to each sub-line.

- **Pros:** each sub-line is uniform → the existing `applyDiscount` + `previewTotals` math works
  unchanged; visually explicit on the receipt.
- **Cons:** mutating cart line structure from the engine is a big blast radius (item ids,
  persistence, idempotent recompute, veto/opt-in bookkeeping keyed by itemId). High risk of
  regressions across the ~1600 sale tests.
- **Effort:** High.

### Approach C — Order-level equivalent (emit the reward as an order-level discount amount)

Compute the total BUY_X_GET_Y saving and fold it into the sale-level order discount channel.

- **Pros:** no per-line model change; smallest engine surface.
- **Cons:** semantically wrong (it's a product-scoped, not order-scoped, saving); collides with a
  real ORDER_DISCOUNT (only one order promo channel today, `pickBestOrderPromo`); hides which
  product earned the reward; breaks per-line receipt attribution.
- **Effort:** Low-Medium, but **poor fit** — flagged for rejection.

| Approach | Output model | Entity change | Blast radius | Effort |
|----------|-------------|---------------|--------------|--------|
| **A fixed-cents line** | new/adapted line result | likely a line-discount path | Medium | **Medium** |
| **B line splitting** | reuse uniform per-unit | cart line structure | **High** | High |
| **C order-level fold** | reuse order result | none | collides w/ ORDER_DISCOUNT | Low-Med (bad fit) |

**Where it slots in `evaluate()`:** a **new pass**, most naturally **after** the per-line
PRODUCT_DISCOUNT best-wins pass (`:208-215`) and **before** the ORDER_DISCOUNT pass (`:236-241`),
so the post-line subtotal feeding ORDER_DISCOUNT already reflects the BUY_X_GET_Y saving — but
the exact ordering depends on Q5 (precedence/stacking). Implement the buy/get math as a **new
pure exported helper** (mirroring `matchTargetTier` / `clampPercentageToSafeRange` — pure,
unit-testable, reused by the future cart engine), NOT inline.

---

## Complexity / Risk Assessment

**This is the highest-complexity change in the promotions series so far.** The predecessors were
targeting deltas (~225-350 authored lines, 400-risk Low-Medium) that reused the existing uniform
discount mechanic. BUY_X_GET_Y introduces a **new mechanic class** (conditional, partial-quantity)
that the current output model does not support, plus 6-9 genuine product decisions.

**Risks:**
- **Representation gap is unavoidable structural work** (Discovery #4). Any approach touches the
  result contract and likely the sale entity — not a branch flip. Resolve Approach A/B/C in
  design BEFORE apply.
- **Product decisions block implementation** (Q1-Q9). Shipping without explicit counting /
  precedence / "free" rules bakes in surprising behavior that is hard to unwind. Resolve the
  question round in propose.
- **"Free" (100%) is not representable today** (Discovery #5) — may force a field + entity gate
  change with its own regression surface (`applyDiscount` clamp, `baseline-discount>=1`).
- **Precedence/stacking vs PRODUCT_DISCOUNT and ORDER_DISCOUNT** (Q5) — the engine has a single
  per-line winner and a single order winner today; BUY_X_GET_Y adds a third dimension.
- **MANUAL wiring** (Q7) — the manual-candidate mapper and self-heal loop hard-code two types;
  extending to BUY_X_GET_Y ripples through `availableManualPromotions` /
  `targetableManualPromotionIds` and the response DTOs.
- **Idempotent recompute** — the new discount must clear/re-apply cleanly like the existing
  promo-sourced discounts (`recomputePromotions` clears `promotionId != null` lines) so re-entry
  never compounds.
- **Config vs session TDD** — `openspec/config.yaml apply.tdd:false` but the session mandates
  strict TDD (predecessors ran RED/GREEN). Follow strict TDD; optionally reconcile config.
- **Scope creep** — keep ADVANCED (BUY/GET side split) and the cart engine firmly OUT.

**Suggested work-unit breakdown SEED** (refined authoritatively in sdd-tasks; likely **needs a
chained/stacked split** — forecast Medium-High):
1. Pure helper: buy/get eligibility + reward-unit computation (RED-first, no engine wiring).
2. Result-contract change: new/adapted `PosEval*Result` shape for the reward (port + engine gate
   flip + new pass wired to the helper).
3. Entity/apply path: how the reward lands on the line and flows into `previewTotals`
   (`SaleItem`/`Sale`), depending on Approach A/B/C.
4. `SalesService.recomputePromotions` wiring + idempotent clear/re-apply.
5. MANUAL surface (only if Q7 puts MANUAL in scope): candidate mapper + self-heal + response DTO.
6. Spec un-defer (`pos-promotion-engine/spec.md`) + integration sweep + zero-migration check.

---

## Explicit Non-Goals

- **`ADVANCED`** (compound BUY-side target → GET-side target, using `buyTargetType`/`getTargetType`/
  `side=BUY|GET`) — a separate future change.
- **The online/cart engine** (`evaluate-cart-promotions.use-case.ts`) — untouched. (The new pure
  helper is designed for future reuse there, but this change does not wire it in.)
- **Any frontend work.**
- **No `PromotionType` enum / DTO / Prisma / migration changes** (all pre-exist) unless Q1/Q6
  force a validation tightening or a 100% cap change.

---

## Ready for Proposal

**Yes — but heavier than its predecessors.** The gate is one helper (`isSupportedEngineType`
`:381-407`), and the type is already wired through DTO/entity/Prisma/persistence, so intake is
free. The weight is in (a) a **required representation decision** (Approach A/B/C for
partial-quantity — Discovery #4) and (b) a **product-decision round** (Q1-Q9: targeting,
counting, reward-unit selection, precedence/stacking, "free", AUTOMATIC/MANUAL, rounding,
insufficient-qty). The propose phase should run the question round FIRST, then bound scope around
the chosen approach. Recommended next phase: **sdd-propose** (carry Approach A — fixed-cents line
result, new pure helper, new pass after per-line & before order — as the default to confirm, and
surface Q1-Q9 for the user).
