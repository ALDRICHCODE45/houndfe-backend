# Apply Progress — buy-x-get-y (WU1 + WU2 + WU3 + WU4)

## Status: ok — Batch 1 + Batch 2 complete (resume salvage of dead WU3 draft)

Branch `feat/buy-x-get-y` from clean `main`. Two work units committed
in order; each commit is RED→GREEN with filtered Jest only (anti-hang
rule observed throughout). No PRs, no merge to main.

## Commits (on `feat/buy-x-get-y`)

| Hash | Subject | Lines |
|---|---|---|
| `71bebe0` | chore(promotions): SDD planning artifacts for buy-x-get-y | 5 files / +1103 |
| `b89fc82` | feat(promotions): add pure computeBuyXGetYReward helper | 2 files / +296 |
| `2a44cc6` | feat(sales): add BXGY line reward and NET readers | 7 files / +948 / −24 |
| `b81565b` | docs(promotions): apply-progress for buy-x-get-y batch 1 (WU1+WU2) | 1 file / +62 |
| `dde0489` | feat(promotions): evaluate BXGY with total-saving best-wins | 3 files / +949 / −1 |
| `f78d324` | feat(sales): recompute BXGY rewards idempotently | 2 files / +427 |

## WU1 — Pure helper `computeBuyXGetYReward`

- **RED spec:** `src/promotions/application/pos-evaluate-promotions.buy-x-get-y-helper.spec.ts` — 12 tests covering spec.md:69-91,102-106 (qty3/1000c/2+1/50, multi-group qty6/9/7, zero-group qty2 & qty1, 100% true-free qty3 & qty8, 33% & 17% rounding, non-round 777c/qty4 & qty10).
- **GREEN impl:** exported `computeBuyXGetYReward` from `pos-evaluate-promotions.use-case.ts` — pure, no DI, no I/O. Math: `rewardGroups = floor(qty / (N+M))`, `discountedUnitCount = groups * M`, `perUnitRewardCents = Math.round((unitPrice * pct) / 100)`, `lineDiscountCents = discountedUnitCount * perUnitRewardCents`. Returns zero reward when `qty < N+M` (Q9).
- **Filtered test:** `pnpm run test -- pos-evaluate-promotions.buy-x-get-y-helper.spec.ts` → 12/12 green.
- **Regression sweep:** `pnpm run test -- pos-evaluate-promotions.use-case.spec.ts` → 42/42 green (zero engine regression).

## WU2 — NET representation (entity + mapper + DTO)

- **RED specs (19 new tests):**
  - `sale-item.entity.spec.ts` — 14 tests: `isBuyXGetYReward()` discriminator (fresh, post-PD, post-manual, post-BXGY), `applyBuyXGetYReward` contract (unitPrice UNCHANGED at 50%/100%, discountAmountCents = R whole-line, discountValue = perUnit snapshot, discountTitle/discountedAt/promotionId stamped, qty/productId/variantId/saleId immutable), guard rails (R ≤ 0, R ≥ unitPrice×qty, R=1 boundary), `removeDiscount()` clears the BXGY reward, regression — `applyDiscount` still rejects 100% PD and still enforces `baseline−discount≥1`.
  - `sale.entity.spec.ts` — 7 tests: `previewTotals` 100% BXGY (3000/1000/2000), 50% BXGY (3000/500/2500), multi-group qty6 (6000/1000/5000), mixed BXGY+PD, BXGY+order discount, non-BXGY PD regression, manual free-form regression.
  - `prisma-sale.repository.spec.ts` — 5 tests: `findOneWithRelations` 100% BXGY → NET 2000c subtotal + `rewardKind='buy_x_get_y'`; 50% BXGY → 2500c; PD line → `rewardKind=null` regression; manual → `rewardKind=null`; mixed BXGY+PD on the same response.
- **GREEN impl (4 source files):**
  - `src/sales/domain/sale-item.entity.ts` — `ApplyBuyXGetYRewardInput` interface + `applyBuyXGetYReward()` method + `isBuyXGetYReward()` getter. `applyDiscount` and `removeDiscount` UNCHANGED (PRODUCT_DISCOUNT path zero regression surface).
  - `src/sales/domain/sale.entity.ts` — `previewTotals` postLine subtrahend subtracts `R` under `item.isBuyXGetYReward()`.
  - `src/sales/infrastructure/prisma-sale.repository.ts` — receipt/detail mapper (`findOneWithRelations`) re-derives the same discriminator from the persisted Prisma row, subtracts `R` from `subtotalCents`, emits `rewardKind: 'buy_x_get_y' | null`. The Prisma `items.select` now includes `promotionId` (was missing — this was the v1 mapper gap that rendered BXGY lines as GROSS).
  - `src/sales/dto/sale-detail-response.dto.ts` — `SaleDetailItemDto.rewardKind: 'buy_x_get_y' | null` (explicit wire flag).
