# Archive Report: Activate CATEGORIES & BRANDS Targeting in the POS Promotion Engine

## Final Verdict: ARCHIVED — PASS WITH NON-BLOCKING WARNINGS

- **Change**: `category-brand-promo-targeting`
- **Branch**: `feat/category-brand-promo-targeting`
- **HEAD sha**: `c675152`
- **Archive folder**: `openspec/changes/archive/2026-07-13-category-brand-promo-targeting/`
- **Archived at**: 2026-07-13
- **Merge state**: branch **NOT merged to `main`**, **NOT pushed** — solo dev merges manually (no PRs, per repo convention)
- **Verify verdict**: PASS WITH WARNINGS — **267 passed / 0 failed unit** (6 canonical sweep suites) + **22 passed / 0 failed integration** (2 suites, runInBand on isolated Postgres `:5433`); variant-level integration sweep held **11/11** (no regression guard fail). Production build type-clean. `prisma migrate diff` returns "No difference detected." — **0 CRITICAL findings.** 15/15 spec scenarios COMPLIANT.
- **Tasks**: 20/20 subtasks across 5 work units, 0 unchecked
- **Spec compliance**: `pos-promotion-engine` (MODIFIED, +2 requirements / +8 scenarios net; the prior CATEGORIES DEFERRED scenario is now active and the blockquote removed; null-guard scenarios + 2 new requirement blocks added) — COMPLIANT with runtime test evidence.

## Commits Archived (5 work-unit commits)

| Hash | Slice | Title |
|------|-------|-------|
| `e801716` | W1 | `feat(engine): add CATEGORIES/BRANDS branches + null guards to matchTargetTier` |
| `6f34ea4` | W2 | `feat(engine): widen LineMatchTier + ordinal pre-pass + CATEGORIES/BRANDS gate` |
| `635d7fd` | W3 | `feat(products): add resolveProductCategoryBrandIds tenant-scoped resolver` |
| `7986118` | W4 | `feat(sales): stamp categoryId/brandId onto PosEvalLine in buildPosEvalInput` |
| `c675152` | W5 | `test(promotions): e2e integration sweep for category/brand targeting` |

Order: W1 → W2 → W3 → W4 → W5. Branch HEAD: `c675152` on `feat/category-brand-promo-targeting`.

## What Shipped

Opens the gate that was already-half-built: `CATEGORIES` / `BRANDS` were reserved on the Postgres enum, the domain entity, the DTO, and `validateTargetIds`, but `isSupportedEngineType` returned `false` and `matchTargetTier` returned `null` for them (unit-tested negative). This change activates them inside the POS engine while introducing a precise **specificity ladder** `VARIANT > PRODUCT > {BRAND ≡ CATEGORY}` — a generalization of the prior binary `VARIANT-wins` pre-pass. `BRAND` and `CATEGORY` are EQUAL-BROADNESS PEERS (both single-valued scalars on `Product`); they never win over each other by tier, only by best-wins (highest discount, then lowest promotionId). Validation is untouched and remains GLOBAL for `Category` / `Brand` (these models are non-tenant-scoped). The online/cart engine is out of scope. **No DB migration.** Data is resolved live at eval time from `Product.categoryId` / `Product.brandId` via a new tenant-scoped batch resolver.

The change ships:

1. **Matcher widening** (`src/promotions/application/pos-evaluate-promotions.use-case.ts:76`):
   - `LineMatchTier` widens to `'VARIANT' | 'PRODUCT' | 'BRAND' | 'CATEGORY' | null`.
   - `PerLineCandidate.tier` widens to the same union.
   - `matchTargetTier` gains CATEGORIES + BRANDS branches after PRODUCTS, each `line.field != null`-guarded (mirrors the existing `variantId != null` guard at `:84`). The line param shape widens to `{ productId; variantId; categoryId?; brandId? }` — all optional so legacy callers stay legal.

