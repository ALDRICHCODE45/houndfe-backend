# Archive Report: Connect Promotions Rule Catalog to POS Sale Flow

## Final Verdict: ARCHIVED — PASS

- **Change**: `promotions-in-sale`
- **Branch**: `feat/promo-sale-u6-endpoints`
- **Archive folder**: `openspec/changes/archive/2026-07-10-promotions-in-sale/`
- **Archived at**: 2026-07-10
- **Merge state**: branch NOT merged to `main`, NOT pushed — solo dev merges manually (no PRs)
- **Verify verdict**: PASS — **1656 passed / 2 skipped / 0 failed** (Jest 30, 2 consecutive runs, stable, no flake), all 6 work units DONE, all 5 gate invariants (C1, C2, W1, W2, opt-in persistence) confirmed by passing tests + source inspection, ZERO CRITICAL, ZERO WARNING
- **Tasks**: 47/47 complete, 0 unchecked
- **Spec compliance**: pos-promotion-engine (NEW, 15 req / 37 scen) and sales (MODIFIED, +5 req / +15 scen) — both COMPLIANT with runtime test evidence

## Commits Archived (8 work-unit commits)

| Hash | Slice | Title |
|------|-------|-------|
| `a63c2c7` | U1 | `feat(promotions): add sale-promotion schema (promotionId, applied, veto tables)` |
| `61f7c03` | U2 | `feat(promotions): add POS promotion engine with eligibility and best-wins (unwired)` |
| `afeffda` | U3 | `feat(promotions): persist promotionId, veto set, and order-promo state on sales` |
| `c04af84` | U4 | `feat(promotions): apply promotions on draft mutations with live recompute` |
| `b1cd15f` | U5 | `feat(promotions): reflect promotions in charged totals and persist audit at charge` |
| `7ca052b` | U5 fix | `fix(promotions): keep sale-level subtotal/discount contract-correct at charge` |
| `7560f60` | U6 | `feat(promotions): add manual promotion apply/remove endpoints with veto` |
| `21a231c` | U6 fix | `fix(promotions): persist manual opt-in set and align charge-confirmation interface` |

Order: U1 → U2 → U3 → U4 → U5 → U5-fix → U6 → U6-fix. Two mid-stream fixes corrected gate findings caught by review (5.7 inline totals contract; 6.7 manual opt-in persistence).

Branch HEAD: `21a231c` on `feat/promo-sale-u6-endpoints`.

## What Shipped

Connected the existing `promotions` rule catalog (CRUD-only, no business impact) to the POS Sale draft flow so the price the seller sees is the price the customer pays. Built a brand-new POS-grade promotion engine `PosEvaluatePromotionsUseCase` (the existing `EvaluateCartPromotionsUseCase` is a partial stub for the chatbot path and stays untouched), wired it into every draft mutation + `chargeDraft`, exposed seller-facing endpoints for MANUAL opt-in / opt-out and AUTOMATIC veto, and added an additive schema (audit link + sale-level applied-promo + per-draft veto + per-draft opt-in set) — all without breaking any prior behavior.

The change ships:

1. **POS promotion engine** (`src/promotions/application/pos-evaluate-promotions.use-case.ts` + port in `src/promotions/application/ports/pos-evaluate-promotions.port.ts`):
   - Full eligibility: effective status (defense-in-depth), `[startDate, endDate]` inclusive, `daysOfWeek[]` (empty = open), `customerScope` (ALL/REGISTERED_ONLY/SPECIFIC with silent-skip until satisfied), `priceLists[]` (matches via **resolved** `appliedGlobalPriceListId`, NOT raw `appliedPriceListId` — fixes C1), `minPurchaseAmountCents` (ORDER only).
   - **Best-wins** selection per line (PRODUCT) and per sale (ORDER). Tiebreak = lowest `promotionId`. No stacking. 100% PERCENTAGE clamped to 99 in BOTH ranking and emission (W3) so best-wins ranks == applied discount.
   - **AUTOMATIC** auto-apply on every recompute (subject to veto). **MANUAL** opt-in only — never auto-applied, listed in `availableManualPromotions[]`.
   - **Manual free-form discount precedence** — manual-discounted lines untouched by auto-promo, manual discount preserved across recomputes.
   - **Per-draft veto set** — seller-removed auto-promos stay excluded on next recompute, do NOT remove a MANUAL promo that happens to share the id.
   - **Audit** — `PRODUCT_DISCOUNT` writes `promotionId` on the line (`SaleItem.promotionId`), `ORDER_DISCOUNT` writes a sale-level `SalePromotionApplied` record. Both persist across recomputes.
   - **Floor of 1¢** — `discounted unit >= 1c` via `applyDiscount` clamp (sale-item.entity.ts:248,283).

