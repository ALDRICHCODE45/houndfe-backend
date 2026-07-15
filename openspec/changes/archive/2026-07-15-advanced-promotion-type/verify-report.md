```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:8e540ed355661dbeed48a6f01a903a6b2330f94937e7e9ca51d3f3426e3fef95
verdict: pass
blockers: 0
critical_findings: 0
requirements: 14/14
scenarios: 23/24
test_command: pnpm run test:integration -- advanced-promotion-type.integration.spec --runInBand
test_exit_code: 0
test_output_hash: sha256:6902099cb5f0f45c6ed2a36b726de6dec9be7dff6d21f4b8d6aa77be8e72450e
build_command: pnpm run build
build_exit_code: 0
build_output_hash: sha256:9d14ccf55f5a8219f87e5d7b6f21ac7d6c7d779a0abe486fb561ee30026df898
```

## Verification Report (RE-VERIFICATION)

**Change**: advanced-promotion-type
**Version**: delta spec `pos-promotion-engine` (single capability)
**Mode**: Strict TDD (Jest 30, filtered-only; test DB Postgres :5433)
**Branch**: `feat/advanced-promotion-type` (16 commits; diff vs `origin/main`: 28 files, +6012/-115)

> **Independent re-verification after correction.** A prior verify returned **FAIL**
> on a single blocker (D3 "true 100% free" — an AUTOMATIC 100% ADVANCED reward on a
> single GET unit threw `BXGY_REWARD_INVALID` in the reward rail → reachable POS 500).
> A scoped correction transaction (3 fix commits + 1 docs commit) has since landed.
> This pass re-inspects the corrected source AND re-executes the affected filtered
> suites + build + migration drift. **The blocker is RESOLVED**; all 8 locked decisions
> (D1–D8) are implemented and covered by load-bearing tests; DEFAULT PD/BXGY is
> unregressed; no NEW regression was introduced. Verdict: **PASS WITH WARNINGS** —
> shippable, with a defense-in-depth coverage recommendation on the D3 qty=1 end-to-end
> chain.

### Correction Under Validation (fix commits `3250a11`, `015a3c3`, `b082c88`)

| # | Fix | Source (confirmed on-disk) | Load-bearing test (re-run GREEN) | Verdict |
|---|-----|----------------------------|----------------------------------|---------|
| 1 | **D3 100%-free crash** — guard `>=`→`>` | `sale-item.entity.ts:432` `if (lineDiscountCents > unitPriceCents*quantity) throw`; `<=0` still throws (`:426`, R>0 kept) | `sale-item.entity.spec.ts:897` — qty=1 @ 1000c, `applyBuyXGetYReward({R:1000,rewardKind:'advanced'})` → `.not.toThrow()`, `toResponse().subtotalCents===0`, `rewardKind==='advanced'`; `:962` R=1001 still throws | ✅ Validated |
| 2 | **D7 cross-entity partition** — BUY lines excluded from GET pool | `use-case.ts:1280` `buyMatchedItemIds=new Set`; `:1285` add; `:1319` `if (buyMatchedItemIds.has(itemId)) continue` | `advanced.spec.ts:801` BUY=PRODUCTS:P, GET=CATEGORIES:C, P∈C, single P line → NO `advanced` result (no double benefit); `:839` disjoint P(buy)+Q(get∈C) → Q rewarded 500c, P not | ✅ Validated |
| 3 | **Zero-cent reward skip** | `use-case.ts:1350` `if (reward.lineDiscountCents <= 0) continue` (mirrors BXGY `:1176`) | `advanced.spec.ts:913` 1c@1%→perUnit=0→no result, no throw; `:956` 50c@1%→perUnit=1→still emitted (no over-skip) | ✅ Validated |
| 4 | **Draft reload mislabel** — 4 reload mappers forward `rewardKind` | `prisma-sale.repository.ts` `findById:306`, `findDraftResponseById:435`, `findDraftsByUserId:576`, `findByIdForUpdate:707` (enum→lowercase) | `prisma-sale.repository.spec.ts:2733/2751/2767/2783` — each of the 4 mappers surfaces `rewardKind='advanced'` on a reloaded ADVANCED draft (not `buy_x_get_y`) | ✅ Validated |
| 5 | **2 cosmetic nits** (folded into `015a3c3`) | `matchTargetTier` inlines `side` (no `effectiveSide` alias); `evaluateAdvancedPass` doc typo fixed | non-load-bearing | ➖ Noted |

