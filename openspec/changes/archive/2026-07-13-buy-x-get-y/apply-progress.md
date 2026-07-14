# Apply Progress — buy-x-get-y (WU1 + WU2 + WU3 + WU4 + WU5 + WU6 + WU7)

## Status: ok — All 7 work units committed on `feat/buy-x-get-y` (batches 1+2+3)

Branch `feat/buy-x-get-y` from clean `main`. Seven work units committed
in order; each commit is RED→GREEN with filtered Jest only (anti-hang
rule observed throughout). No PRs, no merge to main. Zero-migration
invariant verified — `prisma migrate diff` is empty.

## Commits (on `feat/buy-x-get-y`)

| Hash | Subject | Lines |
|---|---|---|
| `71bebe0` | chore(promotions): SDD planning artifacts for buy-x-get-y | 5 files / +1103 |
| `b89fc82` | feat(promotions): add pure computeBuyXGetYReward helper | 2 files / +296 |
| `2a44cc6` | feat(sales): add BXGY line reward and NET readers | 7 files / +948 / −24 |
| `b81565b` | docs(promotions): apply-progress for buy-x-get-y batch 1 (WU1+WU2) | 1 file / +62 |
| `dde0489` | feat(promotions): evaluate BXGY with total-saving best-wins | 3 files / +949 / −1 |
| `f78d324` | feat(sales): recompute BXGY rewards idempotently | 2 files / +427 |
| `84bf463` | docs(promotions): apply-progress for buy-x-get-y batch 2 | 1 file / +141 |
| `6580341` | feat(promotions): require BXGY targets and allow BXGY 100 percent | 6 files / +159 / −16 |
| `9551c4e` | feat(promotions): expose MANUAL BXGY and retain valid opt-ins | 5 files / +426 / −39 |
| `d670406` | test(promotions): complete BXGY integration sweep | 1 file / +1206 |

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

## Batch 3 — Final validation, MANUAL wiring, and integration (WU5 + WU6 + WU7) — RESUMED after dead-agent suspend

> **Resume context.** A prior apply agent started Batch 3 (WU5) but the
> machine suspended mid-run before any commit. Unverified draft left
> in the working tree:
>   - MODIFIED `src/promotions/domain/promotion.entity.ts` (+12),
>     `src/promotions/dto/create-promotion.dto.ts` (+1),
>     `src/promotions/promotions.service.ts` (+33),
>     `src/promotions/domain/promotion.entity.spec.ts` (+12),
>     `src/promotions/promotions.service.spec.ts` (+58)
>   - NEW `src/promotions/dto/create-promotion.dto.spec.ts` (+43)
>   - ALSO modified (prematurely): `apply-progress.md` and `tasks.md`
>     had WU5 checkboxes ticked before any commit landed.
> This apply agent **SALVAGED** the WU5 draft after validation —
> every WU5 requirement was correctly implemented (type-aware 100%
> cap, DTO `@Max(100)`, `assertBuyXGetYTargeted` on create+update,
> inverted entity spec, ADVANCED=100 rejection, `INVALID_TARGET`
> service tests). The premature docs edits were temporarily stashed
> via `git stash push -- openspec/changes/buy-x-get-y/{apply-progress,tasks}.md`
> before the WU5 commit, then restored and properly merged here.

### WU5 — Targeting requirement and type-aware 100% validation

- **RED:** inverted the BUY_X_GET_Y 100% entity boundary at `promotion.entity.spec.ts:216`
  (was `expect(...).toThrow(InvalidArgumentError)` for `getDiscountPercent: 100`,
  now `expect(promo.getDiscountPercent).toBe(100)` — `should allow getDiscountPercent = 100 for BUY_X_GET_Y`).
  Added the ADVANCED=100 rejection test (`should reject getDiscountPercent = 100 for ADVANCED`).
  Created `create-promotion.dto.spec.ts` with BXGY 100% ACCEPT and BXGY 101% REJECT cases.
  Added create/update `INVALID_TARGET` cases to `promotions.service.spec.ts`. The update case
  also proves a rejected target clear does NOT mutate the in-memory aggregate or call `repo.save`.
