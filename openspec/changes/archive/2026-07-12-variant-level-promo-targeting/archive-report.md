# Archive Report: Variant-Level Promotion Targeting (POS)

## Final Verdict: ARCHIVED — PASS WITH NON-BLOCKING WARNINGS

- **Change**: `variant-level-promo-targeting`
- **Branch**: `feat/variant-level-promo-targeting`
- **Archive folder**: `openspec/changes/archive/2026-07-12-variant-level-promo-targeting/`
- **Archived at**: 2026-07-12
- **Merge state**: branch **NOT merged to `main`**, **NOT pushed** — solo dev merges manually (no PRs, per repo convention)
- **Verify verdict**: PASS WITH WARNINGS — **1802 passed / 0 failed unit** (151 suites) + **33 passed / 0 failed integration** (6 suites + 1 skipped) on isolated Postgres `:5433`, `.env.test` — 2 consecutive runs, stable. **0 CRITICAL findings.** 2 non-blocking WARNINGs carried forward (W1 test-only latent `tsc --noEmit` type hygiene; W2 Sc8 nuance on `availableManualPromotions` vs `targetableManualPromotionIds`). 11/11 active spec scenarios COMPLIANT.
- **Tasks**: 24/24 subtasks across 6 work units, 0 unchecked
- **Spec compliance**: `pos-promotion-engine` (MODIFIED, +2 requirements / +10 scenarios net; CATEGORIES scenario explicitly marked DEFERRED so the base spec does NOT claim CATEGORIES engine support) — COMPLIANT with runtime test evidence.

## Commits Archived (6 work-unit commits)

| Hash | Slice | Title |
|------|-------|-------|
| `8a90dd6` | W1 | `chore(db): add VARIANTS to PromotionTargetType` |
| `4bed244` | W2 | `feat(promotions): accept VARIANTS in domain & DTO enums` |
| `e629d8c` | W3 | `feat(engine): extract matchTargetTier pure helper` |
| `99e44c5` | W4 | `feat(engine): wire VARIANTS match + VARIANT-wins precedence` |
| `67159d8` | W5 | `feat(promotions): validateTargetIds accepts VARIANTS (tenant-scoped)` |
| `24f063b` | W6 | `test(promotions): e2e integration sweep for variant-level targeting` |

Order: W1 → W2 → W3 → W4 → W5 → W6. Branch HEAD: `24f063b` on `feat/variant-level-promo-targeting`.

## What Shipped

Additive, minimal-surface change that gives the POS Promotion engine a way to scope a discount to **one** variant of a product without faking a product. A `PRODUCTS` target on a variant-bearing product STILL hits every variant (back-compat preserved); a new `VARIANTS` target hits only the exact variant; when both match the same line, **VARIANTS wins by specificity** (orthogonal to discount value, so a 10¢ VARIANTS promo beats a 500¢ PRODUCTS promo on the same line). Tenant-scoped `validateTargetIds` rejects cross-tenant or non-existent variant ids. Schema is a single additive `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';` migration; no data migration, zero destructive ops.

The change ships:

