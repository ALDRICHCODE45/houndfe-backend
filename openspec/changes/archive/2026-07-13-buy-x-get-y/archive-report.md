# Archive Report — buy-x-get-y

**Change**: buy-x-get-y
**Branch**: `feat/buy-x-get-y` (delivered — NOT yet merged to main; maintainer merges locally)
**Head**: `b2c2b95` — `chore: refresh skill-registry paths for macOS`
**Final commit on archive**: see git log after archive move
**Mode**: openspec
**Date archived**: 2026-07-13 (ISO)

## Executive summary

`BUY_X_GET_Y` — the previously DEFERRED `PromotionType` — is now ACTIVE
across the POS promotion engine, the sale recompute path, the
promotion create+update validation surface, and the manual-candidate
wire contract. Delivered across **8 conventional work units** on a
single branch (`feat/buy-x-get-y`); all 18 spec scenarios GREEN on
**filtered** Jest (804 test-executions across 6 runs, 0 failures, 0
skips), full `pnpm run build` EXIT 0, `prisma migrate diff` empty
(zero-migration invariant preserved). The change is feature-complete
and ready to merge; archive was previously missed (a prior agent
returned empty) and is being completed now.

## Work-unit delivery (WU1 → WU8)

| # | Subject (conventional) | Scope |
|---|------------------------|-------|
| WU1 | `feat(promotions): add pure computeBuyXGetYReward helper` | Pure helper, no DI, no I/O. Math: `floor(qty / (N+M))` groups, `Math.round((unitPrice * getDiscountPercent) / 100)` per unit. Q9 zero-group handling. |
| WU2 | `feat(sales): add BXGY line reward and NET readers` | `SaleItem.applyBuyXGetYReward` + `isBuyXGetYReward()` column-derived discriminator; `previewTotals` subtracts line-level `R`; receipt/detail mapper re-derives the same discriminator and emits `rewardKind: 'buy_x_get_y' \| null`; `SaleDetailItemDto.rewardKind` declared required. |
| WU3 | `feat(promotions): evaluate BXGY with total-saving best-wins` | `isSupportedEngineType` admits BXGY for PRODUCTS/VARIANTS/CATEGORIES/BRANDS; new `evaluateBuyXGetYPass` runs after per-line PRODUCT_DISCOUNT best-wins, before ORDER_DISCOUNT; `pickBestBuyXGetYPerLine` mirrors `pickBestPerLine`; cross-type TOTAL-saving comparator (Q5 REVISED). |
| WU4 | `feat(sales): recompute BXGY rewards idempotently` | `recomputePromotions` clears prior BXGY reward + re-applies new one on every recompute; 5× byte-equal convergence asserted. |
| WU5 | `feat(promotions): require BXGY targets and allow BXGY 100 percent` | `validateByType` tightening (Q1): create+update reject untargeted BXGY with `INVALID_TARGET` (400); type-aware cap: BXGY may reach 100%, ADVANCED stays capped at 99. |
| WU6 | `feat(promotions): expose MANUAL BXGY and retain valid opt-ins` | Manual-candidate mapper classifies by `promo.type`; `targetableManualPromotionIds` self-heal loop retains opted-in BXGY IFF `matchTargetTier(...)` on some line; `ApplicableManualPromotionDto.type` wire union extended. |
| WU7 | `test(promotions): complete BXGY integration sweep` | One integration spec covering all 18 scenarios on a seeded tenant (Postgres :5433); `prisma migrate diff` empty. |
| WU8 | `feat(sales): expose NET subtotalCents and rewardKind on draft sale lines` | Front-end-reported contract gap; `SaleItem.toResponse()` extended with `subtotalCents` (NET) + `rewardKind` so DRAFT and confirmed-sale mappers share the same wire shape. Inferred-type propagation — no DTO/port edits. |

(Plus planning + 3 batch-doc commits on the same branch.)

## Revised decisions (design v2 supersedes v1; Engram `sdd/buy-x-get-y/decisions-revised` #2796)