- **GREEN (4 source files):**
  - `src/promotions/domain/promotion.entity.ts` — `validateGetDiscountPercent(value, type)`
    gained a `type` parameter; max is **100** for `BUY_X_GET_Y`, **99** for `ADVANCED`.
    Error message is per-branch: `getDiscountPercent must be between 0 and ${max} for ${type} type`.
    Call sites `:474` (BXGY) and `:497` (ADVANCED) pass the type literal.
  - `src/promotions/dto/create-promotion.dto.ts:156` — `@Max(99)` → `@Max(100)`.
    The shared DTO bound is loosened to 100; the type-aware entity rule enforces the
    ADVANCED ≤ 99 invariant downstream (no leak into the ADVANCED path).
  - `src/promotions/promotions.service.ts` — `assertBuyXGetYTargeted` private method
    added. Called BOTH on create (beside `:124`, after `targetItems` is set) AND on
    update (after `:208` target resolution, BEFORE the in-memory aggregate is mutated
    at `:215+`). On the update path, the existing scalar assignment is the LAST thing
    that runs — throwing from `assertBuyXGetYTargeted` short-circuits the entire
    mutation sequence, so no `repo.save` fires and the row stays untouched.
- **`SaleItem.applyDiscount` UNTOUCHED** — verified via `git diff` (no edits to
  `src/sales/domain/sale-item.entity.ts`). The 1..99 percentage clamp and the
  `baseline−discount≥1` invariant at `:267` remain the PRODUCT_DISCOUNT path.
  The BXGY path bypasses `applyDiscount` via `applyBuyXGetYReward` (WU2).
- **Filtered test:** `pnpm run test -- promotion.entity.spec.ts create-promotion.dto.spec.ts promotions.service.spec.ts -t "BUY_X_GET_Y|ADVANCED"` → **8 suites / 175 tests GREEN**. The repository Jest wrapper treated the trailing `-t` tokens as path patterns and included 5 additional matching suites (build-sale-timeline, match-target-tier, promotion-target-variants, public-tenant.guard, employee-time-off.service) — still filtered, never full-suite.

### WU6 — MANUAL BXGY wiring (Decision 7 — 4 sites)

- **RED:** extended `pos-evaluate-promotions.buy-x-get-y.spec.ts` with a new
  `BUY_X_GET_Y MANUAL wiring (WU6, spec.md:108-130)` describe block (4 tests):
  - **M-2:** MANUAL BXGY with a matching line appears in `availableManualPromotions`
    with `type: 'BUY_X_GET_Y'` and `method: 'MANUAL'`.
  - **M-3:** opted-in MANUAL BXGY with a matching line → applied AND retained
    in `targetableManualPromotionIds`.
  - **self-heal:** opted-in MANUAL BXGY with NO matching line drops out of
    `targetableManualPromotionIds` (target gone → resurrection-bug fix).
  - **no-match candidate:** MANUAL BXGY with no matching line stays out of
    `availableManualPromotions`.
  Extended `sales.service.spec.ts` with a `Work Unit 6 BXGY` describe block:
  - **listApplicablePromotions** surfaces MANUAL BXGY with type `BUY_X_GET_Y`.
  - **opted-in MANUAL BXGY survives two consecutive recomputes** (spec.md:127-130) —
    pre-seeded draft with `optedInManualPromotionIds: ['promo-bxgy-manual']`,
    two `recomputePromotions` calls (via `addItem` then `updateItemQuantity`),
    assert BXGY reward applied on both runs and opt-in retained.
- **GREEN (4 source files):**
  - `src/promotions/application/ports/pos-evaluate-promotions.port.ts` — `PosEvalManualCandidate.type`
    union extended: `'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT' | 'BUY_X_GET_Y'`.
  - `src/promotions/application/pos-evaluate-promotions.use-case.ts` — `availableManualPromotions`
    mapper now classifies by `promo.type` and emits `BUY_X_GET_Y` for BXGY; the
    `ORDER_DISCOUNT` branch always surfaces, `PRODUCT_DISCOUNT` and `BUY_X_GET_Y`
    branches only surface when at least one line in the cart matches
    `matchTargetTier(...)`. The self-heal loop (targetableManualPromotionIds)
    was extended to retain opted-in BXGY IFF `matchTargetTier(...) !== null` on
    some line — symmetric to PRODUCT_DISCOUNT. Comments updated to reflect the
    new BXGY retention semantics.
  - `src/sales/dto/list-applicable-promotions-response.dto.ts` — `ApplicableManualPromotionDto.type`
    union extended: `'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT' | 'BUY_X_GET_Y'`.
- **Filtered test:** `pnpm run test -- pos-evaluate-promotions.buy-x-get-y.spec.ts sales.service.spec.ts -t "BUY_X_GET_Y"` → **7 suites / 257 tests GREEN** (the -t pattern included 5 additional matching suites as before).

### WU7 — Integration sweep (18 scenarios on one seeded tenant)

