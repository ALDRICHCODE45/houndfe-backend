```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:ba07640b611a0d63ab82b0901c76d7ad9c245f1466d10b050a88b742e63b5eac
verdict: pass
blockers: 0
critical_findings: 0
requirements: 3/3
scenarios: 11/11   # 12 in spec file; 1 (CATEGORIES) explicitly DEFERRED / out of scope
test_command: pnpm test:unit && pnpm test:integration
test_exit_code: 0
test_output_hash: sha256:5f309b493c908a84859af8af3e6af391e6075e8044cbe4d2bff7ddde95411dbe
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:9d14ccf55f5a8219f87e5d7b6f21ac7d6c7d779a0abe486fb561ee30026df898
```

# Verification Report — variant-level-promo-targeting

**Change**: `variant-level-promo-targeting`
**Branch**: `feat/variant-level-promo-targeting` (HEAD `24f063b`, 6 work-unit commits `8a90dd6` → `24f063b`)
**Mode**: openspec + engram (`both`) · STRICT TDD ACTIVE · run of record (isolated Postgres :5433, `.env.test`)
**Verdict**: **PASS WITH WARNINGS** (0 CRITICAL — warnings are test-only type hygiene, non-blocking)

## Test Execution (run of record)

| Suite | Command | Result | Exit |
|---|---|---|---|
| Unit | `pnpm test:unit` | **1802 passed / 1802 total** · 151 suites · 0 failures · 0 skipped · ~4.3s | 0 |
| Integration (real DB :5433) | `pnpm test:integration` | **33 passed / 35 total** · 6 suites passed + 1 skipped · **0 failures** · 2 skipped (SKIP_DB guards) | 0 |
| Build / type-check | `pnpm build` (`nest build`) | **clean, no diagnostics** | 0 |

- Baseline 1771 unit → **1802 (+31 new)**; integration +11 spec-scenario cases. Zero new failures vs baseline.
- Two full unit runs performed, both 1802/1802 (hash `7b97fec8…`). Integration hash `a451f957…`.
- Integration ran against the dedicated test DB (port 5433, `.env.test`) via `jest.integration.config.js` — **never the dev DB**. The e2e sweep seeds a real tenant + product + two variants and drives `PosEvaluatePromotionsUseCase` and `PromotionsService.create` end-to-end.

## Completeness — Tasks (24/24 subtasks, 6/6 work units ✅)

| WU | Scope | Status |
|---|---|---|
| 1 | Schema & Migration (`ALTER TYPE … ADD VALUE 'VARIANTS'`) | ✅ 1.1–1.4 checked + backed |
| 2 | Domain entity + DTO enum accept `VARIANTS` | ✅ 2.1–2.4 checked + backed |
| 3 | Shared `matchTargetTier` pure helper | ✅ 3.1–3.3 checked + backed |
| 4 | Wire both match sites + VARIANT-wins precedence | ✅ 4.1–4.7 checked + backed |
| 5 | `validateTargetIds` VARIANTS branch (tenant-scoped) | ✅ 5.1–5.3 checked + backed |
| 6 | End-to-end integration sweep | ✅ 6.1–6.3 checked + backed |

No unchecked implementation task. Every task is backed by real code and executing tests.

## Spec Compliance Matrix (11 ACTIVE scenarios → covering test(s) → RESULT)

| # | Spec scenario | Covering test(s) | Result |
|---|---|---|---|
| 1 | PRODUCTS targeting matches by product id | unit `match-target-tier.spec.ts:50` (+neg :75) · integ `Scenario 1` (:196, P2 line excluded) | ✅ COMPLIANT |
| 3 | PRODUCTS still matches every variant (back-compat) | unit helper `:58` · unit engine `w4:337` · integ `Scenario 3` (:275, both V-A/V-B) | ✅ COMPLIANT |
| 4 | VARIANTS matches only the exact variant | unit helper `:85` (+null `:93/:101`) · integ `Scenario 4` (:330, only V-A) | ✅ COMPLIANT |
| 5 | VARIANTS wins over PRODUCTS on same line | unit `w4:126` (V-A→PW/30c, V-B→PV/50c) · integ `Scenario 5` (:390) | ✅ COMPLIANT |
| 6 | VARIANTS wins regardless of discount magnitude | unit `w4:179` (V-A→10c, explicit `.not.toBe(500c)`) · integ `Scenario 6` (:472) | ✅ COMPLIANT |
| 7 | VARIANTS on a different variant does not match | unit helper `:147` · unit `w4:223` (result `[]`) · integ `Scenario 7` (:539) | ✅ COMPLIANT |
| 8 | MANUAL VARIANTS promo offered on matching drafts | unit `w4:253` · integ `Scenario 8` (:587) — `targetableManualPromotionIds` contains promo | ✅ COMPLIANT¹ |
| 9 | Opted-in MANUAL VARIANTS survives recompute | unit `w4:286` (targetable + applied across 2 recomputes) · integ `Scenario 9` (:635) | ✅ COMPLIANT |
| 10 | VARIANTS with existing tenant variant id accepted | unit `validate-variants:169` · integ `Scenario 10` (:728, persisted row asserted) | ✅ COMPLIANT |
| 11 | VARIANTS with non-existent variant id rejected | unit `validate-variants:210` (+sibling :242) · integ `Scenario 11` (:753, row counts unchanged) | ✅ COMPLIANT |
| 12 | VARIANTS cross-tenant variant id rejected | unit `validate-variants:276` · integ `Scenario 12` (:779, real T2 tenant, T1 rejects) | ✅ COMPLIANT |
| — | CATEGORIES targeting matches by category id | **DEFERRED / out of scope** — `matchTargetTier`→null, `isSupportedEngineType`→false; documented negative tests `match-target-tier.spec.ts:114/122` | ➖ NOT COUNTED |