- **Filtered test:** `pnpm run test -- sale-item.entity.spec.ts sale.entity.spec.ts prisma-sale.repository.spec.ts` → 261/261 green.
- **Regression sweep:** `pnpm run test -- pos-evaluate-promotions.use-case.spec.ts pos-evaluate-promotions-w4.spec.ts match-target-tier.spec.ts sales.service.spec.ts` → 252/252 green.

## Residual-risk scan (the design's "third consumer" warning)

Grep for `unitPrice × qty` / `item.subtotalCents` / `.unitPriceCents * item.quantity`:

| File:line | Purpose | BXGY consumer? |
|---|---|---|
| `src/sales/domain/sale.entity.ts:520` | `previewTotals` postLine reduce | ✅ Yes — fixed in WU2 |
| `src/sales/infrastructure/prisma-sale.repository.ts:1422` | Receipt/detail mapper | ✅ Yes — fixed in WU2 |
| `src/sales/sales.service.ts:2389` | `confirmBotSale` raw `input.items` sum for bot-created CREDIT sales | ❌ No — raw incoming items, no promotion path; runs only when a bot creates a credit sale |

No third BXGY consumer. Both documented readers compute NET under the same column-derived discriminator.

## Decisions / discoveries worth remembering

1. **`makeBxgyRow` helper omission:** the test factory `makeBxgyRow` in `prisma-sale.repository.spec.ts` originally accepted `promotionId` as a parameter but did NOT include it in the returned Prisma row literal. Without that field, the receipt mapper's column-derived discriminator sees `promotionId === undefined` and falls through to the gross path — silent test helper bug that masked the WU2 mapper's effectiveness. Fixed by including `promotionId: args.promotionId` in the helper's return.
2. **Prisma `items.select` gap in `findOneWithRelations`:** the existing receipt/detail mapper was missing `promotionId: true` in its `items.select` block. The mapper code itself already had `item.promotionId` references (in surrounding code), but at runtime the field came back `undefined`. WU2 added the select field so the column-derived discriminator can read it.
3. **`isBuyXGetYReward()` is column-derived (not stored):** the discriminator reads `promotionId`, `discountAmountCents`, `prePriceCentsBeforeDiscount`, `unitPriceCents`. Unreachable by the per-unit `applyDiscount` path because that path enforces `unitPrice < prePrice` by ≥1 (the `baseline - discountAmountCents < 1` guard at sale-item.entity.ts:267). This is what makes the representation coexist with the existing PD path without an extra column or enum value.

## Batch 2 — Engine pass + recompute (WU3 + WU4) — RESUMED after dead-agent handoff

> **Resume context.** A prior apply agent started Batch 2 (WU3) but
> died before verifying or committing. Unverified draft left in the
> working tree:
>   - NEW untracked spec `pos-evaluate-promotions.buy-x-get-y.spec.ts` (643 lines)
>   - MODIFIED uncommitted `pos-evaluate-promotions.port.ts` (+50) and `pos-evaluate-promotions.use-case.ts` (+257)
> This apply agent **SALVAGED** the draft after validation — every
> WU3 requirement was correctly implemented (gate, pass, comparator,
> short-circuit, discriminated union). The scratch `.tasks/batch2-plan.md`
> was removed (`rm -rf .tasks/`) as cleanup before any commit.

## WU3 — Engine pass with cross-type TOTAL-saving best-wins

- **RED spec:** `src/promotions/application/pos-evaluate-promotions.buy-x-get-y.spec.ts` — 16 tests across 5 suites:
  - **Gate** (4): PRODUCTS / VARIANTS / CATEGORIES / BRANDS admitted into the per-line candidate set.
  - **Counting** (6): one full N+M group (qty 3, R=500), multi-group (qty 6, R=1000), qty<buyQuantity no-result, qty<N+M zero reward, non-matching line no-result, `Math.round` rounding (qty 2 / 100c / 33%).
  - **Short-circuit** (1): AUTO BXGY skips `hasManualDiscount=true` (mirrors `pickBestPerLine :419`).
  - **Cross-type best-wins** (4): BXGY beats smaller PD (BXGY 1000c > PD total 600c), PD wins when PD total > BXGY (PD 1500c > BXGY 500c), genuine cross-type TIE → BXGY when id lower, genuine TIE → PD when PD id lower.
  - **Pass order** (1): post-line subtotal fed to ORDER_DISCOUNT reflects the BXGY saving (L1 3000-300 + L2 1000-100 = 3600c; 10% = 360c).