### Q5 — cross-type comparator (REVISED)

**v1**: compare per-unit PD discount vs BXGY total R (asymmetric basis).
**v2 (LOCKED)**: compare **REAL per-line TOTAL savings in cents**.

- `pdTotal = pdPerUnitCents * line.quantity`
- `bxgyTotal = bxgyWinner.lineDiscountCents = floor(qty / (N+M)) * M * Math.round((unitPrice * getDiscountPercent) / 100)`
- BXGY wins IFF `bxgyTotal > pdTotal`; tie → lowest `promotionId` wins.

The lock is proven by test: `pos-evaluate-promotions.buy-x-get-y.spec.ts:487`
asserts **PD 1500c (500c/unit × 3) beats BXGY 500c** — the corrected
spec:29-32 number — and `:517` / `:551` lock both tie directions.

### Q6 — "Free" (100%) NET representation (REVISED)

**v1**: 100% allowed, single line subtotal in receipt mapper only.
**v2 (LOCKED)**: 100% allowed for BXGY only, **NET single-line subtotal
emitted on BOTH readers** — `previewTotals` (sale.entity) **AND** the
receipt/detail mapper (prisma-sale.repository) — with the same
`rewardKind: 'buy_x_get_y'` discriminator.

The lock is proven by test: `sale.entity.spec.ts:2151/2159` for
`previewTotals` (3000/1000/2000 and 3000/500/2500) and
`prisma-sale.repository.spec.ts:972/995` for the receipt mapper
(both NET subtotal + `rewardKind='buy_x_get_y'`). PD and manual lines
emit `rewardKind=null` (regression intact).

### Pass-ordering invariant (LOCKED)

`BUY_X_GET_Y` pass runs **AFTER** the per-line `PRODUCT_DISCOUNT`
best-wins pass and **BEFORE** the `ORDER_DISCOUNT` pass. The
post-line subtotal fed to `ORDER_DISCOUNT` already reflects the
BUY_X_GET_Y saving. Proven by test:
`pos-evaluate-promotions.buy-x-get-y.spec.ts:582` (L1+L2 → postLine
3600c → 360c) and integration `BW-3:419`.

### Type-aware 100% cap (LOCKED)

`getDiscountPercent = 100` accepted for BXGY only; `ADVANCED` MUST
remain ≤ 99. Owned by the entity (`validateGetDiscountPercent(value,
type)` at `promotion.entity.ts:184`), with the DTO bound loosened to
`@Max(100)`. Defense-in-depth: a future refactor that splits the cap
back to the DTO MUST restore the type param. Proven by test:
`promotion.entity.spec.ts:282` (ADVANCED gDP=100 THROWS) and `:216`
(BXGY 100 accepted).

## Build-blocker caught by verify + one-line port fix

The original verify report (`verify-report.md`, commit `d670406`)
returned **FAIL** with 1 CRITICAL: `pnpm run build` exit 1 with
`TS2322 — SaleDetailItemDto.rewardKind is required, but
ISaleRepository.findOneWithRelations items type omits it`. WU2 had
added the required `rewardKind` to the DTO and updated the repository
**implementation**, but the repository **port interface** return type
was not updated — so `ts-jest` (per-file transpile, no cross-file
type-check) let it through GREEN. Only the full `tsc` / `nest build`
surfaces it.

**Fix** (one line, `0849eec`): added `rewardKind: 'buy_x_get_y' | null`
to the `items` array type in `src/sales/domain/sale.repository.ts`.
After the fix, `pnpm run build` exits 0, the full test sweep is
GREEN, and the change becomes archivable. Recommendation absorbed
into Engram: a `tsc --noEmit` (or `nest build`) step should join the
RED→GREEN loop whenever a change alters shared DTO/port types.

## Frontend-reported draft NET follow-up (WU8)

