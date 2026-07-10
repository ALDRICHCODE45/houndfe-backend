# Proposal: Connect Promotions Rule Catalog to POS Sale Flow

## Intent

`promotions` is a CRUD catalog that never touches a transactional flow. POS drafts (`src/sales/**`) ignore every rule. This change discounts POS drafts at draft-mutation time so the price the seller sees is the price the customer pays.

## Scope

### In Scope
- POS eligibility engine for `PRODUCT_DISCOUNT` + `ORDER_DISCOUNT` (dates, days, customerScope, priceLists, minPurchase).
- Auto-apply on every draft mutation (addItem, qty, customer, remove, price-list override, manual discount).
- Manual path: list-applicable endpoint + apply/remove for `MANUAL` promos.
- Best-wins per line and per sale (no stacking, no priority).
- Manual free-form discount wins over auto-promo on the same line.
- Per-draft veto set: seller-removed auto-promos stay excluded.
- Additive migration: `SaleItem.promotionId` (FK SetNull) + sale-level `applied_promotions` (ORDER).
- Tenant-scoped reads; `PromotionsModule` wired into `SalesModule`.

### Out of Scope (Non-Goals)
`BUY_X_GET_Y`/`ADVANCED` evaluation · usage limits/caps · tax model · priority/stacking fields · all frontend work.

## Capabilities

### New Capabilities
- `pos-promotion-engine`: eligibility, auto-apply on draft mutation, manual apply/remove, best-wins, manual-wins precedence, per-draft veto, recompute correctness, `promotionId` audit.

### Modified Capabilities
- `sales`: `chargeDraft` totals reflect applied promos; draft mutations trigger recompute; manual free-form discount blocks auto-promo on the same line; price-list override re-runs recompute without wiping promo discounts.

## Approach

**Approach A** (from exploration): synchronous domain/application service invoked during draft mutation, aligned with the existing synchronous, tenant-scoped, inline-totals `SalesService` flow. Recompute after every mutation; `chargeDraft` revalidates from item state.

**Engine decision: BUILD a new POS-grade engine** (`PosEvaluatePromotionsUseCase`), not extend the stub. The new engine operates on `Sale`, supports both types with full eligibility, returns applied + available-for-manual results. Stub stays untouched for chatbot-api. Detailed API and recompute placement are design-phase decisions.

## Affected Areas

| Area | Impact |
|------|--------|
| `src/sales/sales.service.ts` | Engine after each mutation; honor veto; manual-wins precedence. |
| `src/sales/sales.module.ts` | Import `PromotionsModule`; new endpoints. |
| `src/sales/domain/sale-item.entity.ts`, `sale.entity.ts` | `promotionId`; per-draft veto persistence. |
| `src/sales/dto/**`, `sales.controller.ts` | Apply/remove + list-applicable DTOs and endpoints. |
| `src/promotions/application/**` | NEW: engine use-case + port. |
| `src/promotions/infrastructure/prisma-promotion.repository.ts` | Tenant-scoped eligibility query. |
| `prisma/schema.prisma` + migration | `SaleItem.promotionId?` FK SetNull; `applied_promotions` table. |

## Risks

| Risk | Lik | Mitigation |
|------|-----|------------|
| Recompute N+1 on promo reads | Med | One eligibility query per recompute; eager relations; index `(tenantId, method, status)`. |
| Totals drift recompute ↔ `chargeDraft` | Med | `chargeDraft` recomputes from item state; precedence enforced everywhere. |
| `overrideItemPrice` wipes promo discounts | Med | Audit call sites; recompute re-applies auto-promos after override. |
| Sales↔Promotions coupling | Med | Engine in `PromotionsModule`; `SalesModule` consumes a port only. |

## Rollback Plan

1. Drop additive migration (non-destructive `down`).
2. Revert `SalesModule` import + remove new endpoints/DTOs.
3. Leave engine files (no-op while unwired); rule catalog + chatbot preview unchanged.

## Dependencies

Existing `IPromotionRepository`, `TenantPrismaService`, `SaleItem.applyDiscount` invariant. No new packages.

## Success Criteria

- [ ] `addItem` returns totals with `AUTOMATIC` promos applied; `chargeDraft` matches `getSaleDetail`.
- [ ] Best-wins with two overlapping promos; manual discount blocks auto-promo on same line; both preserved through recompute.
- [ ] Seller-removed auto-promo stays excluded on recompute (veto persists).
- [ ] Customer-scoped promo silently skips until eligible customer assigned.
- [ ] `promotionId` populated on `SaleItem` (PRODUCT) and sale-level record (ORDER).
- [ ] Migration applies and rolls back cleanly on populated DB.

## Size Signal

Multi-work-unit change; likely > 600 lines. Task planning must forecast. Solo dev, NO PRs — structured branches + work-unit commits merged to main.