1. **New `VARIANTS` target type** (`PromotionTargetType` enum gains `'VARIANTS'`):
   - `prisma/schema.prisma:89–93` — `enum PromotionTargetType` adds `'VARIANTS'`.
   - `prisma/migrations/20260712072002_promotion_target_variants/migration.sql` — standalone `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';`. Postgres restriction (can't use a fresh enum value same-tx) respected; verified via `prisma migrate diff`.
   - `src/promotions/domain/promotion.entity.ts:15` — union gains `'VARIANTS'`; `createPromotion({appliesTo:'VARIANTS', targetItems:[{targetType:'VARIANTS', targetId:'V-A'}]})` does not throw.
   - `src/promotions/dto/create-promotion.dto.ts` — `PromotionTargetTypeEnum.VARIANTS` exported.
   - `update-promotion.dto.ts` — inherits via `PartialType(OmitType(CreatePromotionDto,['type']))`; no edit needed (correctly absent from diff).

2. **Shared `matchTargetTier` pure helper** (`src/promotions/application/pos-evaluate-promotions.use-case.ts:76`, exported):
   ```ts
   export function matchTargetTier(
     targetItems: ReadonlyArray<{ side: string; targetType: string; targetId: string }>,
     line: { productId: string; variantId: string | null },
   ): LineMatchTier  // 'VARIANT' | 'PRODUCT' | null
   ```
   - `null` `variantId` never matches VARIANTS.
   - CATEGORIES / BRANDS → `null` (DEFERRED, unit-tested negative).
   - Both engine match sites (`targetableManualPromotionIds :285` and `pickBestPerLine :388`) call the SAME helper — DRY across the two sites; future online-cart engine can import this same pure helper.

3. **VARIANT-wins specificity precedence** (per-line pre-pass, runs BEFORE best-wins):
   - In `pickBestPerLine` (`pos-evaluate-promotions.use-case.ts:418–421`), any candidate with `tier === 'VARIANT'` causes all `tier === 'PRODUCT'` candidates to be dropped; only the VARIANT survivors flow into `pickBestByMaxDiscountThenLowestId` (`:423`). Best-wins (`max discount, tie→lowest id` per `:441–456`) runs on the survivors untouched — so the documented best-wins invariant is preserved AND "VARIANT wins regardless of discount value" holds unconditionally (proven by scenario 6: 10¢ VARIANTS beats 500¢ PRODUCTS).
   - **Opt-in path is NOT pruned by precedence** (`targetableManualPromotionIds` only requires `matchTargetTier(...) !== null` — retention is about target presence, not winning).

4. **Tenant-scoped `validateTargetIds` VARIANTS branch** (`src/promotions/promotions.service.ts:566`):
   - `case 'VARIANTS'` → `tenantClient.variant.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } })` — symmetric with the PRODUCTS branch (`:556`); NOT the global `this.prisma` that CATEGORIES/BRANDS-on-global would have implied.
   - Error entity name `'Variant'` (`:583`) in `InvalidArgumentError('Variant with id \'…\' not found', 'INVALID_TARGET')`.
   - Called from BOTH create (`:77`) and update (`:181`) via the shared `targetResolver` (`:305`).

5. **Acceptance contract — what the engine WILL and WILL NOT do**:
   - ✅ `appliesTo ∈ {PRODUCTS, VARIANTS}` is the engine-supported set (`isSupportedEngineType :343–348`).
   - ✅ A `VARIANTS` target with `targetId` = an existing variant in the tenant is accepted (created and updated).
   - ✅ A `VARIANTS` target with `targetId` = a non-existent variant id is rejected with `INVALID_TARGET`; no `Promotion` row, no `PromotionTargetItem` row persisted.
   - ✅ A `VARIANTS` target with `targetId` = a variant owned by a different tenant is rejected AS IF it didn't exist (verified with a real T2 tenant in integration).
   - ✅ `matchTargetTier` returns `null` for CATEGORIES / BRANDS; `isSupportedEngineType` returns `false` for CATEGORIES / BRANDS. CATEGORIES is NOT supported by this engine — see DEFERRED section below.
   - ✅ PRODUCTS targets on a variant-bearing product CONTINUE to hit every variant (back-compat scenario 3 green at both unit and integration layers).

6. **Strict TDD test coverage** (`+42` change tests on baseline 1771 → 1802 unit, +11 scenario cases on integration, 0 failures, 2 consecutive runs stable):
   - `src/promotions/application/match-target-tier.spec.ts` — 200 LOC, table-driven: VARIANT/PRODUCT/null tier; null `variantId` never matches VARIANTS; CATEGORIES/BRANDS → null (negative); combined VARIANTS+V-B + PRODUCTS+P1 promo on V-A line → `'VARIANT'`.
   - `src/promotions/application/pos-evaluate-promotions-w4.spec.ts` — 442 LOC, scenarios 5–9 (precedence + targetable set + survives recompute + price-list + hasManualDiscount regressions).
   - `src/promotions/domain/promotion-target-variants.spec.ts` — 87 LOC, entity accepts `appliesTo='VARIANTS'` + `TargetItemDto` shape.
   - `src/promotions/promotions-validate-variants.spec.ts` — 353 LOC, VARIANTS accepted / not-found / cross-tenant; tenant-scoped client symbol guard.
   - `src/promotions/variant-level-promo-targeting.integration.spec.ts` — 866 LOC, live-DB end-to-end sweep on Postgres `:5433` with `.env.test` (NEVER dev DB); 12 spec-scenario-named cases; real T2 tenant for cross-tenant validation; real `promotion.count()` / `promotionTargetItem.count()` row-count assertions to prove non-persistence on rejection.
   - Production code change: **+135 LOC** (entity +1, DTO +1, schema +1, migration +8, engine +89, service +13). Test code: **+1927 LOC** (strict TDD inflates test code 4–6× production per WU; each WU commit is independently reviewable + revertable).


## Specs Synced into Source of Truth

| Domain | Action | Requirements |
|--------|--------|--------------|
| `pos-promotion-engine` | **MODIFIED** (additive) | 1 MODIFIED (`PRODUCT_DISCOUNT Matches Target Items` — adds VARIANTS clause + PRODUCTS back-compat scenario + VARIANTS-exact scenario; CATEGORIES scenario explicitly marked DEFERRED so the base spec does not falsely claim engine support); 2 ADDED (`VARIANT-Wins Specificity Precedence` + `VARIANTS Target Validation`); existing 15 requirements preserved verbatim; Verification Surface expanded with the 5 new test files. |

### `pos-promotion-engine` canonical spec — final shape

All 15 prior requirements preserved verbatim. The MODIFIED requirement (`PRODUCT_DISCOUNT Matches Target Items`) was updated with:
- New sentence fragment: `` `VARIANTS` matches only by variantId when the line's `variantId` equals the target's `targetId` `` + `(Previously: …)` context note.
- PRESERVED scenario: `PRODUCTS targeting matches by product id` (slight wording refresh — "one P1 line and one P2 line" / "only the P1 line is eligible").
- **DEFERRED marking** for `CATEGORIES targeting matches by category id`: heading now reads "(DEFERRED — not supported by the current engine)", GIVEN/WHEN/THEN WHEN clause changed to "WHEN the deferred CATEGORIES engine support is implemented", and a strong blockquote note explaining that `CATEGORIES` / `BRANDS` are NOT activated by this spec, `isSupportedEngineType` returns `false` for them, `matchTargetTier` returns `null` for them, and that the presence of this scenario MUST NOT be read as a claim that CATEGORIES works today. This is critical: the previous `promotions-in-sale` archive left the CATEGORIES scenario unmodified and readers could have inferred support; this archive fixes that ambiguity at the spec level.
- ADDED scenario: `PRODUCTS still matches every variant of a variant-bearing product` (back-compat guarantee).
- ADDED scenario: `VARIANTS matches only the exact variant`.

Two ADDED requirements appended before `Verification Surface`:
- `VARIANT-Wins Specificity Precedence` — 5 scenarios (wins-over-PRODUCTS, wins-regardless-of-magnitude, different-variant-no-match, MANUAL offered for opt-in, opted-in survives recompute).
- `VARIANTS Target Validation` — 3 scenarios (existing tenant id accepted, non-existent rejected, cross-tenant rejected as not-found).

Verification Surface expanded with the 5 new test files:
- `src/promotions/application/match-target-tier.spec.ts`
- `src/promotions/application/pos-evaluate-promotions-w4.spec.ts`
- `src/promotions/domain/promotion-target-variants.spec.ts`
- `src/promotions/promotions-validate-variants.spec.ts`
- `src/promotions/variant-level-promo-targeting.integration.spec.ts`

**Final baseline `pos-promotion-engine` spec totals**: **17 requirements**, **47 scenarios** (15 prior preserved + 2 ADDED net = 17 req; 35 prior scenarios + 2 net added by MODIFIED (PRODUCTS-still-matches-every-variant + VARIANTS-matches-only-exact) + 8 new in ADDED requirements (5 + 3) = 45 scenarios; counting the preserved CATEGORIES scenario (now DEFERRED, kept in the spec as documented future intent) → 47 scenarios in the file, of which 11 are ACTIVE coverage and CATEGORIES is `➖ NOT COUNTED`). Pre-archive baseline was 15 req / 35 active scen (per the prior `promotions-in-sale` archive).


## Design Coherence

No reconciliations needed at archive time. The design.md, proposal.md, and shipped code are aligned:
- Shared `matchTargetTier` helper — exported at `pos-evaluate-promotions.use-case.ts:76`, called at BOTH `:285` and `:388`. No duplicate predicate.
- Precedence pre-pass `:418–421` runs BEFORE best-wins `:423`; best-wins helper `:441–456` untouched.
- `validateTargetIds` VARIANTS branch uses `tenantClient` (`:566`), symmetric with PRODUCTS (`:556`); error entity `'Variant'` (`:583`).
- Update path: shared target-resolver used by both create (`:77`) and update (`:181`) → validation runs at both times.
- Migration: only `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';` — no same-tx consumer.
- `update-promotion.dto.ts` inherits VARIANTS via `PartialType(OmitType(CreatePromotionDto,['type']))` — correctly not in the diff.

## Gate Findings — Carried-Forward Non-Blocking Warnings

| Tag | Severity | Status | Description |
|-----|----------|--------|-------------|
| **W1** | WARNING (non-blocking) | Carried forward | 4 test-only latent type errors via full `tsc --noEmit -p tsconfig.json` (stricter than pipeline; includes specs) in this change's spec files only: `match-target-tier.spec.ts:181` (`TS2558: Expected 0 type arguments, but got 2` — non-generic helper erased at runtime), `promotions-validate-variants.spec.ts:154` (`TS2322` discountType union vs enum), `variant-level-promo-targeting.integration.spec.ts:69 & :813` (`TS2322` partial `cls.get` mock shape). Production code is 100% type-clean and `nest build` passes (`pnpm build` exit 0). Masked by `isolatedModules: true` + `tsconfig.build.json` excluding `**/*spec.ts` — repo-wide convention (44 pre-existing spec type-errors on surfaces the build never checks). Non-blocking; runtime behavior is correct (1802/1802 unit + 33/33 integration green). |
| **W2** | WARNING (non-blocking) | Carried forward | Scenario 8 semantic coverage nuance: spec text says a MANUAL VARIANTS promo "MUST appear in the targetable/available-for-manual set." Tests assert membership in `targetableManualPromotionIds` with the promo **pre-opted-in**. The not-yet-opted-in `availableManualPromotions` (opt-in offer list) reading is not independently asserted for VARIANTS. Functionally correct (`isSupportedEngineType` now admits VARIANTS into that list), but add one assertion to close the literal "offered for opt-in" reading. Non-blocking. |

**W1 and W2 are NOT archive-blockers.** Both are explicitly non-blocking per the verify-report (zero CRITICAL findings; clean test posture; clean design-contract audit; clean assertion-quality audit). They match pre-existing repo patterns (W1) or are narrow coverage nuances (W2). They are carried forward here for visibility, not closure.

## Spec Compliance Matrix (11 ACTIVE scenarios → test → RESULT)

| # | Spec scenario | Covering test(s) | Result |
|---|---|---|---|
| 1 | PRODUCTS targeting matches by product id | unit `match-target-tier.spec.ts:50` (+neg :75) · integ `Scenario 1` (:196, P2 line excluded) | ✅ COMPLIANT |
| 2 | CATEGORIES targeting matches by category id | **DEFERRED / out of scope** — `matchTargetTier`→null, `isSupportedEngineType`→false; documented negative tests `match-target-tier.spec.ts:114/122` | ➖ NOT COUNTED (DEFERRED in base spec) |
| 3 | PRODUCTS still matches every variant (back-compat) | unit helper `:58` · unit engine `w4:337` · integ `Scenario 3` (:275, both V-A/V-B) | ✅ COMPLIANT |
| 4 | VARIANTS matches only the exact variant | unit helper `:85` (+null `:93/:101`) · integ `Scenario 4` (:330, only V-A) | ✅ COMPLIANT |
| 5 | VARIANTS wins over PRODUCTS on same line | unit `w4:126` (V-A→PW/30c, V-B→PV/50c) · integ `Scenario 5` (:390) | ✅ COMPLIANT |
| 6 | VARIANTS wins regardless of discount magnitude | unit `w4:179` (V-A→10c, explicit `.not.toBe(500c)`) · integ `Scenario 6` (:472) | ✅ COMPLIANT |
| 7 | VARIANTS on a different variant does not match | unit helper `:147` · unit `w4:223` (result `[]`) · integ `Scenario 7` (:539) | ✅ COMPLIANT |
| 8 | MANUAL VARIANTS promo offered on matching drafts | unit `w4:253` · integ `Scenario 8` (:587) — `targetableManualPromotionIds` contains promo | ✅ COMPLIANT¹ (W2 nuance noted) |
| 9 | Opted-in MANUAL VARIANTS survives recompute | unit `w4:286` (targetable + applied across 2 recomputes) · integ `Scenario 9` (:635) | ✅ COMPLIANT |
| 10 | VARIANTS with existing tenant variant id accepted | unit `validate-variants:169` · integ `Scenario 10` (:728, persisted row asserted) | ✅ COMPLIANT |
| 11 | VARIANTS with non-existent variant id rejected | unit `validate-variants:210` (+sibling :242) · integ `Scenario 11` (:753, row counts unchanged) | ✅ COMPLIANT |
| 12 | VARIANTS cross-tenant variant id rejected | unit `validate-variants:276` · integ `Scenario 12` (:779, real T2 tenant, T1 rejects) | ✅ COMPLIANT |

**Coverage: 11/11 active scenarios COMPLIANT** — each verified by ≥1 test asserting its stated THEN outcome (not the inverse); 10/11 covered at BOTH the unit and integration layers. CATEGORIES (scenario 2 in spec numbering) is correctly DEFERRED and not counted toward active coverage.

¹ See WARNING W2 — scenario 8's assertion is on the `targetableManualPromotionIds` surface with the promo pre-opted-in; the "available-for-manual" (not-yet-opted-in `availableManualPromotions`) reading is not independently asserted for VARIANTS.


## TDD Compliance Audit (strict TDD module)

| Check | Result |
|-------|--------|
| TDD Evidence in apply-progress | ✅ Found (Engram #2931; per-WU RED→GREEN counts 1771→1802) |
| All tasks have tests | ✅ 24/24 subtasks; every WU has a RED-first spec |
| RED confirmed (test files exist) | ✅ all 5 spec files present in tree |
| GREEN confirmed (tests pass) | ✅ 1802/1802 unit + 33/33 integration on execution (2 consecutive runs, stable) |
| Triangulation adequate | ✅ multi-case per behavior (VARIANT vs PRODUCT vs null; hit/miss; existing/missing/cross-tenant; discount 30c<50c and 10c<500c) |
| Safety net for modified files | ✅ boundary `pnpm test:unit` after each WU, zero new failures |

## Test Layer Distribution

| Layer | Tests (this change) | Files | Tooling |
|---|---|---|---|
| Unit (pure/mocked) | +31 | `match-target-tier.spec.ts`, `pos-evaluate-promotions-w4.spec.ts`, `promotion-target-variants.spec.ts`, `promotions-validate-variants.spec.ts` | jest + ts-jest |
| Integration (real Postgres :5433, `.env.test`) | +11 | `variant-level-promo-targeting.integration.spec.ts` | jest + ts-jest, isolated DB |

Every active spec scenario is covered at the unit layer; 10/11 additionally at the integration layer (real DB). Validation scenarios 10–12 exist at both layers (unit mocks the client symbol; integration proves real tenant-scoping with a live second tenant).

## Files Changed (production + tests, vs `main`)

```
prisma/migrations/20260712072002_promotion_target_variants/migration.sql   |   8 +
prisma/schema.prisma                                                        |   1 +
src/promotions/application/match-target-tier.spec.ts                       | 200 +++++
src/promotions/application/pos-evaluate-promotions-w4.spec.ts               | 442 +++++++++++
src/promotions/application/pos-evaluate-promotions.use-case.ts              | 113 ++-
src/promotions/domain/promotion-target-variants.spec.ts                    |  87 +++
src/promotions/domain/promotion.entity.ts                                   |   2 +-
src/promotions/dto/create-promotion.dto.ts                                  |   1 +
src/promotions/promotions-validate-variants.spec.ts                        | 353 +++++++++
src/promotions/promotions.service.ts                                        |  14 +-
src/promotions/variant-level-promo-targeting.integration.spec.ts           | 866 +++++++++++++++++++++
11 files changed, 2062 insertions(+), 25 deletions(-)
```

No out-of-scope production files touched. Everything is within `src/promotions/**`, `prisma/`, or the test files themselves.

## Archive Contents

- `proposal.md` ✅
- `explore.md` ✅ (preserved with original filename; matches prior archive convention for older-style changes)
- `design.md` ✅
- `tasks.md` ✅ (24/24 subtasks complete, 0 unchecked; CATEGORIES / BRANDS / BUY_X_GET_Y / ADVANCED / priority / stacking / usage limits / tax / online-cart-engine / frontend listed under DEFERRED — NOT gaps)
- `specs/pos-promotion-engine/spec.md` ✅ (delta-style spec preserved for audit trail)
- `verify-report.md` ✅ (PASS WITH WARNINGS, 0 CRITICAL)
- `archive-report.md` ✅ (this file)

## Source-of-Truth Files Updated

The following main spec now reflects the new behavior:

- `openspec/specs/pos-promotion-engine/spec.md` — MODIFIED (additive). 1 requirement MODIFIED (`PRODUCT_DISCOUNT Matches Target Items` — adds VARIANTS clause, PRODUCTS back-compat scenario, VARIANTS-exact scenario; CATEGORIES scenario explicitly marked DEFERRED with strong explanatory note). 2 requirements ADDED (`VARIANT-Wins Specificity Precedence`, `VARIANTS Target Validation`). Verification Surface expanded with 5 new test files. **Total: 17 requirements, 47 scenarios** (11 ACTIVE coverage + 1 explicitly DEFERRED + preserved prior scenarios). All 15 prior requirements preserved verbatim.

No other main spec required modification.


## Engram Observations for Traceability

| Topic | Obs ID | Purpose |
|-------|--------|---------|
| `sdd/variant-level-promo-targeting/proposal` | #2926 | Full proposal artifact |
| `sdd/variant-level-promo-targeting/design` | #2928 | Full design artifact |
| `sdd/variant-level-promo-targeting/spec` | #2929 | Full delta spec artifact |
| `sdd/variant-level-promo-targeting/tasks` | #2930 | Full tasks artifact |
| `sdd/variant-level-promo-targeting/apply-progress` | #2931 | Per-WU RED→GREEN counts, commits, learn notes |
| `sdd/variant-level-promo-targeting/verify-report` | #2935 | Verify PASS WITH WARNINGS, 0 CRITICAL |
| `sdd/variant-level-promo-targeting/archive-report` | #2937 | This archive report |

## Archive Notes

- Branch `feat/variant-level-promo-targeting` is **NOT merged to main** and is **NOT pushed**. The solo dev merges manually after archive; this is intentional per the developer's normal workflow (no PRs, chained work-unit branches). The 6 implementation commits (W1 → W6) remain intact in the branch history (HEAD = `24f063b`). They will land on `main` when the dev merges manually.
- No production source code or tests were modified during archive. Only spec/artifact movement:
  - `openspec/specs/pos-promotion-engine/spec.md` — MODIFIED (1 req) + ADDED (2 req) + Verification Surface expanded (5 test files).
  - `openspec/changes/variant-level-promo-targeting/` → `openspec/changes/archive/2026-07-12-variant-level-promo-targeting/` moved.
  - New `archive-report.md` written inside the archived change folder.
- `openspec/changes/archive/2026-07-12-variant-level-promo-targeting/` is now the immutable audit trail.
- The delta-style spec at `openspec/changes/archive/2026-07-12-variant-level-promo-targeting/specs/pos-promotion-engine/spec.md` is preserved verbatim. The merged baseline spec is at `openspec/specs/pos-promotion-engine/spec.md`.
- The `explore.md` file is preserved with its original filename (matches prior archive convention for older-style changes; the audit trail reflects what the change folder contained).
- Git working tree status at archive time: the only tracked-out-of-band files are the `openspec/changes/variant-level-promo-targeting/...` SDD artifacts that were moved into the archive folder. No production source, no migration, no test file changed at archive time. `git status --short` after the move shows the archive folder present (will be committed separately by the user as part of his merge flow).

## DEFERRED — User Action Required After Merge

### Spec scenarios explicitly DEFERRED (NOT gaps, NOT failed tests)

1. **`PRODUCT_DISCOUNT` CATEGORIES targeting** — `pos-promotion-engine` spec scenario "CATEGORIES targeting matches by category id". Reason: needs `SaleItem` category/brand snapshot columns (separate additive change) plus activation in `isSupportedEngineType`. Engine source today: `isSupportedEngineType` returns `false` for `appliesTo = CATEGORIES`, `matchTargetTier` returns `null` for it (unit-tested negative). Engine will silently skip or reject `appliesTo = CATEGORIES` promotions today. **The base spec scenario is explicitly marked DEFERRED so readers do not falsely infer that CATEGORIES works** — see the blockquote note in `openspec/specs/pos-promotion-engine/spec.md:128`.
2. **`PRODUCT_DISCOUNT` BRANDS targeting** — Same reason as CATEGORIES. Same DEFERRED status.

Correctly excluded from gap accounting — these are NOT implementation gaps; they are intentional scope deferrals documented in `tasks.md` (DEFERRED section) and `design.md`. The base spec now correctly carries the DEFERRED marking so this ambiguity does not recur in future archives.

### Proposal non-goals (out of scope by design, not "spec scenarios")

These were explicitly listed as non-goals in the proposal (`proposal.md:19-20`) and are NOT part of any spec:

- `BUY_X_GET_Y` promotion evaluation
- `ADVANCED` promotion evaluation
- Online / cart engine `evaluate-cart-promotions.use-case.ts` — match predicate factored as a pure helper so it is reusable there later, but the engine wiring is out of scope
- Priority / stacking fields — best-wins by max customer discount in cents, tiebreak by lowest `promotionId`
- Usage limits / caps — no such fields exist on the `Promotion` model
- Tax model — `Sale` / `SaleItem` are tax-agnostic
- All frontend work — backend + DB + domain only

### Carried-forward non-blocking warnings (NOT blockers, NOT failures)

- **W1** (test-only latent `tsc --noEmit` type hygiene — 4 errors in this change's spec files; matches pre-existing repo pattern of 44 spec type-errors on surfaces the build never checks).
- **W2** (scenario 8 coverage nuance: `availableManualPromotions` (not-yet-opted-in offer list) path not independently asserted for VARIANTS, only `targetableManualPromotionIds` with pre-opted-in promo).

Both are documented in the verify-report and here for future cleanup. They are NOT archive-blockers and do NOT gate merge.

## SDD Cycle Complete

The change has been fully explored, proposed, specified, designed, broken into tasks, implemented across 6 work-unit commits (W1 → W6), verified PASS WITH WARNINGS (**1802/0/0 unit + 33/0/0 integration**, 2 consecutive runs, stable; all design contracts honored by passing tests + source inspection; 11/11 active spec scenarios covered; TDD + assertion quality clean; 0 CRITICAL), and the baseline spec (`pos-promotion-engine`) is now the new source of truth with the CATEGORIES scenario correctly marked DEFERRED. Ready for the next change.
