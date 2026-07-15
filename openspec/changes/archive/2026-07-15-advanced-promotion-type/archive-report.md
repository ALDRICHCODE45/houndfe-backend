# Archive Report — advanced-promotion-type

**Change**: advanced-promotion-type
**Branch**: `feat/advanced-promotion-type` (delivered — NOT yet merged to main; maintainer merges locally)
**Head at archive**: `576cd80` — `test(promotions): lock D3 100% free ADVANCED at qty=1 (previewTotals + e2e)`
**Mode**: openspec
**Date archived**: 2026-07-15 (ISO)
**Final commit on archive**: see git log after archive move

## Executive summary

The previously DEFERRED compound `ADVANCED` promotion type is now ACTIVE
in the POS promotion engine. The change wires the **read/apply half** of
a write path that has been provisioned since the multi-tenant foundation
and stubbed by the `buy-x-get-y` change — no `PromotionType` enum, no
targeting DTO, no `PromotionTargetItem` change was needed; this slice
adds the engine admission, a side-aware target tier matcher, a pure
cross-line reward helper, a new `evaluateAdvancedPass` slotted between
`BUY_X_GET_Y` and `ORDER_DISCOUNT`, a persisted `rewardKind = 'advanced'`
discriminator distinct from `buy_x_get_y`, a 3-way cross-type
best-wins comparator, the D7 BUY/GET disjoint guard at intake (with a
matching engine-level partition for cross-entity overlap), and the D3
true-100% "free" path that reuses the BXGY rail with the guard relaxed
`>=` → `>`. Delivered across **10 work units** in 3 chained slices on a
single branch (`feat/advanced-promotion-type`); all 22 implementation
tasks check off, all **8 locked decisions (D1–D8)** implemented and
load-bearing-tested, **23/24 spec scenarios COMPLIANT** (1 PARTIAL on
D3 qty=1 chain — defense-in-depth coverage gap, not a behavior gap),
**811 unit + 27 integration tests** GREEN in 1.8s, full
`pnpm run build` EXIT 0, `prisma migrate diff` zero-drift outside the
additive D4 migration, DEFAULT PD/BXGY unregressed (engine family 195
GREEN + BXGY integration 20/20).

The change went through a **4R review** that surfaced **4 load-bearing
blockers / 1 cosmetic** in one scoped correction transaction
(3 fix commits + 1 docs commit on the same branch, no PR), then a
follow-up commit (`576cd80`) to close the residual D3 qty=1 chain
coverage gap. Verify **PASS WITH WARNINGS** (shippable; defense-in-depth
recommendation already closed in the archive window).

## What shipped

| Capability | Before | After |
|------------|--------|-------|
| Engine admission | `isSupportedEngineType` returned `false` for `ADVANCED` | Admits `ADVANCED` for PRODUCTS/VARIANTS/CATEGORIES/BRANDS on BOTH sides |
| Target tier matcher | `matchTargetTier` ignored BUY/GET `side` (always DEFAULT) | Side-aware: `matchTargetTier(items, line, side: 'DEFAULT' \| 'BUY' \| 'GET')`; DEFAULT contract preserved byte-for-byte |
| Reward helper | None for ADVANCED | Pure `computeAdvancedReward({totalBuyMatchedQty, buyQuantity, getQuantity, getDiscountPercent, getCandidateLines})` — mirrors `computeBuyXGetYReward`; deterministic lowest-`itemId` GET-line allocation; `take = min(line.quantity, remaining)` clamp bounds `R ≤ line value` |
| Engine pass | None — engine gate rejected ADVANCED before any pass | `evaluateAdvancedPass` slots after BXGY (`:283`) and before ORDER (`:304`); aggregates BUY-side matches across all cart lines; emits `PosEvalAdvancedLineResult` on GET lines; zero-skip + BUY/GET partition (D7) |
| Cross-type best-wins | 2-way: PD vs BXGY | 3-way: PD vs BXGY vs ADVANCED, by max real per-line total saving; tie → lowest `promotionId`; no stacking |
| ADVANCED GET-side cap | `validateGetDiscountPercent` capped ADVANCED at 99 | Cap LIFTED to 100 (D3); entity accepts 100, rejects `> 100`; ADVANCED 100% flows through `applyBuyXGetYReward` rail with guard relaxed `>=` → `>` so `R == line` is valid |
| Wire discriminator | Column-derived `isBuyXGetYReward()` cannot distinguish BXGY from ADVANCED; would silently emit `buy_x_get_y` on ADVANCED rows | Persisted enum `SaleItemRewardKind { BUY_X_GET_Y, ADVANCED }` + nullable `rewardKind` column on `SaleItem`; additive migration with backfill; **all four draft reload mappers forward `rewardKind`** (4R fix); `applyBuyXGetYReward` now accepts `rewardKind?: 'buy_x_get_y' \| 'advanced'` (default `buy_x_get_y`) |
| BUY/GET disjointness | Not enforced | Intake rejects same-entity BUY/GET at create + update (`advanced_overlapping_targets`); engine-level `buyMatchedItemIds` partition excludes BUY lines from the GET pool for cross-entity overlap |
| Idempotent recompute | n/a (no ADVANCED pass) | Mirrors BXGY: clears prior ADVANCED reward each recompute; 5× byte-equal `SaleItem` rows + byte-equal `previewTotals` |
| Cross-line pass ordering | n/a | PD → BXGY → **ADVANCED** → ORDER_DISCOUNT — first cross-line pass |
| MANUAL scope | n/a | Untouched. ADVANCED is AUTOMATIC-only (D6); MANUAL surface, self-heal, `availableManualPromotions`, `targetableManualPromotionIds` not extended |
| Min-amount threshold | n/a | Not added. BUY threshold is quantity-only (D8); entity ADVANCED case forbids `minPurchaseAmountCents` |

