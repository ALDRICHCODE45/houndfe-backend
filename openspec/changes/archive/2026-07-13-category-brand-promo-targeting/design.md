# Design: Activate CATEGORIES & BRANDS Targeting in the POS Promotion Engine

## Technical Approach

Open the gate for `CATEGORIES`/`BRANDS` in the POS engine (`pos-evaluate-promotions.use-case.ts`) by (a) widening `matchTargetTier` to compare a line's resolved `categoryId`/`brandId` against DEFAULT-side targets, (b) widening the tier unions, (c) generalizing the binary VARIANT-wins pre-pass into an **ordinal "most-specific tier present wins"** rule, and (d) plumbing `categoryId`/`brandId` onto each `PosEvalLine` via a new tenant-scoped batch resolver called once in `buildPosEvalInput`. Product category/brand are resolved live at eval time — no `SaleItem` snapshot, no migration. Cart engine untouched.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|----------|--------|----------|-----------|
| Precedence model | Ordinal specificity: `VARIANT=3, PRODUCT=2, BRAND=1, CATEGORY=1`; keep only candidates at the max present ordinal, then best-wins | Strict 4-tier `V>P>B>C` | BRAND/CATEGORY are equal-broad peers (both single-valued scalars); no inherent narrower — peers by decision #1 |
| Data source | Resolve live in `buildPosEvalInput` via new resolver | `SaleItem` snapshot columns + backfill | Migration-free, live semantics; predecessor's snapshot claim was wrong (decision #3) |
| Resolver scope | Tenant-scoped (`tenantPrisma.getClient().product`) | Global prisma | `Product` has `tenantId`; clone of `resolvePriceListGlobalIds` |
| Validation scope | Keep GLOBAL (`this.prisma.category/brand`) — no change | Tenant-scope it | `Category`/`Brand` have no `tenantId` (decision #5) — VALIDATION is global, RESOLUTION is tenant-scoped; distinct facts |
| Match helper shape | Widen the `line` param to `{ productId; variantId; categoryId?; brandId? }` | New helper | Single DRY matcher; unset fields → new branches return null (back-compat) |

## Data Flow

    SalesService.buildPosEvalInput
      ├─ distinct productIds ──→ ProductsService.resolveProductCategoryBrandIds  (tenant, 1× IN(...))
      │                              └─ Map<productId,{categoryId,brandId}>
      └─ stamp categoryId/brandId per line ──→ PosEvalLine
                                                   │
                          PosEvaluatePromotionsUseCase.pickBestPerLine
                             ├─ matchTargetTier(targetItems, line) → tier ordinal
                             └─ precedence pre-pass (max ordinal present) → best-wins

Validation path (unchanged, separate concern): `promotions.service.ts` → `validateTargetIds` → GLOBAL `this.prisma.category/brand`.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Modify | Gate flip (:342-349); CATEGORIES/BRANDS branches in `matchTargetTier` (:76-105); widen `LineMatchTier` (:65) + `PerLineCandidate.tier` (:136); ordinal pre-pass (:412-423) |
| `src/promotions/application/ports/pos-evaluate-promotions.port.ts` | Modify | Add `categoryId: string \| null`, `brandId: string \| null` to `PosEvalLine` (:28-41) |
| `src/products/products.service.ts` | Modify | New `resolveProductCategoryBrandIds` (clone of `resolvePriceListGlobalIds` :2463-2480) |
| `src/sales/sales.service.ts` | Modify | Wire resolver into `buildPosEvalInput` (:591-628); stamp lines |
| `openspec/specs/pos-promotion-engine/spec.md` | Delta | Un-defer :113-128; add precedence + null-guard scenarios |

## Interfaces / Contracts

```ts
// port — PosEvalLine gains:
categoryId: string | null;
brandId: string | null;

// use-case unions:
export type LineMatchTier = 'VARIANT' | 'PRODUCT' | 'BRAND' | 'CATEGORY' | null;
interface PerLineCandidate { /* ... */ tier: 'VARIANT' | 'PRODUCT' | 'BRAND' | 'CATEGORY'; }

// matchTargetTier line param widens to:
//   { productId: string; variantId: string | null;
//     categoryId?: string | null; brandId?: string | null }
// New branches (after PRODUCTS), each null-guarded like variantId (:84):
//   if (line.categoryId != null && some(DEFAULT, 'CATEGORIES', id === categoryId)) return 'CATEGORY';
//   if (line.brandId    != null && some(DEFAULT, 'BRANDS',     id === brandId))    return 'BRAND';
// Branch order encodes fallthrough: VARIANT → PRODUCT → {BRAND, CATEGORY}.

// tier→ordinal for the pre-pass:
//   VARIANT=3, PRODUCT=2, BRAND=1, CATEGORY=1
```

```ts
// ProductsService — tenant-scoped, N+1-safe, missing ids omitted, null preserved:
async resolveProductCategoryBrandIds(
  productIds: ReadonlyArray<string>,
): Promise<Map<string, { categoryId: string | null; brandId: string | null }>>
// distinct → one this.tenantPrisma.getClient().product.findMany({
//   where: { id: { in: distinct } },
//   select: { id: true, categoryId: true, brandId: true } })
```

### Ordinal pre-pass — zero-regression argument

Replace `hasVariantTier ? filter(VARIANT) : eligible` with: compute `maxOrd = max(ORD[c.tier])` over eligible, keep `c` where `ORD[c.tier] === maxOrd`, then `pickBestByMaxDiscountThenLowestId`. For inputs containing only VARIANT/PRODUCT tiers, `maxOrd` is 3 iff any VARIANT exists (keeps only VARIANTs — identical to old `hasVariantTier` branch), else 2 (keeps all PRODUCTs — identical to the `else` branch). Thus the generalization is **provably equivalent** on the pre-existing tier set; best-wins tiebreak is unchanged. BRAND(1)≡CATEGORY(1) share an ordinal, so when neither VARIANT nor PRODUCT is present both survive and compete on best-wins — exactly decision #1.

## Testing Strategy (strict TDD — RED first)

| Layer | Suite | RED assertion (currently null/false → flips) |
|-------|-------|----------------------------------------------|
| Unit | `match-target-tier.spec.ts` | CATEGORIES target + `line.categoryId==='CAT1'` → `'CATEGORY'` (today null :113-128); BRANDS → `'BRAND'` |
| Unit | `match-target-tier.spec.ts` | null-guard: `line.categoryId===null` + CATEGORIES target → null; same for brand |
| Unit | new `pos-evaluate-promotions-precedence.spec.ts` | 4-tier: V beats P beats {B,C}; 3-tier P beats {B,C}; 2-tier B≡C → best-wins by discount then lowest id; **existing VARIANTS/PRODUCTS-only fixtures unchanged** |
| Unit | `pos-evaluate-promotions-w4.spec.ts` (or new) | `isSupportedEngineType` true for PRODUCT_DISCOUNT+CATEGORIES/BRANDS; self-heal `targetableManualPromotionIds` includes a CATEGORIES/BRANDS MANUAL promo with a matching line |
| Unit | new `resolve-product-category-brand-ids.spec.ts` (clone `resolve-price-list-global-ids.spec.ts`) | distinct → 1 call; empty → no DB call; missing id omitted; null category/brand preserved; asserts `tenantPrisma.getClient` used |
| Unit | `sales.service` spec | `buildPosEvalInput` calls resolver once and stamps `categoryId`/`brandId` per line |
| Integration | seeded-tenant spec | CATEGORIES promo applies only to lines in that category; `product.categoryId=null` never matches; VARIANTS beats same-line BRANDS/CATEGORIES |

### Work-unit ordering
1. Port field add + `matchTargetTier` branches + null guards (RED: match-target-tier).
2. Union widening + ordinal pre-pass + gate flip (RED: precedence + w4 self-heal; assert VARIANTS/PRODUCTS fixtures still green).
3. `resolveProductCategoryBrandIds` (RED: resolver spec).
4. `buildPosEvalInput` wiring (RED: sales.service spec).
5. Integration on seeded tenant + spec delta un-defer.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Pure in-process matching + one tenant-scoped read.

## Migration / Rollout

No migration required. `PosEvalLine` fields and the resolver read existing `Product.categoryId`/`brandId` columns. `prisma migrate diff` against current schema MUST stay empty — verify in the integration/CI step. Rollback = revert commit(s); promos degrade to "not eligible" as today.

## Open Questions

None — all five decisions locked.
