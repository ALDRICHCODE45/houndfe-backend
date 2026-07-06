# Archive Report: SAT Catalog Search & Validation

## Final Verdict: ARCHIVED — PASS

- **Change**: `sat-catalog`
- **Branch**: `feat/sat-catalog`
- **Archive folder**: `openspec/changes/archive/2026-07-05-sat-catalog/`
- **Archived at**: 2026-07-05
- **Verified commit**: `e47a8d1` — "feat(products): validate satKey against SAT catalog on create/update, change-only"
- **Verify verdict**: PASS — 1307/1307 tests green (stable across 11 full-suite runs + cold-cache + `--runInBand`), 11/11 spec scenarios COMPLIANT with runtime test evidence, `tsc --noEmit` steady at 35 pre-existing errors (ZERO in change files), all 46 tasks `[x]`, all design-gate anchors W1–W6 verified in code.
- **Tasks**: 46/46 complete, 0 unchecked
- **Spec compliance**: 11/11 COMPLIANT

## Commits Archived (4 work-unit commits + design-gate corrections)

| Hash | Slice | Title |
|------|-------|-------|
| `ca16ee5` | A | feat(sat-catalog): add SatProductServiceKey model, migration, and idempotent seed ingest |
| `ccce5a6` | B | feat(sat-catalog): add domain entity, repository port/adapter, and catalog service |
| `8ef92b8` | C | feat(sat-catalog): add HTTP endpoints, CASL SatKey/read, and Manager grant |
| `e47a8d1` | D | feat(products): validate satKey against SAT catalog on create/update, change-only |

Order: A → B → C → D. Slice ordering preserved per proposal/design.

## What Shipped

A new bounded context `src/sat-catalog/` (hexagonal: domain port + Prisma adapter + DTO + controller + service + module) that owns the Mexican SAT `c_ClaveProdServ` catalog (~52k rows) on a non-tenant `SatProductServiceKey` table. `ProductsModule` imports `SatCatalogModule` and calls `SatCatalogService.assertExists()` in `create`/`update` **only when `satKey` changes**, so legacy products whose stored `satKey` is not in the catalog remain editable on other fields. CASL `SatKey`/`read` subject added to the closed `AppSubjects` union and `PERMISSION_REGISTRY`, with the Manager role granted `read:SatKey` in `prisma/seed.ts` so the product editor (realistically a Manager) does not get 403.

Endpoints exposed:

- `GET /sat-keys?search=<text>&limit=<1..50>&offset=<n>` — active-only typeahead (case- AND accent-insensitive on description, case-insensitive prefix on `key`); empty `search` short-circuits to `{items:[], limit, offset, total}`.
- `GET /sat-keys/:key` — single-row lookup that **returns retired rows too** so the editor can resolve a saved (possibly retired) key's label on load; 404 on miss.

Validation contract: `ProductsService` create path validates a non-empty `satKey`; update path validates only when `next !== null && next !== product.satKey`. Miss throws `BadRequestException({ error: 'SAT_KEY_NOT_FOUND', message })`. Public-catalog serializer untouched (`git diff --stat` over `src/public-catalog/` is empty).

## Specs Synced into Source of Truth

| Domain | Action | Requirements |
|--------|--------|--------------|
| `sat-catalog` | **CREATED** | 9 new requirements (SAT Catalog Typeahead Search, SAT Catalog Single-Key Lookup, Strict SAT Key Validation on Product Create/Update, Validate-Only-On-Change, RBAC for SAT Catalog Endpoints, Public Catalog Excludes satKey, Seed Idempotency for SAT Catalog, SAT Data File Header Contract, Accent-Insensitive Search in v1) — 11 scenarios total |

Delta format (`# Delta for sat-catalog` + `## ADDED Requirements`) was converted to the proper main-spec format (`# SAT Catalog Specification` + `## Requirements`) to match the established convention used in `sale-cancellation/spec.md`, `sales/spec.md`, `receipt-review/spec.md`. No other main spec was touched — sat-catalog is a pure ADDED capability (no MODIFIED / REMOVED / RENAMED requirements in the delta).

## Design-Gate Corrections Applied

All six design-gate anchors (W1–W6) verified present in code per `verify-report.md` (see "Design-Gate Anchor Verification" section).

