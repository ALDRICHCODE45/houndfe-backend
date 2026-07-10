# Design: Connect Promotions Rule Catalog to POS Sale Flow

## Technical Approach

Approach A (synchronous, inline). A new POS engine `PosEvaluatePromotionsUseCase` lives in `PromotionsModule`, exposed to `SalesModule` via a port token. `SalesService` calls `recomputePromotions(sale)` after every draft mutation and persists the resulting item/sale state through the existing delete-then-`createMany` `saleRepo.save`. `chargeDraft` re-runs the same recompute inside its transaction, then computes order-discount-aware inline totals (`sales.service.ts:1568-1579`) so totals never drift and the ORDER_DISCOUNT actually reaches the charged amount. The engine reuses `SaleItem.applyDiscount` (`sale-item.entity.ts:229`) for per-line math and reuses `PROMOTION_INCLUDE` eager-loading (`prisma-promotion.repository.ts:13-26`).

Two id spaces must not be confused: `SaleItem.appliedPriceListId` is a `PriceList.id` (per-product row, `schema.prisma:553`), while promo restrictions use `PromotionPriceList.globalPriceListId` → `GlobalPriceList.id` (`schema.prisma:1130`). The engine resolves each line's `appliedPriceListId` to its `globalPriceListId` before any price-list membership test.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| ORDER_DISCOUNT storage | New `sale_applied_promotions` table (tenant-scoped, one row per sale for ORDER type) | JSON column on `Sale` | Needs a real FK to `Promotion` (SetNull audit), queryable for reporting; mirrors existing relation style. |
| Per-draft veto set | New `sale_promotion_vetoes` table (`saleId`,`promotionId` unique) | JSON column on `Sale` | Veto is a set of promotion references; a relation gives FK integrity + cascade-on-sale-delete and avoids read-modify-write races on a JSON blob during rapid mutations. |
| PRODUCT audit link | `SaleItem.promotionId String?` FK `onDelete: SetNull` + index | discountTitle only | Locked decision #4; enables reversal/reporting by promotion. |
| Engine placement | `src/promotions/application/pos-evaluate-promotions.use-case.ts` + port in `application/ports/` | Extend the stub | Locked BUILD-NEW; stub stays for chatbot-api. |
| Coupling | `SalesModule` imports `PromotionsModule`, injects `POS_EVALUATE_PROMOTIONS_USE_CASE` Symbol only | Direct repo import | Hexagonal — Sales depends on a port, not promotions internals. |
| Recompute trigger | Service-layer method called after each mutation | Domain-event async | POS needs correct totals before charge (proposal Approach B rejected). |
| ORDER_DISCOUNT in totals | Subtract `orderDiscountCents` as a whole-order term AFTER the per-line sum; never mutate per-line `unitPriceCents` | Distribute the order discount across lines | Locked #4/#5 keep per-line audit line-scoped; an order discount is a sale-level term. Single source of truth: `Sale.previewTotals()` → `subtotalCents = Σ(pre-discount base × qty)` (where pre-discount base = `prePriceCentsBeforeDiscount ?? unitPriceCents`, S3), `totalCents = max(0, postLineTotal − orderDiscountCents)` (where `postLineTotal = Σ((unitPriceCents − lineDiscount) × qty)`), `discountCents = subtotalCents − totalCents` (FULL savings — includes line + order discounts). |
| Price-list id resolution | Batch-resolve distinct `appliedPriceListId`→`globalPriceListId` once per recompute via `PriceList.findMany` on tenant client | Resolve per line | Fixes C1 (two id spaces) while staying N+1-safe and tenant-scoped. |
| Charge-time item re-persist | Persist recomputed `SaleItem` rows inside the charge tx (new tenant+tx-scoped item re-write step) | Totals-only recompute at charge | Keeps per-line `promotionId`/`discountAmountCents` audit consistent with the charged total (fixes W1). |

## Data Flow

    addItem/qty/remove/assignCustomer/overrideItemPrice
        │  (mutate Sale aggregate in memory)
        ▼
    SalesService.recomputePromotions(sale)
        │  loads eligible promos (tenant-scoped, eager)
        ▼
    PosEvaluatePromotionsUseCase.evaluate({ sale, customerId, vetoedIds, optedInManualIds })
        │  → per-line applied promo + discount
        │  → sale-level ORDER applied promo + discount
        │  → availableManualPromos[]
        ▼
    apply to SaleItem (applyDiscount+promotionId) / sale-applied-promotions
        ▼
    saleRepo.save(sale)  ── persists items(+promotionId), veto rows, applied-promo row

