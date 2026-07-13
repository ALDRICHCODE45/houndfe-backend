# Exploration: category-brand-promo-targeting

Activate the DEFERRED promotion target types **CATEGORIES** and **BRANDS** in the POS
promotion engine, mirroring the targeting pattern VARIANTS/PRODUCTS already use.
**Targeting only.**

**Scope lock:** POS engine only. OUT of scope: BUY_X_GET_Y / ADVANCED mechanics (future
change #2b), the online/cart engine (`evaluate-cart-promotions.use-case.ts`), and any
frontend work. This is the "activate deferred promo types" backlog item the predecessor
`variant-level-promo-targeting` explicitly queued (see its `tasks.md` DEFERRED note and the
DEFERRED scenario in `openspec/specs/pos-promotion-engine/spec.md:123-128`).

> **Prior-assumption correction (with evidence):** The predecessor's `tasks.md` (line 57)
> claims CATEGORIES/BRANDS "needs `SaleItem` category/brand snapshot columns." My
> investigation shows snapshot columns are **NOT required** — a batch resolve-at-eval-time
> (identical to the existing `resolvePriceListGlobalIds` pattern already in
> `buildPosEvalInput`) is a smaller, migration-free path. Snapshot is one option, not a
> requirement. See **Approaches** below.

---

## Current State

### 1. The engine gate — CONFIRMED, this is the exact line to change

`src/promotions/application/pos-evaluate-promotions.use-case.ts` → `isSupportedEngineType`
(**lines 335-350**) is the gate that excludes CATEGORIES/BRANDS today:

```ts
private isSupportedEngineType(promo: Promotion): boolean {
  if (promo.type === 'ORDER_DISCOUNT') return true;
  if (
    promo.type === 'PRODUCT_DISCOUNT' &&
    (promo.appliesTo === 'PRODUCTS' || promo.appliesTo === 'VARIANTS')
  ) {
    return true;
  }
  return false;   // <- CATEGORIES / BRANDS fall through to here
}
```

It is consulted in **four** places (all keyed off this one helper): `passesPromotionWideGates`
(:309), the `availableManualPromotions` filter (:204), and TWICE in the
`targetableManualPromotionIds` self-heal loop (:270, :280). Flipping the helper alone opens
all four call sites — no per-site edits needed for the gate itself.

### 2. The data-flow gap — the engine never sees a line's category/brand

The pure match helper `matchTargetTier` (**:76-105**) only reads `{ productId, variantId }`:

```ts
export function matchTargetTier(
  targetItems: ReadonlyArray<{ side: string; targetType: string; targetId: string }>,
  line: { productId: string; variantId: string | null },
): LineMatchTier
```

It has branches for VARIANTS (→ `line.variantId`) and PRODUCTS (→ `line.productId`), and
returns `null` for everything else — including CATEGORIES/BRANDS (this null is even
unit-asserted in `match-target-tier.spec.ts`). `LineMatchTier = 'VARIANT' | 'PRODUCT' | null`
(:65).

The line shape has **no category or brand identifier**, at any layer:

- Port `PosEvalLine` (`application/ports/pos-evaluate-promotions.port.ts:28-41`) — has
  `productId`, `variantId`, price fields; **no `categoryId` / `brandId`.**
- Builder `buildPosEvalInput` (`src/sales/sales.service.ts:611-624`) maps `sale.items` →
  lines; category/brand are never populated because the source has them...
- Source `SaleItem` (`prisma/schema.prisma:707-748`) — has `productId`, `variantId`,
  `productName`, `variantName`; **no `categoryId` / `brandId` snapshot columns.**

So to match a CATEGORIES/BRANDS promo, the engine must compare the target id against the
line's **product's** categoryId / brandId, and that value is **not available at eval time
today**. This is the ONLY real gap unique to this change (VARIANTS had it free because
`variantId` was already on the line).

### 3. Category/brand are SINGLE-VALUED per product, and GLOBAL (not tenant-scoped)

Two facts that materially shape matching and validation:

- **Single-valued.** `Product.categoryId String?` + `Product.brandId String?`
  (`schema.prisma:342-347`), each a nullable scalar FK (`onDelete: SetNull`). A product
  belongs to **at most one** category and **at most one** brand — NOT many. The reverse
  relations `Category.products Product[]` / `Brand.products Product[]` (:205, :220) confirm
  one-to-many. **This directly answers the brief's multi-category concern: matching compares
  a single `line.categoryId` / single `line.brandId` — no set logic, no "any-of" fan-out.**
  Null must be handled: a line whose product has `categoryId = null` can never match a
  CATEGORIES promo (same for brand).
- **Global.** `Category` (:199-208) and `Brand` (:214-223) have **no `tenantId`** — they are
  shared across tenants (unique by `name`). This is why `validateTargetIds` already queries
  them via the **global** `this.prisma`, not the tenant client (see #4). The product→category
  association is still tenant-scoped through the product row.

### 4. `validateTargetIds` is ALREADY implemented for CATEGORIES/BRANDS

`src/promotions/promotions.service.ts:542-554` already has the branches (they were built with
the polymorphic `targetItems` design and never removed):

```ts
case 'CATEGORIES':
  found = await this.prisma.category.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
  break;
case 'BRANDS':
  found = await this.prisma.brand.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
  break;
```

The not-found error path (`INVALID_TARGET` → 400) and the entity-name ternary
(`'Category'` / `'Brand'`, :578-585) are already wired. **No validation work is required** —
unlike VARIANTS, which had to add a whole branch. (They correctly use global `this.prisma`
because category/brand are global; do NOT "fix" this to `tenantClient`.)

### 5. Domain entity, DTO, and Postgres enum ALREADY support CATEGORIES/BRANDS

- `PromotionTargetType` union (`promotion.entity.ts:15`) already = `'CATEGORIES' | 'BRANDS' |
  'PRODUCTS' | 'VARIANTS'`. Entity accepts `appliesTo: 'CATEGORIES'` (entity spec proves it).
- DTO `PromotionTargetTypeEnum` (`create-promotion.dto.ts:35-40`) already has both;
  `appliesTo` (:133) and `TargetItemDto` (:61-67) already accept them.
- Postgres `enum PromotionTargetType` (`schema.prisma:89-94`) already = `[CATEGORIES, BRANDS,
  PRODUCTS, VARIANTS]`. **The enum values were reserved but engine-deferred.**

### 6. The main spec already documents the intended behavior (as DEFERRED)

`openspec/specs/pos-promotion-engine/spec.md:115` already states: "`CATEGORIES` matches by
product category id; `BRANDS` matches by product brand id." Lines 123-128 carry a **DEFERRED**
scenario explicitly saying `isSupportedEngineType` returns `false` and `matchTargetTier`
returns `null` today, "covered by a separate 'activate deferred promo types' backlog item" —
**this change.** The spec phase will `MODIFY` that requirement to un-defer the scenarios and
add the precedence rule (see Open Question).

---

## Affected Areas

- `src/promotions/application/pos-evaluate-promotions.use-case.ts` — **core.**
  `isSupportedEngineType` (:335-350, allow CATEGORIES/BRANDS); `matchTargetTier` (:76-105, +2
  branches reading new line fields); `LineMatchTier` (:65, widen union);
  `PerLineCandidate.tier` (:136, widen union); precedence pre-pass (:412-423, generalize from
  2-tier to N-tier — see Open Question). Both match sites (`pickBestPerLine` :388,
  `targetableManualPromotionIds` :285) ride `matchTargetTier`, so they open automatically.
- `src/promotions/application/ports/pos-evaluate-promotions.port.ts:28-41` — add
  `categoryId: string | null` and `brandId: string | null` to `PosEvalLine`.
- `src/sales/sales.service.ts:591-624` (`buildPosEvalInput`) — batch-resolve productId →
  {categoryId, brandId} and inject onto each line. Already calls a sibling resolver
  (`resolvePriceListGlobalIds`, :603) in this exact method — same pattern.
- `src/products/products.service.ts` — new `resolveProductCategoryBrandIds(productIds)` batch
  method, a near-clone of `resolvePriceListGlobalIds` (:2463-2480, ~18 lines, tenant-scoped).
- `openspec/specs/pos-promotion-engine/spec.md:113-128` — delta `MODIFY` (un-defer + precedence).
- **Tests (TDD, the bulk):** `match-target-tier.spec.ts` (flip CATEGORIES/BRANDS null→tier,
  add category/brand to `MiniLine`, precedence-order cases); engine spec (category/brand
  best-wins + self-heal `targetable` + precedence); `sales.service.spec.ts` (resolve wiring);
  a `resolveProductCategoryBrandIds` spec; integration spec on a seeded tenant.
- **No change needed:** Postgres enum, migration, `promotion.entity.ts`, DTOs,
  `validateTargetIds`, repo mappers, `SaleItem` (IF resolve-at-eval is chosen).

---

## Approaches (the one real decision: how the line learns its category/brand)

### Approach A — Resolve-at-eval-time (batch resolve in `buildPosEvalInput`) — RECOMMENDED

Add a `ProductsService.resolveProductCategoryBrandIds(distinctProductIds) → Map<productId,
{categoryId, brandId}>` (mirror of `resolvePriceListGlobalIds`). In `buildPosEvalInput`,
collect distinct `productId`s, resolve once, and set `categoryId`/`brandId` on each
`PosEvalLine`. `matchTargetTier` compares against them.

- **Schema/migration:** **NONE.** Enum values already exist; no columns added.
- **Engine:** +2 match branches, widened tier unions, gate flip, pre-pass generalization.
- **Plumbing:** +1 batch query per recompute (distinct productIds, cheap, indexed by PK),
  following the identical batch pattern already living in the same method.
- **Semantics:** "live" — re-categorizing a product immediately affects matching. Correct for
  a POS draft where a promo means "all BRAND X products **now**."
- **Back-compat:** total. `SaleItem` untouched; no backfill.
- **Effort:** **Low–Medium.**

### Approach B — Snapshot columns on `SaleItem` (`categoryId` / `brandId`)

Add two nullable columns to `SaleItem`, populate at add/update-item time, engine reads them
off the line.

- **Schema/migration:** migration (2 columns) + backfill for existing DRAFT rows + populate
  logic at every write site (`addItem`, item replace/update in `sales.service`).
- **Engine:** same match/gate/tier changes as A.
- **Plumbing:** no per-recompute query.
- **Semantics:** point-in-time snapshot — a draft created before recategorization keeps the
  OLD category/brand. Arguably wrong for a live draft; arguably right as an audit trail (but
  the audit need is unproven for targeting).
- **Back-compat:** needs a nullable + backfill story; more risk.
- **Effort:** **Medium–High** (migration + backfill + multi-site populate → likely pushes the
  diff toward/over the 400-line budget and a chained split).

| Approach | Schema/Migration | Extra query | Semantics | Effort | 400-line risk |
|----------|-----------------|-------------|-----------|--------|---------------|
| **A resolve-at-eval** | none | 1 batch/recompute | live (current) | Low–Med | **Low–Med** |
| **B snapshot columns** | migration + backfill + populate | none | point-in-time | Med–High | Med–High |

---

## Recommendation

**Approach A (resolve-at-eval-time).** It is migration-free (enum/DTO/entity/validation all
already exist), it re-uses the batch-resolve pattern already present in `buildPosEvalInput`
(`resolvePriceListGlobalIds`), it keeps `SaleItem` and its ~1600 existing tests untouched, and
it gives "live" category/brand semantics that fit a POS draft recompute. The snapshot
approach's only distinctive benefit — point-in-time category — is questionable for live
targeting and buys a migration + backfill + multi-site populate that materially raises size
and risk. **Surface A vs B to the user in the proposal, but carry A as the default.**

---

## OPEN PRODUCT QUESTION — specificity precedence (do NOT decide here)

Today the pre-pass (`pickBestPerLine` :412-423) models a **2-tier** specificity ladder:
`VARIANT > PRODUCT` — if any candidate on a line is tier `VARIANT`, all `PRODUCT` candidates
are dropped before best-wins runs. Adding CATEGORY and BRAND introduces two broader tiers and
forces a decision the engine cannot infer:

**Where do CATEGORY and BRAND sit, and how do they rank against each other?**

- **Option 1 — Strict 4-tier ladder:** `VARIANT > PRODUCT > BRAND > CATEGORY` (or
  `… > CATEGORY > BRAND`). Most specific present tier wins; best-wins only breaks ties inside
  a tier. Requires picking a BRAND-vs-CATEGORY order.
- **Option 2 — 3 levels, brand/category as peers:** `VARIANT > PRODUCT > {BRAND ≡ CATEGORY}`.
  When the top present tier is the broad level, BRAND and CATEGORY candidates **coexist** and
  compete on best-wins (highest discount, ties → lowest id). *Most intuitive default* given
  both are single-valued and equally broad — neither is structurally narrower.
- **Option 3 — No new precedence:** CATEGORY/BRAND join the PRODUCT level
  (`VARIANT > {PRODUCT, BRAND, CATEGORY}`), all broad targets competing on best-wins. Smallest
  code, but lets a brand-wide promo beat a product-specific one purely on discount value —
  usually undesirable.

**BRAND vs CATEGORY sub-question:** because a product has exactly one brand and one category
(both single-valued), neither is inherently more specific than the other. A **tie broken by
best-wins (Option 2)** is the natural default, but some businesses may want brand promos to
strictly trump category promos (or vice versa) — a genuine product call.

**Engine implication (flag for design/tasks):** whichever option, the pre-pass changes from a
binary `hasVariantTier ? filter(VARIANT) : all` to a "keep-only-the-most-specific-tier-present"
pass over an ordered tier list. That is a real structural edit to :418-421, not just new enum
values. Unchanged invariants to preserve verbatim: a `PRODUCTS` target still hits all variants
of the product; best-wins (max discount, ties → lowest id) remains the in-tier mechanism.

---

## DB Migration — is one needed?

**No migration is needed for Approach A.** The `PromotionTargetType` Postgres enum already
contains `CATEGORIES` and `BRANDS` (`schema.prisma:89-94`) — they were reserved when the
polymorphic targeting was first built and only the engine was deferred. The domain entity,
DTOs, and `validateTargetIds` already accept them. **The only scenario that needs DB work is
Approach B** (snapshot columns on `SaleItem` → one additive migration + backfill of existing
draft rows). Choosing A means zero `prisma/migrations/` changes.

---

## Size Estimate

Calibrated against the near-identical predecessor `variant-level-promo-targeting`
(~230–290 net lines, 400-risk Low). This change **removes** three of that change's work units
(no schema/migration, no domain/DTO enum, no `validateTargetIds` branch — all pre-existing)
but **adds** the line-plumbing VARIANTS got for free (resolver + 2 line fields +
`buildPosEvalInput` wiring), plus a slightly larger pre-pass for the extra tiers.

- Production code (Approach A): **~75–90 lines** (engine ~40, port +6, `buildPosEvalInput`
  ~12, new resolver ~20).
- Tests (TDD): **~150–260 lines** (helper tier flips + engine best-wins/precedence/self-heal +
  resolver spec + integration sweep).
- **Net authored total: ~225–350 lines.**

**400-line budget risk: Low–Medium** for Approach A (single PR is defensible; if tests land
rich, a 2-slice split — engine+helper, then wiring+integration — keeps each slice under
budget). **Medium–High** for Approach B (migration + backfill + populate sites) — likely a
chained split. This forecast is refined authoritatively in `sdd-tasks`.

---

## Risks

- **Precedence is an unforced product decision** (Open Question). Shipping without an explicit
  rule means a brand/category-wide promo could out-discount a product/variant-specific one —
  surprising and hard to unwind later. Resolve BEFORE `sdd-apply`.
- **Null category/brand must be guarded.** `categoryId`/`brandId` are nullable
  (`onDelete: SetNull`); a `matchTargetTier` branch that does `ti.targetId === line.categoryId`
  with `line.categoryId == null` must NOT match (mirror the existing `variantId != null` guard
  at :84).
- **`match-target-tier.spec.ts` has negative assertions to flip.** It currently asserts
  CATEGORIES/BRANDS → `null`; those become RED starting points and `MiniLine` must gain
  category/brand fields. Also update the spec's Verification list (:333).
- **Do NOT tenant-scope category/brand validation.** They are global (no `tenantId`); the
  existing `this.prisma.category/brand` queries are correct. "Fixing" them to `tenantClient`
  would break validation.
- **Recompute cost.** Approach A adds one batch product lookup per recompute; keep it a single
  `IN (...)` over distinct productIds (PK-indexed), matching `resolvePriceListGlobalIds`.
- **Config vs session TDD mismatch (minor).** `openspec/config.yaml` says `apply.tdd: false`,
  but the session mandates strict TDD (and the predecessor's tasks were RED/GREEN). Follow
  strict TDD; optionally reconcile `config.yaml` in this change or note it for the user.
- **Scope creep guard.** Keep BUY_X_GET_Y / ADVANCED and the cart engine
  (`evaluate-cart-promotions.use-case.ts`, which does NOT use `matchTargetTier`) firmly out —
  they are change #2b.

---

## Ready for Proposal

**Yes — with the precedence rule (and A-vs-B) as the decisions to surface.** The technical
surface is small, well-understood, and mostly a clone of the just-merged VARIANTS change: the
gate is one helper (`isSupportedEngineType`), the match is one pure helper (`matchTargetTier`),
enum/DTO/entity/validation are already done, and no migration is required under the recommended
approach. Before the proposal bounds the work, the orchestrator should get the user to decide
(1) **specificity precedence** — where CATEGORY/BRAND sit and how they rank against each other
(Options 1–3, default Option 2), and (2) **data source** — resolve-at-eval (A, recommended)
vs snapshot columns (B). Recommended next phase: **sdd-propose** (carry Approach A + Option 2
as defaults, both as explicit confirmations).