2. **Ordinal pre-pass — generalization of the prior binary VARIANT-wins pre-pass** (`pos-evaluate-promotions.use-case.ts:412–423`):
   ```ts
   const TIER_ORDINAL: Record<Tier, number> = { VARIANT: 3, PRODUCT: 2, BRAND: 1, CATEGORY: 1 };
   const maxOrd = Math.max(0, ...eligible.map(c => TIER_ORDINAL[c.tier]));
   const top     = eligible.filter(c => TIER_ORDINAL[c.tier] === maxOrd);
   const winner  = pickBestByMaxDiscountThenLowestId(top);     // best-wins unchanged
   ```
   **Zero-regression proof for VARIANTS/PRODUCTS-only inputs**: when candidates contain only `VARIANT`/`PRODUCT`, `maxOrd === 3` iff any `VARIANT` exists (keeps only `VARIANT`s — identical to the prior `hasVariantTier` branch); else `maxOrd === 2` (keeps all `PRODUCT`s — identical to the prior `else` branch). For BRAND(1)/CATEGORY(1) only the peer maxOrd equals 1 and both survive into best-wins — exactly the decision.

3. **Engine gate flip** (`pos-evaluate-promotions.use-case.ts:335–350`): `isSupportedEngineType` accepts `PRODUCT_DISCOUNT` with `appliesTo ∈ {CATEGORIES, BRANDS}` (prior `false` deferral removed). Self-heal `targetableManualPromotionIds` correctly retains opted-in MANUAL CATEGORIES/BRANDS promotions on drafts with matching lines (covered by `pos-evaluate-promotions-w4.spec.ts` and the integration sweep).

4. **Port field add** (`src/promotions/application/ports/pos-evaluate-promotions.port.ts:28–41`):
   ```ts
   categoryId: string | null;
   brandId:    string | null;
   ```
   Optional on construction so existing callers stay legal; nullable because not every product has a category or brand.

5. **Tenant-scoped resolver** (`src/products/products.service.ts`):
   ```ts
   async resolveProductCategoryBrandIds(
     productIds: ReadonlyArray<string>,
   ): Promise<Map<string, { categoryId: string | null; brandId: string | null }>> {
     const distinct = [...new Set(productIds)];
     if (distinct.length === 0) return new Map();
     const rows = await this.tenantPrisma.getClient().product.findMany({
       where: { id: { in: distinct } },
       select: { id: true, categoryId: true, brandId: true },
     });
     return new Map(rows.map(r => [r.id, { categoryId: r.categoryId, brandId: r.brandId }]));
   }
   ```
   Clone of `resolvePriceListGlobalIds` (`:2463–2480`), select clause widened. N+1-safe. Missing ids are omitted; null category/brand preserved.

6. **Plumber wiring** (`src/sales/sales.service.ts:591–628`, in `buildPosEvalInput`): one additional call to `resolveProductCategoryBrandIds(distinctProductIds)`, then stamp each `PosEvalLine.categoryId` / `.brandId`. Lines whose product is not in the map get `null` (i.e. "silent skip" — the same semantic the engine guard expresses).

7. **Validation — unchanged, correctly relied upon** (`src/promotions/promotions.service.ts:528`): `validateTargetIds` CATEGORIES + BRANDS branches already used GLOBAL `this.prisma.category` / `this.prisma.brand` (since `Category` / `Brand` have no `tenantId`). Throws `InvalidArgumentError(…, 'INVALID_TARGET')` BEFORE persistence — proven not-persisted via row-count assertions in V3 / V4.