## Locked product decisions (D1–D8, all implemented)

| # | Decision | Where locked / proven |
|---|----------|------------------------|
| **D1** | BUY-side matching aggregated across all cart lines whose entity hits a BUY-side target | `evaluateAdvancedPass:1281-1286` sums `line.quantity` over `matchTargetTier(..., 'BUY')` hits; S1 + INT-S1 + INT-S2 multi-group; `advanced.spec.ts` |
| **D2** | `rewardGroupCount = floor(totalBuyMatchedQty / buyQuantity)`; repeated per group | Pass (`:1289`) + pure helper `:160`; S2 multi-group (qty6/3 → 2 apps, 600c); `sale.entity.spec.ts:2376` |
| **D3** | GET-side discount percentage up to 100 (true free); `> 100` rejected; reuses BXGY `applyDiscount` clamp | `validateGetDiscountPercent` accepts 100 / rejects `> 100`; apply rail guard relaxed `>=`→`>` at `sale-item.entity.ts:432`; helper `take = min(line.quantity, remaining)` mathematically bounds `R ≤ line`; INT-S6 + `sale-item.entity.spec.ts:897` runtime-proven at qty=1 R==line |
| **D4** | Wire emits `rewardKind: 'advanced'` (NOT `buy_x_get_y`); persisted discriminator required | `SaleItemRewardKind` enum + nullable column + backfill; mapper + **all four draft reload mappers** (4R fix `b082c88`); `prisma-sale.repository.spec.ts:2733/2751/2767/2783` |
| **D5** | GET-line 3-way best-wins by max total saving; tie → lowest id | `evaluateAdvancedPass` comparator + `computeAppliedDiscountCents:1060` ORDER base; S5 (ADVANCED 50% beats PD 20%); tie→lowest id |
| **D6** | AUTOMATIC-only this slice; MANUAL ADVANCED silently skipped at gate | `evaluateAdvancedPass:1259` `if (promo.method !== 'AUTOMATIC') continue`; MANUAL candidate surface untouched |
| **D7** | BUY/GET disjoint (intake) + engine partition (cross-entity overlap) | Intake `assertAdvancedSideTargets` rejects same-entity (`advanced_overlapping_targets`); engine `buyMatchedItemIds` partition at `:1319`; `advanced.spec.ts:801` + `:839` |
| **D8** | Quantity-only BUY threshold; no `minPurchaseAmountCents` | Engine gates on `totalBuyMatchedQty >= buyQuantity` only; entity ADVANCED case forbids `minPurchaseAmountCents` |

## Review + correction record

**Initial verify** returned **FAIL** with 1 CRITICAL blocker: an AUTOMATIC 100% ADVANCED reward on a single GET unit (qty=1) reached `applyBuyXGetYReward` and threw `BXGY_REWARD_INVALID` — a reachable POS 500.