- **GREEN impl (2 source files):**
  - `src/promotions/application/ports/pos-evaluate-promotions.port.ts` — discriminated `PosEvalLineResult` union (`PosEvalPerUnitLineResult` with optional `kind?:'per-unit'` for back-compat + `PosEvalBuyXGetYLineResult` with `kind:'buy-x-get-y'`, `lineDiscountCents`, `perUnitRewardCents`, `discountedUnitCount`).
  - `src/promotions/application/pos-evaluate-promotions.use-case.ts`:
    - `isSupportedEngineType` gate admits BUY_X_GET_Y for `appliesTo ∈ {PRODUCTS, VARIANTS, CATEGORIES, BRANDS}`.
    - `evaluateBuyXGetYPass` runs AFTER the per-line PRODUCT_DISCOUNT best-wins pass and BEFORE the post-line-subtotal ORDER_DISCOUNT machinery, so `postLineSubtotalCents` already reflects the BXGY saving.
    - `pickBestBuyXGetYPerLine` mirrors `pickBestPerLine` for the gating layers (MANUAL opt-in/veto, `passesPromotionWideGates`, `matchTargetTier`, price-list, buyQuantity/getQuantity/getDiscountPercent null guards, `line.quantity >= buyQuantity` pre-gate, helper yield > 0). Ranks candidates by line-total `R` instead of per-unit; ties → lowest id.
    - **Cross-type TOTAL-saving comparator (Q5 REVISED — supersedes v1 per-unit basis):**
      ```
      pdPerUnitCents = computeAppliedDiscountCents(line, existingPd)  // per-unit
      pdTotalCents   = pdPerUnitCents * line.quantity                   // NEW ×qty
      bxgyTotalCents = bxgyWinner.lineDiscountCents                    // helper total R
      bxgy wins IFF bxgyTotalCents > pdTotalCents
        OR (bxgyTotalCents === pdTotalCents && bxgyWinner.id < existingPd.promotionId)
      ```
    - `computeAppliedDiscountCents` gains a leading `kind === 'buy-x-get-y' → return lineDiscountCents` branch so the ORDER_DISCOUNT base reflects the whole-line reward R.
- **Filtered test:** `pnpm run test -- pos-evaluate-promotions.buy-x-get-y.spec.ts` → 16/16 GREEN.
- **Regression sweep:** `pnpm run test -- pos-evaluate-promotions.use-case.spec.ts pos-evaluate-promotions-w4.spec.ts` → 58/58 GREEN (zero engine regression).

## WU4 — Recompute applies/clears BXGY idempotently

- **RED spec (4 new tests in `sales.service.spec.ts` under `Work Unit 4 BXGY`):**
  - **4.1 apply:** BXGY discriminator routes to `applyBuyXGetYReward` (not `applyDiscount`) — verifies `unitPriceCents === 1000` UNCHANGED, `prePriceCentsBeforeDiscount === 1000` (discriminator holds), `discountAmountCents === 1000` whole-line R, `discountValue === 500` per-unit snapshot, `isBuyXGetYReward() === true`.
  - **4.1 regression:** per-unit result keeps `applyDiscount` path UNCHANGED (10% off → unitPrice drops 1000→900, `isBuyXGetYReward() === false`).
  - **4.2 clear/re-apply:** pre-seeded draft with stale BXGY reward gets cleared and re-stamped with fresh state (discountTitle changes from "stale" to "fresh"; `isBuyXGetYReward()` still true).
  - **4.2 byte-equal convergence:** five consecutive recomputes on the same draft → byte-equal `unitPriceCents / prePriceCentsBeforeDiscount / discountAmountCents / discountValue / discountType / promotionId / subtotalCents / discountCents / totalCents`. Sanity: qty 6 × 1000c = 6000c subtotal; R=1000c; total=5000c.
- **GREEN impl (1 source file):**
  - `src/sales/sales.service.ts` — `recomputePromotions` apply-loop branches on `kind`:
    ```ts
    if (lineResult.kind === 'buy-x-get-y') {
      item.applyBuyXGetYReward({ lineDiscountCents, perUnitRewardCents,
        discountedUnitCount, discountTitle, promotionId });
      continue;
    }
    item.applyDiscount({ /* existing per-unit shape */ });
    ```
    The clear loop above (`removeDiscount()` on `promotionId != null` items) already handles BXGY lines — for BXGY the unit-price restore is a no-op (equal) and the field reset lets `applyBuyXGetYReward` stamp fresh state. Byte-equal convergence holds by design (BXGY never mutates `unitPriceCents`).