2. **Id-space resolver** (`ProductsService.resolvePriceListGlobalIds`, one batch query per recompute):
   - Resolves `appliedPriceListId` (per-product `PriceList.id`) → `globalPriceListId` (`GlobalPriceList.id`) once per recompute via tenant-scoped `PriceList.findMany`. Fixes C1 (two id spaces — promos restrict on global, lines carry per-product).
   - N+1-safe: single batch query, no per-line DB call.

3. **Domain + repository persistence** (`sale-item.entity.ts`, `sale.entity.ts`, `prisma-sale.repository.ts`):
   - `SaleItem.promotionId String?` + getter + toResponse exposure; `applyDiscount({ ..., promotionId })` accepts and stamps the audit link.
   - `Sale` gains `appliedOrderPromotion`, `vetoedPromotionIds`, `optedInManualPromotionIds` (3 new fields), `SaleFromPersistenceProps` defaults (`null`/`[]`), `fromPersistence` maps them (W2).
   - `Sale.previewTotals()` (single source of truth, C2) returns order-discount-aware `{ subtotalCents, discountCents, totalCents }`:
     - `subtotalCents = Σ(pre-discount base × qty)` where pre-discount base = `prePriceCentsBeforeDiscount ?? unitPriceCents` (S3, pre-promo base — recompute never compounds on re-entry).
     - `totalCents = max(0, postLineTotal − orderDiscountCents)` where `postLineTotal = Σ((unitPriceCents − lineDiscount) × qty)`.
     - `discountCents = subtotalCents − totalCents` (FULL savings — line + order, per `docs/sales-pos-charge-frontend.md:473-475`).
   - All FOUR read mappers (`findById`, `findByIdForUpdate`, `findDraftResponseById`, `findDraftsByUserId`) load veto + applied-promo + opt-in (W2). `save` uses delete-then-`createMany` for veto/applied-promo + promotionId write on items.
   - `persistChargeConfirmation` re-writes `SaleItem` rows inside the charge tx (W1) so charge-time recompute persists per-line audit, not just totals.

4. **Wire recompute on every draft mutation** (`sales.service.ts`):
   - `recomputePromotions(sale)` called after `addItem` (~610), `updateItemQuantity` (~675), `removeItem`, `assignCustomer` (~1234), `overrideItemPrice` (~1042), and inside `chargeDraft`'s transaction.
   - Idempotent: two recomputes back-to-back with no mutations = same applied list + same totals.
   - `overrideItemPrice` re-runs recompute on the new price, preserves auto-promo if it still best-wins, does NOT clear a manual free-form discount (only explicit `removeItemDiscount` does).
   - `chargeDraft` recomputes in-tx (tenant tx client), re-writes SaleItem rows (W1), then inline totals consume `Sale.previewTotals()` — same engine + same math = charged totals == draft totals from `getSaleDetail` (C2).

5. **Seller-facing endpoints** (`sales.controller.ts` + DTOs + CASL `update:Sale` guard):
   - `GET /sales/:id/applicable-promotions` — list applicable MANUAL promotions for the draft (with per-line computed discount).
   - `POST /sales/:id/manual-promotions/:promotionId` — opt in to a MANUAL promo; persists in `SalePromotionOptIn` (Unit 6 close-out), survives recomputes, cleared on explicit remove.
   - `DELETE /sales/:id/manual-promotions/:promotionId` — remove opt-in.
   - `DELETE /sales/:id/promotions/:promotionId` — remove an auto-applied AUTOMATIC promo; adds id to per-draft veto set. Does NOT mutate the `Promotion` catalog (status / method / discountValue all unchanged).

