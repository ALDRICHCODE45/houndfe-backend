# Design: Advanced Promotion Type (POS Engine Activation)

## Technical Approach

Reuse the proven BXGY reward rail. Add one side-aware matcher change, one pure cross-line helper, one new `evaluate()` pass, and one additive persisted discriminator. All seams below are line-verified against current source (exploration was accurate; `SaleItem.toResponse` is `:456-518`, not `:512`).

## Architecture Decisions

| # | Decision | Choice | Rationale (alternative rejected) |
|---|----------|--------|-----------|
| 1 | Side threading | Add `side` **parameter** to `matchTargetTier` | One change turns DEFAULT matcher into BUY/GET; rejected duplicating the 4-tier ladder. |
| 2 | Reward math | New **pure** `computeAdvancedReward` per GET line | Unit-testable, mirrors `computeBuyXGetYReward:73-100`; rejected inlining in the pass. |
| 3 | Result shape | **New `kind:'advanced'`** union member | Honest provenance (cross-line source); the union was built to grow. Rejected reusing `buy-x-get-y` (conflates + silent default-field footgun). |
| 4 | Wire discriminator | **Persisted enum column** on `SaleItem` | Rail is byte-identical to BXGY at persistence (`isBuyXGetYReward` + mapper `:1420-1424` share one predicate); derivation cannot distinguish. |
| 5 | Best-wins | `lineTotalSavingCents` normalizer, 3-way max | Extends comparator `:900-905`; ties→lowest id. |

## Data Flow

```
evaluate():  pickBestPerLine(PD) :258 → evaluateBuyXGetYPass :283
             → evaluateAdvancedPass (NEW, :284) → pickBestOrderPromo :304

evaluateAdvancedPass (per AUTOMATIC ADVANCED candidate):
  BUY lines ──Σ matchTargetTier(items,line,'BUY')──▶ totalBuyMatchedQty  (D1)
  computeAdvancedReward ─▶ rewardGroupCount=floor(qty/buyQuantity)       (D2)
  GET lines ──matchTargetTier(items,line,'GET')──▶ per-line reward, best-wins (D5)
  emit PosEvalAdvancedLineResult ─▶ recompute ─▶ applyBuyXGetYReward(rewardKind:'advanced')
```

Intake guarantees BUY/GET entities disjoint (D7), so no cart line matches both sides — the engine needs no partition logic.

## Interfaces / Contracts

```typescript
// 1. Side-aware matcher (:136). DEFAULT preserved byte-for-byte.
matchTargetTier(items, line, side: 'DEFAULT' | 'BUY' | 'GET' = 'DEFAULT'): LineMatchTier
// replaces hardcoded `const side = 'DEFAULT'` (:145) with the param.

// 2. Pure helper (mirrors computeBuyXGetYReward). Allocates rewardGroupCount*getQuantity
//    GET units across candidate lines sorted by itemId asc (deterministic → idempotent).
computeAdvancedReward(input: {
  totalBuyMatchedQty: number; buyQuantity: number; getQuantity: number;
  getDiscountPercent: number;                       // 0..100 (D3)
  getCandidateLines: ReadonlyArray<{ itemId: string; effectiveUnitPriceCents: number; quantity: number }>;
}): { rewardGroupCount: number; rewards: Array<{
  itemId: string; discountedUnitCount: number;
  perUnitRewardCents: number;                        // Math.round(eff*pct/100)
  lineDiscountCents: number; }>; }

// 3. New result (port). Union += PosEvalAdvancedLineResult.
interface PosEvalAdvancedLineResult { kind: 'advanced'; itemId; promotionId;
  discountTitle; lineDiscountCents; perUnitRewardCents; discountedUnitCount; getDiscountPercent }

// 4. Reuse the rail — extend input; entity persists _rewardKind.
interface ApplyBuyXGetYRewardInput { /* ...existing... */ rewardKind?: 'buy_x_get_y' | 'advanced' } // default 'buy_x_get_y'
```

## File Changes

| File | Action | Change |
|------|--------|--------|
| `pos-evaluate-promotions.use-case.ts` | Modify | `matchTargetTier` side param (:136/145); admit ADVANCED in `isSupportedEngineType` (:579, gate on `buy/getTargetType`); `computeAdvancedReward`; `evaluateAdvancedPass` (:284); `computeAppliedDiscountCents` (:1060) `advanced`→`lineDiscountCents` (ORDER base). |
| `ports/pos-evaluate-promotions.port.ts` | Modify | Add `PosEvalAdvancedLineResult`; extend union (:132). |
| `match-target-tier.spec.ts` | Modify | Rewrite `:269-284` to side-aware. |
| `sale-item.entity.ts` | Modify | `ApplyBuyXGetYRewardInput.rewardKind` (:68); store `_rewardKind` in `applyBuyXGetYReward` (:362); emit persisted kind in `toResponse` (:512); clear in `clearDiscountFields`. |
| `sales.service.ts` | Modify | Route `kind:'advanced'` (:515) → `applyBuyXGetYReward({...,rewardKind:'advanced'})`. |
| `prisma-sale.repository.ts` | Modify | Receipt mapper (:1420-1459) reads persisted `rewardKind`; persist on save. |
| `promotion.entity.ts` | Modify | **D3**: `:184` `const max = 100` (both types; `>100` rejected). |
| `promotions.service.ts` | Modify | **D7**: disjoint check in `assertAdvancedSideTargets` (:598), code `advanced_overlapping_targets`. |
| `prisma/schema.prisma` + migration | Create | `enum SaleItemRewardKind { BUY_X_GET_Y ADVANCED }`, nullable `rewardKind` on `SaleItem` (:728). |

## Testing Strategy (Strict TDD — RED first)

| Order | File | Layer |
|-------|------|-------|
| 1 | `match-target-tier.spec.ts` (rewrite `:269-284`) | side-aware unit |
| 2 | `pos-evaluate-promotions.advanced-helper.spec.ts` (NEW) | pure: 1-group, S2 multi, 0-group, 100% free, rounding |
| 3 | `promotion.entity.spec.ts` (D3: 100 ok, 101 reject) | entity |
| 4 | `promotions-validate-side-disjoint.spec.ts` (NEW, S3) | intake D7 |
| 5 | `pos-evaluate-promotions.advanced.spec.ts` (NEW) | pass: gate, D1, D5, S4 |
| 6 | `sale-item.entity.spec.ts` + `sales.service.spec.ts` | `rewardKind='advanced'`, idempotent 5× |
| 7 | `prisma-sale.repository.spec.ts` | mapper |
| 8 | `advanced-promotion-type.integration.spec.ts` (NEW, :5433) | S1–S5 e2e |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Change is engine logic + one additive DB migration.

## Migration / Rollout

Additive (mirrors `20260714204955_add_reward_discount_percent`): `CREATE TYPE "SaleItemRewardKind"`; `ALTER TABLE "sale_items" ADD COLUMN "rewardKind" "SaleItemRewardKind"` (nullable). Backfill existing reward rows: `UPDATE sale_items SET "rewardKind"='BUY_X_GET_Y' WHERE "promotionId" IS NOT NULL AND "prePriceCentsBeforeDiscount"="unitPriceCents" AND "discountAmountCents">0` (all reward-shaped rows today are BXGY — ADVANCED is engine-rejected). `prisma migrate diff` expects zero drift outside this migration. Reversible by dropping column + type.

## Open Questions

- [ ] None blocking. Multi-GET-line allocation uses deterministic lowest-`itemId` order (spec scenarios are single-GET-line); confirm in sdd-tasks if merchants need cheapest-first.