**Coverage: 11/11 active scenarios COMPLIANT** — each verified by ≥1 test asserting its stated THEN outcome (not the inverse); 10/11 covered at BOTH the unit and integration layers. No `UNTESTED` / `FAILING` scenarios.

¹ See WARNING W2 — scenario 8's assertion is on the `targetableManualPromotionIds` surface with the promo pre-opted-in; the "available-for-manual" (not-yet-opted-in `availableManualPromotions`) reading is not independently asserted for VARIANTS.

## Correctness & Design Contracts (spec/design → implementation)

| Contract | Evidence | Status |
|---|---|---|
| Single `matchTargetTier` helper used by BOTH match sites | exported `pos-evaluate-promotions.use-case.ts:76`; called at `:388` (`pickBestPerLine`) AND `:285` (`targetableManualPromotionIds`). No duplicate predicate. | ✅ |
| Precedence pre-pass runs BEFORE best-wins | `pickBestPerLine`: VARIANT-tier survivor filter `:418–421` precedes `pickBestByMaxDiscountThenLowestId(survivors)` `:423`; best-wins helper `:441–456` untouched. | ✅ |
| VARIANT wins regardless of discount value | precedence is orthogonal to discount (filters tier before max-discount ranking) — proven by scenario 6. | ✅ |
| `validateTargetIds` VARIANTS branch is tenant-scoped | `promotions.service.ts:566` `tenantClient.variant.findMany` (NOT global `this.prisma`); symmetric with PRODUCTS `:556`. Error entity name `'Variant'` `:583`. | ✅ |
| Validation at create AND update time | shared target-resolver calls `validateTargetIds` at `:305`; resolver used by both `create` (`:77`) and `update` (`:181`). | ✅ |
| Migration is standalone | `migration.sql` = only `ALTER TYPE "PromotionTargetType" ADD VALUE 'VARIANTS';`, no same-transaction consumer (Postgres restriction respected; verified via `prisma migrate diff`). | ✅ |
| PRODUCTS back-compat preserved | `matchTargetTier` falls back to `'PRODUCT'` when no VARIANTS hit → PRODUCTS still matches every variant (scenario 3). | ✅ |
| `isSupportedEngineType` accepts VARIANTS | `:343–348` true for PRODUCT_DISCOUNT with `appliesTo ∈ {PRODUCTS, VARIANTS}`. | ✅ |
| `update-promotion.dto.ts` accepts VARIANTS | `PartialType(OmitType(CreatePromotionDto,['type']))` inherits the shared `PromotionTargetTypeEnum` — no edit needed (correctly absent from diff). | ✅ |
| No out-of-scope production files changed | `git diff --stat main..HEAD` = 11 files, all within `src/promotions/**` + `prisma/` (schema + migration) + tests. Nothing unexpected. | ✅ |

## Test Layer Distribution

| Layer | Tests (this change) | Files | Tooling |
|---|---|---|---|
| Unit (pure/mocked) | +31 | `match-target-tier.spec.ts`, `pos-evaluate-promotions-w4.spec.ts`, `promotion-target-variants.spec.ts`, `promotions-validate-variants.spec.ts` | jest + ts-jest |
| Integration (real Postgres) | +11 | `variant-level-promo-targeting.integration.spec.ts` | jest + ts-jest, DB :5433 |

Every active spec scenario is covered at the unit layer; 10/11 additionally at the integration layer (real DB). Validation scenarios 10–12 exist at both layers (unit mocks the client symbol; integration proves real tenant-scoping with a live second tenant).

## TDD Compliance (Strict TDD module)