| # | Anchor | Resolution |
|---|--------|-----------|
| W1 | ñ-preservation in `normalize()` | `src/sat-catalog/ingest/normalize.ts:19-24` shields `ñ/Ñ` with `\u0001/\u0002` sentinels before NFD strip, restores after. Same fn at ingest (`sat-key.entity.ts:62`) and query (`prisma-sat-key.repository.ts:54`). Triangulated: `niño`↛`nino`, `piña`↛`pina`, `piña` and `pina` are distinct substrings, `MEDICACIÓN`→`medicacion`. |
| W2 | `@Type(() => Number)` rejects `?limit=200` | `src/sat-catalog/dto/search-sat-key.dto.ts:22,29` — explicit `@Type(()=>Number)` before `@IsInt`/`@Min`/`@Max(50)`. Global `ValidationPipe` does NOT set `enableImplicitConversion`, so this annotation is mandatory. Verified by `search-sat-key.dto.spec.ts` (`?limit=200` rejected) and `controller.spec.ts:278` (HTTP 400). |
| W3 | CASL `AppSubjects` union + registry + typecheck | `src/auth/authorization/domain/permission.ts:23` adds `'SatKey'` to the closed string-literal union (BEFORE the registry entry so `pnpm build` does not fail on the closed union); `:158` adds the `{ subject:'SatKey', action:'read' }` registry entry. `tsc --noEmit` clean in `permission.ts`. |
| W4 | Manager grant | `prisma/seed.ts:1351` — `permissionKey('SatKey','read')` appended to the Manager `managerPermissionKeys` allowlist (Manager uses an explicit grant, not "all"). `sat-catalog.controller.spec.ts:260` proves Manager → 200 (not just superAdmin). |
| W5 | Public-catalog snapshot preserved | `src/public-catalog/http/public-catalog.snapshots.spec.ts:54` `not.toHaveProperty('satKey')` remains green. Public-catalog serializer UNCHANGED across all 4 commits (`git diff --stat src/public-catalog/` = empty). |
| W6 | External SAT file user-supplied; fixture keeps slice testable | Production file `prisma/data/sat-clave-prod-serv.csv` (~52k) NOT yet committed — user supplies it. A small test fixture `prisma/data/sat-clave-prod-serv.fixture.csv` (10 rows including a retired row `01010105`, a `ñ` description `Pañales para niño`, a `piña`, and an `Opcional` row) keeps the ingest code and tests deterministic without the live file. `seed-sat.ts` reads the live file when present and falls back to the fixture for the test build. |

## Archive Contents