**No scope creep**: `3250a11` = sale-item.entity.ts + spec; `015a3c3` = use-case.ts + advanced.spec.ts; `b082c88` = prisma-sale.repository.ts + spec. Each fix touches only its target + its spec.

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total (impl work units WU1–WU10, phases 1–10) | 22 checkboxes |
| Tasks complete (all implementation phases 1–10) | 22 |
| Tasks incomplete | 3 (11.1 archive-note, 12.1 verify-gate = this pass, 12.2 final merge) |

The 3 unchecked tasks are post-implementation gate/cleanup items (archive note for sdd-archive; this verification step; the final `git merge --no-ff` that runs only after PASS). All 10 implementation work units are checked with commits present. WARNING (cleanup), not CRITICAL — full verification proceeded.

### Build & Tests Execution (filtered-only per Strict TDD; full suite NEVER run)

**Build**: ✅ `pnpm run build` → exit 0, no errors. `sha256:9d14ccf5…30026df898`

**Migration drift**: ✅ `npx prisma migrate diff --from-url <:5433 test DB> --to-schema-datamodel prisma/schema.prisma --exit-code` → exit 0, **"No difference detected"**. `sha256:d7c9882d…f4f818a1` (32 migrations applied to the live test DB; zero drift).

| Run | Command (args after `pnpm run test:unit --`) | Suites | Tests | Exit | Output hash |
|-----|----------------------------------------------|--------|-------|------|-------------|
| U1 (advanced core) | `match-target-tier.spec pos-evaluate-promotions.advanced-helper pos-evaluate-promotions.advanced.spec promotion.entity.spec promotions-validate-side-disjoint` | 5 | 138 ✅ | 0 | `sha256:920a0cd4…0349f937` |
| U2 (sales/persistence) | `sale-item.entity.spec sale.entity.spec sales.service.spec prisma-sale.repository.spec` | 4 | 478 ✅ | 0 | `sha256:9a312de2…9973a10b` |
| U3 (engine regression) | `pos-evaluate-promotions promotions.service.spec` | 8 | 195 ✅ | 0 | `sha256:5358220a…a87b586e` |
| INT (live :5433) | `pnpm run test:integration -- advanced-promotion-type.integration.spec` | 1 | 7 ✅ | 0 | `sha256:6902099c…8e72450e` |
| INT-BXGY (live :5433) | `pnpm run test:integration -- buy-x-get-y.integration.spec` | 1 | 20 ✅ | 0 | `sha256:5e207821…ebde309e` |

Zero failures across every executed suite. Counts rose vs the prior FAIL run exactly as the correction predicts: U1 134→138 (+4: D7 partition ×2, zero-skip ×2), U2 470→478 (+8: FIX 1 full-free ×3, FIX 4 reload ×4+…), U3 191→195 (+4, same advanced-family delta). **U3 re-runs the full `pos-evaluate-promotions.*` family (PD, ORDER, BXGY, advanced) — DEFAULT PD/BXGY behavior preserved (regression GREEN)**. **INT-BXGY 20/20 confirms the shared-rail guard relaxation did NOT regress BUY_X_GET_Y.**

**Coverage**: ➖ Not re-collected this pass (informational; prior pass reported changed-file coverage 63–100%, all non-blocking).

### Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| BUY_X_GET_Y "Free" (100%) [MODIFIED] | 100% + 50% NET representation (BXGY) | `buy-x-get-y.integration.spec.ts` (INT-BXGY 20/20) + engine specs (U3) | ✅ COMPLIANT |
| ADVANCED Eligibility Gate | PRODUCTS buy / CATEGORIES get admitted | `advanced.spec.ts` + INT S1 | ✅ COMPLIANT |
| ADVANCED Eligibility Gate | null target type silently skipped | `advanced.spec.ts` | ✅ COMPLIANT |
| Side-Aware Target Tier | BUY-side matches only when side=BUY | `match-target-tier.spec.ts` | ✅ COMPLIANT |
| Side-Aware Target Tier | DEFAULT unchanged for PD/BXGY | `match-target-tier.spec.ts` + U3 | ✅ COMPLIANT |
| D1 Aggregated BUY counting | S1 multiple small lines summing to N | `advanced.spec.ts` + INT S1 | ✅ COMPLIANT |
| D1 | single line at/above buyQuantity | `advanced.spec.ts` | ✅ COMPLIANT |
| D1 | out-of-target lines excluded | `advanced.spec.ts` | ✅ COMPLIANT |
| D2 Per-group repeatability | S2 six units / buy 3 → 2 apps (600c) | `advanced-helper.spec.ts` + `sale.entity.spec.ts:2376` + INT S2 | ✅ COMPLIANT |
| D2 | below buyQuantity → 0 groups | `advanced-helper.spec.ts` | ✅ COMPLIANT |
| **D3 GET magnitude ≤100% (true-free)** | **100% ADVANCED yields free GET unit (qty=1 → 0c, no throw, receipt rewardKind=advanced)** | apply-rail edge covered: `sale-item.entity.spec.ts:897` (qty=1 R==line → no throw, item NET=0, rewardKind=advanced); receipt `prisma-sale.repository.spec.ts:1320`. **`Sale.previewTotals().totalCents=0` aggregate at qty=1 NOT asserted (only qty=3→2000); INT S6 still qty=2** | ⚠️ PARTIAL |
| D3 | >100 rejected | `promotion.entity.spec.ts` (101 rejected) | ✅ COMPLIANT |
| D4 rewardKind wire | ADVANCED emits `rewardKind='advanced'` (apply + reload + receipt) | `sale-item.entity.spec.ts` + `sales.service.spec.ts:6957` + `prisma-sale.repository.spec.ts:1320/2679` | ✅ COMPLIANT |
| D4 | BXGY still emits `buy_x_get_y` | same + INT-BXGY (no regression) | ✅ COMPLIANT |
| D5 Best-wins 3-way | S5 ADVANCED 50% beats 20% PD | `advanced.spec.ts` + INT S5 | ✅ COMPLIANT |
| D5 | tie → lowest promotionId | `advanced.spec.ts` | ✅ COMPLIANT |
| D6 AUTOMATIC-only | AUTOMATIC auto-applies | `advanced.spec.ts` + `sales.service.spec.ts` | ✅ COMPLIANT |
| D6 | MANUAL silently skipped | `advanced.spec.ts` | ✅ COMPLIANT |
| D7 Disjoint BUY/GET | S3 same-entity rejected at intake (create+update) | `promotions-validate-side-disjoint.spec.ts` + INT S3 | ✅ COMPLIANT |
| D7 | cross-entity accepted at intake | same | ✅ COMPLIANT |
| **D7 engine partition (4R)** | **cross-entity overlap P∈C on single P line → no double benefit; disjoint still rewards** | `advanced.spec.ts:801` + `:839` | ✅ COMPLIANT |
| D8 Quantity-only threshold | quantity is the only BUY gate | `advanced.spec.ts` (D1) + static (engine reads only buyQuantity; entity forbids minPurchaseAmount) | ✅ COMPLIANT |
| Cross-line pass placement | ADVANCED saving flows into ORDER subtotal | INT S7 | ✅ COMPLIANT |
| Idempotent recompute | 5 recomputes byte-equal + previewTotals converge | `sales.service.spec.ts:7137/7251` | ✅ COMPLIANT |
| Degenerate cart | S4 BUY met, no GET → no reward | `advanced.spec.ts` + INT S4 | ✅ COMPLIANT |

**Compliance summary**: **23/24 scenarios COMPLIANT, 1 PARTIAL** (D3 100% true-free — apply-rail edge + receipt discriminator are runtime-tested and the crash is fixed; the `Sale.previewTotals().totalCents=0` aggregate at qty=1 and an integration path at qty=1 remain unasserted). This is an **upgrade from the prior FAIL** (was ❌ UNTESTED / would-throw): the runtime defect is gone and the guard edge is directly tested.

### Correctness (Static Evidence — verified against on-disk source)