The 4R review surfaced **5 issues** (4 load-bearing blockers + 1 cosmetic). All five fixes landed in RED→GREEN→commit work-unit commits on the same branch; no PR was opened.

| Fix | Severity | Source (confirmed on-disk) | Commit | RED test summary |
|-----|----------|----------------------------|--------|------------------|
| 1 | **BLOCKER** (D3 qty=1 crash) | `sale-item.entity.ts:432` guard `>=`→`>` (`R == unitPriceCents*quantity` is valid; `<= 0` still throws at `:426`) | `3250a11` | `sale-item.entity.spec.ts:897` — qty=1 @ 1000c, `applyBuyXGetYReward({R:1000, rewardKind:'advanced'})` → `.not.toThrow()`, `toResponse().subtotalCents === 0`, `rewardKind === 'advanced'`; `:962` R=1001 still throws |
| 2 | **CRITICAL** (D7 cross-entity double-benefit) | `use-case.ts:1280/1285/1319` — `buyMatchedItemIds = new Set`, populate on BUY hit, skip in GET pool | `015a3c3` | `advanced.spec.ts:801` BUY=PRODUCTS:P, GET=CATEGORIES:C, P ∈ C, single P line → no ADVANCED result; `:839` disjoint P+Q rewards Q correctly, P not |
| 3 | Zero-cent reward skip (mirrors BXGY `:1176`) | `use-case.ts:1350` `if (reward.lineDiscountCents <= 0) continue` | `015a3c3` | `advanced.spec.ts:913` 1c@1% → perUnit=0 → no result, no throw; `:956` 50c@1% → perUnit=1 → still emitted |
| 4 | Draft reload mislabel — 4 reload mappers forward `rewardKind` | `prisma-sale.repository.ts` `findById:306`, `findDraftResponseById:435`, `findDraftsByUserId:576`, `findByIdForUpdate:707` (enum→lowercase) | `b082c88` | `prisma-sale.repository.spec.ts:2733/2751/2767/2783` — each of the 4 mappers surfaces `rewardKind='advanced'` on a reloaded ADVANCED draft (not `buy_x_get_y`) |
| 5 | Cosmetic — inline `side` (no `effectiveSide` alias); fix `Intakerejects` typo | use-case + advanced.spec | `015a3c3` (folded) | n/a |

A follow-up `576cd80` then **closed the residual D3 qty=1 chain coverage gap** (recommended in the initial verify) — added `previewTotals().totalCents = 0` at qty=1 + upgraded INT-S6 to qty=1. **No further blockers.**

## Test evidence (re-verification pass)

| Run | Command | Suites | Tests | Exit | Hash |
|-----|---------|--------|-------|------|------|
| U1 (advanced core) | `pnpm run test:unit -- match-target-tier.spec pos-evaluate-promotions.advanced-helper pos-evaluate-promotions.advanced.spec promotion.entity.spec promotions-validate-side-disjoint` | 5 | 138 ✅ | 0 | `sha256:920a0cd4…0349f937` |
| U2 (sales/persistence) | `pnpm run test:unit -- sale-item.entity.spec sale.entity.spec sales.service.spec prisma-sale.repository.spec` | 4 | 478 ✅ | 0 | `sha256:9a312de2…9973a10b` |
| U3 (engine regression) | `pnpm run test:unit -- pos-evaluate-promotions promotions.service.spec` | 8 | 195 ✅ | 0 | `sha256:5358220a…a87b586e` |
| INT (live :5433) | `pnpm run test:integration -- advanced-promotion-type.integration.spec --runInBand` | 1 | 7 ✅ | 0 | `sha256:6902099c…8e72450e` |
| INT-BXGY (live :5433) | `pnpm run test:integration -- buy-x-get-y.integration.spec --runInBand` | 1 | 20 ✅ | 0 | `sha256:5e207821…ebde309e` |

**Total**: 811 unit + 27 integration across 5 filtered runs, 0 failures, 0 skips.
**Build**: `pnpm run build` → EXIT 0. `sha256:9d14ccf5…30026df898`
**Migration drift**: `npx prisma migrate diff --from-url <5433 test DB> --to-schema-datamodel prisma/schema.prisma --exit-code` → "No difference detected". `sha256:d7c9882d…f4f818a1` (32 migrations applied; zero drift).