8. **Strict TDD test coverage** (`+8` scenarios on baseline, 0 failures):
   - `src/promotions/application/match-target-tier.spec.ts` — CATEGORIES → `'CATEGORY'`, BRANDS → `'BRAND'`, null guards (line.categoryId === null + CATEGORIES → null; line.brandId === null + BRANDS → null). Mirrors existing VARIANT/PRODUCT cases.
   - `src/promotions/application/pos-evaluate-promotions-precedence.spec.ts` (NEW) — 4-tier V > P > {B≡C}; 3-tier P > {B≡C}; 2-tier B≡C → best-wins (CAT wins on 500c vs 100c; the test also flips to BRAND > CAT, proving no BRAND-over-CATEGORY hierarchy; lowest-id tiebreak); VARIANTS/PRODUCTS-only regression guard.
   - `src/promotions/application/pos-evaluate-promotions-w4.spec.ts` — extended: `isSupportedEngineType` accepts CATEGORIES/BRANDS for PRODUCT_DISCOUNT; self-heal `targetableManualPromotionIds` retains opted-in CATEGORIES/BRANDS MANUAL with a matching line.
   - `src/promotions/application/pos-evaluate-promotions.use-case.spec.ts` — engine sweep green; full variant-level regression through it.
   - `src/products/resolve-product-category-brand-ids.spec.ts` (NEW) — distinct→1 call, empty→0, missing omitted, null preserved, `tenantPrisma.getClient` asserted.
   - `src/sales/sales.service.spec.ts` — extended: `buildPosEvalInput` calls resolver exactly once with distinct productIds and stamps `categoryId`/`brandId` per line.
   - `src/promotions/category-brand-promo-targeting.integration.spec.ts` (NEW) — live-DB end-to-end sweep on Postgres `:5433`, `.env.test` (NEVER dev DB); 11 spec-scenario-named cases.
   - **Regression guard**: `src/promotions/variant-level-promo-targeting.integration.spec.ts` re-run on the same merge — held 11/11, proving the ordinal `maxOrdinal` pre-pass generalization did NOT regress prior VARIANTS behavior.

## Specs Synced into Source of Truth

| Domain | Action | Requirements |
|--------|--------|--------------|
| `pos-promotion-engine` | **MODIFIED** (additive) | 1 MODIFIED (`PRODUCT_DISCOUNT Matches Target Items` — un-defer CATEGORIES/BRANDS, add null-guard clause, replace DEFERRED scenario+blockquote with 4 active scenarios: CATEGORIES, BRANDS, null-categoryId, null-brandId). 2 ADDED (`Specificity Precedence Ladder VARIANT > PRODUCT > {BRAND ≡ CATEGORY}` and `CATEGORIES and BRANDS Target Validation`). Pre-existing 17 requirements preserved verbatim (including the 2 from the prior `variant-level-promo-targeting` archive). Verification Surface updated: `match-target-tier.spec.ts` entry now reflects tier → BRAND/CATEGORY (was null); 3 new test files added. |

### `pos-promotion-engine` canonical spec — final shape

The MODIFIED requirement (`PRODUCT_DISCOUNT Matches Target Items`) was updated with:
- New sentence fragments: `CATEGORIES matches a line when the line's product categoryId equals the target's targetId`, `BRANDS matches a line when the line's product brandId equals the target's targetId`, plus the **null-guard** clause: "A line whose product has a null `categoryId` MUST NOT match any `CATEGORIES` promotion, and a line whose product has a null `brandId` MUST NOT match any `BRANDS` promotion."
- Replaced `(Previously: …)` context note to reflect the DEFERRED → ACTIVE transition.
- REMOVED scenario: `CATEGORIES targeting matches by category id (DEFERRED — not supported by the current engine)` + the strong blockquote that followed it. The deferral is now resolved.
- ADDED (replacing the DEFERRED one, in the same scenario slot to preserve ordering): `CATEGORIES targeting matches by product category id` (active, normative).
- ADDED: `BRANDS targeting matches by product brand id` (active, normative).
- ADDED: `Line whose product has null categoryId does not match a CATEGORIES promo`.
- ADDED: `Line whose product has null brandId does not match a BRANDS promo`.
- PRESERVED: `PRODUCTS targeting matches by product id`, `PRODUCTS still matches every variant of a variant-bearing product`, `VARIANTS matches only the exact variant`.

