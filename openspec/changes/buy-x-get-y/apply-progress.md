# Apply Progress — buy-x-get-y (WU1 + WU2)

## Status: ok — Batch 1 complete

Branch `feat/buy-x-get-y` from clean `main`. Two work units committed
in order; each commit is RED→GREEN with filtered Jest only (anti-hang
rule observed throughout). No PRs, no merge to main.

## Commits (on `feat/buy-x-get-y`)

| Hash | Subject | Lines |
|---|---|---|
| `71bebe0` | chore(promotions): SDD planning artifacts for buy-x-get-y | 5 files / +1103 |
| `b89fc82` | feat(promotions): add pure computeBuyXGetYReward helper | 2 files / +296 |
| `2a44cc6` | feat(sales): add BXGY line reward and NET readers | 7 files / +948 / −24 |

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

## Next batch (Batch 2)

`apply` for WU3 + WU4:
- **WU3:** `feat(promotions): evaluate BXGY with total-saving best-wins` — gate (isSupportedEngineType BXGY branch), per-line BXGY pass after per-line PD best-wins, comparator compares REAL per-line TOTAL savings (PD perUnit×qty vs BXGY R; ties → lowest id), `hasManualDiscount` short-circuit mirrored from `:419`, port discriminated `PosEvalLineResult`, mapper `type` enum union += BXGY, self-heal branch.
- **WU4:** `feat(sales): recompute BXGY rewards idempotently` — sales.service `recomputePromotions` apply-loop kind branch (BXGY → `applyBuyXGetYReward`, else `applyDiscount`), 5× byte-equal convergence.

Filter pattern stays the same; full-suite anti-hang rule applies.