U3 re-runs the full `pos-evaluate-promotions.*` family (PD, ORDER, BXGY, advanced) — DEFAULT PD/BXGY behavior preserved (regression GREEN). INT-BXGY 20/20 confirms the shared-rail guard relaxation did NOT regress BUY_X_GET_Y.

## Spec compliance matrix (23/24 COMPLIANT, 1 PARTIAL — defense-in-depth only)

Full matrix in `verify-report.md`. Highlights:

- **D1**: 3 scenarios COMPLIANT (S1 many-small-lines, single-line ≥ N, out-of-target excluded).
- **D2**: 2 scenarios COMPLIANT (S2 six/three → 600c, below buyQty → 0 groups).
- **D3**: 1 COMPLIANT (>100 rejected), 1 PARTIAL — apply-rail guard edge (qty=1 R==line → no throw, NET=0) is **runtime-proven** at the entity unit test; `Sale.previewTotals().totalCents=0` aggregate at qty=1 closed by `576cd80` (the archive-window follow-up). The initial verify flagged this as a coverage gap; the archive-window commit closes it.
- **D4**: 2 COMPLIANT (ADVANCED emits `rewardKind='advanced'` on apply + reload + receipt; BXGY still emits `buy_x_get_y`).
- **D5**: 2 COMPLIANT (S5 ADVANCED 50% > PD 20%; tie → lowest id).
- **D6**: 2 COMPLIANT (AUTOMATIC auto-applies; MANUAL silently skipped, manual surface unchanged).
- **D7**: 3 COMPLIANT (S3 same-entity rejected; cross-entity accepted; 4R engine partition closes cross-entity overlap).
- **D8**: 1 COMPLIANT (quantity only; entity forbids `minPurchaseAmountCents`).
- **Cross-line pass placement**: COMPLIANT (ADVANCED saving flows into ORDER_DISCOUNT subtotal — INT S7).
- **Idempotent recompute**: COMPLIANT (5× byte-equal + previewTotals converge).
- **Degenerate cart**: COMPLIANT (S4 BUY met, no GET → no reward).
- **Eligibility gate**: 2 COMPLIANT (PRODUCTS buy / CATEGORIES get admitted; null target type silently skipped).
- **Side-aware target tier**: 2 COMPLIANT (BUY-side matches only when side=BUY; DEFAULT unchanged for PD/BXGY).

## Source-of-truth updates (base spec `openspec/specs/pos-promotion-engine/spec.md`)

The canonical base spec now reflects the SHIPPED ADVANCED behavior. The delta spec was synced and the stale non-requirement wording flagged in the archive notes was corrected.

- **Purpose** updated to enumerate `PRODUCT_DISCOUNT` + `BUY_X_GET_Y` + **`ADVANCED`** + `ORDER_DISCOUNT`, the 3-way cross-type comparator, the ADVANCED cross-line pass placement, the type-aware 100% "free" cap (BOTH reach 100, `> 100` rejected for both), the disjoint BUY/GET intake guard, the quantity-only BUY threshold, and the `rewardKind = 'advanced'` wire discriminator. Removed "ADVANCED stays capped at 99".
- **BUY_X_GET_Y "Free" (100%)** MODIFIED — the requirement body now states BOTH types reach 100, the wire emits `rewardKind` distinguishing the two, and a `> 100` rejection covers both types. Includes the explicit `(Previously: ...)` historical note recording the D3 lift.
- **13 ADDED requirements** appended covering: Eligibility — Engine Gate; Side-Aware Target Tier Match; BUY-Side Aggregated Counting (D1); Per-Group Reward Repeatability (D2); GET-Side Magnitude Up To and Including 100% (D3, true-free); `rewardKind: 'advanced'` Wire Discriminator (D4); GET-Line Best-Wins By Maximum Total Saving (D5); AUTOMATIC-Only Scope (D6); Disjoint BUY/GET Entities (D7, with the 4R cross-entity overlap scenario); Quantity-Only Threshold (D8); Cross-Line Pass Placement; Idempotent Recompute; Degenerate Cart.
- **Verification Surface** updated — `promotion.entity.spec.ts` entry now reads "ADVANCED 100% accepted — cap lifted (D3); `> 100` rejected for both types; ADVANCED forbids `minPurchaseAmountCents` for D8" (was "ADVANCED 100% throws — type-aware cap"). New entries added for `pos-evaluate-promotions.advanced-helper.spec.ts`, `pos-evaluate-promotions.advanced.spec.ts`, `match-target-tier.spec.ts` rewrite note, `promotions-validate-side-disjoint.spec.ts`, `advanced-promotion-type.integration.spec.ts`, and ADVANCED extensions on the sales-side specs.
- The `W3 99% clamp` reference in `pos-evaluate-promotions.use-case.spec.ts` is **preserved** — it is the engine-side defensive `clampPercentageToSafeRange` for the `applyDiscount` path, used by PRODUCT_DISCOUNT. The D3 lift is **entity-side only** for ADVANCED, and ADVANCED 100% **bypasses** `applyDiscount` entirely via the rail. The W3 clamp does not constrain the ADVANCED path.