The DRAFT sale line did NOT expose a NET per-line subtotal. The
confirmed-sale `findOneWithRelations` mapper already exposed
`subtotalCents` (NET) and `rewardKind`, but the DRAFT path —
`sale.toResponse()` in `sale.entity.ts:798` spreading
`SaleItem.toResponse()` — was missing both keys, so POS /wiz-pos
rendered BXGY lines as gross. WU8 (`cc51a71`) added the two keys
inline: `subtotalCents = unitPriceCents * quantity - (isBuyXGetYReward()
? (discountAmountCents ?? 0) : 0)` and `rewardKind = isBuyXGetYReward()
? 'buy_x_get_y' : null`. The existing in-domain `get subtotalCents()`
getter is intentionally UNCHANGED (gross by design — feeds
`previewTotals` and other PRE-DRAFT consumers). The new wire key on
the DRAFT is per-line NET, independent of `previewTotals()`'s
order-discount-aware aggregate (intentional: a per-line wire field
must NOT include the order-discount split; that's an aggregate
concern). Inferred-type propagation — no DTO/port edits — and
`pnpm run build` exit 0 confirms.

## Test evidence (18/18 scenarios GREEN)

- **Unit** (filtered Jest per work unit, anti-hang rule observed):
  - `pos-evaluate-promotions.buy-x-get-y-helper.spec.ts` — 12 tests (qty3/1000c/2+1/50, multi-group qty6/9/7, zero-group qty1 & qty2, 100% true-free, 33%/17% rounding, non-round 777c).
  - `pos-evaluate-promotions.buy-x-get-y.spec.ts` — 16 tests (gate ×4, counting ×6, short-circuit ×1, cross-type ×4, pass-order ×1).
  - `sale-item.entity.spec.ts` — 14 WU2 tests + 6 WU8 tests (discriminator + reward path + guard rails + draft `toResponse()` NET).
  - `sale.entity.spec.ts` — 7 WU2 tests (100%/50%/multi-group/mixed/regression previewTotals).
  - `prisma-sale.repository.spec.ts` — 5 WU2 tests (100%→NET 2000c, 50%→2500c, PD/manual regression `rewardKind=null`).
  - `promotion.entity.spec.ts` — BXGY 100% accepted; ADVANCED 100% throws.
  - `create-promotion.dto.spec.ts` — DTO bound 100 ok / 101 rejected.
  - `promotions.service.spec.ts` — `INVALID_TARGET` create + update paths.
  - `sales.service.spec.ts` — BXGY idempotent recompute 5× byte-equal; AUTOMATIC apply; MANUAL candidate + targetable + 2-recompute opt-in survival.
  - Regression sweep — 79 tests (PD/ORDER/VARIANTS/CATEGORIES/BRANDS unchanged).
- **Integration** (real Postgres :5433): `buy-x-get-y.integration.spec.ts` — 20 tests (18 spec-scenario-named cases + F-1 has 2 sub-cases).
- **Total**: 804 test-executions across 6 filtered runs, 0 failures, 0 skips.
- **Build**: `pnpm run build` → EXIT 0 (after the `0849eec` one-line port fix).
- **Migration drift**: `prisma migrate diff --from-schema-datamodel ... --to-schema-datasource ...` → "No difference detected." (zero-migration invariant holds — the type, the three scalar columns, and the enum value all pre-exist).

## Spec compliance matrix (18/18)

All 18 spec scenarios map to concrete, GREEN test evidence (unit +
integration). Full matrix in `verify-report.md`; scenario-to-test
map is exhaustive (no coverage gaps; 16/18 have BOTH unit and
integration coverage).

## Archive contents (moved under `openspec/changes/archive/`)

