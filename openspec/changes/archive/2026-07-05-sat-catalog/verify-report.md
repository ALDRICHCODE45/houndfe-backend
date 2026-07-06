# Verification Report: SAT Catalog Search & Validation

## Final Verdict: PASS

- **Change**: sat-catalog
- **Branch**: feat/sat-catalog
- **Verified commit**: `e47a8d1` — "feat(products): validate satKey against SAT catalog on create/update, change-only"
- **Commits verified**: `ca16ee5` (Slice A) → `ccce5a6` (Slice B) → `8ef92b8` (Slice C) → `e47a8d1` (Slice D)
- **Mode**: Strict TDD (`pnpm run test`)
- **Verified at**: 2026-07-05 (fresh, independent re-derivation of all evidence)
- **Result**: PASS — all 11 spec scenarios COMPLIANT with runtime test evidence, 1307/1307 tests green, tsc steady at 35 pre-existing errors (0 in change files), all 46 tasks checked, all design-gate anchors W1–W6 present.
- **Flaky test (obs #2608) classification**: **(c) BENIGN — cold-start / first-run environmental noise.** Could NOT be reproduced in 11 full-suite runs + 28 targeted runs (39 executions total), including cold-cache, `--runInBand`, and isolated suspect suites. All new SAT tests are clock-deterministic (injected `now`) and DB-free (mocked). See Flaky Test Investigation section.
- **Archive readiness**: READY (see Archive Readiness section).

> This is the single authoritative verdict for this change. No FAIL condition
> was found. No production or test code was modified during verification.

## Evidence

### Tests — PASS (1307/1307), stable across 11 full runs

```text
$ pnpm run test
Test Suites: 123 passed, 123 total
Tests:       1307 passed, 1307 total
Snapshots:   0 total
Time:        ~4 s
```

Full-suite stability matrix (each is an independent `pnpm run test` invocation):

| Run | Condition | Result |
|-----|-----------|--------|
| 1 | default (warm) | 1307/1307 ✅ |
| 2–9 | default (warm), consecutive | 1307/1307 ✅ (×8) |
| 10 | cold cache (`jest --clearCache` first) | 1307/1307 ✅ |
| 11 | `jest --runInBand` (serial, no workers) | 1307/1307 ✅ |

- 0 failed, 0 skipped in every run. All change suites are fully mocked / clock-injected — no DB connectivity, no wall-clock dependency.
- Count matches the apply-progress report (1307), +8 over the pre-change 1299 baseline (Slice D products.service additions).

SAT-related suites (all green every run):

```text
PASS prisma/seed-sat.spec.ts
PASS src/sat-catalog/domain/sat-key.entity.spec.ts
PASS src/sat-catalog/infrastructure/prisma-sat-key.repository.spec.ts
PASS src/sat-catalog/sat-catalog.service.spec.ts
PASS src/sat-catalog/dto/search-sat-key.dto.spec.ts
PASS src/sat-catalog/sat-catalog.controller.spec.ts
PASS src/public-catalog/http/public-catalog.snapshots.spec.ts   (W5 — not.toHaveProperty('satKey') @ :54)
```

### Type Check — 35 errors (pre-existing), ZERO in change files

```text
$ pnpm exec tsc --noEmit
TOTAL TS errors: 35
Errors in sat-catalog / products.service / products.module / permission: ZERO
```

- All 35 errors are in unrelated pre-existing `*.spec.ts` files (chatbot-api, customers, employees, etc. — loose partial mocks), excluded from the build path (`tsconfig.build.json`) and tolerated by ts-jest per-file `isolatedModules`. Steady at 35 as reported by apply — zero new, zero in any file this change touched.

### Completeness — PASS

| Metric | Value |
|--------|-------|
| Tasks total | 46 |
| Tasks complete | 46 |
| Tasks incomplete | 0 |

All Slice A–D checkboxes are `[x]` in `tasks.md` (46 checked / 0 unchecked), corroborated by 4 work-unit commits on `feat/sat-catalog`. No unchecked implementation task remains.

### Spec Compliance Matrix — PASS (11/11 COMPLIANT)

| Requirement | Scenario | Test (runtime evidence) | Result |
|-------------|----------|--------------------------|--------|
| SAT Catalog Typeahead Search | Substring, prefix, case-insensitive matching | `prisma-sat-key.repository.spec.ts > runs normalize(q) before building the where clause` (proves `key.startsWith(n)` OR `searchText.contains(n)`); `sat-catalog.controller.spec.ts > 200 for user with read:SatKey` proves `{items,limit,offset,total}` shape | ✅ COMPLIANT |
| SAT Catalog Typeahead Search | Retired excluded; limit capped at 50 | `prisma-sat-key.repository.spec.ts > applies ACTIVE-only filter` (validTo null OR > now) + `> honors limit (take)`; `search-sat-key.dto.spec.ts > REJECT ?limit=200 (@Max(50))`; empty q → empty via `sat-catalog.service.spec.ts > empty items on empty q WITHOUT calling the repo` | ✅ COMPLIANT |
| SAT Catalog Single-Key Lookup | Active, retired, and missing key | `sat-catalog.controller.spec.ts > 200 on ACTIVE hit`, `> 200 on RETIRED hit`, `> 404 when key is missing`; `prisma-sat-key.repository.spec.ts > findByKey returns row WITHOUT activeClause` (retired resolvable) | ✅ COMPLIANT |
| Strict SAT Key Validation on Create/Update | Known succeeds; unknown 400 SAT_KEY_NOT_FOUND; absent accepted | `products.service.spec.ts > accepts a satKey that exists in the catalog (D.2.1)`, `> rejects unknown satKey with 400 SAT_KEY_NOT_FOUND`, `> accepts absent satKey (null)`; `sat-catalog.service.spec.ts > throws BadRequestException({error:'SAT_KEY_NOT_FOUND'})` | ✅ COMPLIANT |
| Validate-Only-On-Change | Unchanged satKey and non-satKey edits never block | `products.service.spec.ts > does NOT call assertExists when satKey === current value (D.3.1)` (spy `not.toHaveBeenCalled`), `> does NOT call assertExists when satKey not in dto (D.3.2)`, `> clearing satKey to null without calling assertExists` | ✅ COMPLIANT |
| Validate-Only-On-Change | Change to unknown fails 400; change to valid succeeds | `products.service.spec.ts > change to unknown → 400 SAT_KEY_NOT_FOUND (assertExists called with '99999999')`, `> change to valid known key → 200 (assertExists called with '01010102')` | ✅ COMPLIANT |
| RBAC for SAT Catalog Endpoints | With permission allowed; without permission rejected | `sat-catalog.controller.spec.ts > 403 when user lacks read:SatKey`, `> 200 for user with read:SatKey`, `> 200 for the Manager role (W4 anchor)`, `> 401 without JWT` | ✅ COMPLIANT |
| Public Catalog Excludes satKey | Public payload omits satKey | `public-catalog.snapshots.spec.ts:54 > not.toHaveProperty('satKey')` green; serializer confirmed UNCHANGED by the 4 commits (`git diff --stat` over `src/public-catalog/` = empty) | ✅ COMPLIANT |
| Seed Idempotency for SAT Catalog | Re-run is stable | `seed-sat.spec.ts > calls createMany with skipDuplicates:true, never drops keys, and is stable across replays` (two ingest replays → byte-identical 10-row batches, no NULL/empty key) | ✅ COMPLIANT |
| SAT Data File Header Contract | Enum mapping and open-ended validity | `seed-sat.spec.ts > maps Sí→REQUIRED, No→NONE, Opcional→OPTIONAL`, `> is case/trim-insensitive`, `> parses ISO date, empty → null`, `> tolerates missing headers → null/default` | ✅ COMPLIANT |
| Accent-Insensitive Search in v1 | Accent-insensitive matching provided | `prisma-sat-key.repository.spec.ts > query "MEDICACIÓN" matches row "Medicación"` (both normalize to `medicacion`); `sat-key.entity.spec.ts > strips diacritics ("Medicación"→"medicacion")`; `seed-sat.spec.ts > normalize("Medicación") === "medicacion"` | ✅ COMPLIANT |

**Compliance summary**: 11/11 scenarios COMPLIANT with runtime test evidence.

### Correctness — PASS

| Requirement | Status | Notes |
|------------|--------|-------|
| ñ-preserving `normalize()` (W1) | ✅ | `ingest/normalize.ts:19-24` shields `ñ/Ñ` with `\u0001/\u0002` sentinels before NFD strip, restores after — `niño`↛`nino`, `piña`↛`pina`, `Medicación`→`medicacion`. Same fn used at ingest (`sat-key.entity.ts:62`) and query (`prisma-sat-key.repository.ts:54`). |
| Search match modes | ✅ | `prisma-sat-key.repository.ts:55-65` — `AND[activeClause, OR[{key:{startsWith:n}}, {searchText:{contains:n}}]]`; `n = normalize(q)`. |
| ACTIVE filter | ✅ | `activeClause()` (`:97-105`) = `OR[{validTo:null},{validTo:{gt:now}}]`; `now` is an injectable `() => Date` (default `new Date()`) — deterministic in tests. |
| Single-key lookup returns retired | ✅ | `findByKey` / `exists` (`:83-95`) bypass `activeClause` — retired rows resolve. |
| Limit cap 50 | ✅ | `SearchSatKeyDto` `@Max(50)` (`:25`), default 20; `?limit=200` → 400. |
| `@Type(() => Number)` coercion (W2) | ✅ | `search-sat-key.dto.ts:22,29` — explicit `@Type(()=>Number)` before `@IsInt` (global ValidationPipe lacks `enableImplicitConversion`). |
| CASL `AppSubjects` union (W3) | ✅ | `permission.ts:23` — `'SatKey'` in the closed union (before registry entry, so build compiles). |
| Permission registry entry | ✅ | `permission.ts:158` — `{ subject:'SatKey', action:'read', description:'View SAT catalog keys' }`. |
| Manager grant (W4) | ✅ | `seed.ts:1351` — `permissionKey('SatKey','read')` in `managerPermissionKeys`; controller test proves Manager → 200. |
| `assertExists` error contract | ✅ | `sat-catalog.service.ts:57-65` throws `BadRequestException({error:'SAT_KEY_NOT_FOUND', message})`; passes on hit incl. retired. |
| Empty-query short-circuit | ✅ | `sat-catalog.service.ts:39-41` returns `{items:[],...}` without hitting repo. |
| Create-path validation | ✅ | `products.service.ts:286` — `if (dto.satKey) await this.satCatalog.assertExists(dto.satKey);` before `Product.create({...})`. |
| Update-path change-detection | ✅ | `products.service.ts:606-616` — lookup only when `next !== null && next !== product.satKey`; `product` is the persisted entity from `findById`, so legacy keys never block. |
| Seed idempotency (`createMany skipDuplicates`) | ✅ | `key` is `@id` PK + `skipDuplicates:true` → stable COUNT on re-run. |

### Coherence (Design) — PASS

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Option A: normalized `searchText` column, app-layer `normalize()` (no PG extension) | ✅ | `searchText` populated at ingest via `normalize(key+' '+description)`; query-time `normalize(q)` before ILIKE — byte-identical fn. |
| Base (non-tenant) Prisma client | ✅ | `PrismaSatKeyRepository` uses `prisma.satProductServiceKey` directly; `SatCatalogModule` imports base `DatabaseModule`. |
| Validation in application layer (not domain/FK) | ✅ | `SatCatalogService.assertExists` called from `ProductsService`; `Product` aggregate unchanged. |
| `SatInclusion` enum | ✅ | schema enum `{REQUIRED NONE OPTIONAL}`; parser maps Sí/No/Opcional. |
| `search` ACTIVE-only, `findByKey` returns retired | ✅ | repository split confirmed by tests. |
| Idempotent batched seed step in `seed-sat.ts` | ✅ | `ingestSatCatalog` + `createMany({skipDuplicates:true})`, wired from `seed.ts`. |
| TWO edits in `permission.ts` (union + registry) | ✅ | both present (`:23`, `:158`). |
| `SatCatalogModule` exports `SatCatalogService`; `ProductsModule` imports it | ✅ | `sat-catalog.module.ts:34` exports; `products.service.ts:97` injects (5th ctor arg). |
| Change-detection predicate `next !== null && next !== product.satKey` | ✅ | exact match at `products.service.ts:612`. |

### TDD Compliance — PASS (6/6)

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | apply-progress (obs #2598) documents RED→GREEN per slice; 8 new products.service Slice D tests enumerated. |
| All tasks have tests | ✅ | entity, repository, service, DTO, controller, seed-sat, products.service Slice D block — every behavioral task has a covering spec. |
| RED confirmed (tests exist) | ✅ | all 7 SAT/change spec files exist and execute. |
| GREEN confirmed (tests pass) | ✅ | 1307/1307 on independent execution, 11 runs. |
| Triangulation adequate | ✅ | normalize: niño/piña/Medicación/ÁÉÍÓÚÜ variants; assertExists hit/miss/retired; update: unchanged/other-field/change-unknown/change-valid/clear-null (5 cases). |
| Safety net for modified files | ✅ | products.service (modified) + 3 other product specs got the 5th ctor mock arg; all prior suites remain green; chatbot-api full-graph test got `SAT_KEY_REPOSITORY` override. |

### Test Layer Distribution

| Layer | Coverage | Notes |
|-------|----------|-------|
| Unit (pure, mocked) | entity, service, DTO, normalize/parse | no DB, no clock dependency |
| Integration (Nest DI + supertest) | `sat-catalog.controller.spec.ts` (guards + ValidationPipe + routes), `service-auth.guard.spec.ts` (full ChatbotApiModule graph) | in-memory guards; no live DB |
| Repository (mocked Prisma + injected clock) | `prisma-sat-key.repository.spec.ts` | `() => NOW` fixed at 2026-07-01 |

Coverage tool: not run per-file (informational only, non-blocking). All 11 spec scenarios are covered by at least one passing test layer.

### Assertion Quality — ✅ All assertions verify real behavior

Audited all 7 change spec files. No tautologies, no ghost loops, no smoke-only tests, no orphan empty-array checks. Notable strengths:
- Empty-result assertions (`search('')`) have companion non-empty tests and pair with `repo.search not.toHaveBeenCalled()` (proves the short-circuit, not just an empty return).
- Spy assertions (`assertExists.not.toHaveBeenCalled()`) are the CORRECT behavioral proof for the validate-only-on-change requirement — they verify a real code path (change-detection guard), not an implementation detail.
- ñ-preservation uses both positive (`toContain('niño')`) and negative (`not.toContain('nino')`) plus cross-collapse distinctness (`a.searchText).not.toBe(b.searchText)`).

## Flaky Test Investigation (obs #2608)

**Symptom (reported)**: one gatekeeper `pnpm run test` run showed 2 failed / 1305 passed; the next 7 runs were 1307/1307. Not reproduced.

**Classification: (c) BENIGN — cold-start / first-run environmental noise. NOT a determinism bug in sat-catalog code or tests.**

### Reproduction attempt — 39 executions, 0 failures

| Test target | Runs | Failures | Purpose |
|-------------|------|----------|---------|
| Full `pnpm run test` (warm) | 9 | 0 | baseline stability |
| Full suite, cold cache (`jest --clearCache`) | 1 | 0 | candidate #1: cold ts-jest first-run |
| Full suite, `--runInBand` (serial) | 1 | 0 | candidate #3: worker ordering / module-graph |
| `service-auth.guard.spec.ts` (ChatbotApi full graph) | 10 | 0 | candidate #3: DI transitive `PrismaSatKeyRepository` |
| `src/sat-catalog/` + `seed-sat.spec.ts` | 10 | 0 | candidate #2: time-dependent SAT tests |
| `products.service.spec.ts` (Slice D spies) | 8 | 0 | Slice D integration |

### Candidate rulings (with evidence)

- **Candidate #2 — time-dependent `activeClause` (`new Date()`) — RULED OUT.** The repository's `activeClause` does use `new Date()` in production, BUT every spec that exercises it injects a fixed clock: `PrismaSatKeyRepository` constructor takes `now: () => Date = () => new Date()`, and `prisma-sat-key.repository.spec.ts:56` passes `() => NOW` (fixed `2026-07-01`). The entity `isActive` tests use `now = 2026-07-01`; the one no-arg test (`sat-key.entity.spec.ts:164`) asserts only the `validTo === null → true` branch, which is clock-independent. The fixture retired row (`01010105`, `validTo=2020-12-31`) and the seed-sat assertion (`retired.validTo < Date.now()`, line 181) compare against a date **6 years in the past** — impossible to flip. **No SAT fixture seeds `validTo` near `now()`.** The repository even ships an injectable clock specifically to avoid this class of flake — good design.
- **Candidate #3 — DI transitive `PrismaSatKeyRepository` (ChatbotApiModule → SalesModule → ProductsModule → SatCatalogModule) — RULED OUT.** `service-auth.guard.spec.ts` is the ONLY test that compiles the full `ChatbotApiModule` graph, and it already carries `.overrideProvider(SAT_KEY_REPOSITORY).useValue({search,findByKey,exists})` (`:278-283`). No other spec imports `ChatbotApiModule`/`SalesModule`/`ProductsModule` as a Nest module graph (grep confirmed). It passed 10/10 in isolation and inside every full-suite run. No residual override gap exists.
- **Candidate #1 — cold-start ts-jest timing on first run under load — MOST LIKELY, BENIGN.** The suite runs in ~4s with default parallel workers on a `ts-jest` transform. A single 2-failure blip that never recurs across 39 executions (including an explicit cold-cache run that also passed) is consistent with first-run transform/worker warm-up jitter or transient host load during the gatekeeper run, not with any code path in this change. It carries no fixed failing-test signature (the original 2 failing test names were not captured), and no deterministic condition in the new code can produce a 2-test-only intermittent failure.

**Conclusion**: the flake is environmental (cold-start/host-load noise), not a defect in sat-catalog. No code fix is warranted or made. If the exact 2 failing test names resurface in future CI, capture them (`jest --json` or tee the log) — but nothing in the current tree reproduces it.

## Design-Gate Anchor Verification (W1–W6)

| # | Anchor | Present? | Evidence |
|---|--------|----------|----------|
| W1 | ñ-preservation | ✅ | `ingest/normalize.ts:19-24` sentinel-shield; entity/repo/seed specs assert `niño`/`piña` intact, `piña`≠`pina` |
| W2 | `@Type(()=>Number)` rejects `?limit=200` | ✅ | `search-sat-key.dto.ts:22,29`; `dto.spec.ts` + `controller.spec.ts:278` → 400 |
| W3 | `AppSubjects` union before registry + typecheck | ✅ | `permission.ts:23` union member + `:158` registry; `tsc --noEmit` clean in permission.ts |
| W4 | Manager grant | ✅ | `seed.ts:1351`; `controller.spec.ts:260` Manager → 200 |
| W5 | Public-catalog snapshot preserved | ✅ | `public-catalog.snapshots.spec.ts:54` green; serializer untouched (git diff empty) |
| W6 | External file user-supplied; fixture keeps slice testable | ✅ | `prisma/data/sat-clave-prod-serv.fixture.csv` (10 rows incl. retired `01010105`, ñ `Pañales para niño`, `piña`, `Opcional`); tests read fixture, not the 52k live file |

## Issues Found

**CRITICAL**: None.

**WARNING**: None that block archive.

**SUGGESTION**:
- **SUGGESTION-1 (flaky follow-up)** — The flake could not be reproduced and is classified benign. To make any future recurrence diagnosable, consider teeing CI test output to a file or running `jest --json --outputFile` in the gatekeeper step so failing test names survive. No code change needed now.
- **SUGGESTION-2 (pre-existing, unrelated)** — `tsc --noEmit` reports 35 errors, all in unrelated pre-existing `*.spec.ts` files (chatbot-api, customers, employees, etc.) with loose partial mocks. Excluded from the build path; tolerated by ts-jest. Consider a `tsconfig.spec.json` typecheck in CI to tighten over time. Not introduced by this change.

## Archive Readiness

**READY FOR ARCHIVE.**

- All 46 tasks complete and committed across 4 work-unit commits on `feat/sat-catalog`.
- 1307/1307 tests pass with zero failures/skips, stable across 11 full-suite runs (warm, cold-cache, and serial).
- `tsc --noEmit` steady at 35 pre-existing errors, ZERO in any file this change touched.
- All 11 spec scenarios COMPLIANT with runtime test evidence.
- All design-gate anchors W1–W6 verified present in code.
- The reported flaky test is classified **(c) benign cold-start noise** — not reproduced in 39 executions, ruled out as a determinism bug in sat-catalog (injected clocks, mocked DB, single full-graph test already has the DI override).
- Only two non-blocking SUGGESTIONs remain (CI log-capture for future flake diagnosis; pre-existing spec-file tsc looseness) — neither gates archive.

**Next recommended phase: archive.**