| Check | Result |
|---|---|
| TDD Evidence in apply-progress | ✅ Found (Engram #2931; per-WU RED→GREEN counts 1771→1802) |
| All tasks have tests | ✅ 24/24 subtasks; every WU has a RED-first spec |
| RED confirmed (test files exist) | ✅ all 5 spec files present in tree |
| GREEN confirmed (tests pass) | ✅ 1802/1802 unit + 33/33 integration on execution |
| Triangulation adequate | ✅ multi-case per behavior (VARIANT vs PRODUCT vs null; hit/miss; existing/missing/cross-tenant; discount 30c<50c and 10c<500c) |
| Safety net for modified files | ✅ boundary `pnpm test:unit` after each WU, zero new failures |

## Assertion Quality Audit

✅ **No tautologies, no ghost loops, no smoke-only tests, no assertions without a production-code call.**
- Matcher tests assert three DISTINCT return values (`'VARIANT'` / `'PRODUCT'` / `null`) — real triangulation, not empty-only variance.
- Precedence tests assert the winning `promotionId` AND include explicit anti-regression (`.not.toBe('promo-X-500c')`).
- Empty-result assertions (`toEqual([])`, scenarios 7 + gates) each run the full engine and have companion non-empty cases — legitimate negatives, not orphan empties.
- Validation tests assert message + code + `save` NOT called; integration asserts real `promotion.count()` / `promotionTargetItem.count()` unchanged.
- One mock-call assertion (`variantFindMany … toHaveBeenCalledTimes(1)`, `validate-variants:351`) pins the tenant-scoped-client design decision; it is self-documented as a symbol guard and is backed end-to-end by integration Scenario 12. Acceptable.

## Quality Metrics

- **Build / project type-check** (`nest build`, canonical pipeline): ✅ **clean** (`tsconfig.build.json` excludes `**/*spec.ts`; all production code type-clean).
- **Full `tsc --noEmit -p tsconfig.json`** (stricter than pipeline; includes specs): 44 errors repo-wide (pre-existing — this project runs specs transpile-only via `isolatedModules: true` and never type-checks specs in the build). **4 belong to this change — all in TEST files, zero in production** → see W1.
- **Linter**: not run this pass (no regressions reported by apply boundary `pnpm test:unit … zero new lint warnings`, WU6.2).
- **Coverage**: not collected this run (informational only; `test:cov` available if desired).

## Findings

**CRITICAL**: none. ✅

**WARNING** (non-blocking — do not gate archive):
- **W1 — Test-only latent type errors (4) masked by `isolatedModules` transpile-only runs.** A full `tsc --noEmit` flags, in this change's spec files only:
  - `match-target-tier.spec.ts:181` — `TS2558: Expected 0 type arguments, but got 2` (`matchTargetTier<MiniTargetItem, MiniLine>([], …)` — the production helper is non-generic; erased at runtime so the test still passes correctly).
  - `promotions-validate-variants.spec.ts:154` — `TS2322` (`discountType` union vs `DiscountTypeEnum` in a test helper).
  - `variant-level-promo-targeting.integration.spec.ts:69 & :813` — `TS2322` (partial `cls.get` mock shape vs `ClsService` overload).
  Production code is 100% type-clean and `nest build` passes; runtime behavior is correct (all 1835 tests green). These match a pre-existing repo-wide pattern (40 other spec type-errors on surfaces the build never checks). Low-priority cleanup: drop the `<…>` type args on the non-generic call and tighten the two mock typings.
- **W2 — Scenario 8 semantic coverage nuance.** The spec text says a MANUAL VARIANTS promo "MUST appear in the targetable/available-for-manual set." Tests assert membership in `targetableManualPromotionIds` with the promo **pre-opted-in**. The not-yet-opted-in `availableManualPromotions` (opt-in offer list) path is not independently asserted for VARIANTS. Functionally correct (`isSupportedEngineType` now admits VARIANTS into that list), but add one assertion to close the literal "offered for opt-in" reading.

**SUGGESTION**:
- **S1 — No dedicated runtime test for the UPDATE path validating a VARIANTS target.** Structurally covered by the shared `validateTargetIds` used by both `create` and `update`; a small `PromotionsService.update` VARIANTS-rejection test would make the "at update time" clause of the validation requirement explicit.
- **S2 — Test-file numbering vs spec numbering.** Test files number scenarios 1–12 skipping the deferred CATEGORIES slot; the spec lists CATEGORIES as its 2nd block. Harmless, but a one-line note in the specs mapping would avoid confusion for the next reader.

## Verdict

**PASS WITH WARNINGS** — 1802/1802 unit + 33/33 integration (live DB :5433) green, `nest build` clean, 24/24 tasks done across 6 work units, **all 11 active spec scenarios covered by passing tests** (10/11 at both unit and integration layers), all design contracts honored (single `matchTargetTier`, precedence-before-best-wins, tenant-scoped VARIANTS validation, standalone migration, PRODUCTS back-compat), TDD + assertion quality clean. **Zero CRITICAL findings.** The two WARNINGs are test-only type hygiene and a coverage nuance — neither blocks release. **Ready for `sdd-archive`.**
