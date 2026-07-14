```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:6a59eae8fc91bef317426a8d3bc5feaf2d62da9b7b0ce667fa62fd0ca973340e
verdict: fail
blockers: 1
critical_findings: 1
requirements: 8/8
scenarios: 18/18
test_command: pnpm run test -- <filtered spec files> ; pnpm run test:integration -- buy-x-get-y.integration.spec.ts
test_exit_code: 0
test_output_hash: sha256:7bb7fd50a94b326208b639ea4d93b8d43379f8d8f5283fb411d5965d2e9b4ce8
build_command: pnpm run build
build_exit_code: 1
build_output_hash: sha256:ccec879fedbc8cf01b803afda91a12a9571bf045ee19305b53823d411557a589
```

## Verification Report

**Change**: buy-x-get-y
**Version**: spec v2 (18 scenarios, 8 requirements) · design v2 · decisions-revised #2796
**Mode**: Strict TDD
**Branch**: `feat/buy-x-get-y` (11 commits; working tree clean except unrelated `.atl/skill-registry.md`)

> **Headline**: All 18 spec scenarios map to concrete, GREEN test evidence (unit + integration), every revised decision (Q5 total-saving comparator, Q6 NET on both readers, type-aware 100% cap, MANUAL wiring, idempotency) is proven **by test, not assertion**, and `prisma migrate diff` is empty. **BUT** `pnpm run build` (full `tsc`) **fails with exit 1** — a WU2 type-wiring gap breaks compilation of the live `getSaleDetail` endpoint. `ts-jest` transpiles per file so no test caught it. **A branch that does not compile cannot be archived → VERDICT: FAIL (1 blocker).** The fix is a one-line addition to the repository port interface.

---

### Completeness
| Metric | Value |
|--------|-------|
| Work units total | 7 (14 task checkboxes) |
| Work units complete | 7 (all `[x]`) |
| Tasks incomplete | 0 |
| Spec requirements | 8 |
| Spec scenarios | 18 |

---

### Build & Tests Execution

**Build**: ❌ **FAILED** — `pnpm run build` (nest build / tsc), exit code **1**, `Found 1 error(s).`
```text
src/sales/sales.service.ts:1180:7 - error TS2322: Type '{ productName: string; ... prePriceCentsBeforeDiscount: number | null; }[]'
  is not assignable to type 'SaleDetailItemDto[]'.
  Property 'rewardKind' is missing in type '{ ... }' but required in type 'SaleDetailItemDto'.
  1180       items: sale.items,
  → 'rewardKind' declared required at src/sales/dto/sale-detail-response.dto.ts:63
```

**Tests**: ✅ **804 passing test-executions across 6 filtered Jest runs, 0 failures, 0 skips.** Every command was FILTERED to named spec files — the anti-hang full-suite was never run.

| # | Command (all filtered — anti-hang honored) | Suites | Tests | Result |
|---|--------------------------------------------|-------:|------:|--------|
| 1 | `pnpm run test -- pos-evaluate-promotions.buy-x-get-y.spec.ts pos-evaluate-promotions.buy-x-get-y-helper.spec.ts` | 2 | 32 | ✅ |
| 2 | `pnpm run test -- sale-item.entity.spec.ts sale.entity.spec.ts prisma-sale.repository.spec.ts` | 3 | 261 | ✅ |
| 3 | `pnpm run test -- sales.service.spec.ts -t "BUY_X_GET_Y"` | 6 | 237 | ✅ |
| 4 | `pnpm run test -- promotion.entity.spec.ts create-promotion.dto.spec.ts promotions.service.spec.ts -t "BUY_X_GET_Y\|ADVANCED"` | 8 | 175 | ✅ |
| 5 | `pnpm run test -- pos-evaluate-promotions.use-case.spec.ts pos-evaluate-promotions-w4.spec.ts match-target-tier.spec.ts` (regression) | 3 | 79 | ✅ |
| 6 | `pnpm run test:integration -- buy-x-get-y.integration.spec.ts` | 1 | 20 | ✅ |