6. **Additive schema** (2 Prisma migrations, zero destructive ops):
   - `20260710041420_promotions_in_sale`: `ALTER TABLE "sale_items" ADD COLUMN "promotionId" TEXT` + FK `ON DELETE SET NULL` + index; `CREATE TABLE "sale_promotion_applied"` and `"sale_promotion_vetoes"` with tenantId, FKs (`Promotion` SetNull/Cascade, `Sale` Cascade), unique constraints.
   - `20260710061943_promotions_opt_in`: `CREATE TABLE "sale_promotion_opt_ins"` (per-draft MANUAL opt-in set).
   - `pnpm prisma migrate status`: "Database schema is up to date!" — 28 migrations applied, NO DRIFT. `promotions-in-sale-migration-drift.spec.ts` (16 tests) passes + asserts additivity.

7. **Strict TDD test coverage** (`+456` change tests on baseline, total 1656/2/0, 2 consecutive runs):
   - `pos-evaluate-promotions.use-case.spec.ts` — 34 it-blocks (eligibility × 6 gates + C1 + W3 + best-wins + manual + veto + manual-wins).
   - `prisma-promotion.repository.spec.ts` — `resolve-price-list-global-ids` (6 tests, 1-query N+1-safe, tenant-scoped).
   - `sale-item.entity.spec.ts` — `promotionId` describe (8 tests, audit link + applyDiscount).
   - `sale.entity.spec.ts` — `previewTotals` block (7 tests incl clamp-to-0 + S-1 guard), `appliedOrderPromotion` / `vetoedPromotionIds` / `optedInManualPromotionIds` getters.
   - `prisma-sale.repository.spec.ts` — W2 (four read mappers load veto + applied-promo + opt-in), opt-in delete-then-`createMany` save, W1 (`persistChargeConfirmation` item re-write + back-compat), C2 (`findDraftResponseById` order-discount totals).
   - `sales.service.spec.ts` — Work Unit 4/5/6 blocks (recompute on every mutation, idempotent double-run, overrideItemPrice re-apply, manual-discount preserved, charge recompute picks up qty change, C1 wiring test, 5.4/5.7 totals, manual list/apply/remove, veto persistence, opt-in round-trip).
   - `sales.controller.spec.ts` — 4 route tests (list-applicable, apply-manual, remove-manual, remove-applied).
   - `promotions-in-sale-migration-drift.spec.ts` — 16 tests, asserts additivity + zero drift across both migrations.

## Specs Synced into Source of Truth

| Domain | Action | Requirements |
|--------|--------|--------------|
| `sales` | **MODIFIED** (additive) | +5 requirements, +15 scenarios appended before `Verification Surface`; existing 6 requirements + Verification Surface preserved verbatim |
| `pos-promotion-engine` | **NEW** | Created from delta with `## Purpose` + `## Requirements` + `## Verification Surface` sections; 15 requirements, 37 scenarios |

### `sales` canonical spec — final shape

All 6 existing requirements (`Bot Sale Registration`, `Bot Sale Event Emission`, `Bot Sale Idempotency`, `Canceled Sales Remain Queryable But Are Excluded From CONFIRMED Reporting`, `Stock Decrement Returns Threshold Crossings`, `Sales Orchestrator Dispatches Low-Stock Alerts Via Durable Outbox`) preserved verbatim. The 5 new requirements (`Draft Mutations Trigger Recompute`, `chargeDraft Totals Consistent With getSaleDetail`, `Price-List Override Re-Runs Recompute Without Wiping Promo Discounts`, `Manual Apply And Remove Endpoints For MANUAL Promotions`, `Remove Endpoint For AUTOMATIC Promotions Feeds The Veto Set`) inserted before `Verification Surface`. Verification Surface expanded to reference the new test files (sales.service/controller + sale.entity + sale-item.entity + prisma-sale.repository + pos-evaluate-promotions + prisma-promotion + promotions-in-sale-migration-drift).