- **RED→GREEN:** created `src/promotions/buy-x-get-y.integration.spec.ts` — single
  file covering all 18 scenarios from spec.md on the baseline tenant
  (`nest-practice-test` on port 5433). Each `describe` block maps to one or more
  scenarios:
  - **BW-1, BW-2a, BW-2b, BW-3** (4 tests) — cross-type TOTAL-saving best-wins +
    pass-order invariant + ORDER_DISCOUNT base reflects BXGY saving.
  - **T-1, T-2, T-3** (3 tests) — targeting-required create / update rejection /
    acceptance (real Prisma writes via `PromotionsService.create` + `update`).
  - **E-1, E-2, E-3, E-4** (4 tests) — eligibility + counting (qty < N → no result,
    qty < N+M → zero reward, one full group, multi-group).
  - **R-1, R-2** (2 tests) — `Math.round` rounding + non-matching line.
  - **F-1** (2 sub-tests) — `getDiscountPercent=100` accepted for BXGY (case A)
    and partial 50% uses same reward shape (case B).
  - **M-1, M-2, M-3, M-4** (4 tests) — AUTOMATIC auto-applies; MANUAL surfaces
    with type `BUY_X_GET_Y`; targetable retention; two-recompute survival.
  - **I-1** (1 test) — five concurrent `engine.evaluate()` calls produce
    byte-equal BXGY results (idempotency).
  Test helpers: `seedProduct`, `seedPromotion` (persists a Promotion +
  PromotionTargetItem rows directly so the test does not depend on
  `validateTargetIds`'s roundtrip for engine-only scenarios), `makeBxgy`,
  `makePd`, `id` (deterministic ids for readable failure output).
- **Integration test:** `pnpm run test:integration -- buy-x-get-y.integration.spec.ts` → **1 suite / 20 tests GREEN** (18 scenarios + F-1 has 2 sub-tests).
- **Migration diff:** `pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma` → **"No difference detected."** The BXGY reward rides the existing `discountType='amount'` + `discountAmountCents` columns with a column-derived discriminator; no schema/enum/migration change. Side note: had to run `prisma generate` once to refresh the Prisma client (the `manuallyEnded` migration was deployed but the generated client was stale — caught by the T-3 service.create path before any test runs).

### Decisions / discoveries worth remembering (Batch 3)

1. **WU5 type-aware 100% cap — defense-in-depth:** the entity now owns the type
   boundary (`validateGetDiscountPercent(value, type)`), the DTO only loosens the
   shared bound. A future refactor that splits the cap back to the DTO MUST restore
   the type param — otherwise ADVANCED could silently accept 100. **Locked invariant:**
   ADVANCED is capped at 99 by the entity, regardless of the DTO.
2. **WU5 update-time guard ordering matters:** `assertBuyXGetYTargeted` runs
   between target resolution (`:207-208`) and the in-memory aggregate mutation
   (`:215+`). Swapping the order — e.g. mutating first, then asserting — would
   persist a half-updated promotion row on a rejected request. The current
   ordering guarantees the WU5 update spec test passes: `existing.appliesTo`
   stays at `'PRODUCTS'` and `repo.save` is not called when the assertion throws.
3. **WU6 candidate mapper — matchTargetTier as the inclusion predicate:** a MANUAL
   BXGY with no matching line is silently filtered out of `availableManualPromotions`.
   This uses the SAME `matchTargetTier` predicate the per-line gate uses, so the
   candidate never references a target the engine can't apply to. If a future
   promotion type targets a tier the matcher doesn't recognize, the candidate
   would never surface — the engine would silently skip the line and the seller
   would never see the offer.
4. **WU6 self-heal target list — target presence, NOT best-wins outcome:**
   `targetableManualPromotionIds` retains opted-in BXGY IFF any cart line matches
   the target — precedence and best-wins ranking do NOT prune the opt-in. This is
   the same rule PRODUCT_DISCOUNT already followed; the WU6 change was symmetric.
   qty < buyQuantity and `hasManualDiscount` are "temporarily ineligible" — the
   opt-in is RETAINED across recomputes (subject to re-evaluation).
5. **WU7 Prisma client staleness — first-run trap:** running `pnpm run test:integration`
   on a fresh checkout where the migrations have been deployed but the Prisma client
   was NOT regenerated fails T-3 with `Unknown argument manuallyEnded`. The fix is
   a one-time `pnpm exec prisma generate` (the schema's `manuallyEnded Boolean @default(false)`
   column exists, but the generated client doesn't know about it). Add this to the
   on-boarding checklist for new devs. **NOT a WU7 bug** — pre-existing staleness.

### Closing

All 7 work units landed on `feat/buy-x-get-y` (10 commits including
the planning + 2 batch docs). Zero migration drift. Strict TDD
(RED→GREEN) with filtered Jest only — never the full suite. Next
step for the maintainer: locally merge to `main` and run `sdd-verify`
to confirm implementation matches spec.md and design.md before
`sdd-archive`.

---

## WU8 — Draft NET per-line subtotal + rewardKind wire contract

Front-end reported a contract gap: the DRAFT sale line did NOT expose a
NET per-line subtotal. The confirmed-sale `findOneWithRelations` mapper
already exposes `subtotalCents` (NET) and `rewardKind` (via
`prisma-sale.repository.ts:1407,1421-1422,1437`), but the
DRAFT path — `sale.toResponse()` in `src/sales/domain/sale.entity.ts:798`
which spreads `SaleItem.toResponse()` (`src/sales/domain/sale-item.entity.ts:427`) —
was missing both keys, so POS /wiz-pos rendered BXGY lines as gross.

**Change (additive only):** extended `SaleItem.toResponse()` with two
new keys, computed inline:

- `subtotalCents = unitPriceCents * quantity
   - (isBuyXGetYReward() ? (discountAmountCents ?? 0) : 0)`
- `rewardKind    = isBuyXGetYReward() ? 'buy_x_get_y' : null`

The existing `get subtotalCents()` at `:194-196` is intentionally
UNCHANGED — it returns gross by design (used by `previewTotals` and
other in-domain consumers). The new key is a separate wire-side field
that mirrors the confirmed-sale mapper exactly. `isBuyXGetYReward()`
(`sale-item.entity.ts:386-394`) is the existing column-derived
discriminator — no reimplementation.

**Typing / DTO wiring:** `toResponse()` returns an inferred object;
the only typed reference is `ReturnType<SaleItem['toResponse']>[]`
in `Sale.toResponse()` at `sale.entity.ts:819` and `DraftSaleResponse`
at `sale.repository.ts:47-50`. New keys propagate automatically
(no DTO/port edit needed, confirmed by green build).

**Tests (RED → GREEN):** 6 new cases appended to
`src/sales/domain/sale-item.entity.spec.ts` under a new
`toResponse() — Draft NET subtotalCents + rewardKind (WU8)` describe block:

- **BXGY 100% (one true-free get-unit):** unitPrice 20000, qty 2,
  lineDiscount 20000 → `subtotalCents = 20000` (NET) and
  `rewardKind = 'buy_x_get_y'`.
- **BXGY 50% partial:** qty 3 × 1000c, R=500c → `subtotalCents = 2500`
  and `rewardKind = 'buy_x_get_y'`.
- **Per-unit PRODUCT_DISCOUNT:** prePrice 1000 → unitPrice 900,
  qty 2 → `subtotalCents = 1800` (already NET, no subtraction)
  and `rewardKind = null`.
- **Manual free-form discount:** no `promotionId` → `rewardKind = null`,
  `subtotalCents = unitPrice × qty`.
- **Plain line (no discount):** `subtotalCents = unitPrice × qty`,
  `rewardKind = null`.
- **removeDiscount clears a BXGY reward:** after removal
  `rewardKind` flips back to `null` and `subtotalCents` returns to
  the un-discounted `unitPrice × qty` (3000c, gross = NET).

**Verification:**

- `pnpm run test -- sale-item.entity.spec.ts` → **56 / 56 GREEN**
  (50 prior + 6 new WU8 tests).
- `pnpm run test -- sales.service.spec.ts` → **179 / 179 GREEN**
  (regression net for the draft-path consumers; the inferred type
  change to the wire object propagates cleanly through `Sale.toResponse()`,
  `findDraftResponseById`, and every POS-facing call site).
- `pnpm run build` (full nest/tsc) → **EXIT 0** (no DTO/port interface
  edits required — the inline return type auto-extends).

**Decisions worth remembering:**

- The wire key is named `subtotalCents` on BOTH surfaces (DRAFT and
  confirmed) and is NET on both. Frontend uses one field.
- The in-domain `get subtotalCents()` getter REMAINS gross — it feeds
  `previewTotals()` and other PRE-DRAFT calculations where the
  discount-aware `Sale.previewTotals()` handles NET vs gross math
  correctly. Mixing the two would double-count.
- The new wire key on the DRAFT is computed at the line level (per-item
  NET), independent of `previewTotals()`'s order-discount-aware aggregate.
  This is intentional: a per-line wire field should not include the
  order-discount split; that's an aggregate concern.


