```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:786df3e75d269d6af8478971b822650aa5763f5adefb0de7d75c7a24ac079368
verdict: pass
blockers: 0
critical_findings: 0
requirements: 3/3
scenarios: 15/15
test_command: pnpm exec jest --config jest.config.js src/promotions/application/match-target-tier.spec.ts src/promotions/application/pos-evaluate-promotions-precedence.spec.ts src/promotions/application/pos-evaluate-promotions-w4.spec.ts src/promotions/application/pos-evaluate-promotions.use-case.spec.ts src/products/resolve-product-category-brand-ids.spec.ts src/sales/sales.service.spec.ts
test_exit_code: 0
test_output_hash: sha256:786df3e75d269d6af8478971b822650aa5763f5adefb0de7d75c7a24ac079368
build_command: npx tsc -p tsconfig.build.json --noEmit
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Verification Report

**Change**: category-brand-promo-targeting
**Version**: pos-promotion-engine delta — 1 MODIFIED + 2 ADDED requirements
**Mode**: Strict TDD
**Branch**: `feat/category-brand-promo-targeting` (5 commits: e801716, 6f34ea4, 635d7fd, 7986118, c675152)
**Verdict**: **PASS WITH WARNINGS** — 0 blockers, 0 CRITICAL, 15/15 scenarios covered by passing tests. 5 new type-hygiene warnings confined to test fixtures (production build clean).

### Completeness
| Metric | Value |
|--------|-------|
| Work units | 5 / 5 committed |
| Task checklist items | 20 |
| Tasks complete | 20 |
| Tasks incomplete | 0 |

All tasks `[x]` → full spec-driven verification permitted (no pending-task block).

### Build & Tests Execution

**Build (production type-check, specs excluded via `tsconfig.build.json`)**: ✅ Passed
```text
$ npx tsc -p tsconfig.build.json --noEmit
BUILD_EXIT=0   (0 errors — empty output, canonical digest e3b0c442…)
```
The production build excludes `**/*spec.ts`. Every source file this change touched
(`products.service.ts`, `pos-evaluate-promotions.use-case.ts`,
`ports/pos-evaluate-promotions.port.ts`, `sales.service.ts`) is type-clean.

**Tests**: ✅ 289 passed / ❌ 0 failed / ⚠️ 0 skipped (all filtered per anti-hang rules — no bare suite)

Unit (canonical sweep, exit 0, hash `786df3e7…`):
```text
$ pnpm exec jest --config jest.config.js \
    src/promotions/application/match-target-tier.spec.ts \
    src/promotions/application/pos-evaluate-promotions-precedence.spec.ts \
    src/promotions/application/pos-evaluate-promotions-w4.spec.ts \
    src/promotions/application/pos-evaluate-promotions.use-case.spec.ts \
    src/products/resolve-product-category-brand-ids.spec.ts \
    src/sales/sales.service.spec.ts
Test Suites: 6 passed, 6 total
Tests:       267 passed, 267 total
```
(Split evidence: 5 engine/product specs = 94 passed; sales.service.spec.ts = 173 passed.)

Integration (exit 0, TEST DB :5433, globalSetup applied 30 migrations + seed):
```text
$ pnpm exec jest --config jest.integration.config.js \
    src/promotions/category-brand-promo-targeting.integration.spec.ts \
    src/promotions/variant-level-promo-targeting.integration.spec.ts --runInBand
Test Suites: 2 passed, 2 total
Tests:       22 passed, 22 total    (category-brand 11 + variant-level 11)
```
Regression guard: `variant-level-promo-targeting.integration.spec.ts` still **11/11** —
proves the ordinal `maxOrdinal` pre-pass generalization did NOT regress prior VARIANTS behavior.

No-migration gate:
```text
$ pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma
No difference detected.
```

**Coverage**: ➖ Not separately measured — coverage run avoided to respect the mandatory
anti-hang constraint. Every changed production line is directly exercised: `matchTargetTier`
CATEGORY/BRAND branches + null guards (match-target-tier.spec), ordinal pre-pass
(precedence.spec), resolver (resolve-product-category-brand-ids.spec), stamping in
`buildPosEvalInput` (sales.service.spec), and full-stack in the integration sweep.

### Spec Compliance Matrix

Requirement A = *PRODUCT_DISCOUNT Matches Target Items* (MODIFIED),
B = *Specificity Precedence Ladder* (ADDED), C = *CATEGORIES and BRANDS Target Validation* (ADDED).

| # | Req | Scenario | Covering test(s) | Result |
|---|-----|----------|------------------|--------|
| 1 | A | PRODUCTS matches by product id | `variant-level.integration › Scenario 1`; `match-target-tier.spec` PRODUCTS cases | ✅ COMPLIANT |
| 2 | A | CATEGORIES matches by category id | `category-brand.integration › Scenario 2`; `match-target-tier.spec › returns "CATEGORY"…`; `w4.spec › AUTO CATEGORIES…matches` | ✅ COMPLIANT |
| 3 | A | BRANDS matches by brand id | `category-brand.integration › Scenario 3`; `match-target-tier.spec › returns "BRAND"…`; `w4.spec › AUTO BRANDS…matches` | ✅ COMPLIANT |
| 4 | A | null categoryId → no CATEGORIES match | `category-brand.integration › Scenario 4`; `match-target-tier.spec › null when line.categoryId is null (null guard)` | ✅ COMPLIANT |
| 5 | A | null brandId → no BRANDS match | `category-brand.integration › Scenario 5`; `match-target-tier.spec › null when line.brandId is null (null guard)` | ✅ COMPLIANT |
| 6 | A | PRODUCTS still hits every variant | `variant-level.integration › Scenario 3`; `w4.spec › PRODUCTS still hits every variant` | ✅ COMPLIANT |
| 7 | A | VARIANTS matches only exact variant | `variant-level.integration › Scenario 4`; `w4.spec › VARIANTS on different variant does not match` | ✅ COMPLIANT |
| 8 | B | VARIANTS wins over BRANDS & CATEGORIES | `precedence.spec › VARIANT wins over BRAND/CATEGORY (4-tier)`; `category-brand.integration › Precedence P1` | ✅ COMPLIANT |
| 9 | B | PRODUCTS wins over BRANDS & CATEGORIES | `precedence.spec › PRODUCT wins over BRAND/CATEGORY (3-tier)`; `category-brand.integration › Precedence P2` | ✅ COMPLIANT |
| 10 | B | BRAND≡CATEGORY peers — best-wins, not tier (incl. flip) | `precedence.spec › BRAND ≡ CATEGORY peers (2-tier)` (CAT wins; **flips** when BRAND>CAT; lowest-id tie); `category-brand.integration › Precedence P3` | ✅ COMPLIANT |
| 11 | B | VARIANTS/PRODUCTS-only unchanged (regression) | `precedence.spec › VARIANTS/PRODUCTS-only regression guard` (V-A wins; V-B → PRODUCTS); full `variant-level.integration` 11/11 | ✅ COMPLIANT |
| 12 | C | CATEGORIES existing id accepted | `category-brand.integration › Validation V1` | ✅ COMPLIANT |
| 13 | C | BRANDS existing id accepted | `category-brand.integration › Validation V2` | ✅ COMPLIANT |
| 14 | C | CATEGORIES missing id → INVALID_TARGET 400, no persist | `category-brand.integration › Validation V3` (asserts rejection + NO promotion/target rows) | ✅ COMPLIANT |
| 15 | C | BRANDS missing id → INVALID_TARGET 400, no persist | `category-brand.integration › Validation V4` (asserts rejection + NO promotion/target rows) | ✅ COMPLIANT |

**Compliance summary**: **15/15 scenarios COMPLIANT** — each backed by ≥1 test that passed at runtime; 13/15 carry both unit and integration coverage.

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| A — matcher CATEGORIES/BRANDS + null guards | ✅ Implemented | `matchTargetTier` branches use `line.categoryId != null` / `line.brandId != null` (scalar `===` compare), mirroring the `variantId` guard. |
| A — gate un-defer | ✅ Implemented | `isSupportedEngineType` accepts `PRODUCT_DISCOUNT` with `CATEGORIES`/`BRANDS` (prior `false` deferral removed). |
| B — precedence ladder | ✅ Implemented | Ordinal `TIER_ORDINAL {VARIANT:3, PRODUCT:2, BRAND:1, CATEGORY:1}`, `maxOrdinal` filter → best-wins on survivors. No BRAND-over-CATEGORY hierarchy. |
| A/B — live data source | ✅ Implemented | `resolveProductCategoryBrandIds` resolves categoryId/brandId at eval time; stamped per line in `buildPosEvalInput`. No snapshot columns, no migration. |
| C — global target validation | ✅ Implemented (pre-existing) | `validateTargetIds` (promotions.service.ts:528) uses **global** `this.prisma.category`/`this.prisma.brand`; throws `INVALID_TARGET` before persistence. Not modified by this change — correctly relied upon. |

### Coherence (Locked Decisions — obs #2968)
| Decision | Followed? | Evidence |
|----------|-----------|----------|
| 1. Precedence VARIANT>PRODUCT>{BRAND≡CATEGORY}, ordinal V=3/P=2/B=1/C=1, best-wins within max tier | ✅ Yes | `pos-evaluate-promotions.use-case.ts` ordinal pre-pass; `precedence.spec` proves peer flip + lowest-id tiebreak. |
| 2. `!= null` guards on categoryId/brandId (not truthiness) | ✅ Yes | `matchTargetTier` uses `line.categoryId != null` / `line.brandId != null`. |
| 3. Resolver TENANT-scoped; validation GLOBAL (two distinct paths) | ✅ Yes | Resolver: `this.tenantPrisma.getClient().product.findMany`. Validation: `this.prisma.category`/`this.prisma.brand`. Distinct clients confirmed. |
| 4. POS engine ONLY — cart engine untouched | ✅ Yes | `evaluate-cart-promotions.use-case.ts` absent from `git diff main..HEAD`; `matchTargetTier` referenced only by the POS use-case. |
| 5. Missing target id → 400 INVALID_TARGET, no persist | ✅ Yes | `validateTargetIds` throws `InvalidArgumentError(…, 'INVALID_TARGET')` at target-build (before create), V3/V4 assert zero persisted rows. |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD evidence reported | ⚠️ Partial | apply-progress #2977 reports RED→GREEN narratively and tasks.md carries explicit RED/GREEN/VERIFY steps per work unit — but NOT the prescribed 6-column "TDD Cycle Evidence" table. |
| All tasks have tests | ✅ | 5/5 work units name a covering spec; all exist in-repo. |
| RED confirmed (tests exist) | ✅ | All 6 unit specs + 2 integration specs present; W2/W3 added NEW spec files (precedence, resolver). |
| GREEN confirmed (tests pass) | ✅ | 267/267 unit + 22/22 integration pass on independent re-run. |
| Triangulation adequate | ✅ | Scenario 10 triangulated 3 ways (CAT-wins, BRAND-wins flip, lowest-id tie); scenario 11 two-way (V-A/V-B). |
| Safety net for modified files | ✅ | Prior engine specs (`use-case.spec`, `w4.spec`) re-run green after each edit; variant-level integration held 11/11. |

**TDD Compliance**: 5/6 checks fully pass; 1 partial (report *format*, not TDD substance).

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 267 | 6 | Jest 30 (`jest.config.js`) |
| Integration | 22 | 2 | Jest 30 + Postgres :5433 (`jest.integration.config.js`, `--runInBand`) |
| E2E | 0 | 0 | not applicable (out of scope) |
| **Total** | **289** | **8** | |

### Changed File Coverage
➖ Coverage analysis skipped — per-file coverage run avoided to respect the anti-hang constraint (would require a broad run). Behavioral coverage of every changed production path is instead evidenced by the 15/15 scenario matrix above.

### Assertion Quality
Scanned all 8 change-related spec files for banned patterns (tautologies, orphan empty-checks, ghost loops, smoke-only, implementation-detail coupling). Findings:
- Negative "no-match" assertions (scenarios 4/5) each have a companion positive matcher test (scenarios 2/3) → not orphan empty-checks.
- Validation V3/V4 assert BOTH rejection AND zero persisted promotion/target rows (real post-state assertion, not a bare throw).
- Precedence tests assert concrete winner ids + applied discount cents, including the peer *flip* and lowest-id tiebreak.
- No tautologies, no ghost loops, no render-only smoke tests.

**Assertion quality**: ✅ All assertions verify real behavior.

### Quality Metrics
**Linter**: ➖ Not run (not requested; no new lint config in scope).
**Type Checker (production, `tsconfig.build.json`)**: ✅ 0 errors — shipped code type-clean.
**Type Checker (whole-project `tsc --noEmit`, incl. specs)**: ⚠️ exit 2, 89 errors — **ALL in `.spec.ts` files, 0 in production**. Of these, **5 were introduced by this change** (all test fixtures, excluded from the production build, silently transpiled green by Jest isolatedModules):

| File | Lines | Commit | Issue |
|------|-------|--------|-------|
| `src/sales/sales.service.spec.ts` | 5115, 5128, 5141, 5225 | 7986118 (W4) | `priceSource: 'manual'` fixture literal not in union `'default'\|'price_list'\|'custom'\|null` |
| `src/promotions/category-brand-promo-targeting.integration.spec.ts` | 116 | c675152 (W5) | ClsService mock typing `(key)=>…` vs `TenantClsStore` getter (cloned from pre-existing variant-level harness pattern, L69/L843 = commit 24f063b) |

The remaining 84 tsc errors pre-date this change (older commits `c8c1cc02`, `06ad4c37`, `be2ad926`, `c04af846`, `24f063b`, plus unrelated modules) and are the known repo-wide isolatedModules spec-type-drift pattern → non-blocking.

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. **5 new spec-file type errors introduced by this change** (4× `sales.service.spec.ts` W4 `priceSource:'manual'`; 1× category-brand integration W5 ClsService mock typing). They do not affect runtime (289/289 tests green) or the production build (clean), but they are *new* type-hygiene debt this change added. They are only masked because Jest transpiles specs per-file (isolatedModules) without cross-file type-checking.
2. **apply-progress #2977 self-report inaccuracy**: it states "Final typecheck (npx tsc --noEmit) clean … (no new errors introduced)". That is accurate for *production* sites but false for spec files — this change introduced 5 new spec-file type errors. Minor provenance/accuracy note for the orchestrator.
3. **TDD evidence format**: reported as narrative + tasks.md RED/GREEN steps rather than the strict 6-column "TDD Cycle Evidence" table. TDD *substance* is verifiable and sound; only the reporting shape deviates.

**SUGGESTION**:
1. Fix the `priceSource: 'manual'` fixtures (use a valid union member, or widen the domain type if `'manual'` is a legitimate source) and align the ClsService mock typing, so whole-project `tsc --noEmit` regains a clean baseline and the isolatedModules pattern stops masking future *real* type drift. Best handled as separate test-hygiene cleanup — not required to ship this change.

### Verdict
**PASS WITH WARNINGS** — All 15 spec scenarios are covered by tests that passed at runtime (267 unit + 22 integration), all 5 locked decisions are honored in code, the cart engine is untouched, the no-migration gate holds ("No difference detected."), and the variant-level regression guard is intact (11/11). The only issues are 5 new type-hygiene errors confined to test fixtures — invisible to Jest, excluded from the clean production build, non-blocking. No CRITICAL findings; safe to proceed to archive after (optionally) addressing the test-fixture type warnings.
