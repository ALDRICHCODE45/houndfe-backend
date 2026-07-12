# Design: Variant-Level Promotion Targeting (POS)

## Technical Approach

Approach A from exploration: add `VARIANTS` to `PromotionTargetType` and reuse the polymorphic `PromotionTargetItem` row (`targetType='VARIANTS'`, `targetId=variantId`). The engine input already carries `variantId` per line (`PosEvalLine.variantId`, populated at `sales.service.ts:614`), so no plumbing is added. The core work is: (1) a **single shared match helper** that both engine match sites call, encoding PRODUCTS/VARIANTS matching plus specificity; (2) a **precedence pre-pass** that, per line, drops PRODUCTS-target candidates when a VARIANTS-target candidate exists for that same line — so best-wins only ever ranks within the winning specificity tier; (3) a tenant-scoped `VARIANTS` branch in `validateTargetIds`; (4) an additive enum migration emitted as its own step. Modifies `PRODUCT_DISCOUNT Matches Target Items` (spec `:113-125`) and adds a precedence requirement.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Precedence placement | **Shared match helper + per-line precedence pre-pass** that filters candidates before best-wins | Inline precedence duplicated at each site | DRY: both sites (`:225-237`, `:328-334`) call ONE predicate; precedence is computed once per line and reused. Future online-cart engine (`evaluate-cart-promotions.use-case.ts`) can import the same pure helper. |
| Match helper shape | Pure module-level fn returning **match tier**, not a bare boolean | boolean-only match | The tier (`VARIANT` vs `PRODUCT`) is exactly the specificity signal the pre-pass needs; a boolean forces a second predicate pass. |
| Precedence vs best-wins | Precedence **filters the candidate set first**; best-wins (max discount, ties→lowest id) runs on the survivors | Add specificity as a tiebreaker inside best-wins | Keeps the documented best-wins invariant (`:374-389`) untouched; specificity is an orthogonal pre-filter, so "VARIANT wins regardless of discount value" holds unconditionally. |
| Enum migration | `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS'` as its **own migration**, no same-tx use | Add value + use in one migration | Postgres cannot use a freshly-added enum value in the same tx. Repo precedent: `20260623205337` adds `SaleStatus 'CANCELED'` standalone (value used 0 times in that file). Prisma migrate emits `ADD VALUE` alone — verify generated SQL, no manual edit expected. |
| VARIANTS validation client | `tenantClient.variant.findUnique/findMany` (tenant-scoped), symmetric with PRODUCTS | Global `this.prisma` | Variants are tenant-scoped (`Variant.tenantId`, `schema.prisma:456`); PRODUCTS already uses `tenantClient` (`:556`). CATEGORIES/BRANDS-on-global is intentionally NOT the template here. |

## Shared Match Helper (the DRY core)

```ts
// pos-evaluate-promotions.use-case.ts — module-level, exported for tests + reuse
export type LineMatchTier = 'VARIANT' | 'PRODUCT' | null;

export function matchTargetTier(
  targetItems: ReadonlyArray<{ side: string; targetType: string; targetId: string }>,
  line: { productId: string; variantId: string | null },
): LineMatchTier {
  const side = 'DEFAULT';
  if (line.variantId != null &&
      targetItems.some(ti => ti.side === side && ti.targetType === 'VARIANTS' && ti.targetId === line.variantId))
    return 'VARIANT';
  if (targetItems.some(ti => ti.side === side && ti.targetType === 'PRODUCTS' && ti.targetId === line.productId))
    return 'PRODUCT';
  return null;
}
```

Both sites replace their inline `.some(...)` with `matchTargetTier(promo.targetItems, line)`. A promo with BOTH a VARIANTS row and a PRODUCTS row that hit the same line reports `VARIANT` (self-consistent).