> **Anti-hang honesty note**: pnpm inserts `--` before script args, so jest treats the `-t "…"` tokens in runs 3 & 4 as **path globs, not `testNamePattern`**. Consequence: those runs executed the *entire* named suites (plus a few incidentally path-matched suites: build-sale-timeline, match-target-tier, promotion-target-variants, public-tenant.guard, employee-time-off.service) rather than only BXGY-named tests. This is **broader** coverage, still path-filtered, and it means every BXGY test inside `sales.service.spec.ts`, `promotion.entity.spec.ts`, and `promotions.service.spec.ts` verifiably ran and passed. Suites overlap between runs 3/4/5, so 804 is a sum of per-run executions, not distinct tests.

**Migration drift**: ✅ `pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma` (against test DB `:5433`) → **"No difference detected."** Zero-migration invariant holds.

**Coverage**: ➖ Per-file coverage not run (informational only; behavioral coverage is demonstrated by the scenario matrix below).

---

### Spec Compliance Matrix (18/18)

| # | Requirement | Scenario (spec line) | Covering test (verified GREEN) | Result |
|---|-------------|----------------------|--------------------------------|--------|
| 1 | Best-Wins | BXGY beats smaller PD (:24-27) | `buy-x-get-y.spec.ts:458` (BXGY 1000c > PD 600c) + int `BW-1:266` | ✅ COMPLIANT |
| 2 | Best-Wins | Real per-line totals + lowest-id ties (:29-32) | `buy-x-get-y.spec.ts:487` **PD 1500c > BXGY 500c → PD wins** + `:517`/`:551` ties + int `BW-2a:318`,`BW-2b:368` | ✅ COMPLIANT |
| 3 | Best-Wins | BXGY pass between PD and ORDER (:34-37) | `buy-x-get-y.spec.ts:582` (postLine 3600→360c) + int `BW-3:419` | ✅ COMPLIANT |
| 4 | Targeting Required | No-target rejected at create (:45-48) | `promotions.service.spec.ts:262` (INVALID_TARGET, `repo.save` not called) + int `T-1:493` | ✅ COMPLIANT |
| 5 | Targeting Required | Update clearing target rejected (:50-53) | `promotions.service.spec.ts:1004` (INVALID_TARGET, not mutated, no save) + int `T-2:523` | ✅ COMPLIANT |
| 6 | Targeting Required | Valid PRODUCTS target accepted (:55-58) | `promotions.service.spec.ts:237` (`repo.save` ×1) + int `T-3:551` | ✅ COMPLIANT |
| 7 | Eligibility/Counting | Below buyQuantity not eligible (:64-67) | `buy-x-get-y.spec.ts:330` (qty1→[]) + helper + int `E-1:583` | ✅ COMPLIANT |
| 8 | Eligibility/Counting | At buyQty below N+M → zero (:69-72) | `buy-x-get-y.spec.ts:351` (qty2→[]) + helper zero-group + int `E-2:623` | ✅ COMPLIANT |
| 9 | Eligibility/Counting | One full N+M group (:74-77) | `buy-x-get-y.spec.ts:274` (R=500) + `*-helper.spec.ts` (qty3/1000/2+1/50→500) + int `E-3:663` | ✅ COMPLIANT |
| 10 | Eligibility/Counting | floor(Q/(N+M)) groups (:79-82) | `buy-x-get-y.spec.ts:303` (qty6→R=1000) + helper multi-group + int `E-4:710` | ✅ COMPLIANT |
| 11 | Rounding | Math.round per-unit (:88-91) | `buy-x-get-y.spec.ts:401` (33c) + helper 33%/17% + int `R-1:757` | ✅ COMPLIANT |
| 12 | Rounding | Non-matching line zero (:93-96) | `buy-x-get-y.spec.ts:371` (P2→no reward) + int `R-2:804` | ✅ COMPLIANT |
| 13 | "Free" (100%) | 100% free + 50% NET on **both readers** (:102-106) | previewTotals `sale.entity.spec.ts:2151`(3000/1000/2000),`:2159`(3000/500/2500) · receipt mapper `prisma-sale.repository.spec.ts:972`(NET 2000+rewardKind),`:995`(NET 2500+rewardKind) · int `F-1:860` (engine reward shape) | ✅ COMPLIANT |
| 14 | AUTO/MANUAL | AUTOMATIC auto-applies (:112-115) | `sales.service.spec.ts:6580` (routes → `applyBuyXGetYReward`) + `buy-x-get-y.spec.ts:303` + int `M-1:950` | ✅ COMPLIANT |
| 15 | AUTO/MANUAL | MANUAL in availableManualPromotions (:117-120) | `buy-x-get-y.spec.ts:662` (type BUY_X_GET_Y) + `sales.service.spec.ts:6971` + int `M-2:993` | ✅ COMPLIANT |
| 16 | AUTO/MANUAL | MANUAL in targetableManualPromotionIds (:122-125) | `buy-x-get-y.spec.ts:694` (opted-in→targetable) + int `M-3:1040` | ✅ COMPLIANT |
| 17 | AUTO/MANUAL | Opted-in MANUAL survives recompute (:127-130) | `sales.service.spec.ts:6995` (survives 2 recomputes, opt-in retained) + int `M-4:1090` | ✅ COMPLIANT |
| 18 | Idempotent Recompute | Five recomputes byte-equal (:136-139) | `sales.service.spec.ts:6801` (5× byte-equal snapshot 6000/1000/5000) + int `I-1:1150` | ✅ COMPLIANT |