chargeDraft: findByIdForUpdate (loads veto/applied-promo/opt-in) → recomputePromotions (tx client) → re-persist recomputed SaleItem rows in-tx → order-discount-aware inline totals (1568-1579) → persistChargeConfirmation. Same engine, same result → no drift; ORDER_DISCOUNT reaches the charged total.

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `SaleItem.promotionId String?` + relation; new models `SalePromotionApplied`, `SalePromotionVeto`; back-relations on `Sale` and `Promotion`. |
| `prisma/migrations/<ts>_promotions_in_sale/migration.sql` | Create | Additive `ALTER TABLE`/`CREATE TABLE` (up) + `down` drop. |
| `src/promotions/application/ports/pos-evaluate-promotions.port.ts` | Create | Port interface + `POS_EVALUATE_PROMOTIONS_USE_CASE` Symbol + I/O types. |
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Create | Engine: eligibility + best-wins. |
| `src/promotions/domain/promotion.repository.ts` | Modify | Add `findEligibleForSale(now)` (or reuse `findAll`) — see Eligibility. |
| `src/promotions/infrastructure/prisma-promotion.repository.ts` | Modify | Implement eligibility query (eager `PROMOTION_INCLUDE`). |
| `src/promotions/promotions.module.ts` | Modify | Provide + export `POS_EVALUATE_PROMOTIONS_USE_CASE`. |
| `src/sales/domain/sale-item.entity.ts` | Modify | `promotionId` field; `applyDiscount` accepts `promotionId`; getter; persistence props. |
| `src/sales/domain/sale.entity.ts` | Modify | Hold `appliedOrderPromotion`, `vetoedPromotionIds`, `optedInManualPromotionIds`; helpers to set/clear. **W2:** `SaleFromPersistenceProps` gains those 3 fields and `fromPersistence` (167-200) maps them (default `null`/`[]`). Add `previewTotals()` returning order-discount-adjusted `{ subtotalCents, discountCents, totalCents }` for draft preview (C2). |
| `src/sales/sales.service.ts` | Modify | `recomputePromotions()`; call after mutations + in `chargeDraft`; manual apply/remove/list methods. **Inline totals (1568-1579) consume `Sale.previewTotals()` (single source of truth, C2): `subtotalCents = Σ(pre-discount base × qty)`, `totalCents = max(0, postLineTotal − orderDiscountCents)`, `discountCents = subtotalCents − totalCents` (FULL savings).** `orderDiscountCents = sale.appliedOrderPromotion?.discountAmountCents ?? 0` is the only ORDER_DISCOUNT input. Order-adjusted `discountCents`/`totalCents` flow into `persistChargeConfirmation` so charged totals match `getSaleDetail`. |
| `src/products/products.service.ts` (or `PrismaSaleRepository`) | Modify | Add `resolvePriceListGlobalIds(priceListIds: string[]): Promise<Map<string,string>>` — one tenant-scoped `PriceList.findMany({ where:{ id:{in} } }, select:{ id, globalPriceListId } })` for batch resolution (fixes C1, N+1-safe). |
| `src/sales/infrastructure/prisma-sale.repository.ts` | Modify | Map `promotionId` on item write/read; persist+load veto & applied-promo rows in ALL read mappers (`findById`, `findByIdForUpdate`, `findDraftResponseById`, `findDraftsByUserId`); `persistChargeConfirmation` (489-545) gains an in-tx `SaleItem` re-write step so charge-time recompute persists per-line audit. |
| `src/sales/sales.controller.ts`, `src/sales/dto/**` | Modify/Create | 3 endpoints + DTOs. |
| `src/sales/sales.module.ts` | Modify | Import `PromotionsModule`. |

## Interfaces / Contracts