## Data Flow — one sale line

    line{productId, variantId}
        │
        ▼
    per-promo: matchTargetTier(promo.targetItems, line) → tier ∈ {VARIANT, PRODUCT, null}
        │   collect eligible = [{promo, tier, discountCents}]   (null tier dropped)
        ▼
    PRECEDENCE PRE-PASS (per line):
        if any eligible has tier==='VARIANT'
            → keep only tier==='VARIANT' candidates   (PRODUCT candidates dropped)
        else keep all (tier==='PRODUCT')
        ▼
    BEST-WINS on survivors: max discountCents, ties → lowest promotionId
        ▼
    applied line result (unchanged emit shape)

- **AUTOMATIC path** (`pickBestPerLine`, `:296-357`): full flow above; MANUAL-not-opted-in and vetoed still skipped first.
- **MANUAL opt-in path** (`targetableManualPromotionIds`, `:225-237`): uses `matchTargetTier(...) !== null` as the "has matching line" test. Self-heal RETAINS an opted-in VARIANTS promo iff a cart line still matches its variant — precedence does NOT prune opt-ins (retention is about target presence, not winning).

## File Changes

| File | Action | Description |
|---|---|---|
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Modify | Add exported `matchTargetTier`; call it at both sites; add per-line precedence pre-pass in `pickBestPerLine`; allow `appliesTo='VARIANTS'` in `isSupportedEngineType`. |
| `src/promotions/domain/promotion.entity.ts:15` | Modify | `PromotionTargetType` union gains `'VARIANTS'`. |
| `src/promotions/dto/create-promotion.dto.ts:35-39` | Modify | `PromotionTargetTypeEnum.VARIANTS`; `TargetItemDto` accepts it (no shape change). |
| `src/promotions/promotions.service.ts:528-580` | Modify | `case 'VARIANTS'` → `tenantClient.variant.findMany`; entity name `'Variant'` in the not-found error. |
| `prisma/schema.prisma:89-93` | Modify | `VARIANTS` enum value. |
| `prisma/migrations/<ts>_promotion_target_variants/migration.sql` | Create | `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';` standalone. |
| `openspec/specs/pos-promotion-engine/spec.md:113-125` | Modify | Delta: match rule + new precedence requirement. |

## Interfaces / Contracts

`matchTargetTier` (above) is the only new contract. `TargetItemDto` and `PromotionTargetItem` row shape are unchanged (`targetId` carries the variant uuid). `@@unique([promotionId, side, targetType, targetId])` and `@@index([targetType, targetId])` (`schema.prisma:1120-1135`) already serve variant lookups — no key change.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `matchTargetTier` returns VARIANT/PRODUCT/null; null variantId never matches VARIANTS | Table-driven spec on exported fn |
| Unit | Precedence: VARIANTS wins over PRODUCTS on same line even when PRODUCTS discount is larger | `pos-evaluate-promotions.use-case.spec.ts` scenario |
| Unit | PRODUCTS target still hits sibling variants (back-compat) | Two-variant line set, product-only promo |
| Unit | MANUAL opted-in VARIANTS promo survives recompute (self-heal) | `targetableManualPromotionIds` scenario |
| Integration | `validateTargetIds` rejects cross-tenant / non-existent variant id; accepts valid | `promotions.service` spec with tenant client |
| Migration | `ADD VALUE` applies + rolls back on populated DB | manual `prisma migrate` check |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. This is in-process engine + additive schema only.

## Migration / Rollout

Single additive migration; zero data migration. `down` reverts code only (enum value is harmless if left). Verify generated SQL contains ONLY the `ADD VALUE` statement (no same-migration consumer). Deploy engine + DTO + migration together in one PR (~220-280 lines, within 400-line budget).

## Open Questions

- [ ] None blocking. **Landing-order note (not a dependency)**: independent open bug #2911 (`sales/manual-promo-still-autoapplies-on-additem`) touches the same MANUAL `pickBestPerLine` branch — land/verify it first to avoid noisy MANUAL test signal, but it does not gate this design.