- `proposal.md` ✅ — intent, locked decisions Q1–Q9, approach A vs B vs C tradeoff, scope and out-of-scope.
- `exploration.md` ✅ — verified ground-truth drift log; representational gap discovery; "free" not representable finding.
- `design.md` ✅ — 8 architecture decisions; v2 revised (Q5 + Q6 + type-aware 100% cap); `computeBuyXGetYReward` signature + comparator; RED spike.
- `specs/pos-promotion-engine/spec.md` ✅ — v2 delta (1 MODIFIED + 6 ADDED requirements, 18 scenarios).
- `tasks.md` ✅ — 7 phases / 14 task checkboxes, all complete.
- `apply-progress.md` ✅ — RED→GREEN evidence per WU; commit table; decisions worth remembering.
- `verify-report.md` ✅ — 18/18 COMPLIANT; build GREEN; zero-migration; the CRITICAL-1 port fix noted in history.
- `archive-report.md` ✅ (this file) — closure summary.

## Source-of-truth updates

The base spec `openspec/specs/pos-promotion-engine/spec.md` now
describes `BUY_X_GET_Y` as ACTIVE:

- **Purpose** section updated: includes BUY_X_GET_Y, the cross-type
  total-savings comparator, the pass-ordering rule, the type-aware
  100% cap, the targeted-required constraint, and the idempotent
  recompute invariant.
- **Best-Wins Selection Per Line And Per Sale** MODIFIED to
  add the cross-type rule (Q5), the pass-ordering invariant
  (BXGY between per-line PD and ORDER), and three new
  cross-type scenarios.
- **6 ADDED requirements** appended (Targeting Is Required,
  Per-Line Eligibility And Counting, Cheapest-Unit Reward
  Selection And Rounding, "Free" 100%, AUTOMATIC And MANUAL
  Wiring, Idempotent Recompute).
- **Verification Surface** updated to list the new unit
  (`*.buy-x-get-y*.spec.ts`), the new DTO spec, and the new
  integration spec, with what each one proves.
- All other requirements (eligibility, PRODUCT_DISCOUNT matching,
  ORDER_DISCOUNT application, manual-wins precedence, veto,
  audit, VARIANT-wins, VARIANTS validation, Specificity Ladder,
  CATEGORIES/BRANDS validation) are **preserved unchanged**.

## Delivery

- **Branch**: `feat/buy-x-get-y` (NOT yet merged to main).
- **Commits**: 13 conventional commits on the branch (planning
  + WU1–WU8 + 3 batch-docs). Single reviewable chain on a
  dedicated branch; no PRs (solo-dev delivery per the proposal's
  Delivery Note).
- **Maintainer action**: locally merge to `main` after this
  archive lands.
- **Rollback**: revert the branch. Engine gate returns `false`
  for BUY_X_GET_Y → no new pass runs → no fixed-cents rewards
  emitted → `recomputePromotions` applies nothing new.
  `validateByType` tightening rejects newly-built untargeted
  promos at creation but does NOT mutate persisted rows; no
  backfill, no data migration, no API contract change. The
  99→100 cap is the only field-level change — relaxing it
  back is a one-line revert.

## What this archive preserved (vs. the missed first attempt)

A prior archive agent returned empty without moving the folder,
without syncing the delta, and without committing. This archive
recovered the full state: the delta was synced to the base spec
(+133 / −21 lines), the closure report was written, the change
folder will move under `openspec/changes/archive/2026-07-13-buy-x-get-y/`
with `git mv` (preserves history), the untracked `verify-report.md`
is added so it moves with the folder, and a single conventional
commit records the archive.

## Open follow-ups (NOT blockers for archive)

- A `tsc --noEmit` (or `nest build`) step should join the
  RED→GREEN loop whenever a change alters shared DTO/port types.
  (Lesson from CRITICAL-1 — absorbed into Engram.)
- An end-to-end `getSaleDetail` integration assertion on
  `items[].rewardKind` would also have caught the port-type gap.
  (SUGGESTION in `verify-report.md`.)
- `TDD Cycle Evidence` matrix in `apply-progress.md` is in prose
  + commit table rather than the Strict TDD module's exact matrix.
  Substance is present and verifiable; format is not. (WARNING-1
  in `verify-report.md`.)