```ts
// pos-evaluate-promotions.port.ts
export const POS_EVALUATE_PROMOTIONS_USE_CASE = Symbol('POS_EVALUATE_PROMOTIONS_USE_CASE');

export interface PosEvalLine {
  itemId: string; productId: string; variantId: string | null;
  quantity: number; effectiveUnitPriceCents: number; // post price-list, pre-promo (prePriceCentsBeforeDiscount ?? unitPriceCents)
  appliedPriceListId: string | null;        // PriceList.id (per-product row)
  appliedGlobalPriceListId: string | null;  // resolved GlobalPriceList.id — used for promo price-list eligibility (C1)
  hasManualDiscount: boolean; // seller free-form → auto-promo skips
}
export interface PosEvalInput {
  now: Date; customerId: string | null;
  lines: PosEvalLine[];
  vetoedPromotionIds: ReadonlyArray<string>;
  optedInManualPromotionIds: ReadonlyArray<string>;
}
export interface PosEvalLineResult {
  itemId: string; promotionId: string; discountType: 'amount' | 'percentage';
  discountValue: number; discountTitle: string;
}
export interface PosEvalOrderResult {
  promotionId: string; discountType: 'amount' | 'percentage';
  discountValue: number; discountTitle: string; discountAmountCents: number;
}
export interface PosEvalResult {
  lines: PosEvalLineResult[];               // best PRODUCT promo per eligible line
  order: PosEvalOrderResult | null;         // best ORDER promo
  availableManualPromotions: Array<{ id: string; title: string; type: 'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT' }>;
}
export interface IPosEvaluatePromotionsUseCase { evaluate(input: PosEvalInput): Promise<PosEvalResult>; }
```

`discountValue` for a PERCENTAGE promo maps to `applyDiscount({type:'percentage', percent})`; FIXED maps to `{type:'amount', amountCents}`. Engine converts DiscountType→SaleItem discount vocabulary.

## Eligibility Algorithm

Load candidates via one tenant-scoped query. Reuse `findAll({ page:1, limit:500, status:'ACTIVE' })` (already date-window-aware at DB, eager `PROMOTION_INCLUDE`) — do NOT filter by `method` so MANUAL promos are available for opt-in. Then in-memory, per promotion, keep only if ALL:

1. `getEffectiveStatus(now) === 'ACTIVE'` (defense-in-depth vs DB filter).
2. `type ∈ {PRODUCT_DISCOUNT, ORDER_DISCOUNT}` (others ignored — non-goal).
3. `daysOfWeek` empty OR includes `now`'s weekday.
4. customerScope: `ALL` always; `REGISTERED_ONLY` needs `customerId != null`; `SPECIFIC` needs `customerId ∈ customers[]`.
5. `priceLists` empty OR `line.appliedGlobalPriceListId ∈ promo.priceLists[].globalPriceListId`. **CRITICAL (C1): match against `appliedGlobalPriceListId` (a `GlobalPriceList.id`), NOT `appliedPriceListId` (a per-product `PriceList.id`).** Comparing the raw `appliedPriceListId` never matches, so every price-list-restricted promo would be silently ineligible forever. If restricted and no matching global list on the line → not eligible for that line.
6. ORDER only: `minPurchaseAmountCents` null OR pre-order-discount subtotal ≥ it.

**Price-list id resolution (C1):** before evaluation, `recomputePromotions` collects the distinct non-null `appliedPriceListId`s across items and calls `resolvePriceListGlobalIds(ids)` — ONE tenant-scoped `PriceList.findMany` (`select: { id, globalPriceListId }`). It maps each `PosEvalLine.appliedGlobalPriceListId` from that result. Batch-resolved once per recompute → no per-line DB call.

N+1 avoided: single `findAll` promo load (all relations eager) + single `PriceList.findMany` id resolution. No per-item DB calls.

## Application & Best-Wins Algorithm