| Decision | Status | Notes |
|----------|--------|-------|
| D1 aggregated BUY counting | ✅ Implemented | `evaluateAdvancedPass:1281-1286` sums `line.quantity` across `matchTargetTier(…,'BUY')` hits. |
| D2 per-group floor | ✅ Implemented | `floor(totalBuyMatchedQty/buyQuantity)` in pass (`:1289`) and pure `computeAdvancedReward:160`. |
| D3 cap lift 99→100 + true-free apply | ✅ Implemented | `validateGetDiscountPercent` accepts 100 / rejects >100; **apply rail now delivers a fully-free line** — guard `sale-item.entity.ts:432` relaxed `>=`→`>` (R==line valid, R>line rejected). Helper `take=Math.min(line.quantity,remaining)` (`:183`) mathematically bounds `lineDiscountCents ≤ line value`, so the rail never throws on a legit reward. |
| D4 rewardKind discriminator | ✅ Implemented | Persisted enum `SaleItemRewardKind`; write path + confirmed-receipt mapper + **all 4 draft reload mappers** now forward `rewardKind` (FIX 4 closes the silent-mislabel gap). |
| D5 3-way best-wins + lowest-id | ✅ Implemented | `evaluateAdvancedPass` compares `lineDiscountCents` vs existing, tie → lowest `promotionId`; replace-in-place (no stacking). |
| D6 AUTOMATIC-only | ✅ Implemented | `:1259` `if (promo.method !== 'AUTOMATIC') continue`; no MANUAL surface extended. |
| D7 disjoint at intake + engine partition | ✅ Implemented | Intake `assertAdvancedSideTargets` rejects exact same-entity; **engine-level `buyMatchedItemIds` partition (`:1319`) closes the cross-entity overlap** the intake check cannot see. |
| D8 quantity-only threshold | ✅ Implemented | Engine gates only on `totalBuyMatchedQty >= buyQuantity`; no BUY-side `minPurchaseAmountCents`. |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Side parameter on `matchTargetTier` (not duplicated ladder) | ✅ Yes | `matchTargetTier(…, side='DEFAULT')`; DEFAULT preserved byte-for-byte; cosmetic `effectiveSide` alias removed (FIX 5). |
| Pure `computeAdvancedReward` per GET line | ✅ Yes | Lowest-`itemId` asc allocation, `take=min(quantity,remaining)` clamp, `Math.round(eff*pct/100)`. |
| New `kind:'advanced'` union member | ✅ Yes | `PosEvalAdvancedLineResult` in the port union. |
| Persisted enum column on SaleItem | ✅ Yes | Additive migration; zero drift confirmed. |
| Pass slotted after BXGY, before ORDER | ✅ Yes | `evaluate()` order PD → BXGY → advanced → ORDER. |
| "Reuse the BXGY reward rail" | ✅ Reconciled | The prior design gap (rail guard incompatible with true-free) is **now resolved** — the guard admits `R==line` for the decoupled GET line; the helper clamp guarantees `R≤line`. |

### Issues Found

**CRITICAL**: None. (The prior blocker — reachable POS 500 on qty=1 @ 100% ADVANCED — is RESOLVED: guard relaxed at source, directly runtime-tested at the exact crashing input, and the helper clamp bounds `R≤line` so the rail cannot throw on a legit reward.)

**WARNING**

1. **D3 true-free end-to-end coverage is proven by parts, not as one qty=1 flow.** The guard edge (`applyBuyXGetYReward` at qty=1 R==line → no throw, item NET=0) and the receipt discriminator (`rewardKind='advanced'`) are runtime-tested, but no single test drives `Sale.previewTotals().totalCents=0` **at qty=1** — the sale-level 100% test uses qty=3 (`sale.entity.spec.ts:2338` → total 2000) and **integration S6 still uses qty=2** (`advanced-promotion-type.integration.spec.ts:641,679`, comment "qty≥2 satisfies the BXGY guard `R < unitPrice × qty`"). The exact edge that crashed is only covered by the entity unit test. **Recommend before/with archive**: (a) add a `Sale.previewTotals()` test on a single qty=1 @ 100% ADVANCED line asserting `subtotalCents=1000, discountCents=1000, totalCents=0`; (b) upgrade INT S6 to qty=1 (the guard now permits R==line) and assert the reward flows through recompute→apply→preview.
2. **INT S6 comment/parameter is stale** relative to the fix — it still dodges the R==line edge it no longer needs to avoid.
3. **apply-progress lacks the prescribed "TDD Cycle Evidence" table** (RED/GREEN/TRIANGULATE/SAFETY-NET). Substance is present (per-fix RED/GREEN in the correction record, one commit per fix, per-spec GREEN counts) and every touched spec re-ran GREEN here — format deviation, non-blocking.
4. **`promotions.service.ts` filtered coverage is low** — expected under the filtered-only constraint; the D7 method itself is covered.

