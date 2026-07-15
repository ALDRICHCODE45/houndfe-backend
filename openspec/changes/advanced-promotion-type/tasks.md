# Tasks: Advanced Promotion Type (POS Engine Activation)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~700–850 (impl ~350, tests ~350, migration ~40, docs ~50) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Slice 1 → Slice 2 → Slice 3 (work-unit-commit chain on ONE feature branch) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain (solo-dev: chained work-unit commits, final `git merge --no-ff`; NO PRs) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

> Solo-dev delivery: NO GitHub PRs. "Chained" = ordered Conventional work-unit
> commits on one `feat/advanced-promotion-type` branch, merged locally with
> `git merge --no-ff` to main; user pushes manually. Each slice below is an
> independently revertable commit group.

### Suggested Work Units

| Unit | Goal | Slice | Focused test command | Runtime harness | Rollback boundary |
|------|------|-------|----------------------|-----------------|-------------------|
| WU1 | Side-aware `matchTargetTier` | S1 | `pnpm run test:unit -- match-target-tier.spec.ts` | N/A (pure matcher) | `use-case.ts` matcher param only |
| WU2 | Pure `computeAdvancedReward` | S1 | `pnpm run test:unit -- pos-evaluate-promotions.advanced-helper.spec.ts` | N/A (pure fn) | new helper + port union member |
| WU3 | D3 cap lift 99→100 | S1 | `pnpm run test:unit -- promotion.entity.spec.ts` | N/A (entity) | `promotion.entity.ts:184` const |
| WU4 | `evaluateAdvancedPass` + gate | S1 | `pnpm run test:unit -- pos-evaluate-promotions.advanced.spec.ts` | N/A (engine unit) | pass + `isSupportedEngineType` gate |
| WU5 | D4 enum/column/migration + backfill | S2 | `pnpm run build` + `pnpm run test:unit -- sale-item.entity.spec.ts` | migration on :5433 | drop column + type |
| WU6 | Sales apply routing + idempotence | S2 | `pnpm run test:unit -- sales.service.spec.ts` | N/A (unit, mocked repo) | `sales.service.ts:515` route arm |
| WU7 | Receipt mapper discriminator | S2 | `pnpm run test:unit -- prisma-sale.repository.spec.ts` | N/A (mapper unit) | mapper read/persist of rewardKind |
| WU8 | D7 intake disjoint rejection | S3 | `pnpm run test:unit -- promotions-validate-side-disjoint.spec.ts` | N/A (validation unit) | `assertAdvancedSideTargets` |
| WU9 | e2e integration (S1–S5 + 100%) | S3 | `pnpm run test:integration -- advanced-promotion-type.integration.spec.ts` | live Postgres :5433 | new spec file only |
| WU10 | Docs | S3 | N/A | N/A (markdown) | doc edits only |

**Open question resolved:** Multi-GET-line allocation = deterministic lowest-`itemId`
ascending order (per design). All spec scenarios are single-GET-line; cheapest-first
is a deferred follow-up. WU2 encodes the lowest-`itemId` sort as the committed contract.

---

## Slice 1: Engine Core (WU1–WU4) — pure logic + pass, no persistence

RED → GREEN → commit per work unit. No shared enum/column yet, so no build gate here
except WU2 (port union edit).

### Phase 1: Side-Aware Matcher (WU1)

- [ ] 1.1 RED: rewrite `src/promotions/application/match-target-tier.spec.ts:269-284` — replace "BUY/GET ignored" with side-aware: `matchTargetTier(items,line,'BUY')` hits BUY-side P1, `'GET'` hits GET-side P2, `'DEFAULT'` returns null; add DEFAULT-unchanged case for PD/BXGY. Run `pnpm run test:unit -- match-target-tier.spec.ts` → RED.
- [ ] 1.2 GREEN: `pos-evaluate-promotions.use-case.ts:136` add `side: TargetSide = 'DEFAULT'` param; replace hardcoded `const side='DEFAULT'` (:145) with the param threaded through the 4-tier ladder. Re-run → GREEN.
- [ ] 1.3 Regression: `pnpm run test:unit -- pos-evaluate-promotions` (PD + BXGY DEFAULT specs) → still GREEN. Commit `feat(promotions): make matchTargetTier side-aware (BUY/GET/DEFAULT)`.

### Phase 2: Pure Reward Helper (WU2)

