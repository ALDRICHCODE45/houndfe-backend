# Exploration: variant-level-promo-targeting

Add the ability to target a POS promotion at a **specific product variant**, instead of
only at the product (which today implicitly hits ALL of that product's variants).

**Scope:** backend + DB + domain only (engine match logic, promotion config/validation,
schema). Frontend and the deferred promo types (BUY_X_GET_Y / ADVANCED / CATEGORIES /
BRANDS) are OUT of scope for this change.

> Line-number note: prior notes (engram #2905) and the task brief cite
> `pos-evaluate-promotions.use-case.ts:244-248`. That reference is **stale** — line 244 is
> now the `return` block. The real product-match sites in the current file are
> **225-237** (MANUAL self-heal) and **328-334** (per-line best-wins). Cited accurately below.

---

## Current State

### Targeting is product-level only — and it lives in TWO match sites, not one

The POS engine (`src/promotions/application/pos-evaluate-promotions.use-case.ts`) matches a
`PRODUCT_DISCOUNT` line against a promotion's `targetItems` using **productId only**. This
same predicate appears in **two** places and BOTH must change together:

1. **Per-line best-wins** — `pickBestPerLine`, lines **328-334**:
   ```ts
   const targetsProduct = promo.targetItems.some(
     (ti) =>
       ti.side === 'DEFAULT' &&
       ti.targetType === 'PRODUCTS' &&
       ti.targetId === line.productId,   // <- productId, never variantId
   );
   ```
2. **MANUAL opt-in self-heal** — `targetableManualPromotionIds`, lines **225-237** (same
   predicate). This is the "resurrection-bug self-healer" added recently (Work Unit 7 /
   commit `b84aab7`). If it is NOT updated, an opted-in MANUAL promo that targets a variant
   would be treated as orphaned and pruned on recompute.

Gating helper `isSupportedEngineType` (lines **282-290**) additionally restricts
`PRODUCT_DISCOUNT` to `appliesTo === 'PRODUCTS'`; `CATEGORIES`/`BRANDS` are deferred.

### KEY INSIGHT — the engine input ALREADY carries `variantId`

No input plumbing is required. The line shape already has the field, populated end-to-end:

- Port: `PosEvalLine.variantId: string | null` — `application/ports/pos-evaluate-promotions.port.ts:31`.
- Builder: `buildPosEvalInput` sets `variantId: item.variantId` — `src/sales/sales.service.ts:614`.
- Source: `SaleItem.variantId String?` — `prisma/schema.prisma:710` (+ `Variant` relation :738).

So the only gap in the engine is that `variantId` is **received and then ignored** by the
match predicate.

### The documented spec only knows PRODUCTS / CATEGORIES / BRANDS

`openspec/specs/pos-promotion-engine/spec.md` → Requirement **"PRODUCT_DISCOUNT Matches
Target Items"** (lines 113-125): "`PRODUCTS` matches by productId; `CATEGORIES` by category
id; `BRANDS` by brand id." No VARIANT concept. This is the requirement the delta must
`MODIFY`, plus a new requirement for PRODUCT-vs-VARIANT precedence.

### Data model — variants are a first-class, tenant-scoped sibling table

- `enum PromotionTargetType { CATEGORIES, BRANDS, PRODUCTS }` — `prisma/schema.prisma:89-93`
  (mirrored in `promotion.entity.ts:15` and DTO `create-promotion.dto.ts:35-39`). No VARIANTS.
- `PromotionTargetItem` — `prisma/schema.prisma:1120-1135`: polymorphic
  `(side, targetType, targetId)` with `@@unique([promotionId, side, targetType, targetId])`
  and `@@index([targetType, targetId])`. `targetId` is an opaque string keyed by `targetType`.
- `Variant` — `prisma/schema.prisma:446-471`: own `id` (uuid PK), `productId`, `name`,
  `option`, `value`, `sku?`, `barcode?`, `tenantId`. A variant is fully identified by its own id.
- `Product.hasVariants Boolean` — `prisma/schema.prisma:373`. Variants share the parent
  `productId`, which is exactly why a `PRODUCTS` target hits all of them today.

### Promotion creation / validation — a variantId would be REJECTED today

- `TargetItemDto { targetType, targetId }` — `create-promotion.dto.ts:60-66`;
  `PromotionTargetTypeEnum` (35-39) has no VARIANTS.
- `PromotionsService.resolveTargetItems` → `validateTargetIds` — `promotions.service.ts:528-580`:
  a `switch(targetType)` that verifies ids exist. `PRODUCTS` queries `tenantClient.product`
  (556-559). A variantId passed as a `PRODUCTS` target is rejected as "Product not found"
  (confirmed in engram #2905). A new `case 'VARIANTS'` querying `tenantClient.variant` is required.
  Note: `CATEGORIES`/`BRANDS` use the **global** `this.prisma`; `PRODUCTS` uses the
  **tenant-scoped** `tenantClient` — variants are tenant-scoped, so VARIANTS MUST use `tenantClient`.

### A second engine also matches by product (scope flag)

`src/promotions/application/evaluate-cart-promotions.use-case.ts` (the online / WhatsApp
chatbot path, NOT the POS seller path) does its own product-level match; its input
`CartItemForEvaluation` also carries `variantId`. Whether variant targeting should ALSO
apply online is a scope decision for the proposal.

---

## Affected Areas

- `src/promotions/application/pos-evaluate-promotions.use-case.ts` — **two** match predicates
  (`:225-237`, `:328-334`) + `isSupportedEngineType` (`:282-290`). Core change.
- `src/promotions/domain/promotion.entity.ts:15` — `PromotionTargetType` union; possibly
  `validateByType` if `appliesTo=VARIANTS` needs the same required/forbidden rules as PRODUCTS.
- `src/promotions/dto/create-promotion.dto.ts:35-39,60-66` — enum + `TargetItemDto`
  (+ update DTO merge path `promotions.service.ts:432-485`).
- `src/promotions/promotions.service.ts:528-580` — `validateTargetIds` new VARIANTS branch
  (tenant-scoped variant lookup) + variant-belongs-to-product check (approach-dependent).
- `prisma/schema.prisma:89-93` (+ `1120-1135`) — enum value or new column, plus a migration
  under `prisma/migrations/` (repo uses timestamped additive migrations, e.g.
  `20260710120000_promotion_manually_ended`).
- `src/promotions/infrastructure/prisma-promotion.repository.ts` — hydration/save mappers for
  `targetItems` (only if approach B/C changes the row shape; approach A is transparent here).
- `openspec/specs/pos-promotion-engine/spec.md:113-125` — delta `MODIFY` + new precedence requirement.
- **No change needed:** `PosEvalLine`/`buildPosEvalInput` (variantId already flows through);
  `SaleItem` audit (`promotionId` already recorded per line).

---

## Approaches

### Approach A — New `VARIANTS` value on the `PromotionTargetType` enum (polymorphic, symmetric)

Reuse the existing `PromotionTargetItem` row: `targetType='VARIANTS'`, `targetId=variantId`.
Add a match branch `ti.targetType==='VARIANTS' && ti.targetId===line.variantId`.

- **Schema impact:** additive enum value only (`ALTER TYPE "PromotionTargetType" ADD VALUE
  'VARIANTS'`). No new column, no unique-key change. `@@index([targetType,targetId])` already
  serves variant lookups.
- **Engine change:** add the variant predicate at both match sites + allow `appliesTo='VARIANTS'`
  in `isSupportedEngineType`. `variantId` already on the line → no plumbing.
- **Backward-compat:** total. Existing `PRODUCTS` rows untouched; product-level "applies to
  all variants" default is preserved unchanged.
- **Migration cost:** Low. One enum value. (Postgres gotcha: adding an enum value and using
  it in the *same* transaction can fail — Prisma normally emits it as its own migration step;
  verify the generated SQL.)
- **Precedence:** must be defined explicitly (see below) — a VARIANTS target is just a
  narrower match; it does not by itself beat a PRODUCTS target.
- **Effort:** **Low–Medium**. Mirrors the user's own "targetType VARIANT" option (#2905).

### Approach B — Optional `variantId` sub-column on `PromotionTargetItem` (narrow a PRODUCTS target)

Keep `targetType='PRODUCTS'`, `targetId=productId`, and add nullable `variantId`. A row means
"product P; if `variantId` set, only that variant." Match:
`ti.targetType==='PRODUCTS' && ti.targetId===line.productId && (ti.variantId==null || ti.variantId===line.variantId)`.

- **Schema impact:** new nullable column **and** the `@@unique([promotionId, side, targetType,
  targetId])` key must grow to include `variantId` (else two variants of one product collide).
- **Engine change:** one extra clause on the PRODUCTS branch (both sites). No new enum.
- **Backward-compat:** excellent and *automatic* — legacy rows have `variantId=null` ⇒ still
  match all variants (byte-for-byte today's behavior). Specificity is encoded in the row.
- **Migration cost:** Medium. Column add + unique-index rebuild + repo mapper changes.
- **Precedence:** natural *within* one promo (null=all, set=one). Across two promos still
  needs an explicit rule.
- **Effort:** **Medium**. Mirrors the user's "variantId on target" option (#2905).

### Approach C — Dedicated `PromotionVariantTarget` relation table (typed FK)

A new table `PromotionVariantTarget(promotionId, variantId)` parallel to
`PromotionCustomer`/`PromotionPriceList`, hydrated as `promotion.variantTargets[]`.

- **Schema impact:** new table with a real FK to `Variant` (referential integrity — which the
  polymorphic `targetItems` lacks; it has no FK).
- **Engine change:** read a new relation; match `line.variantId`.
- **Backward-compat:** total (additive table).
- **Migration cost:** Medium–High. New table + entity relation + repo read/save mappers +
  `toResponse` + a second "targets" code path to reason about.
- **Effort:** **Medium–High**. Cleanest typing, most surface area; diverges from the unified
  `targetItems` design.

| Approach | Schema | Migration | Back-compat | Engine | Effort |
|----------|--------|-----------|-------------|--------|--------|
| A — enum `VARIANTS` | enum value | Low | Full (additive) | +1 branch ×2 sites | Low–Med |
| B — nullable `variantId` | column + unique-key | Medium | Full (null=all, automatic) | +1 clause ×2 sites | Medium |
| C — dedicated FK table | new table | Med–High | Full (additive) | new relation read | Med–High |

---

## Recommendation

**Approach A (new `VARIANTS` enum value)** — conditionally, pending one product decision.

Why A:
1. **Least new surface for the biggest win.** The engine input already carries `variantId`
   (`port:31` → `sales.service.ts:614`); A is essentially "add a match branch + an enum value
   + a validation case." No repo mapper churn (A reuses the existing `targetItems` row shape).
2. **Symmetric with the existing polymorphic design.** `PRODUCTS/CATEGORIES/BRANDS` are peers;
   `VARIANTS` joins them naturally and keeps the door open for the deferred CATEGORIES/BRANDS
   work that is queued right after this (#2911 next-steps).
3. **Additive, low-risk migration** consistent with this repo's pattern (timestamped additive
   migrations like `20260710120000_promotion_manually_ended`).
4. It is one of the two shapes the user already sketched (#2905: "targetType VARIANT or a
   variantId on target").

When B wins instead: if the product intent is "a promotion is authored on a PRODUCT and then
*narrowed* to some of its variants **inside the same promotion**" (rather than variant being a
standalone peer target), B's `null = all variants` gives that for free and encodes specificity
in the row. This is a genuine product fork — **defer to the proposal**, don't decide here.

C is the right call only if strict FK referential integrity to `Variant` is a hard requirement;
otherwise its extra mapper/table surface isn't justified for this slice.

---

## Precedence & the "applies-to-all" default (OPEN product decisions for the proposal)

Today the engine resolves multiple eligible promos on a line by **best-wins** (highest
customer discount in cents, ties → lowest `promotionId`; spec "Best-Wins Selection", :160-177).
Variant targeting introduces a specificity axis that best-wins doesn't model:

1. **PRODUCT vs VARIANT on the same line.** If promo X targets product P (all variants) and
   promo Y targets variant V of P, and a line is variant V — does Y win because it's *more
   specific*, or do X and Y compete on discount value (current best-wins)? Recommendation for
   the proposal to weigh: keep best-wins as the default mechanism (least surprising, preserves
   the documented invariant) and treat VARIANTS purely as a narrower match set — but confirm,
   because a business may expect "target this variant" to mean "ONLY this variant, and it wins."
2. **Does a VARIANTS target suppress the product-wide default?** I.e. if a product has a
   variant-specific promo, should the product-wide promo stop applying to that variant? (Mutual
   exclusion vs. coexistence-then-best-wins.)
3. **Unchanged default:** a `PRODUCTS` target continues to hit all variants — this must be
   preserved verbatim for backward compatibility regardless of approach.

---

## Risks

- **Two match sites, not one.** `:328-334` AND `:225-237` must both learn VARIANTS or opted-in
  variant-targeted MANUAL promos will be silently pruned by the self-heal (correctness bug).
- **Postgres enum-add gotcha (Approach A).** Verify Prisma emits `ADD VALUE` as its own step;
  using a freshly-added enum value in the same transaction can fail.
- **Unique-key rebuild (Approach B).** `@@unique([promotionId, side, targetType, targetId])`
  must include `variantId`, else two variants of the same product violate the constraint.
- **Tenant scoping.** VARIANTS validation MUST use `tenantPrisma.getClient()` (variants are
  tenant-scoped), unlike the CATEGORIES/BRANDS branches that use the global client.
- **Pre-existing OPEN bug in the same path.** engram `sales/manual-promo-still-autoapplies-on-additem`
  (#2911): a MANUAL promo appears to auto-apply on `addItem` with zero opt-ins — hypothesis is a
  `method`/opt-in mapping issue in the promotion repo, NOT the engine. Independent of this
  change, but it touches the same `pickBestPerLine` MANUAL branch; land/verify it first or the
  variant work will inherit noisy test signal.
- **Second engine.** `evaluate-cart-promotions.use-case.ts` (chatbot/online) also matches by
  product and its input carries `variantId`; decide whether variant targeting applies there too.
- **Test surface.** The engine spec suite
  (`pos-evaluate-promotions.use-case.spec.ts`) and repo mapper spec will need VARIANTS cases;
  the `pos-promotion-engine` spec has scenario-level coverage expectations (spec §Verification).

---

## Ready for Proposal

**Yes — with one product decision to surface first.** The technical surface is small and
well-understood, the engine input already carries `variantId`, and the change is additive.
Before the proposal bounds the work, the orchestrator should get the user to decide the
**PRODUCT-vs-VARIANT precedence rule** (open question 1 above) and confirm the **target shape**
(Approach A "peer VARIANTS target" vs Approach B "narrow a PRODUCTS target with variantId").
Recommended next phase: **sdd-propose** (carry Approach A as the default, precedence + shape as
the two decisions to confirm).