**SUGGESTION**

1. Pre-existing integration fragility (out of scope): `buy-x-get-y.integration.spec.ts` and `category-brand-promo-targeting.integration.spec.ts` share global category names, so a combined full integration run trips the unique `categories.name` constraint. Each spec was run in isolation here (both GREEN). Worth a shared-fixture cleanup.
2. Document the D3 100% ADVANCED semantics in `docs/promotions-frontend.md` so merchant/frontend expectations match engine reality (now that true-free works).

---

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ⚠️ | Present in substance (per-fix RED/GREEN in the correction record + one commit per fix); not in the prescribed table format |
| All tasks/fixes have tests | ✅ | Each of the 4 load-bearing fixes has a RED-first spec; all executed GREEN here |
| RED confirmed (test files exist) | ✅ | All named spec files exist on disk and were run |
| GREEN confirmed (tests pass) | ✅ | 811 unit (U1+U2+U3) + 27 integration re-run GREEN this session |
| Triangulation adequate | ✅ | FIX 1: full-free qty=1/qty=2 + over-reward reject; FIX 2: overlap + disjoint; FIX 3: zero + non-zero; FIX 4: all 4 mappers |
| Safety net for modified files | ✅ | PD/BXGY/order regression (U3) + BXGY integration 20/20 GREEN — shared rail unregressed |

**TDD Compliance**: 5/6 ✅ (1 format-only WARNING).

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 811 (U1 138 + U2 478 + U3 195; advanced family overlaps U1/U3) | 17 suites | Jest 30 (`jest.config.js`) |
| Integration (live DB) | 27 (advanced 7 + BXGY 20) | 2 | Jest 30 `--runInBand`, Postgres :5433 |
| E2E (HTTP) | 0 | — | not applicable to this engine change |

### Assertion Quality

Scanned all correction-touched spec files. Assertions verify real behavior — `.not.toThrow()` on the exact qty=1 R==line apply, full-object reward shapes, specific cents (500/600/1000), `rewardKind` values on reload/receipt, partition `toBeUndefined()` on the double-benefit line. No tautologies, no ghost loops, no empty-without-companion, no smoke-only tests. The prior "false sense of D3 coverage" caveat is materially reduced: `sale-item.entity.spec.ts:897` now exercises the apply rail at the exact edge (not the pure helper). Residual: the full qty=1 chain through `previewTotals`/integration is not asserted (captured as WARNING 1, not a bad assertion).

**Assertion quality**: ✅ 0 CRITICAL / 0 WARNING trivial assertions.

### Quality Metrics

**Build (type-check)**: ✅ `pnpm run build` (nest build / tsc) → 0 errors.
**Linter**: ➖ not run (out of scope for this verify pass; not requested).

### Verdict

**PASS WITH WARNINGS** — The prior FAIL blocker (reachable POS 500 on an AUTOMATIC qty=1 @ 100% ADVANCED reward) is **RESOLVED**: the `applyBuyXGetYReward` guard is relaxed `>=`→`>` at source, directly runtime-tested at the exact crashing input (no throw, item NET=0, `rewardKind='advanced'`), and the pure-helper `take=min(quantity,remaining)` clamp mathematically guarantees `R≤line` so the rail cannot throw on a legit reward. All 8 locked decisions D1–D8 are implemented and covered by load-bearing tests (incl. the 4R D7 engine partition and the zero-skip). Build clean, `prisma migrate diff` zero-drift, DEFAULT PD/BXGY unregressed (engine family 195 GREEN + BXGY integration 20/20), and no NEW regression introduced. **Shippable.** The single residual is a defense-in-depth coverage gap on the D3 true-free path at qty=1 (previewTotals aggregate + integration still exercise qty≥2/3, not the R==line edge) — recommended to close alongside archive, but not a blocker: the runtime defect is gone and the guard edge is proven.