Confirmed via grep: no remaining "ADVANCED stays capped at 99" or "ADVANCED 100% throws — type-aware cap" wording in the base spec.

## Archive contents (moved under `openspec/changes/archive/`)

- `proposal.md` ✅ — intent, locked decisions D1–D8, approach A vs B vs C, scope and out-of-scope, success criteria, rollback plan.
- `exploration.md` ✅ — verified ground-truth drift log; representation gap discovery; engine seams line-verified.
- `design.md` ✅ — 5 architecture decisions; data flow showing pass order PD → BXGY → **ADVANCED** → ORDER; interfaces and file changes (line-verified).
- `specs/pos-promotion-engine/spec.md` ✅ — v1 delta (1 MODIFIED + 13 ADDED requirements, 24 scenarios + the verification surface), with engine seams and archive notes preserved for traceability.
- `tasks.md` ✅ — 22 implementation checkboxes complete + 3 post-impl/cleanup gate items; the 4R correction record (5 fixes) and the W3 budget forecast preserved.
- `verify-report.md` ✅ — re-verification report (PASS WITH WARNINGS); build GREEN, zero migration drift, 23/24 scenarios COMPLIANT, correction-under-validation table, spec compliance matrix.
- `archive-report.md` ✅ (this file) — closure summary.

## File changes (28 files, +6012/−115 vs `origin/main`)

| Area | Files |
|------|-------|
| Engine | `pos-evaluate-promotions.use-case.ts`, `match-target-tier.spec.ts` (rewrite), `ports/pos-evaluate-promotions.port.ts` |
| Engine pass / pure helper | `pos-evaluate-promotions.advanced.spec.ts` (NEW), `pos-evaluate-promotions.advanced-helper.spec.ts` (NEW) |
| Entity | `promotion.entity.ts` (D3 cap lift), `promotion.entity.spec.ts` (D3 RED→GREEN) |
| Intake guard | `promotions.service.ts` (D7 `assertAdvancedSideTargets`), `promotions-validate-side-disjoint.spec.ts` (NEW) |
| Sales apply | `sales.service.ts` (ADVANCED route arm), `sales.service.spec.ts` (idempotent 5× byte-equal) |
| Sales entity | `sale-item.entity.ts` (`rewardKind` input + persist + toResponse + clear; D3 guard relax `>=`→`>`) |
| Sales mapper | `prisma-sale.repository.ts` (4 reload mappers + receipt mapper) |
| Migration | `prisma/schema.prisma` (`enum SaleItemRewardKind`, nullable `rewardKind` on `SaleItem`); `prisma/migrations/<timestamp>_add_sale_item_reward_kind/` (CREATE TYPE + ADD COLUMN + backfill `UPDATE ... WHERE promotionId IS NOT NULL AND prePriceCentsBeforeDiscount = unitPriceCents AND discountAmountCents > 0`) |
| Docs | `docs/promotions-frontend.md` (POS/eval semantics + `rewardKind='advanced'`), `docs/promotions-in-sale-frontend-prompt.md` (ADVANCED removed from deferred list) |
| Integration | `advanced-promotion-type.integration.spec.ts` (NEW, live Postgres :5433, S1–S5 + 100% + ORDER subtotal flow-through) |
| Tasks/closure | `openspec/changes/advanced-promotion-type/{proposal,exploration,design,tasks,verify-report}.md` + this `archive-report.md` |