Two ADDED requirements appended after `VARIANTS Target Validation` and before `Verification Surface`:
- `Specificity Precedence Ladder VARIANT > PRODUCT > {BRAND ≡ CATEGORY}` — 4 scenarios (VARIANTS-wins-over-BR&C, PRODUCTS-wins-over-BR&C, BR≡CAT peers best-wins + flip guarantee, VARIANTS/PRODUCTS-only regression guard).
- `CATEGORIES and BRANDS Target Validation` — 4 scenarios (existing id accepted × 2, non-existent id rejected with INVALID_TARGET 400 + zero rows persisted × 2).

Verification Surface updated:
- `match-target-tier.spec.ts` — entry updated from "(table-driven: VARIANT/PRODUCT/null tier; null `variantId` never matches VARIANTS; CATEGORIES/BRANDS → null)" to "(table-driven: VARIANT/PRODUCT/BRAND/CATEGORY tier; null `variantId`/`categoryId`/`brandId` never matches its respective type)" — reflects the new positive branches and null-guard semantics.
- NEW entry: `src/promotions/application/pos-evaluate-promotions-precedence.spec.ts` (ordinal `maxOrdinal` pre-pass; 4-tier / 3-tier / 2-tier + VARIANTS/PRODUCTS-only regression guard).
- NEW entry: `src/promotions/category-brand-promo-targeting.integration.spec.ts` (live-DB e2e on Postgres :5433 — 11 spec-scenario-named cases: matcher 2–5, precedence P1–P3, validation V1–V4).
- NEW entry: `src/products/resolve-product-category-brand-ids.spec.ts` (tenant-scoped resolver; distinct→1 call, empty→0, missing omitted, null preserved, `tenantPrisma.getClient` asserted).
- `sales.service.spec.ts` — annotation extended to mention "W4 stamps `categoryId`/`brandId` per PosEvalLine".

All 17 prior requirements (15 from baseline + 2 added by `variant-level-promo-targeting`) preserved verbatim. The `VARIANT-Wins Specificity Precedence` requirement (which the new ladder **generalizes**) is preserved alongside; the new `Specificity Precedence Ladder` requirement supersedes it in semantic coverage but the prior scenarios are still guaranteed active (covered by the regression-guard scenario in the new ladder, and the `variant-level-promo-targeting.integration.spec.ts` regression guard held 11/11).

**Final baseline `pos-promotion-engine` spec totals**: **19 requirements**, **58 scenarios** at file level. Of the 58 scenarios, 15/15 are the COMPLIANT scenarios governed by this change's compliance matrix; the remaining scenarios are legacy coverage carried forward from the prior `variant-level-promo-targeting` and earlier archives and continued to be exercised by the existing + extended test sweep (267/267 unit + 22/22 integration, all green). The prior DEFERRED marker on CATEGORIES was REMOVED — the scenario is now active, normative, and verified by integration scenarios 2 / 3. The spec remains the living contract for the engine.

## Design Coherence

No reconciliations needed at archive time. The proposal.md, design.md, tasks.md, verify-report.md, and shipped code are aligned:

- `matchTargetTier` branches use `line.categoryId != null` and `line.brandId != null` (explicit `!= null`, mirroring the `variantId` guard) — locked decision #2 satisfied.
- Pre-pass is ordinal `TIER_ORDINAL {VARIANT:3, PRODUCT:2, BRAND:1, CATEGORY:1}`, filter to top ordinal, then best-wins — locked decision #1 satisfied. No BRAND-over-CATEGORY hierarchy.
- `resolveProductCategoryBrandIds` uses `this.tenantPrisma.getClient().product` — locked decision #3 (resolution TENANT-scoped) satisfied.
- `validateTargetIds` uses GLOBAL `this.prisma.category` / `this.prisma.brand` — locked decision #3 (validation GLOBAL) satisfied. RESOLUTION and VALIDATION are distinct clients; both facts hold.
- `evaluate-cart-promotions.use-case.ts` absent from `git diff main..HEAD` — locked decision #4 (POS engine ONLY) satisfied.
- `prisma migrate diff` returns "No difference detected." — no-migration gate satisfied.
- Null target id → `InvalidArgumentError('… not found', 'INVALID_TARGET')` at target-build (before create) — locked decision #5 satisfied. V3/V4 assert zero persisted promotion/target rows.