- **Filtered test:** `pnpm run test -- sales.service.spec.ts -t "Work Unit 4 BXGY"` → 235/235 GREEN.
- **Regression sweep:** `pnpm run test -- sales.service.spec.ts pos-evaluate-promotions.use-case.spec.ts pos-evaluate-promotions-w4.spec.ts pos-evaluate-promotions.buy-x-get-y.spec.ts sale-item.entity.spec.ts sale.entity.spec.ts prisma-sale.repository.spec.ts` → 512/512 GREEN across 7 spec files.

## Decisions / discoveries worth remembering (Batch 2)

1. **Resume salvage pattern — UNVERIFIED DRAFT validation:** when an apply agent dies mid-WU, the working tree carries uncommitted code that MUST be validated against the design + spec before any commit. The inherited WU3 draft was *complete and correct* on the first validation pass (gate, pass, comparator, short-circuit all aligned with design v2 Decisions 3+4) — salvaging it saved a full re-write. The diagnostic pattern is: (a) read the diff, (b) cross-check every requirement against design.md + spec.md, (c) run the filtered test, (d) only commit after GREEN + design alignment. The dead agent did the RED+GREEN correctly; the failure was in *verification + commit*, not in the code itself.
2. **`evaluate()` ordering invariant:** the BXGY pass runs at index 3b, strictly between per-line PD best-wins (3) and the post-line-subtotal computation (4). This is load-bearing for `spec.md:34-37` — the ORDER_DISCOUNT base MUST reflect the BXGY saving. Any future refactor that moves this pass without preserving the ordering would silently break the cross-type comparison's downstream effect on order-level discounts.
3. **`addItem` stacks same-product+variant onto an existing item:** the WU4 5x byte-equal test seeded with `buildFreshDraftWithItem` (qty 6 pre-populated) caused `addItem` to STACK onto the existing item → qty 12 → wrong arithmetic. The fix is to seed `findById` with an EMPTY draft `Sale.create(...)` and let `addItem` add the only item at the spec's quantity. **LESSON: when testing recompute idempotency, never pre-populate the draft with the same product the service will add — `addItem`'s stacking behavior inflates the qty and breaks byte-equal assertions.**
4. **Discriminated routing is a TYPESCRIPT NARROWING CONTRACT, not just a runtime check:** the `if (lineResult.kind === 'buy-x-get-y') { item.applyBuyXGetYReward({...}) }` branch is the *only* way `applyBuyXGetYReward` ever runs in production. The per-unit branch (`else`) calls `applyDiscount({...})` with the existing literal shape — the lack of `kind` discriminator on those results defaults to `'per-unit'` (the optional `kind?: 'per-unit'` field on `PosEvalPerUnitLineResult`). Any future engine code that emits a per-unit result MUST NOT stamp `kind:'buy-x-get-y'` — TypeScript's tagged union narrowing catches this at compile time.

## Next batch (Batch 3)

`apply` for WU5 + WU6 + WU7:
- **WU5:** `feat(promotions): require BXGY targets and allow BXGY 100 percent` — entity type-aware `validateGetDiscountPercent(value, type)` (100 for BXGY, 99 for ADVANCED), DTO `@Max(99)→@Max(100)`, `assertBuyXGetYTargeted` on create+update (create beside `:124`, update beside `:220`), `INVALID_TARGET (400)` contract. Invert `promotion.entity.spec.ts:216` (currently asserts `getDiscountPercent:100` THROWS for BUY_X_GET_Y → ACCEPT) + ADD ADVANCED=100 rejection test.
- **WU6:** `feat(promotions): expose MANUAL BXGY and retain valid opt-ins` — candidate mapper (`:258-261`) `BUY_X_GET_Y → 'BUY_X_GET_Y'`, port union (`port.ts:93`) `type` += `'BUY_X_GET_Y'`, self-heal loop (`:326`) retain opt-in BXGY IFF `matchTargetTier(...) !== null`, response DTO (`list-applicable-promotions-response.dto.ts:16`) union += `'BUY_X_GET_Y'`. Needs WU3 — landed.
- **WU7:** `test(promotions): complete BXGY integration sweep` — required spec.md edits (Q5 tie re-lock, new genuine cross-type tie scenario, 99→100 type-aware prose, INVALID_TARGET update-time scenario), full integration sweep on one seeded tenant, `prisma migrate diff` empty. Needs WU1–WU6.

Filter pattern stays the same; full-suite anti-hang rule applies.