**Final baseline `sales` spec totals**: **11 requirements**, **34 scenarios** (15 promotion-related + 19 from the 6 prior requirements, distributed across `Bot Sale Registration` 3, `Bot Sale Event Emission` 2, `Bot Sale Idempotency` 2, `Canceled Sales Queryable` 2, `Stock Decrement Threshold Crossings` 5, `Sales Orchestrator Low-Stock Alerts` 5, `Draft Mutations Trigger Recompute` 5, `chargeDraft Totals Consistent With getSaleDetail` 2, `Price-List Override Re-Runs Recompute Without Wiping Promo Discounts` 3, `Manual Apply And Remove Endpoints For MANUAL Promotions` 3, `Remove Endpoint For AUTOMATIC Promotions Feeds The Veto Set` 2).

Delta format (`## ADDED Requirements` only — no `MODIFIED`, no `REMOVED`, no `RENAMED`) was correctly handled as APPEND of new requirements — no existing requirement block was replaced or removed.

### `pos-promotion-engine` canonical spec — final shape

New capability spec at `openspec/specs/pos-promotion-engine/spec.md`. Created from the delta's 15 ADDED requirements, with `## Purpose` section added on top and `## Verification Surface` appended at the end matching the existing canonical-spec convention. Requirements (15): `Eligibility — Effective Status` (2 scen), `Eligibility — Date Window` (2), `Eligibility — Day Of Week` (2), `Eligibility — Customer Scope With Silent Skips` (4), `Eligibility — Price Lists` (3), `Eligibility — ORDER_DISCOUNT Minimum Purchase` (2), `PRODUCT_DISCOUNT Matches Target Items` (2), `PRODUCT_DISCOUNT Computed On Effective Per-Line Price` (3), `ORDER_DISCOUNT Applied At Sale Level` (2), `Best-Wins Selection Per Line And Per Sale` (3), `AUTOMATIC Promotions Auto-Apply` (2), `MANUAL Promotions Require Explicit Opt-In` (2), `Manual Free-Form Discount Precedence` (2), `Per-Draft Veto Of Auto-Applied Promotions` (3), `Audit — Promotion ID On Line And Sale-Level Record` (3) = **15 requirements, 37 scenarios** + Verification Surface.

## Design Coherence (reconciled at archive per gate deferral)

The gate flagged that the design.md still described the OLD `subtotalCents = Σ(unitPrice·qty)` formula in three locations (lines 19, 55, 127, 129). All four were reconciled at archive time to the contract-correct model shipped by the code (verified PASS at `21a231c`):

- `subtotalCents = Σ(pre-discount base × qty)` where pre-discount base = `prePriceCentsBeforeDiscount ?? unitPriceCents` (S3, pre-promo base)
- `totalCents = max(0, postLineTotal − orderDiscountCents)` where `postLineTotal = Σ((unitPriceCents − lineDiscount) × qty)`
- `discountCents = subtotalCents − totalCents` (FULL savings — line + order, per `docs/sales-pos-charge-frontend.md:473-475`)
- Single source of truth: `Sale.previewTotals()` (sale.entity.ts:468-508), consumed by both `findDraftResponseById` (draft preview, C2) and `chargeDraft` inline totals (charge confirm, C2)

The reconciled design.md is the archived audit trail — line 19 (decision row) and lines 55 / 127 / 129 (data flow + charge placement + draft-preview explanation) now match the shipped contract. Line 115 (S3) was already correct.

## Gate Findings Caught & Fixed Mid-Stream