## Gate Findings — Carried-Forward Non-Blocking Warnings

| Tag | Severity | Status | Description |
|-----|----------|--------|-------------|
| **W1** | WARNING (non-blocking) | New (introduced this change) | 5 test-fixture type-hygiene errors in spec files only: 4× `src/sales/sales.service.spec.ts` lines 5115/5128/5141/5225 (W4 commit `7986118`) — `priceSource: 'manual'` fixture literal not in the `'default' \| 'price_list' \| 'custom' \| null` union; 1× `src/promotions/category-brand-promo-targeting.integration.spec.ts` line 116 (W5 commit `c675152`) — `ClsService` mock typing `(key)=>…` vs `TenantClsStore` getter (cloned from the pre-existing variant-level harness pattern at L69/L843, commit `24f063b`). The 84 remaining `tsc --noEmit` errors pre-date this change (older commits `c8c1cc02`/`06ad4c37`/`be2ad926`/`c04af846`/`24f063b` plus unrelated modules — known repo-wide `isolatedModules` spec-type-drift pattern). Production build via `tsc -p tsconfig.build.json --noEmit` (excludes `**/*spec.ts`) is CLEAN — exit 0, 0 errors. **Runtime behavior is correct**: 267/267 unit + 22/22 integration green. Masked because Jest transpiles specs per-file (isolatedModules) without cross-file type-checking. Suggested follow-up: fix the fixtures / widen the domain type if `'manual'` is a legitimate source; align the ClsService mock typing — separate test-hygiene cleanup. |
| **W2** | WARNING (non-blocking) | provenance/accuracy note | `apply-progress` (#2977) states "Final typecheck (`npx tsc --noEmit`) clean … (no new errors introduced)". That is accurate for production sites but FALSE for spec files — this change introduced the 5 new spec-file type errors cataloged in W1. Minor self-report inaccuracy for the orchestrator; the substance is sound, only the wording underreports scope. |
| **W3** | WARNING (non-blocking) | report-format deviation | TDD evidence is reported as narrative + explicit RED/GREEN/VERIFY steps per work unit in tasks.md / apply-progress, NOT the prescribed 6-column "TDD Cycle Evidence" table. TDD substance is verifiable and sound (all 6 unit spec files + 2 integration spec files present; W2/W3 added NEW spec files; 267/267 + 22/22 GREEN on independent re-run); only the *shape* of the reporting deviates. |

None of W1 / W2 / W3 are archive blockers. They are documented for the orchestrator and for future cleanup.

## Engram Observations for Traceability

| Topic | Obs ID | Purpose |
|-------|--------|---------|
| `sdd/category-brand-promo-targeting/decisions` | #2968 | Locked-design decisions (precedence, null guard, scope, validation) |
| `sdd/category-brand-promo-targeting/proposal` | #2969 | Full proposal artifact |
| `sdd/category-brand-promo-targeting/design` | #2970 | Full design artifact |
| `sdd/category-brand-promo-targeting/spec` | #2971 | Full delta spec artifact |
| `sdd/category-brand-promo-targeting/tasks` | #2972 | Full tasks artifact |
| `sdd/category-brand-promo-targeting/apply-progress` | #2977 | Per-WU RED→GREEN counts, commits, learn notes |
| `sdd/category-brand-promo-targeting/verify-report` | #2982 | Verify PASS WITH WARNINGS, 0 CRITICAL |
| `sdd/category-brand-promo-targeting/archive-report` | (this report) | This archive report |

## Archive Notes

- Branch `feat/category-brand-promo-targeting` is **NOT merged to main** and is **NOT pushed**. The solo dev merges manually after archive; this is intentional per the developer's normal workflow (no PRs, chained work-unit branches). The 5 implementation commits (W1 → W5) remain intact in the branch history (HEAD = `c675152`). They will land on `main` when the dev merges manually.

- No production source code or tests were modified during archive. Only spec/artifact movement:
  - `openspec/specs/pos-promotion-engine/spec.md` — MODIFIED (1 requirement, +8 scenarios net, removed DEFERRED blockquote) + ADDED (2 requirements, +8 scenarios) + Verification Surface updated (`match-target-tier.spec.ts` entry + 3 new test files).
  - `openspec/changes/category-brand-promo-targeting/` → `openspec/changes/archive/2026-07-13-category-brand-promo-targeting/` moved.
  - New `archive-report.md` written inside the archived change folder.

- `openspec/changes/archive/2026-07-13-category-brand-promo-targeting/` is now the immutable audit trail.

- The delta-style spec at `openspec/changes/archive/2026-07-13-category-brand-promo-targeting/specs/pos-promotion-engine/spec.md` is preserved verbatim. The merged baseline spec is at `openspec/specs/pos-promotion-engine/spec.md`.

- The `exploration.md` file is preserved with its original filename (matches the change folder convention; the prior `variant-level-promo-targeting` archive kept a similar `explore.md`).

- Git working tree status at archive time: the only tracked-out-of-band files are the `openspec/changes/category-brand-promo-targeting/...` SDD artifacts that were moved into the archive folder. No production source, no migration, no test file changed at archive time. `git status --short` after the move shows:
  - `M openspec/specs/pos-promotion-engine/spec.md` (synced base spec — the 4 edits: MODIFIED requirement description, DEFERRED→ACTIVE scenarios, 2 new requirements, Verification Surface)
  - `?? openspec/changes/archive/2026-07-13-category-brand-promo-targeting/` (new archive folder — will be committed by the user)

## Spec scenarios — no longer DEFERRED (resolved by this change)

| # | Scenario | Status | Resolution |
|---|----------|--------|------------|
| 1 | `PRODUCT_DISCOUNT` CATEGORIES targeting matches by category id | ✅ RESOLVED | Un-deferred; gate flipped; matcher accepts; integration sweep Scenario 2 green. |
| 2 | `PRODUCT_DISCOUNT` BRANDS targeting matches by brand id | ✅ RESOLVED | Un-deferred; gate flipped; matcher accepts; integration sweep Scenario 3 green. |

Correctly excluded from gap accounting — these WERE intentional scope deferrals from the prior `variant-level-promo-targeting` archive, and this change is precisely the resolution (locked decision #1 + #4). The base spec now carries the requirement as active, normative engine behavior, so the ambiguity does not recur in future archives.

## Proposal non-goals (out of scope by design, not "spec scenarios")

These were explicitly listed as non-goals in the proposal (`proposal.md:34–41`) and are NOT part of any spec:

- `BUY_X_GET_Y` promotion evaluation
- `ADVANCED` promotion evaluation
- Online / cart engine `evaluate-cart-promotions.use-case.ts` — POS engine only this change
- `SaleItem` snapshot columns, schema/migration, backfill — data is resolved live
- Frontend / admin UI changes
- Tenant-scoping of Category/Brand validation — they are global models, kept global (validation) while resolution stays tenant-scoped

## SDD Cycle Complete

The change has been fully explored, proposed, specified, designed, broken into tasks, implemented across 5 work-unit commits (W1 → W5), verified PASS WITH WARNINGS (**267/0 unit + 22/0 integration**, all design contracts honored by passing tests + source inspection; 15/15 spec scenarios covered; TDD substance clean; 0 CRITICAL), and the baseline spec (`pos-promotion-engine`) is now the new source of truth with CATEGORIES / BRANDS engine targeting ACTIVE, an explicit precedence ladder, and global target validation. The prior `variant-level-promo-targeting` regression guard was held intact (11/11). Ready for the next change.
