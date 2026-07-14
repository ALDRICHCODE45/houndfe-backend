# Design v2: Activate BUY_X_GET_Y in the POS Promotion Engine

> **v2** — revised after adversarial dual review. Q5 and Q6 were re-decided
> (Engram `sdd/buy-x-get-y/decisions-revised` #2796, supersedes #2792 for Q5+Q6).
> Approach A — new per-line **fixed-cents** reward, one pure exported helper, and a
> new evaluation pass between the per-line `PRODUCT_DISCOUNT` and the `ORDER_DISCOUNT`
> passes. All file:line refs re-verified against the working tree on this pass.
>
> **What changed from v1:** (1) Q5 comparator now compares REAL per-line TOTAL
> savings (PD per-unit × qty), not per-unit vs line-total; (2) Q6 representation now
> renders NET on BOTH `previewTotals` AND the receipt/detail mapper via a
> column-derived + wire-serialized reward discriminator (v1 left the mapper reading
> gross); (3) the 99→100 cap is now TYPE-AWARE (BXGY only, ADVANCED stays ≤99);
> (4) `hasManualDiscount` short-circuit + update-time `INVALID_TARGET` added.

## Ground-truth verification (drift log)

- **`SaleItemDiscountType` is a Postgres ENUM** (`amount`/`percentage`). The reward
  MUST ride the existing `amount` value + existing columns (`discountType`,
  `discountValue`, `discountAmountCents`, `prePriceCentsBeforeDiscount`,
  `promotionId`). No new column / enum / migration.
- **`previewTotals` (`sale.entity.ts:492-526`)** is driven by
  `prePriceCentsBeforeDiscount ?? unitPriceCents` (subtotal, `:501-507`) and
  `Σ item.subtotalCents = Σ unitPrice×qty` (postLine, `:510-513`). It never reads
  `discountAmountCents`.
- **The confirmed-sale receipt/detail mapper (`prisma-sale.repository.ts:1386-1406`)**
  emits per line: `subtotalCents = item.unitPriceCents * item.quantity` (`:1393`) and
  `discountCents = item.discountAmountCents ?? 0` (`:1392`). **v1 REGRESSION (now
  fixed):** with a BXGY line at full `unitPriceCents` and `R` in `discountAmountCents`,
  `:1393` yields GROSS (3000c) while every PD line's `subtotalCents` is already NET.
  This is a gross↔net **flip** on the wire. **The v1 drift-log claim that these two
  columns are inert receipt snapshots is RETRACTED — `:1393` is load-bearing net math.**
- **`computeAppliedDiscountCents` (`use-case.ts:663-674`) is PER-UNIT** (`min(value,
  effUnit)` / `round(effUnit*pct/100)`); consumed at `:225`. Q5-revised multiplies it
  by line quantity to get the PD TOTAL saving.
- **`validateGetDiscountPercent` (`promotion.entity.ts:180-187`)** is SHARED by
  BUY_X_GET_Y (`:474`) and ADVANCED (`:497`); DTO `@Max(99)` (`create-promotion.dto.ts:156`)
  is SHARED too. A naive 99→100 loosening LEAKS into ADVANCED (out of scope) — must be
  type-aware.
- **`hasManualDiscount` short-circuit** lives at `use-case.ts:419` (`pickBestPerLine`).
- **`assertAdvancedSideTargets`** runs on create (`promotions.service.ts:124`) AND
  update (`:220`, route at `:186`); the new BXGY guard mirrors it on BOTH.

## Technical Approach

Flip the engine gate, add ONE pure helper, add ONE evaluation pass, and add ONE new
`SaleItem` reward path storing a whole-line cents reward `R` in `discountAmountCents`
while `unitPriceCents` stays at full buy-price and `prePriceCentsBeforeDiscount =
unitPriceCents`. **NET is rendered by subtracting `R` in BOTH read paths** (previewTotals
and the receipt mapper) under one shared, column-derived discriminator; the mapper also
surfaces an explicit `rewardKind` on the wire. No schema/migration/enum change.

## Architecture Decisions

### Decision 1 — Result contract: line-total `amount` reward, existing columns only

A BXGY reward is a whole-line cents amount `R` persisted on the winning line:

| Column | BXGY line | PRODUCT_DISCOUNT `amount` line |
|--------|-----------|--------------------------------|
| `unitPriceCents` | **full buy-price (UNCHANGED)** | `baseline − perUnitAmount` (reduced/NET) |
| `prePriceCentsBeforeDiscount` | `= unitPriceCents` (EQUAL) | `baseline` (> unitPrice) |
| `discountType` | `'amount'` | `'amount'` |
| `discountAmountCents` | `R` (**whole-line** total) | per-unit amount |
| `discountValue` | `perUnitRewardCents` (snapshot) | per-unit amount |
| `promotionId` | BXGY id | promo id |

**Discriminator (shared, no new column).** `isBuyXGetYReward` ≙ `promotionId != null &&
discountAmountCents > 0 && prePriceCentsBeforeDiscount != null && unitPriceCents ===
prePriceCentsBeforeDiscount`. Unreachable by the per-unit path (whose invariant forces
`unitPrice < prePrice` by ≥1, `sale-item.entity.ts:267`). It is defined **once as a domain
method** `SaleItem.isBuyXGetYReward()` AND **re-derived from the same persisted columns in
the receipt mapper** (see Decision 6) — so both readers compute NET identically.

**New `SaleItem` method** (bypasses per-unit `applyDiscount` entirely):

```ts
interface ApplyBuyXGetYRewardInput {
  lineDiscountCents: number;    // R — whole-line reward
  perUnitRewardCents: number;   // snapshot for the receipt
  discountedUnitCount: number;  // snapshot (groups * M)
  discountTitle: string; promotionId: string;
}
applyBuyXGetYReward(input): void
// guard: R integer, 0 < R < unitPriceCents*quantity → INVALID
// sets: _prePriceCentsBeforeDiscount = _unitPriceCents (unchanged);
//       _discountType='amount'; _discountValue=perUnitRewardCents; _discountAmountCents=R;
//       _discountTitle; _discountedAt=new Date(); _promotionId; (unitPriceCents left FULL)
```

**`Sale.previewTotals` (`:510-513`) — one subtrahend on postLine:**

```ts
const postLineSubtotalCents = this._items.reduce(
  (sum, item) => sum + item.subtotalCents
    - (item.isBuyXGetYReward() ? item.discountAmountCents! : 0), 0);
```
`subtotalCents` (base, `:501-507`) is unchanged — BXGY lines have `prePrice === unitPrice`
so they contribute full price to the base, and `discountCents = subtotal − total` (`:524`)
carries `R` automatically.

**Alternatives rejected.** New column / new `discountType` → migration (forbidden).
Per-unit amortization → `R/qty` non-integer (2000c ÷ 3), byte-exact reproduction
impossible. **Line-splitting** (get-units become a 0c/reduced sub-line) IS the only
representation where `unitPrice×qty` is intrinsically NET for every consumer with zero
discriminator — but its blast radius is HIGH (synthetic `SaleItem` ids created/destroyed
per recompute, product+variant uniqueness/`matches()` merge invariant broken, buy-line
quantity mutation vs conservation, persistence row-diffing, idempotent recompute keyed by
itemId must reap synthetic rows) and it CONTRADICTS spec `:97-100`, which describes ONE
line's `subtotalCents` = 2000c. **Rejected: the aggregate-invariant damage outweighs its
"intrinsic net" advantage; the read-time subtraction is contained to two documented,
column-derived readers instead.** See Risks.

### Decision 2 — Pure helper `computeBuyXGetYReward`

Co-located/exported in `pos-evaluate-promotions.use-case.ts` (pure, unit-testable).

```ts
export function computeBuyXGetYReward(i: {
  quantity; effectiveUnitPriceCents; buyQuantity /*N*/; getQuantity /*M*/; getDiscountPercent /*0..100*/;
}): { rewardGroups; discountedUnitCount; perUnitRewardCents; lineDiscountCents } {
  const groupSize = i.buyQuantity + i.getQuantity;              // N+M
  const rewardGroups = Math.floor(i.quantity / groupSize);      // Q3 + Q9
  const discountedUnitCount = rewardGroups * i.getQuantity;     // Q3
  const perUnitRewardCents =
    Math.round((i.effectiveUnitPriceCents * i.getDiscountPercent) / 100); // Q8, Q4
  return { rewardGroups, discountedUnitCount, perUnitRewardCents,
           lineDiscountCents: discountedUnitCount * perUnitRewardCents };
}
```
Q2 per-line (never aggregated); Q3 `floor(Q/(N+M))` groups, uniform line price → "cheapest
M units" = "M units at line price"; Q8 `Math.round`; Q9 `Q<N+M ⇒ 0`.

### Decision 3 — New pass + cross-type best-wins (Q5 **REVISED** — total savings)

**Placement.** Insert the pass in `evaluate()` after the per-line PRODUCT_DISCOUNT loop
(`~:215`) and BEFORE the order-subtotal machinery (`:219-234` → `pickBestOrderPromo :236`),
so the ORDER_DISCOUNT base (built from `lineResults` via `computeAppliedDiscountCents`)
already reflects the BXGY saving.

**Per-line candidate.** `pickBestBuyXGetYPerLine` — **MUST replicate
`if (line.hasManualDiscount) return null` (mirrors `:419`)** so an AUTOMATIC BXGY skips a
line already carrying a seller free-form discount; same MANUAL opt-in/veto gating as
`pickBestPerLine (:431-437)`; `passesPromotionWideGates`; `matchTargetTier != null`;
price-list gate; `lineDiscountCents > 0`; ties → lowest id.

**Comparator (REVISED — REAL per-line TOTAL saving; supersedes #2792/v1 per-unit basis):**

```
pdPerUnitCents = existingPd ? computeAppliedDiscountCents(line, existingPd) : 0   // :663, PER-UNIT
pdTotalCents   = pdPerUnitCents * line.quantity                                   // NEW ×qty (all units discounted)
bxgyTotalCents = bxgyWinner.lineDiscountCents                                     // helper total reward R
if (bxgyTotalCents > pdTotalCents ||
    (bxgyTotalCents === pdTotalCents && bxgyWinner.id < existingPd.promotionId))
   → replace/insert BXGY line result; else keep PRODUCT_DISCOUNT
```
Each side's line saving is read where it lives: **PD** from `computeAppliedDiscountCents`
(per-unit) × `line.quantity`; **BXGY** from the helper's `lineDiscountCents`. Larger total
wins; ties → lowest promotion id. **This SUPERSEDES the v1 per-unit-vs-line-total
asymmetry** and forces the spec `:29-32` tie to be re-locked (see Required spec edits).

### Decision 4 — `isSupportedEngineType` gate (`:381-407`)

```ts
if (promo.type === 'BUY_X_GET_Y' &&
    ['PRODUCTS','VARIANTS','CATEGORIES','BRANDS'].includes(promo.appliesTo)) return true;
```
The four call sites (`:250,:316,:326,:355`) then admit BXGY transparently.

### Decision 5 — Q1 targeting-required (service, create + **update**)

`validateByType` cannot see `targetItems` (resolved in the service). Add a guard mirroring
`assertAdvancedSideTargets`, invoked BOTH in `create` (beside `:124`) AND `update`
(beside `:220`):

```ts
private assertBuyXGetYTargeted(type, appliesTo, targetItems): void {
  if (type !== 'BUY_X_GET_Y') return;
  if (!appliesTo || targetItems.length === 0)
    throw new InvalidArgumentError('BUY_X_GET_Y requires appliesTo + at least one target',
                                   'INVALID_TARGET');
}
```
Entity `validateByType` BXGY case (`:464-485`) unchanged (an entity `requireField(appliesTo)`
would surface `MISSING_REQUIRED_FIELD`, not the locked `INVALID_TARGET`). Service is the
single source of the `INVALID_TARGET (400)` contract on create AND update.

### Decision 6 — Q6 **REVISED**: NET rendered on previewTotals AND the receipt mapper

The get-units surface at their reduced per-unit price; the line subtotal is NET on EVERY
consumer, with NO gross/net flip.

- **Domain (`previewTotals`)** subtracts `R` under `isBuyXGetYReward()` (Decision 1).
- **Receipt/detail mapper (`prisma-sale.repository.ts:1386-1406`) — CHANGED:** the same
  discriminator, re-derived from the persisted Prisma row (`item.promotionId != null &&
  (item.discountAmountCents ?? 0) > 0 && item.prePriceCentsBeforeDiscount != null &&
  item.unitPriceCents === item.prePriceCentsBeforeDiscount`), subtracts `R`:
  ```ts
  const isBxgy = /* predicate above */;
  subtotalCents: item.unitPriceCents * item.quantity - (isBxgy ? (item.discountAmountCents ?? 0) : 0), // :1393
  discountCents: item.discountAmountCents ?? 0,                                                          // :1392 = R
  rewardKind: isBxgy ? 'buy_x_get_y' : null,                                                             // NEW wire flag
  ```
- **Wire (`sale-detail-response.dto.ts`) — CHANGED:** add `rewardKind?: 'buy_x_get_y' | null`
  to `SaleDetailItemDto` so the discriminator is EXPLICIT on the wire (not backend-only),
  letting the frontend render the "free"/reward badge without inferring it.

**Because the discriminator is reconstructed from serialized columns AND surfaced as an
explicit wire field, this is NOT the v1 "unserialized backend-only predicate" — both
readers compute NET from the same rule (#2796 constraint satisfied).**

**Type-aware 100% cap (CRITICAL — must NOT leak into ADVANCED):**
- Entity: `validateGetDiscountPercent(value, type)` — max **100** for `BUY_X_GET_Y`, **99**
  for `ADVANCED`; message per branch. Call sites `:474` pass `'BUY_X_GET_Y'`, `:497` pass
  `'ADVANCED'`.
- DTO (`create-promotion.dto.ts:156`): `@Max(99) → @Max(100)` (loosen the shared bound); the
  ADVANCED ≤99 domain rule is enforced by the type-aware entity guard, so ADVANCED=100 is
  rejected by the entity even though the DTO admits it.
- `SaleItem.applyDiscount`'s 1..99 percentage clamp (`:302-309`) and the `baseline−discount≥1`
  invariant (`:267`) are **NOT on the BXGY path** (`applyBuyXGetYReward` bypasses them; `R =
  groups*M*unitPrice < qty*unitPrice` always > 0). **Leave `applyDiscount` UNCHANGED** — zero
  PRODUCT_DISCOUNT regression surface.

### Decision 7 — MANUAL wiring (Q7), 4 sites

1. **Candidate mapper** (`:258-261`): map `BUY_X_GET_Y → 'BUY_X_GET_Y'`.
2. **Port union** (`port.ts:93`): `type` += `'BUY_X_GET_Y'`.
3. **Self-heal loop** (`:326`): extend the target branch to retain opt-in BXGY IFF
   `matchTargetTier(...) !== null` on some line (retention keys off target PRESENCE).
4. **Response DTO** (`list-applicable-promotions-response.dto.ts:16`): union += `'BUY_X_GET_Y'`;
   `sales.service.ts:1542` passes it through unchanged.

### Decision 8 — `recomputePromotions` idempotency

- **Clear (`:484-488`):** BXGY lines have `promotionId != null` → `removeDiscount()` restores
  `unitPrice = prePrice` (no-op, equal) and clears discount fields.
- **Apply (`:493-509`) branches on kind:**
  ```ts
  if (lineResult.kind === 'buy-x-get-y')
    item.applyBuyXGetYReward({ lineDiscountCents, perUnitRewardCents, discountedUnitCount, discountTitle, promotionId });
  else item.applyDiscount({ ...existing });
  ```
- **5× convergence:** BXGY never mutates `unitPriceCents`, so `effectiveUnitPriceCents =
  prePrice ?? unitPrice` is stable across recomputes → identical helper output → byte-equal
  totals. Item ids are STABLE (no line-splitting), so idempotency keyed by itemId holds
  trivially.

### Result-contract type (`port.ts:71-79`)

Discriminated union with optional `kind` (default `'per-unit'` keeps existing literals
compiling):

```ts
export interface PosEvalPerUnitLineResult { kind?: 'per-unit'; itemId; promotionId;
  discountType: 'amount'|'percentage'; discountValue; discountTitle; }
export interface PosEvalBuyXGetYLineResult { kind: 'buy-x-get-y'; itemId; promotionId; discountTitle;
  lineDiscountCents; perUnitRewardCents; discountedUnitCount; }
export type PosEvalLineResult = PosEvalPerUnitLineResult | PosEvalBuyXGetYLineResult;
```
`computeAppliedDiscountCents` gains a leading
`if (result.kind === 'buy-x-get-y') return result.lineDiscountCents;`.

## Worked examples (end-to-end)

**buy 2 get 1 @ 100%, qty 3, 1000c/unit:** groups 1, discountedUnits 1, perUnit
`round(1000*100/100)=1000`, `R=1000`. Stored: `unitPrice=1000`, `prePrice=1000`,
`discountAmountCents=1000`.
- `previewTotals`: subtotal `1000*3=3000`; postLine `3000−1000=2000`; total `2000`; discount `1000`.
- **Receipt mapper:** `subtotalCents = 1000*3 − 1000 = 2000` (NET); `discountCents = 1000`;
  `rewardKind='buy_x_get_y'`. ✓ spec `:97-100` (2000c buy-units, free unit reflected at 0c).

**buy 2 get 1 @ 50% (partial rounding), qty 3, 1000c/unit:** perUnit `round(1000*50/100)=500`,
`R=500`. Stored: `unitPrice=1000`, `prePrice=1000`, `discountAmountCents=500`.
- `previewTotals`: subtotal `3000`; postLine `2500`; total `2500`; discount `500`.
- **Receipt mapper:** `subtotalCents = 3000 − 500 = 2500` (NET); `discountCents = 500`. ✓
Both readers agree; no non-integer amortization (reward is integer per get-unit).

## Data Flow

```
evaluate()                                       recomputePromotions()
  per-line PRODUCT_DISCOUNT (:208-215) ─┐          clear promo lines (:484-488)
  NEW BXGY pass + TOTAL-saving best-wins ┤─lineResults─▶ apply per kind (:493-509)
  order-subtotal (:219-234) ◀ reflects BXGY        set/clear order promo (:511-522)
  ORDER_DISCOUNT (:236-241) ────────────┘          self-heal opt-ins (:563-569)
NET readers: Sale.previewTotals() ◀ isBuyXGetYReward()  │  prisma-sale.repository.ts:1393 ◀ column-derived isBxgy
```

## File Changes

| File | Action | Change |
|------|--------|--------|
| `promotions/application/pos-evaluate-promotions.use-case.ts` | Modify | export `computeBuyXGetYReward`; gate (`:381-407`); BXGY pass + `pickBestBuyXGetYPerLine` (incl. `hasManualDiscount` short-circuit) + TOTAL-saving reconcile (after `:215`); `computeAppliedDiscountCents` BXGY branch (`:663`); mapper `type` (`:258-261`); self-heal (`:326`) |
| `promotions/application/ports/pos-evaluate-promotions.port.ts` | Modify | discriminated `PosEvalLineResult`; candidate `type` union (`:93`) |
| `sales/domain/sale-item.entity.ts` | Modify | `applyBuyXGetYReward()` + `isBuyXGetYReward()`; **no** `applyDiscount` change |
| `sales/domain/sale.entity.ts` | Modify | `previewTotals` postLine subtrahend (`:510-513`) |
| `sales/sales.service.ts` | Modify | apply-loop kind branch (`:493-509`) |
| `sales/infrastructure/prisma-sale.repository.ts` | **Modify (NEW in v2)** | receipt/detail mapper `:1393` net subtotal via column-derived `isBxgy`; `:1392` unchanged (`=R`); emit `rewardKind` |
| `sales/dto/sale-detail-response.dto.ts` | **Modify (NEW in v2)** | `SaleDetailItemDto.rewardKind?: 'buy_x_get_y' \| null` |
| `promotions/domain/promotion.entity.ts` | Modify | type-aware `validateGetDiscountPercent(value,type)` — 100 for BXGY, 99 for ADVANCED (`:180-187`,`:474`,`:497`) |
| `promotions/dto/create-promotion.dto.ts` | Modify | `@Max(99)→@Max(100)` (`:156`) |
| `promotions/promotions.service.ts` | Modify | `assertBuyXGetYTargeted` on create (`:124`) + update (`:220`) |
| `sales/dto/list-applicable-promotions-response.dto.ts` | Modify | `type` union += `BUY_X_GET_Y` (`:16`) |

## Required spec.md edits (drives the follow-up sdd-spec update)

1. **`:29-32` (RE-LOCK — Q5 revised).** Old tie (PD FIXED 500c == BXGY 500c at qty 3) is
   WRONG: PD total = 500c/unit × 3 = **1500c** > BXGY 500c. Rewrite THEN so **P-A
   (PRODUCT_DISCOUNT) is applied** (1500c > 500c), and fix the GIVEN note to state the
   per-line PD saving is `perUnit×qty`.
2. **NEW cross-type TIE scenario (Q5 revised).** Add a genuine equal-total case to keep
   lowest-id tie coverage, e.g. 1000c line qty 6, PD FIXED 100c (total `100*6=600c`), BXGY
   buy 2 get 1 @ 30% (`floor(6/3)*1*round(1000*30/100)=2*300... `→ pick numbers so totals
   equal; concrete: PD FIXED 250c×… ) — spec author selects integers where PD total ==
   BXGY total and `P-B.id < P-A.id` → BXGY wins on lowest id.
3. **`:24-27` (note fix).** Update the comparison note from "1000c > 100c" to
   "1000c > 600c" (PD total = `100 × 6`). THEN (BXGY wins) unchanged.
4. **`:34-37` (fix stacking contradiction).** As written it applies BOTH a PD and a BXGY to
   one 1000c line, contradicting cross-type no-stacking. Re-scope so the PD is on a
   DIFFERENT line (or drop the PD), keeping the point that the ORDER_DISCOUNT base reflects
   the BXGY saving.
5. **`:93-95` requirement prose (Q6 revised).** Reword: the cap lift is `getDiscountPercent
   = 100` **for BUY_X_GET_Y only**; ADVANCED remains ≤99; `SaleItem.applyDiscount`'s
   percentage clamp is **unchanged** (the reward path bypasses it). Scenario `:97-100`
   numbers stay (single-line NET 2000c / discount 1000c) — now also asserted on the receipt
   mapper.
6. **NEW 18th scenario — update-time INVALID_TARGET.** Under "BUY_X_GET_Y Targeting Is
   Required": GIVEN an existing BXGY, WHEN `PATCH /promotions/:id` sets `appliesTo=null` or
   `targetItems=[]`, THEN rejected with `INVALID_TARGET (400)` and no row mutated.

## Testing Strategy

| Layer | What | Where |
|-------|------|-------|
| Unit (pure) | `computeBuyXGetYReward` groups/rounding/Q9 | new `*.buy-x-get-y-helper.spec.ts` |
| Unit (entity) | `applyBuyXGetYReward`+`isBuyXGetYReward`+`previewTotals` NET (100% & 50%) + 5× idempotency | `sale-item.entity.spec.ts`, `sale.entity.spec.ts` |
| Unit (repo) | receipt mapper NET subtotal + `rewardKind` for BXGY row; gross unchanged for PD/manual | `prisma-sale.repository` mapper spec |
| Unit (engine) | eligibility, counting, **TOTAL-saving x-type best-wins** (PD-wins 1500>500; tie lowest-id), `hasManualDiscount` skip, pass ordering, MANUAL surfaces, self-heal | `pos-evaluate-promotions.*.spec.ts` |
| Unit (service) | recompute clear/re-apply, 5× convergence, opt-in survival | `sales.service.spec.ts` |
| Validation | `INVALID_TARGET` create+update; BXGY `getDiscountPercent=100` accepted; **ADVANCED=100 rejected** | promotions.service/entity/DTO specs |
| Integration | seeded sweep; `prisma migrate diff` empty | `*.integration.spec.ts` |

**Existing-test inversions (WU5):**
- `promotion.entity.spec.ts:216` — currently asserts `getDiscountPercent:100` THROWS for
  BUY_X_GET_Y → **invert to ACCEPT** (`expect(...).not.toThrow()` / assert persisted 100).
- **Add** an ADVANCED `getDiscountPercent:100` THROWS test (none exists today) to lock the
  type-aware boundary so the 100 cap does not leak into ADVANCED.

## Migration / Rollout

No migration. `prisma migrate diff` MUST be empty. Reward rides existing `amount` +
`discountAmountCents`; `rewardKind` is a RESPONSE/DTO field only (no column). Rollback =
revert branch; validation changes reject new rows only.

## The RED spike (write FIRST)

1. **Helper RED (WU1):** `computeBuyXGetYReward({quantity:3,effectiveUnitPriceCents:1000,
   buyQuantity:2,getQuantity:1,getDiscountPercent:50})` → `{rewardGroups:1,
   discountedUnitCount:1,perUnitRewardCents:500,lineDiscountCents:500}`.
2. **Representation RED (WU2 — NOW two readers):** on a qty-3/1000c item,
   `applyBuyXGetYReward({lineDiscountCents:500,...})` → `isBuyXGetYReward()===true`,
   `unitPriceCents===1000`, `previewTotals()` → `{subtotal:3000,discount:500,total:2500}`
   **AND** the receipt mapper maps the same persisted row to `subtotalCents===2500`,
   `discountCents===500`, `rewardKind==='buy_x_get_y'`. Proves NET renders on BOTH paths
   with no flip before the pass is wired.

## Work-Unit File Plan (TDD RED→GREEN, conventional commits)

| WU | Commit | Files | Independent? |
|----|--------|-------|--------------|
| 1 | `feat(promotions): pure computeBuyXGetYReward helper` | use-case (helper) + helper spec | ✅ |
| 2 | `feat(sales): BXGY line reward + NET on previewTotals & receipt mapper` | sale-item.entity, sale.entity, **prisma-sale.repository**, **sale-detail-response.dto** + specs | ✅ (entity+mapper, no engine) — **largest v2 change** |
| 3 | `feat(promotions): BXGY gate + pass + TOTAL-saving best-wins` | use-case (gate/pass/reconcile + `hasManualDiscount` skip), port + engine specs | ⛔ needs WU1+WU2 — **comparator is the v2 crux** |
| 4 | `feat(sales): recompute applies/clears BXGY idempotently` | sales.service + spec | ⛔ needs WU3 |
| 5 | `feat(promotions): require target (create+update) + type-aware 100% (Q1/Q6)` | promotion.entity, create-promotion.dto, promotions.service + specs (incl. `:216` inversion + ADVANCED=100 throws) | ✅ (validation-only) |
| 6 | `feat(promotions): MANUAL BXGY surface + self-heal` | use-case (mapper/self-heal), port, response DTO + specs | ⛔ needs WU3 |
| 7 | `test(promotions): BXGY spec edits + integration sweep` | spec.md (Required edits), integration, migrate-diff | ⛔ last |

Order: 1 → 2 → 3 → 4 → 6, with 5 landable anytime; 7 closes. WU2 and WU3 carry the bulk of
the v2 delta (representation + comparator).

## Open Questions

- [ ] None blocking. Decision 6 accepts a documented read-time NET subtraction in TWO
  column-derived readers (previewTotals + receipt mapper) rather than the intrinsic-net
  line-split; any THIRD consumer of the persisted line that computes `unitPrice×qty` must
  apply the same discriminator (documented, wire-flagged via `rewardKind`).