| Tag | Severity | Found during | Fix commit | What |
|-----|----------|--------------|------------|------|
| **C1** | CRITICAL | U2 design review | `61f7c03` (built correctly first time, no fix commit) | Price-list id-space mismatch: promos restrict on `PromotionPriceList.globalPriceListId`, lines carry `appliedPriceListId` (per-product `PriceList.id`). Comparing raw `appliedPriceListId` against `globalPriceListId` never matches → every price-list-restricted promo silently ineligible. Fix: `resolvePriceListGlobalIds` batch resolver (1 tenant-scoped query per recompute) maps each `PosEvalLine.appliedGlobalPriceListId` from `PriceList.findMany`. |
| **C2** | CRITICAL | U4 implementation review (gated, deferred to archive) | `7ca052b` (U5 fix) | Sale-level subtotal/discount contract mismatch: `totalCents = 0` for drafts (`Sale.toResponse()` returns `this.totalCents`), so ORDER_DISCOUNT never reached the charged amount via `getSaleDetail`. Fix: `Sale.previewTotals()` (single source of truth) + `findDraftResponseById` spreads it over `toResponse()` so draft preview and charge share the same math. |
| **W1** | WARNING | U5 review | `b1cd15f` (built into U5 commit) | Charge tx recompute persists totals but NOT per-line audit (because `persistChargeConfirmation` only updates Sale + SalePayment rows, unlike `save`'s delete-then-`createMany`). Fix: tenant+tx-scoped `SaleItem` re-write step inside `runInTransaction`, before `persistChargeConfirmation`. |
| **W2** | WARNING | U3 implementation | `afeffda` (built into U3 commit) | Veto + applied-promo loaded only through some read mappers → state loss on reload. Fix: ALL FOUR read mappers (`findById`, `findByIdForUpdate`, `findDraftResponseById`, `findDraftsByUserId`) load veto + applied-promo + opt-in. |
| **W3** | WARNING | U2 design review | `61f7c03` (built correctly first time) | 100% PERCENTAGE promo: `applyDiscount` clamps to 99 but ranking comparator could see the pre-clamp 100% value → best-wins could pick a worse "ranked" promo than what actually applies. Fix: engine clamps `percent` to 99 in BOTH ranking and emitted `discountValue` so ranking value == applied value. |
| **Opt-in persistence** | WARNING (close-out) | U6 review | `21a231c` (U6 fix) | MANUAL opt-in set was applied in-memory but not persisted to `SalePromotionOptIn` (table existed but no save path) + `ISaleRepository.persistChargeConfirmation` interface misaligned with the new item re-write step. Fix: `SalePromotionOptIn` migration + opt-in loaded through all four read mappers + save delete-then-`createMany` + round-trip test + interface alignment (U5 source tsc error at sales.service.ts:2053 cleared). |

All 5 gate invariants confirmed PASS by runtime tests + source inspection (see verify-report.md for evidence).

## Spec Compliance Matrix (37 + 15 scenarios → test → RESULT)

### pos-promotion-engine (15 req / 37 scen) — NEW

| # | Spec requirement | Covering test(s) | Result |
|---|---|---|---|
| 1 | Eligibility — Effective Status (2 scen) | engine spec status describe; effective-status does NOT exclude | ✅ PASS |
| 2 | Eligibility — Date Window (2) | engine spec dateWindow describe; inclusive endDate | ✅ PASS |
| 3 | Eligibility — Day Of Week (2) | engine spec dayOfWeek describe; empty opens gate | ✅ PASS |
| 4 | Eligibility — Customer Scope With Silent Skips (4) | engine spec customerScope describe; SPECIFIC silent-skip then auto-apply | ✅ PASS |
| 5 | Eligibility — Price Lists (3) | engine spec C1 describe; resolver test; open/restricted/no-list | ✅ PASS |
| 6 | Eligibility — ORDER_DISCOUNT Minimum Purchase (2) | engine spec minPurchase describe; below / at minimum | ✅ PASS |
| 7 | PRODUCT_DISCOUNT Matches Target Items (2) | engine spec appliesTo describe; PRODUCTS by productId; CATEGORIES (scenario documented, engine restricts to PRODUCTS — see DEFERRED) | ✅ PASS (PRODUCTS) / DEFERRED (CATEGORIES) |
| 8 | PRODUCT_DISCOUNT Computed On Effective Per-Line Price (3) | engine spec per-line math describe; sale-item.entity promotionId describe | ✅ PASS |
| 9 | ORDER_DISCOUNT Applied At Sale Level (2) | engine spec order describe; sale.appliedOrderPromotion getter | ✅ PASS |
| 10 | Best-Wins Selection Per Line And Per Sale (3) | engine spec best-wins describe; tie→lowest id; no stacking | ✅ PASS |
| 11 | AUTOMATIC Promotions Auto-Apply (2) | engine spec AUTOMATIC describe; service U4 addItem recompute | ✅ PASS |
| 12 | MANUAL Promotions Require Explicit Opt-In (2) | engine spec MANUAL describe; opt-in round-trip test (U6 close-out) | ✅ PASS |
| 13 | Manual Free-Form Discount Precedence (2) | engine spec manual-wins describe; service U5 overrideItemPrice preserves | ✅ PASS |
| 14 | Per-Draft Veto Of Auto-Applied Promotions (3) | engine spec veto describe; service U6 remove endpoint; integration persist→recompute→excluded | ✅ PASS |
| 15 | Audit — Promotion ID On Line And Sale-Level Record (3) | sale-item.entity promotionId describe; sale.entity appliedOrderPromotion getter; repo W1 block | ✅ PASS |

### sales MODIFIED (5 req / 15 scen)

| # | Spec requirement | Covering test(s) | Result |
|---|---|---|---|
| 1 | Draft Mutations Trigger Recompute (5 scen) | service spec U4 blocks: addItem, updateItemQuantity, assignCustomer, removeItem, idempotent double-run | ✅ PASS |
| 2 | chargeDraft Totals Consistent With getSaleDetail (2) | service spec U5 5.3 + 5.4 (C2) blocks; repo findDraftResponseById C2 | ✅ PASS |
| 3 | Price-List Override Re-Runs Recompute Without Wiping Promo Discounts (3) | service spec U5 5.1 block (override re-applies, manual-discount preserved) | ✅ PASS |
| 4 | Manual Apply And Remove Endpoints For MANUAL Promotions (3) | service spec U6 blocks; controller routes; opt-in round-trip | ✅ PASS |
| 5 | Remove Endpoint For AUTOMATIC Promotions Feeds The Veto Set (2) | service spec U6 6.4 block; veto persists across recompute | ✅ PASS |

## TDD Compliance Audit (strict TDD module)

| Check | Result |
|-------|--------|
| TDD Evidence in apply-progress | ✅ Found (Engram #2839 verify-report; RED→GREEN per work unit) |
| All tasks have tests | ✅ 47/47 backed (change tests: 456 passing / 0 failing / 0 skipped) |
| RED confirmed (test files exist) | ✅ engine + entity + repo + service + controller spec files present |
| GREEN confirmed (tests pass) | ✅ 1656/2/0 on full suite (2 consecutive runs, stable) + 456/0/0 on targeted change suite |
| Triangulation adequate | ✅ multi-case per behavior (best-wins 2-of vs 3-way tiebreak; override + manual-discount coexistence; veto + manual-promo coexistence; opt-in round-trip) |
| Assertion quality | ✅ No tautologies. W1 (item re-write) asserts `promotionId`/`discountAmountCents` on post-charge SaleItem rows. W2 (veto persistence) asserts state across all four read mappers. C1 (id-space) asserts resolver is the only DB call. C2 (totals) asserts previewTotals is the source — repo C2 + service 5.4/5.7. U6 close-out (opt-in) asserts delete-then-createMany round-trip through 4 mappers. |

## Archive Contents

- `proposal.md` ✅
- `explore.md` ✅ (preserved as-is; older naming convention — file existed at this name in active change)
- `design.md` ✅ (reconciled at archive — 4 inline total formulas updated to contract-correct model per gate deferral)
- `tasks.md` ✅ (47/47 tasks complete, 0 unchecked; CATEGORIES/BRANDS deferral noted as DEFERRED, not gap)
- `specs/pos-promotion-engine/spec.md` ✅ (delta-style spec preserved for audit trail)
- `specs/sales/spec.md` ✅ (delta-style spec preserved for audit trail)
- `archive-report.md` ✅ (this file)

## Source-of-Truth Files Updated

The following main specs now reflect the new behavior:

- `openspec/specs/sales/spec.md` — 5 ADDED requirements + 15 scenarios appended before `Verification Surface`. All 6 prior requirements preserved verbatim. Verification Surface expanded with new test files. Total: **11 requirements, 45 scenarios**.
- `openspec/specs/pos-promotion-engine/spec.md` — NEW canonical spec (15 requirements, 37 scenarios) + Purpose + Verification Surface.

No other main spec required modification.

## Engram Observations for Traceability

| Topic | Obs ID | Purpose |
|-------|--------|---------|
| `sdd/promotions-in-sale/verify-report` | #2839 | Verify PASS — 1656/2/0, 2 consecutive runs, all 5 gate invariants confirmed |
| `sdd/promotions-in-sale/archive-report` | (this save) | This archive report |

## Archive Notes

- Branch `feat/promo-sale-u6-endpoints` is **NOT merged to main** and is **NOT pushed**. The solo dev merges manually after archive; this is intentional per the developer's normal workflow (no PRs, chained work-unit branches).
- No production source code or tests were modified during archive. Only spec/artifact movement (`openspec/specs/sales/spec.md` append + new `openspec/specs/pos-promotion-engine/spec.md` + design.md reconciliation + tasks.md checkoff + `openspec/changes/promotions-in-sale/` → `openspec/changes/archive/2026-07-10-promotions-in-sale/` move) and the new `archive-report.md`.
- The 8 implementation commits (U1 → U2 → U3 → U4 → U5 → U5-fix → U6 → U6-fix) remain intact in the branch history (HEAD = `21a231c`). They will land on `main` when the dev merges manually.
- `openspec/changes/archive/2026-07-10-promotions-in-sale/` is now the immutable audit trail.
- The delta-style specs at `openspec/changes/archive/2026-07-10-promotions-in-sale/specs/{sales,pos-promotion-engine}/spec.md` are preserved verbatim. The merged baseline specs are at `openspec/specs/sales/spec.md` and `openspec/specs/pos-promotion-engine/spec.md`.
- The `explore.md` file is preserved with its original filename (NOT renamed to `exploration.md` — both names appear in prior archives; the audit trail reflects what the change folder contained).

## DEFERRED — User Action Required After Merge

### Spec scenarios explicitly DEFERRED (NOT gaps, NOT failed tests)

1. **`PRODUCT_DISCOUNT` CATEGORIES targeting** — `pos-promotion-engine` spec scenario "CATEGORIES targeting matches by category id". Reason: requires `SaleItem` category/brand snapshot columns (separate additive change). Engine source restricts `appliesTo` to `'PRODUCTS'` (`use-case.ts:213, 247`) and documents the deferral (`use-case.ts:22, 208`). Engine tests only assert PRODUCTS targeting — no test falsely claims CATEGORIES passes.
2. **`PRODUCT_DISCOUNT` BRANDS targeting** — `pos-promotion-engine` spec "PRODUCT_DISCOUNT Matches Target Items" BRANDS clause (`spec.md:112`). Same reason as CATEGORIES.

Correctly excluded from gap accounting — these are NOT implementation gaps; they are intentional scope deferrals documented in `tasks.md` (DEFERRED section) and `design.md` (S1).

### Proposal non-goals (out of scope by design, not "spec scenarios")

These were explicitly listed as non-goals in the proposal (`proposal.md:19-20`) and are NOT part of any spec:

- `BUY_X_GET_Y` promotion evaluation
- `ADVANCED` promotion evaluation
- Usage limits / caps (global or per-customer) — no such fields exist on the `Promotion` model
- Tax model — `Sale`/`SaleItem` are tax-agnostic; no tax field
- Priority / stacking fields — best-wins by max customer discount in cents, tiebreak by lowest `promotionId`
- All frontend work — backend + DB + domain only

## SDD Cycle Complete

The change has been fully explored, proposed, specified, designed, broken into tasks, implemented across 8 work-unit commits (U1→U2→U3→U4→U5→U5-fix→U6→U6-fix), verified PASS (**1656/2/0** stable across 2 consecutive runs; 456/0/0 on change-targeted suite; all 5 gate invariants confirmed by passing tests + source inspection), reconciled (design.md totals contract corrected at archive per gate deferral), and the baseline specs (`sales` + new `pos-promotion-engine`) are now the new source of truth. Ready for the next change.