- `proposal.md` ✅
- `explore.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (46/46 tasks complete, 0 unchecked)
- `verify-report.md` ✅ (final verdict PASS at top; full evidence + flaky-test investigation + design-gate verification)
- `specs/sat-catalog/spec.md` ✅ (delta-style spec preserved for audit trail)
- `archive-report.md` ✅ (this file)

## Source-of-Truth Files Updated

The following main spec now reflects sat-catalog as first-class behavior:

- `openspec/specs/sat-catalog/spec.md` (NEW — 9 requirements, 11 scenarios)

No other main spec required modification (pure ADDED capability).

## Engram Observations for Traceability

| Topic | Obs ID | Purpose |
|-------|--------|---------|
| `sdd/sat-catalog/apply-progress` | #2598 | Slices A→D implementation record with commit hashes and Slice D wiring detail |
| `tech-debt/prisma-drift-emergency-contacts` | #2599 | Pre-existing `employee_emergency_contacts.updatedAt` Prisma drift (NOT in sat-catalog scope — see Deferred section) |
| `sdd/sat-catalog/flaky-test` | #2608 | Once-observed 2-failure blip during Slice D gatekeeper run, classified **(c) BENIGN cold-start / first-run environmental noise** by verify-report.md |
| `sdd/sat-catalog/archive-report` | (this save) | This archive report |

## DEFERRED — User Action Required After Merge

### (a) Real ~52k SAT data file — production seed needs it

**`prisma/data/sat-clave-prod-serv.csv` is USER-SUPPLIED and NOT yet committed.** The seed step (`prisma/seed.ts` → `prisma/seed-sat.ts` → `ingestSatCatalog()`) reads the live file when present and falls back to the small fixture (`sat-clave-prod-serv.fixture.csv`, 10 rows) for the test build.

**To seed production**: obtain the SAT `c_ClaveProdServ` reference list (expected source: SAT `catCFDI` workbook, sheet `c_ClaveProdServ`), convert offline to CSV or JSON, and commit at `prisma/data/sat-clave-prod-serv.csv`. Required headers (case-insensitive, parsed by name):

| Header | Column | Notes |
|--------|--------|-------|
| `c_ClaveProdServ` | `key` | 8 digits; `@id` PK |
| `Descripción` | `description` | free text |
| `Incluir IVA trasladado` | `includeIva` | `Sí` / `No` / `Opcional` → `REQUIRED` / `NONE` / `OPTIONAL` |
| `Incluir IEPS trasladado` | `includeIeps` | same mapping |
| `Fecha de inicio de vigencia` | `validFrom` | ISO date |
| `Fecha de fin de vigencia` | `validTo` | ISO date; empty → `NULL` (open-ended / ACTIVE) |

The ingestion script tolerates missing headers as `NULL`/empty (verified by `seed-sat.spec.ts`). Re-running the seed is idempotent (`createMany({ skipDuplicates: true })` + `key` PK ⇒ stable `COUNT(*)`).

## DEFERRED / EXTERNAL — Pre-existing, Out of Scope

These are explicitly NOT part of the sat-catalog change. They are listed for traceability so future work can pick them up cleanly.

### (b.1) Prisma schema drift on `employee_emergency_contacts.updatedAt` (Engram obs #2599)

`EmployeeEmergencyContact.updatedAt` exists in the live DB but is missing from the Prisma model in `prisma/schema.prisma`. Surfaced during sat-catalog Slice A when `prisma migrate dev` wanted to DROP the untracked column (destructive, unrelated to sat-catalog). The apply agent correctly avoided the destructive diff by hand-writing the additive SAT migration (`prisma/migrations/<ts>_sat_catalog/migration.sql`) and shipping via `prisma migrate deploy`. **This drift will bite any future `prisma migrate dev`** — fix separately by adding `updatedAt DateTime @updatedAt` (or the correct type) to the Prisma model and generating a no-op/aligning migration.

### (b.2) 35 pre-existing TS errors in unrelated `*.spec.ts` files

`pnpm exec tsc --noEmit` reports 35 errors, ALL in unrelated pre-existing `*.spec.ts` files (chatbot-api, customers, employees, etc. — loose partial mocks). Excluded from the build path (`tsconfig.build.json`) and tolerated by `ts-jest` per-file `isolatedModules`. Steady at 35 (zero new, zero in any file this change touched). Consider a `tsconfig.spec.json` typecheck in CI to tighten over time. SUGGESTION-2 in verify-report.md.

### (c) Observed-once benign flaky (Engram obs #2608)

During Slice D gatekeeper verification, ONE `pnpm run test` run showed 2 failed / 1305 passed; the next 7 consecutive runs were 1307/1307 green. Could not be reproduced in **39 executions** (full-suite, cold-cache, `--runInBand`, plus targeted suites). Three candidates investigated and ruled out:

- **(2) Time-dependent `activeClause`** — Ruled out: repository's `activeClause` uses `new Date()` in production BUT every spec that exercises it injects a fixed clock via the `now: () => Date = () => new Date()` constructor parameter. The retired-row fixture (`01010105`, `validTo=2020-12-31`) is 6 years in the past — impossible to flip. No SAT fixture seeds `validTo` near `now()`.
- **(3) DI transitive `PrismaSatKeyRepository`** — Ruled out: `service-auth.guard.spec.ts` (the ONLY test that compiles the full `ChatbotApiModule` graph) already carries `.overrideProvider(SAT_KEY_REPOSITORY).useValue(...)`. Passed 10/10 in isolation.
- **(1) Cold-start ts-jest timing** — **MOST LIKELY, BENIGN.** A single 2-failure blip that never recurs across 39 executions is consistent with first-run transform/worker warm-up jitter or transient host load during the gatekeeper run. Carries no fixed failing-test signature. No code fix warranted or made.

SUGGESTION-1 in verify-report.md: tee CI test output to a file (or run `jest --json --outputFile`) so any future failing-test names survive for diagnosis.

## Archive Notes

- Branch `feat/sat-catalog` is **NOT merged to main**. The user merges after archive. This commit is the only archive commit (`chore(sat-catalog): archive SDD change`).
- No production source code or tests were modified during archive. Only spec/artifact movement (`openspec/`) and the new `archive-report.md`.
- The 4 implementation commits (Slices A→D) precede this archive commit and remain intact in the branch history.
- `verify-report.md` was untracked at the start of archive (the verify phase wrote it to disk but did not commit it). It is now included in the archive folder AND committed as part of this archive commit.
- The delta-style spec at `openspec/changes/archive/2026-07-05-sat-catalog/specs/sat-catalog/spec.md` is preserved verbatim for audit trail. The main-spec conversion is at `openspec/specs/sat-catalog/spec.md`.

## SDD Cycle Complete

The change has been fully planned, proposed, specified, designed, broken into tasks, implemented across 4 work-unit commits (Slices A→D), verified PASS (1307/1307), and archived. Ready for the next change.