- [ ] 2.1 RED: NEW `src/promotions/application/pos-evaluate-promotions.advanced-helper.spec.ts` — cases: single-group; S2 multi-group (buy6/3 → 2 apps, 600c); zero-group (floor→0); 100% true-free (0c unit); >100 not reachable here (entity-guarded); `Math.round(eff*pct/100)` rounding; multi-`getQuantity`; multi-GET-line lowest-`itemId` allocation order. Run → RED.
- [ ] 2.2 GREEN: add `PosEvalAdvancedLineResult` to `ports/pos-evaluate-promotions.port.ts:132` (union member); implement pure `computeAdvancedReward` in `use-case.ts` (mirror `computeBuyXGetYReward:73-100`); GET candidate lines sorted `itemId` asc. Re-run → GREEN.
- [ ] 2.3 **BUILD GATE** (port union changed): `pnpm run build` → 0 errors (guards against BXGY-precedent TS2322 port mismatch). Commit `feat(promotions): add pure computeAdvancedReward helper + port result`.

### Phase 3: D3 Cap Lift (WU3)

- [ ] 3.1 RED: `src/promotions/domain/promotion.entity.spec.ts` — ADVANCED `validateGetDiscountPercent`: assert `100` accepted (was rejected), `101` still rejected. Run `pnpm run test:unit -- promotion.entity.spec.ts` → RED.
- [ ] 3.2 GREEN: `promotion.entity.ts:184` set `const max = 100` (both types; `>100` rejected). Re-run → GREEN. Commit `feat(promotions): lift ADVANCED get-discount cap 99→100 (true free)`.

### Phase 4: Advanced Engine Pass (WU4)

- [ ] 4.1 RED: NEW `src/promotions/application/pos-evaluate-promotions.advanced.spec.ts` — gate admits 4 buy × 4 get target types (PRODUCTS/VARIANTS/CATEGORIES/BRANDS); null-target silently skipped; MANUAL silently skipped (D6); side-aware aggregated BUY counting (D1: S1 many-small-lines, single-line ≥N, out-of-target excluded); D5 best-wins 50% ADVANCED beats 20% PD; tie→lowest id; S4 degenerate cart (BUY met, no GET → no result). Run → RED.
- [ ] 4.2 GREEN: admit ADVANCED in `isSupportedEngineType` (`use-case.ts:579`, gate on `buy/getTargetType`); implement `evaluateAdvancedPass` slotted `:284` (after BXGY `:283`, before ORDER `:304`); wire best-wins into comparator `:900-905` (3-way max via `lineTotalSavingCents`); `computeAppliedDiscountCents:1060` add `advanced`→`lineDiscountCents` for ORDER base. Re-run → GREEN.
- [ ] 4.3 Regression: `pnpm run test:unit -- pos-evaluate-promotions` full engine suite → GREEN. Commit `feat(promotions): add cross-line evaluateAdvancedPass + 3-way best-wins`.

**Slice 1 boundary:** revert these 4 commits → `isSupportedEngineType` rejects ADVANCED again; PD/BXGY/ORDER untouched. No DB changes yet.

---

## Slice 2: Persistence + Sales Apply (WU5–WU7) — discriminator to the wire

### Phase 5: D4 Enum, Column, Migration, Backfill (WU5)

- [ ] 5.1 RED: `src/sales/domain/sale-item.entity.spec.ts` — `applyBuyXGetYReward({...,rewardKind:'advanced'})` sets `_rewardKind`; `toResponse().rewardKind === 'advanced'`; BXGY path still emits `'buy_x_get_y'`; non-reward emits `null`; `clearDiscountFields` clears `_rewardKind`. Run → RED.
- [ ] 5.2 GREEN (schema): `prisma/schema.prisma` add `enum SaleItemRewardKind { BUY_X_GET_Y ADVANCED }` + nullable `rewardKind` on `SaleItem` (:728). `pnpm prisma generate`.
- [ ] 5.3 GREEN (migration): `pnpm prisma migrate dev --name add_sale_item_reward_kind` — CREATE TYPE + ADD COLUMN (nullable); backfill `UPDATE sale_items SET "rewardKind"='BUY_X_GET_Y' WHERE "promotionId" IS NOT NULL AND "prePriceCentsBeforeDiscount"="unitPriceCents" AND "discountAmountCents">0`.
- [ ] 5.4 GREEN (entity): `sale-item.entity.ts` — `ApplyBuyXGetYRewardInput.rewardKind?` (:68, default `'buy_x_get_y'`); store `_rewardKind` in `applyBuyXGetYReward` (:362); emit in `toResponse` (:512, verified `:456-518`); clear in `clearDiscountFields`. Re-run → GREEN.
- [ ] 5.5 **BUILD GATE** (shared enum/DTO changed): `pnpm run build` → 0 errors. Then verify `pnpm prisma migrate diff` shows zero drift outside this migration. Commit `feat(sales): add SaleItemRewardKind discriminator + additive migration + backfill`.