Per line (PRODUCT_DISCOUNT): if `hasManualDiscount` → skip (manual wins, #3). First slice restricts candidates to `appliesTo='PRODUCTS'` (match `targetItems[side=DEFAULT]` by `productId`); CATEGORIES/BRANDS are DEFERRED (see Scope Boundary / S1). Compute each candidate's discount on `effectiveUnitPriceCents` (S3: this is `prePriceCentsBeforeDiscount ?? unitPriceCents`, the pre-promo base, so recompute never compounds on re-entry).

**Best-wins must rank by the APPLICABLE discount, not a theoretical one (W3):** `applyDiscount` clamps PERCENTAGE to 1–99 and rejects `baseline − discount < 1` (`sale-item.entity.ts:248,283`). Decision: for a 100% PERCENTAGE promo, the engine clamps `percent` to **99 for BOTH the comparison value and the applied value** — one clamp helper used in ranking and in the emitted `discountValue`. This guarantees the value best-wins ranks equals the value `applyDiscount` produces. Then pick **max applicable customer discount** across candidates.

Per sale (ORDER_DISCOUNT): gather eligible ORDER promos; compute against the post-line-discount subtotal; pick max `discountAmountCents`. Persist to `sale_applied_promotions`. Manual (MANUAL method) promos only considered when their id ∈ `optedInManualPromotionIds`; vetoed ids always excluded.

## Recompute Placement & Transaction Boundaries

`recomputePromotions(sale)` is a private `SalesService` method: (1) batch-resolves distinct `appliedPriceListId`→`globalPriceListId` (C1) via `resolvePriceListGlobalIds`; (2) builds `PosEvalInput` from current item state — each `PosEvalLine.effectiveUnitPriceCents = item.prePriceCentsBeforeDiscount ?? item.unitPriceCents` (S3, pre-promo base), `appliedGlobalPriceListId` from the resolution map, `hasManualDiscount = discountType set AND promotionId == null`; (3) calls engine; (4) for each item clears prior auto-promo (`removeDiscount` only if the existing discount was promo-sourced, i.e. `promotionId != null`), applies new promo via `applyDiscount({..., promotionId})`; (5) sets/clears `sale.appliedOrderPromotion`.

Call sites (after in-memory mutation, before `saleRepo.save`): `addItem` (~610), `updateItemQuantity` (~675), `removeItem`, `assignCustomer` (~1234), `overrideItemPrice` (~1042). CRITICAL: in `overrideItemPrice`, `overridePrice()` calls `clearDiscountFields()` (`sale-item.entity.ts:226`) — so recompute runs *after* the override and re-applies auto-promos on the new price. Manual free-form discount lines are also wiped by override; that is existing behavior and out of scope to preserve.

`chargeDraft` (transactional, 1518-1732): after `findByIdForUpdate` (which now loads veto/applied-promo/opt-in — W2) and the price-freshness loop (1540-1566), call `recomputePromotions(sale)` (tenant tx client). **W1:** because `persistChargeConfirmation` (489-545) only updates the Sale row + `SalePayment` rows and does NOT re-write `SaleItem` rows (unlike `save`'s delete-then-`createMany`), a charge-time recompute that changes a line would leave stale per-line audit. Fix: add a tenant+tx-scoped `SaleItem` re-write step in the charge path (inside the `runInTransaction` block, before `persistChargeConfirmation`) so recomputed `promotionId`/`discountAmountCents`/`unitPriceCents` persist. THEN the order-discount-aware inline totals (1568-1579) consume `Sale.previewTotals()` (single source of truth, C2): `subtotalCents = Σ(pre-discount base × qty)`, `totalCents = max(0, postLineTotal − orderDiscountCents)`, `discountCents = subtotalCents − totalCents` (FULL savings — includes line + order discounts). `orderDiscountCents = sale.appliedOrderPromotion?.discountAmountCents ?? 0` is the only ORDER_DISCOUNT input. Same engine + same `previewTotals()` math → confirmed totals equal the draft totals shown by `getSaleDetail`.

**Draft-preview totals (C2):** `Sale.toResponse()` returns `totalCents = this.totalCents`, which is 0 for drafts (`sale.entity.ts:557`). So mutation responses and draft preview would NOT reflect the ORDER_DISCOUNT. Fix: surface an order-discount-adjusted `subtotalCents`/`discountCents`/`totalCents` in the draft response — `findDraftResponseById` spreads `sale.previewTotals()` over `sale.toResponse()` so the same math is reused by both preview and charge (C2 single source of truth).

## Precedence & Veto State Machine

| Line state | Auto PRODUCT promo eligible? | Result |
|---|---|---|
| Manual free-form discount (`discountType`set, `promotionId`null) | yes | Auto skipped; manual kept. |
| Auto promo applied, seller removes it | — | Add id to veto set; line reverts; stays excluded on recompute. |
| Vetoed promo, seller re-applies (manual opt-in of same id) OR reactivate | — | Remove from veto; eligible again next recompute. |
| MANUAL promo, opted-in | yes | Applied as best-wins candidate. |
| MANUAL promo, not opted-in | — | Never auto-applied; appears in `availableManualPromotions`. |
| No customer, customer-scoped promo | — | Silently not applied (#8). |

Remove endpoint: auto promo → add to veto; manual opted-in → remove from opt-in set. Both trigger recompute.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | Engine eligibility + best-wins + precedence | Pure use-case tests with mocked `IPromotionRepository`. |
| Unit | **C1**: price-list-restricted promo eligible only when `appliedGlobalPriceListId` (resolved) matches, NOT the raw `appliedPriceListId` | Engine test with distinct PriceList.id vs GlobalPriceList.id. |
| Unit | **W3**: 100% PERCENTAGE promo — ranked value == applied value (clamped 99); best-wins picks the applicable discount | Engine + entity test. |
| Unit | `SaleItem.applyDiscount(promotionId)` + veto/opt-in on `Sale`; `Sale.previewTotals()` order-discount math | Entity tests. |
| Integration | **C2**: ORDER_DISCOUNT changes charged `totalCents` AND draft-preview `totalCents` (not just audit) | Charge + `getSaleDetail`. |
| Integration | **W2**: veto survives reload — vetoed AUTOMATIC promo stays vetoed after `findByIdForUpdate`/`findById`/`findDraftResponseById`, does NOT re-apply on next recompute/charge | Persist veto → reload → recompute. |
| Integration | **W1**: charge-time recompute persists per-line `promotionId`/`discountAmountCents` (item re-write in charge tx) | Charge then read SaleItem rows. |
| Integration | recompute on each mutation; override re-apply; charge = detail | `SalesService` with in-memory/mocked repos. |
| Integration | migration up/down on populated DB | Prisma migrate against seeded fixture. |

## Migration / Rollout

Additive only. Up: `ALTER TABLE "sale_items" ADD COLUMN "promotionId" TEXT;` + FK SetNull + index; `CREATE TABLE "sale_promotion_applied"` and `"sale_promotion_vetoes"` with tenantId, FKs (`Promotion` SetNull/Cascade, `Sale` Cascade), unique constraints. Down: drop the two tables and the column. No data loss on populated DB — all new columns nullable, no backfill.

## Edge Cases

- 100% PERCENTAGE promo (W3): engine clamps `percent` to 99 in BOTH the best-wins comparison and the emitted `discountValue`, so ranking value == applied value. `applyDiscount` then keeps `baseline − discount ≥ 1`.
- Promo ineligible mid-draft (date/day rollover, customer change): next recompute drops it; charge recompute is authoritative.
- Item with promo removed: promo link vanishes with the item (no orphan; `promotionId` was on the item row).
- Two promos identical discount: deterministic tiebreak = lowest `promotion.id` (stable, tenant-safe).
- Rounding: `Math.round` in `applyDiscount` (percentage) — consistent with stub + chargeDraft.
- Veto persists across mutations because it lives in `sale_promotion_vetoes`, not derived state.

## Scope Boundary (S1 — resolved, not open)

The spec (`pos-promotion-engine/spec.md:110-122`) includes a CATEGORIES scenario, but `SaleItem` (`schema.prisma:700-734`) has NO category/brand snapshot fields. Decision: **the first slice restricts `PRODUCT_DISCOUNT` to `appliesTo='PRODUCTS'`. The CATEGORIES and BRANDS spec scenarios are explicitly DEFERRED** — they require adding category/brand snapshot columns to `SaleItem` (a separate additive change) and MUST be marked DEFERRED in the tasks phase. This keeps the first slice scope honest; ORDER_DISCOUNT and PRODUCTS-scoped PRODUCT_DISCOUNT are fully in-scope.

## Work-Unit Decomposition Hint (for tasks phase)

>600-line change — chain these revertable units (C1/C2/W1 widen units 2, 4, 5):
1. Migration + schema (`promotionId`, applied-promo, veto tables).
2. Port + engine (eligibility incl. `appliedGlobalPriceListId` C1, best-wins W3 clamp) + `resolvePriceListGlobalIds` batch resolver + unit tests — unwired.
3. Entity changes (`SaleItem.promotionId`; `Sale` veto/opt-in/`appliedOrderPromotion` + `SaleFromPersistenceProps` W2 + `previewTotals` C2) + repo persistence (save veto/applied rows; ALL read mappers load them — W2).
4. Wire `recomputePromotions` (with id resolution) into `addItem`/qty/remove/assignCustomer + draft-preview order-discount totals (C2).
5. `overrideItemPrice` re-apply + `chargeDraft`: order-discount inline totals (C2) + in-tx `SaleItem` re-write (W1) + veto-loaded `findByIdForUpdate` (W2).
6. Manual endpoints (list/apply/remove) + DTOs + veto/opt-in wiring.