## Delivery

- **Branch**: `feat/advanced-promotion-type` (NOT yet merged to main).
- **Commits**: 16 conventional commits on the branch (planning + WU1–WU10 + 5 correction/fix commits + 1 follow-up coverage commit). Single reviewable chain on a dedicated branch; no PRs (solo-dev delivery per the proposal).
- **Maintainer action**: locally merge to `main` after this archive lands.
- **Rollback**: revert the branch. The `isSupportedEngineType` gate returns to rejecting `ADVANCED`; all changes are additive on the engine and reward rail — PRODUCT_DISCOUNT, BUY_X_GET_Y, ORDER_DISCOUNT behavior is untouched. The D4 migration is reversible by dropping the column + type (no destructive data). The D3 entity cap lift is a one-line revert (`const max = 100` → `const max = 99`).

## Documented follow-ups (NOT blockers for archive)

These are explicitly **deferred follow-ups** per the proposal's Out-of-Scope section, plus the residual coverage observations from verify. They are recorded here for the next session's awareness:

1. **Minimum-amount threshold on BUY side** (Q7). Quantity-only threshold for this slice; a `minPurchaseAmountCents` on the BUY side is a future change. Entity already forbids it for ADVANCED.
2. **MANUAL application scope** (Q8). MANUAL candidate surface, self-heal, `availableManualPromotions`, `targetableManualPromotionIds` are not extended in this slice. A future change can wire ADVANCED into the manual opt-in flow.
3. **Fixed-amount reward variant** for ADVANCED (e.g. "get $5 off product B"). Only the percentage reward rail is activated; a fixed-amount variant needs a different reward shape and a separate change.
4. **BUY/GET targeting the same entity** (engine-level overlap). Explicitly out of scope per D7. Reduces to BXGY in practice; rejected at intake (`advanced_overlapping_targets`) and partitioned at engine level (cross-entity overlap).
5. **Multi-GET-line cheapest-first allocation**. Current deterministic lowest-`itemId` ascending order is the committed contract. Cheapest-first is a future enhancement if merchants need it; all spec scenarios are single-GET-line.
6. **Pre-existing integration fixture-name collision** (SUGGESTION in verify-report). `buy-x-get-y.integration.spec.ts` and `category-brand-promo-targeting.integration.spec.ts` share global category names, so a combined full integration run trips the unique `categories.name` constraint. Each spec was run in isolation here (both GREEN). Worth a shared-fixture cleanup — NOT introduced by this change.
7. **Defense-in-depth**: D3 qty=1 chain is now closed by `576cd80` (`previewTotals().totalCents=0` at qty=1 + INT-S6 upgraded). Future changes touching the apply rail should keep the `R ≤ line` invariant and the `take = min(line.quantity, remaining)` clamp.
8. **`tsc --noEmit` / `nest build` in the RED→GREEN loop**. Lesson from the prior BXGY archive (`0849eec` port-type fix): whenever a change alters shared DTO/port types, a build step should join the RED→GREEN loop. This change caught no port-type gap (the helper port union was updated synchronously in WU2 with a build gate), but the lesson stands.

## Open question (resolved during tasks)

Multi-GET-line allocation order = deterministic **lowest-`itemId` ascending**. WU2 encodes this as the committed contract. All spec scenarios are single-GET-line. Cheapest-first is a deferred follow-up.

## TDD compliance

| Check | Result | Details |
|-------|--------|---------|
| All tasks have tests | ✅ | Each of WU1–WU10 has a RED-first spec; 4R correction added 5 RED-first specs; `576cd80` follow-up added a closing spec. |
| RED confirmed | ✅ | All named spec files exist on disk and were run. |
| GREEN confirmed | ✅ | 811 unit + 27 integration re-run GREEN this session. |
| Triangulation adequate | ✅ | FIX 1: qty=1 R==line + qty=2 R==line + R>line reject; FIX 2: overlap + disjoint; FIX 3: zero + non-zero; FIX 4: all 4 reload mappers. |
| Safety net | ✅ | PD/BXGY/ORDER regression (U3) + BXGY integration 20/20 GREEN — shared rail unregressed. |
| TDD Evidence format | ⚠️ | Substance is present (per-fix RED/GREEN in the correction record + commit table); not in the prescribed Strict TDD matrix format. Non-blocking. |