### Phase 6: Sales Apply Routing + Idempotence (WU6)

- [ ] 6.1 RED: `src/sales/sales.service.spec.ts` — `recomputePromotions` routes `kind:'advanced'` → `applyBuyXGetYReward({...,rewardKind:'advanced'})`; GET line carries `rewardKind='advanced'`; **idempotent 5× byte-equal** (`rewardKind`/`discountAmountCents`/`unitPriceCents`/`prePriceCentsBeforeDiscount`/`rewardDiscountPercent` + `previewTotals` identical, no compounding); prior ADVANCED rewards cleared each recompute. Run → RED.
- [ ] 6.2 GREEN: `sales.service.ts:515` add `kind:'advanced'` route arm calling `applyBuyXGetYReward` with the discriminator on the GET-side `SaleItem`. Re-run → GREEN. Commit `feat(sales): route ADVANCED reward through applyBuyXGetYReward rail (idempotent)`.

### Phase 7: Receipt Mapper (WU7)

- [ ] 7.1 RED: `src/sales/infrastructure/prisma-sale.repository.spec.ts` — confirmed-receipt mapper (:1420-1459) emits `rewardKind='advanced'` for ADVANCED rows, `'buy_x_get_y'` for BXGY (no regression); persist rewardKind on save. Extend `sale.entity.spec.ts`: `previewTotals` for ADVANCED 100% → `totalCents=0` on GET line; S2 multi-group 600c. Run → RED.
- [ ] 7.2 GREEN: mapper reads persisted `rewardKind`; save writes it. Re-run → GREEN. Commit `feat(sales): read/persist rewardKind in confirmed-receipt mapper`.

**Slice 2 boundary:** revert Slice 2 → engine pass is a no-op at persistence (Slice 1 pure logic intact); drop column + type reverses migration. BXGY untouched.

---

## Slice 3: Intake Guard + e2e + Docs (WU8–WU10)

### Phase 8: D7 Disjoint Intake Rejection (WU8)

- [ ] 8.1 RED: NEW `src/promotions/promotions-validate-side-disjoint.spec.ts` — S3: ADVANCED create AND update with `buyTargetItems=[P1]` & `getTargetItems=[P1]` (any product/variant/category/brand combo) rejected with code `advanced_overlapping_targets`, no row persisted; cross-entity (`[CAT1]`/`[P1]`) accepted. Run → RED.
- [ ] 8.2 GREEN: `promotions.service.ts:598` implement `assertAdvancedSideTargets` disjoint check on create + update, throw `advanced_overlapping_targets`. Re-run → GREEN. Commit `feat(promotions): reject same-entity ADVANCED BUY/GET at intake (D7)`.

### Phase 9: e2e Integration (WU9)

- [ ] 9.1 RED: NEW `src/promotions/advanced-promotion-type.integration.spec.ts` (live DB :5433) — scenario-named cases: S1 category→product, S2 multi-group 2 apps, S3 same-entity rejected, S4 degenerate no-reward, S5 best-wins vs PD, plus 100% free GET (`totalCents=0`), plus ADVANCED saving flows into ORDER_DISCOUNT subtotal. Run `pnpm run test:integration -- advanced-promotion-type.integration.spec.ts --runInBand` → RED.
- [ ] 9.2 GREEN: verify full stack green (no new impl expected — Slices 1–2 cover behavior; fix any seam gaps surfaced). Commit `test(promotions): add ADVANCED e2e integration suite (S1–S5 + 100% free)`.

### Phase 10: Docs (WU10)

- [ ] 10.1 `docs/promotions-frontend.md` — document POS/evaluation semantics + new `rewardKind='advanced'` value.
- [ ] 10.2 `docs/promotions-in-sale-frontend-prompt.md` — remove ADVANCED from deferred list (`:31, :241`). Commit `docs(promotions): document ADVANCED POS semantics + rewardKind=advanced`.

### Phase 11: Archive Prep (non-requirement main-spec edits — archive phase applies)

- [ ] 11.1 Note for sdd-archive: main spec `:10-15` Purpose swap (ADVANCED now reaches 100%); `:533` Verification Surface rewrite (100% accepted, >100 rejected).

**Slice 3 boundary:** intake guard, e2e spec, and docs each revertable in isolation; intake revert re-opens same-entity risk (engine has no partition logic — keep guard).

---

## Final Merge

- [ ] 12.1 `pnpm run build` → 0 errors; run each touched spec file filtered (never full suite); `pnpm prisma migrate diff` zero drift outside D4 migration.
- [ ] 12.2 `git merge --no-ff feat/advanced-promotion-type` into main locally; user pushes manually.