**Compliance summary**: **18/18 scenarios COMPLIANT** — every scenario has ≥1 GREEN covering test; 16/18 have BOTH a unit and an integration test. **Zero coverage gaps.**

---

### Revised-Decision Verification (the review hot-spots — proven by test)

| Decision (#2796 / design v2) | Proof | Verdict |
|------------------------------|-------|---------|
| **Q5** comparator = REAL per-line TOTAL saving (PD per-unit×qty vs BXGY total R); ties→lowest id | `buy-x-get-y.spec.ts:487` asserts **PD 1500c (500c/unit×3) beats BXGY 500c** — the corrected spec:29-32 number; `:517`/`:551` lock both tie directions; int `BW-2a/BW-2b` | ✅ Proven |
| **Q6** NET: buy2get1@100% → get-unit 0c, line net 2000c; emitted on previewTotals **AND** receipt mapper + `rewardKind` | previewTotals `sale.entity.spec.ts:2151/2159`; receipt mapper `prisma-sale.repository.spec.ts:972/995` (both NET subtotal + `rewardKind='buy_x_get_y'`); PD/manual regression `:1016/:1050` emit `rewardKind=null` | ✅ Proven (both readers) |
| **100% cap is BXGY-ONLY** (ADVANCED must stay ≤99) | `promotion.entity.spec.ts:282` asserts **ADVANCED gDP=100 THROWS**; `:216` BXGY=100 accepted; `create-promotion.dto.spec.ts:24/32` DTO 100 ok / 101 rejected; `promotion.entity.ts:184` `max = type==='BUY_X_GET_Y' ? 100 : 99` | ✅ Proven (no ADVANCED leak) |
| **MANUAL** availableManualPromotions + targetableManualPromotionIds + opt-in survival | `buy-x-get-y.spec.ts:662/694/722/757` + `sales.service.spec.ts:6971/6995` + int `M-2/M-3/M-4` | ✅ Proven |
| **Idempotency** 5× byte-equal convergence | `sales.service.spec.ts:6801` (multi-field snapshot equality) + int `I-1:1150` | ✅ Proven |

---

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|-------------|--------|-------|
| Pure helper math (`computeBuyXGetYReward`) | ✅ Implemented | `use-case.ts` — floor groups, Math.round per-unit, Q9 zero |
| Engine gate + pass ordering | ✅ Implemented | gate admits BXGY for PRODUCTS/VARIANTS/CATEGORIES/BRANDS; pass runs 3b (between PD and ORDER) |
| Cross-type TOTAL-saving comparator | ✅ Implemented | `pdTotal = perUnit×qty` vs `bxgyTotal = R`; ties→lowest id |
| NET representation (2 readers) | ✅ Implemented (runtime) | `sale.entity.ts:521` previewTotals subtrahend; `prisma-sale.repository.ts:1422/1437` mapper NET + `rewardKind` |
| Type-aware 100% cap | ✅ Implemented | `promotion.entity.ts:184` + DTO `@Max(100)` |
| INVALID_TARGET create+update | ✅ Implemented | `promotions.service.ts:124/209/580` |
| Zero migration | ✅ Verified | `prisma migrate diff` empty |
| **DTO/port type contract consistency** | ❌ **BROKEN** | `SaleDetailItemDto.rewardKind` required, but `ISaleRepository.findOneWithRelations` items type omits it → **build fails** (see CRITICAL-1) |

---

### Coherence (Design v2)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 line-total `R` in existing columns, column-derived discriminator | ✅ Yes | `sale-item.entity.ts:337/386` |
| D2 pure helper | ✅ Yes | exported from use-case |
| D3 pass + Q5 TOTAL-saving best-wins | ✅ Yes | comparator asserts PD 1500c > BXGY 500c |
| D4 `isSupportedEngineType` gate | ✅ Yes | 4 appliesTo values |
| D5 targeting required create+update | ✅ Yes | `INVALID_TARGET` on both routes |
| D6 Q6 NET on previewTotals AND receipt mapper + `rewardKind` | ⚠️ Runtime-correct, **type-incomplete** | mapper emits `rewardKind`, but the design's own **Open Question** ("any consumer of the persisted line must apply the same discriminator, wire-flagged via `rewardKind`") was only half-satisfied: the `getSaleDetail` consumer's port type was not updated → build break |
| D7 MANUAL wiring (4 sites) | ✅ Yes | candidate type, port union, self-heal, response DTO |
| D8 recompute idempotency | ✅ Yes | 5× byte-equal |

---

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD evidence reported | ⚠️ Prose, not table | `apply-progress.md` documents RED→GREEN per WU (named RED spec files + GREEN impl + filtered test + regression sweep) and a commit table, but not the exact RED/GREEN/TRIANGULATE/SAFETY-NET/REFACTOR matrix |
| All work units have tests | ✅ | 7/7 WU have RED spec files, all present in the tree |
| RED confirmed (test files exist) | ✅ | all named spec files exist and were read |
| GREEN confirmed (tests pass) | ✅ | 804 executions GREEN on independent re-run |
| Triangulation adequate | ✅ | counting/rounding/best-wins/ties all have distinct-value cases; empty-array assertions each have companion non-empty tests |
| Safety net (regression) | ✅ | run 5 (79 tests) proves PD/ORDER/VARIANTS/CATEGORIES/BRANDS unchanged |

### Test Layer Distribution
| Layer | Where | Tools |
|-------|-------|-------|
| Unit (pure/entity/engine/service) | helper, sale-item/sale entity, engine, use-case, service specs | Jest + ts-jest |
| Integration (real Postgres :5433) | `buy-x-get-y.integration.spec.ts` (20 tests, real Prisma/service/engine) | Jest integration config + Docker `nest-practice-test-db` |
| E2E (HTTP) | none | — (not required for this change) |

### Changed File Coverage
➖ Per-file coverage not run (informational, non-blocking per Strict TDD module). Behavioral coverage is demonstrated by the 18/18 scenario matrix with both unit and integration layers.

### Assertion Quality
✅ **All assertions verify real behavior.** No tautologies, no assertion-free tests. Empty-collection assertions (`expect(result.lines).toEqual([])`) each have a companion non-empty test (qty 3 → reward vs qty 1/2 → empty). The 5× loop in `sales.service.spec.ts:6873` iterates a fixed 4 times (not over a possibly-empty collection → not a ghost loop). Byte-equal tests assert multi-field concrete cents. Service specs mock only the engine (correct layer boundary); engine math is proven separately with the real engine + integration.

### Quality Metrics
**Type checker / Build**: ❌ **`nest build` (tsc) FAILS — 1 error (TS2322)**. This is the blocker.
**Linter**: ➖ not run.

---

### Issues Found

**CRITICAL**
- **CRITICAL-1 — The branch does not compile (`pnpm run build` exit 1).** WU2 added the **required** field `rewardKind: 'buy_x_get_y' | null` to `SaleDetailItemDto` (`src/sales/dto/sale-detail-response.dto.ts:63`) and updated the repository **implementation** to emit it (`prisma-sale.repository.ts:1437`), but did **not** update the repository **port interface** return type — `ISaleRepository.findOneWithRelations` still declares its `items` shape without `rewardKind` (`src/sales/domain/sale.repository.ts:270-286`). As a result the live `getSaleDetail()` mapper (`src/sales/sales.service.ts:1180` → `items: sale.items`) fails `TS2322` because it assigns items-without-`rewardKind` to `SaleDetailItemDto[]`.
  - **Why every test still passed**: `ts-jest` transpiles each file in isolation without cross-file type-checking, so no unit/integration test surfaces this. Only the full `tsc`/`nest build` does.
  - **Runtime impact**: LOW for `getSaleDetail` itself — the mapper *does* emit `rewardKind` at runtime, so the HTTP response is correct. **Deploy impact**: BLOCKER — `nest build` cannot produce `dist/`, so the branch is not shippable/archivable.
  - **Fix (one line, apply-phase — NOT applied by verify)**: add `rewardKind: 'buy_x_get_y' | null;` to the `items` array type in `src/sales/domain/sale.repository.ts` (after `prePriceCentsBeforeDiscount` at line 285). Then re-run `pnpm run build` (expect 0) and re-verify. Recommend adding a `getSaleDetail` unit/int assertion on `items[].rewardKind`, or a `tsc --noEmit` step to the pipeline, so this class of gap fails a test next time.

**WARNING**
- **WARNING-1 — TDD evidence format.** `apply-progress.md` documents RED→GREEN richly in prose + commit table but not in the exact "TDD Cycle Evidence" matrix the Strict TDD module expects. Substance is present and verifiable; format is not. Non-blocking.
- **WARNING-2 — `ts-jest` gives false confidence.** The test pipeline does not type-check across files, which is precisely why CRITICAL-1 slipped through GREEN. A `tsc --noEmit` (or `nest build`) gate belongs in the RED→GREEN loop for changes that alter shared DTO/port types.

**SUGGESTION**
- **SUGGESTION-1 — Integration F-1 is partial for scenario 13's NET clause.** `buy-x-get-y.integration.spec.ts` `F-1` asserts only the engine reward shape (`perUnitRewardCents`/`lineDiscountCents`), not `previewTotals` (3000/1000/2000) or the receipt mapper NET+`rewardKind`. Those are fully covered by the WU2 unit tests, so scenario 13 is not a gap — but an end-to-end `getSaleDetail` assertion on `subtotalCents`/`rewardKind` would also have caught CRITICAL-1.
- **SUGGESTION-2 — `-t` flag is inert here.** Because pnpm injects `--`, the `-t "BUY_X_GET_Y"` name filters run the whole named suites. Harmless (broader coverage), but if a future run truly needs name-filtering, invoke jest directly (`npx jest <path> -t <name>`) to avoid the `--` swallow.

---

### Verdict

**FAIL** — All 18 spec scenarios are behaviorally satisfied with GREEN unit + integration evidence, every revised decision (Q5/Q6/type-aware cap/MANUAL/idempotency) is proven by test, and migration drift is zero — **but `pnpm run build` fails (TS2322): the branch does not compile.** A non-compiling branch is a hard blocker and cannot proceed to archive. Route back to `sdd-apply` for the one-line port-interface fix (`sale.repository.ts` items type += `rewardKind`), then re-run `pnpm run build` and re-verify. Do **not** archive until the build is green.
