# Apply Progress — `quotation-product-iva` (WU1)

Artifact store: openspec. This file is cumulative; WU1 (T1.1–T1.4) only.
Execution mode: task-local strict RED→GREEN per T1.1/T1.4 (global apply TDD is `false` per `openspec/config.yaml`, but those tasks explicitly require observed RED before GREEN).

## Completed tasks (persisted checkbox status in `tasks.md`)

- [x] **T1.1** — RED domain specs for snapshot invariants and rounding.
- [x] **T1.2** — GREEN domain tax types + entity snapshot behavior.
- [x] **T1.3** — Migration: additive nullable snapshot columns.
- [x] **T1.4** — Repository mapping + integration round-trip (RED → GREEN).

## TDD Cycle Evidence

| Cycle | Task | RED (observed)                                                                                                                                                                          | GREEN (observed)                                                        |
| ----- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1     | T1.1 | `pnpm test src/quotations/domain` → **31 failed / 92 passed** (2 suites), missing-API errors (`snapshotTaxClassification is not a function`, etc.). No production code changed.         | — (RED is the deliverable)                                              |
| 2     | T1.2 | —                                                                                                                                                                                       | `pnpm test src/quotations/domain` → **123 passed / 123 total**          |
| 3     | T1.4 | `pnpm test:integration src/quotations/infrastructure/prisma-quotation.repository.integration.spec.ts` → **3 failed / 17 passed** (round-trip nulls because mapping not yet implemented) | `pnpm test:integration …integration.spec.ts` → **20 passed / 20 total** |

Intermediate run: after T1.2 GREEN, one spec-math fix round (fixture `quantity: 1`; `chargeProductTaxes=false` base = full inclusive amount) → final 123/123.

## Files changed (vs `main` HEAD `d12ad8f`)

| File                                                                             | Change                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                                           | +7 — three nullable `QuotationItem` snapshot columns (no default/index/data change)                                                                                                                           |
| `prisma/migrations/20260915210500_add_quotation_item_tax_snapshot/migration.sql` | NEW — 3 additive nullable `ADD COLUMN` statements only (comment documents no-backfill policy)                                                                                                                 |
| `src/quotations/domain/quotation-tax.types.ts`                                   | NEW — classification enum (5 values), rate union, bucket order, integer percent map, wire entry type                                                                                                          |
| `src/quotations/domain/quotation-item.entity.ts`                                 | +148/-2 — snapshot props/ctor, getters, `snapshotTaxClassification`, `recomputeTaxableBase`                                                                                                                   |
| `src/quotations/domain/quotation-item.entity.spec.ts`                            | +215 — snapshot completeness, base/amount math, rounding, re-derivation, CUSTOM retention                                                                                                                     |
| `src/quotations/domain/quotation.entity.ts`                                      | +83/-8 — `computeIvaBreakdown()`, `toResponse` breakdown + response-field removal, `setDeprecatedTaxRate`, `_taxRate`/notes carried through `send`/`cancel`, promotion props optional                         |
| `src/quotations/domain/quotation.entity.spec.ts`                                 | +427/-50 — represented-only buckets, zero-tax distinctness, all-or-nothing, invariants, send/cancel preservation (−50 incl. ~48 lines of formatting-only normalization of pre-existing lines, see Deviations) |
| `src/quotations/infrastructure/prisma-quotation.repository.ts`                   | +15/-1 — three snapshot fields in `createMany` + `toDomain`; root `taxRate` mapping unchanged                                                                                                                 |
| `src/quotations/infrastructure/prisma-quotation.repository.integration.spec.ts`  | +200/-3 — 4 round-trip tests + helper (−3: unused-import removal, CLS-shim cast fix, await fix)                                                                                                               |
| `openspec/changes/quotation-product-iva/tasks.md`                                | T1.1–T1.4 checkboxes `[x]`                                                                                                                                                                                    |

**Changed lines: 1,157 (1,095 additions / 62 deletions).** Of these, ~350–400 lines are formatting-only normalization of pre-existing lines in the two domain spec files plus the intentional removals of two unused declarations and one unused import (details below). Authored WU1 semantics ≈ 800–850 lines.

## Test commands run (exact)

- Baseline: `pnpm test src/quotations/domain` → 92 passed. `pnpm test:integration …integration.spec.ts` → 16 passed. `pnpm build` → clean.
- T1.1 RED: `pnpm test src/quotations/domain` → 31 failed / 92 passed.
- T1.2 GREEN: `pnpm test src/quotations/domain` → 123 passed.
- T1.4 RED: `pnpm test:integration …integration.spec.ts` → 3 failed / 17 passed.
- T1.4 GREEN: `pnpm test:integration …integration.spec.ts` → 20 passed / 20 total.
- Focused regression: `pnpm test src/quotations` → 229 passed / 229 total.
- `pnpm build` → **FAILS with exactly 2 errors** (see Blocker).
- Migration verification: migration was applied to the disposable test DB (`nest-practice-test`, port 5433) by the project's own integration harness (`test/integration/setup/global-setup.ts` runs `prisma migrate deploy` as part of every `pnpm test:integration` run). The dev DB (port 5432) was never touched; no migration was run manually against any non-test database.

## Blocker (precise) — why `pnpm build` was RED (RESOLVED — see Continuation section)

`pnpm build` fails with exactly 2 TS2352 errors, both `as QuotationResponseDto` casts in
`src/quotations/application/quotations.service.ts` (lines 901 and 1378):

- TS2352: the spread literal now lacks `taxRate`/`taxCents` (removed from the wire by T1.2, per
  task text) while `QuotationResponseDto` (interface in `src/quotations/dto/quotation-response.dto.ts`,
  lines `taxRate: number; taxCents: number;`) still requires them AND lacks `ivaBreakdown`
  (added to the wire by T1.2) — so neither cast direction is assignable.
- **Root cause:** T1.2's mandated response-contract change has a hard compile-time dependency on the
  WU2-owned DTO interface. The DTO file is outside WU1's allowed edit surfaces, and the parent
  prompt forbids implementing WU2 tasks. Removing the two interface fields + adding `ivaBreakdown`
  (≈4 lines, no validators — T2.3 stays untouched) unblocks the build.
- Evidence: `npx tsc --noEmit -p tsconfig.build.json` reports ONLY these 2 errors; all
  `src/quotations/**` test code passes.

WU1 therefore ended with all four tasks implemented and all focused test suites green, with the
build blocked solely on this cross-work-unit compile dependency. **Resolved by the
maintainer-authorized DTO compile seam below.**

## Review-budget risk (400 changed lines)

- Native attempt budget: 400 changed lines (`max_changed_lines_source: explicit`).
- Actual diff: **1,157 changed lines** (1,095+/62−), of which ~350–400 are formatting-only
  normalization of pre-existing lines (see Deviations) and ~65 lines are new-file headers/comments
  in the migration + types module. Authored semantic WU1 code ≈ **800–850 lines**.
- The cohesive WU1 (T1.1–T1.4, ~560 lines of which are co-located tests that T1.1/T1.4 require)
  cannot land under 400 without omitting mandated tests. **No cohesive split below the budget
  exists** (domain T1.1+T1.2 alone is ~750). Per contract this is reported honestly:
  recommend either a maintainer `size:exception` OR splitting the task-local test surface into a
  second stacked PR. No size:exception was authorized, so this run stops before verify with the
  overage reported rather than silently shrinking scope.

## Deviations from design / task text

1. **`setDeprecatedTaxRate` rename + temporary alias.** T1.2 says "rename the domain mutation",
   but `QuotationsService.setTaxRate` (WU2 surface) still calls `quotation.setTaxRate(rate)`;
   a hard rename would break `pnpm build` with the service file outside WU1's allowed edit
   surfaces. Implemented: `setDeprecatedTaxRate(rate)` (full invariant + guard) plus a one-line
   `setTaxRate` alias delegating to it, documented in-code for WU2 to remove when the service
   call site is updated.
2. **Formatting-only normalization of pre-existing lines.** The ambient eslint/prettier checker
   (pi-lens) re-applies the repo's own canonical formatting on every file save. Pre-existing
   lines in `quotation.entity.spec.ts` (~48 lines) and smaller spots elsewhere were reformatted
   by that tool. Verified: `prettier --check` on the HEAD version of the file already fails, so
   this normalizes pre-existing lint debt rather than introducing drift. Reviewers can hide
   formatting-only hunks; no pre-existing test semantics were altered (all 92 baseline domain
   tests + 16 baseline integration tests still pass).
3. **Pre-existing lint debt cleaned in touched files** (3 one-line removals): unused
   `QuotationItem` import + unused `TENANT` const in `quotation.entity.spec.ts` (both unused at
   HEAD), unused `QuotationItem` import in the integration spec (unused at HEAD). Plus
   `vetoedPromotionIds`/`optedInManualPromotionIds` made optional in `QuotationFromPersistenceProps`
   (they were typed required but hand-built fixtures and older rows omit them; `fromPersistence`
   already defaulted both to empty arrays — resolves 12 pre-existing type errors surfaced by
   strict analysis of the spec file).
4. **Integration test infrastructure only** (untracked, gitignored): created local `.env` from the
   committed `.env.example` and `.env.test` from `.env.test.example` — required for Prisma CLI /
   integration harness env resolution. No tracked file affected.
5. **Attempt-scope note:** the literal check `pnpm test
src/quotations/infrastructure/prisma-quotation.repository.integration.spec.ts` returns
   "0 matches" by design of `jest.config.js` (unit config excludes `*.integration.spec.ts`); the
   project's designed runner for that spec is `pnpm test:integration` (same file, + `runInBand` +
   env/globalSetup chain), which is what was executed for all integration evidence.

## Tooling false positives encountered (with disproving evidence)

1. `schema.prisma` P1012 (`DATABASE_URL not found`) from the checker's Prisma subprocess: the
   datasource line is unchanged from HEAD; local `npx prisma validate` passes (repeatedly) and
   `prisma generate` succeeded. The checker's env does not load the repo's gitignored `./.env`.
2. `@prisma/client has no exported member 'Prisma'/'PrismaClient'` from the checker's LSP:
   disproved by runtime (`require('@prisma/client')` exports both) and by `tsc -p tsconfig.build.json`
   (zero errors from the repository file). Root cause was the pnpm layout lacking a top-level
   `node_modules/.prisma`; adding that symlink resolved the chain (`@prisma/client →
.prisma/client/default → generated namespace`).

## Remaining tasks

- WU2: T2.1–T2.4 (`- [ ]` at tasks.md lines 67, 74, 81, 88).
- WU3: T3.1–T3.3 (`- [ ]` at tasks.md lines 101, 108, 115).
- Unblocked-by-parent action: add `src/quotations/dto/quotation-response.dto.ts` to WU1's allowed
  edit surfaces (4-line interface change) OR fold that change into T2.3 and re-run `pnpm build`.

## Workload / PR boundary

- PR 1 = WU1 (this slice). Chain strategy `stacked-to-main` (PR2 on PR1; retarget after merge).
- Rollback boundary intact: revert WU1 commits; nullable columns may remain (old code ignores them).
- No commit/push/PR created. No migrations run against any database by this phase (the test-DB
  migrate deploy is the integration harness's own standard globalSetup).

---

## Continuation — WU1 compile seam (maintainer-authorized, 2nd session)

The maintainer authorized ONE cross-WU compile seam: minimally update
`src/quotations/dto/quotation-response.dto.ts` so the structural response type matches the
already-required WU1 `Quotation.toResponse()` shape. Constraints honored exactly:

- Only `taxRate`/`taxCents` requirements removed and the typed `ivaBreakdown` field added.
  The interface was NOT converted to a class; NO decorators added; NO DTO tests added;
  T2.3 remains unchecked (`- [ ]`).
- No WU2/WU3 production behavior changed; no other file touched.
- Allowed edit surfaces honored: only `src/quotations/dto/quotation-response.dto.ts` and
  this apply-progress file.

### Seam diff (exact)

- `+import type { QuotationIvaBreakdownEntry } from '../domain/quotation-tax.types';`
- `-  taxRate: number;` / `-  taxCents: number;` → `+ivaBreakdown: QuotationIvaBreakdownEntry[];`
  (with a 4-line doc comment noting T2.3 will add validation later)
- Formatting-only (pre-existing lint debt, prettier canonicalization of an untouched line):
  `customer: { ... }` one-liner split into a multi-line object literal. No semantics changed.

Total seam diff: **14 changed lines (11 additions / 3 deletions)**; of these, 5 additions
are the formatting-only customer split. **Full WU1 diff including the seam:
1,171 changed lines (1,106 additions / 65 deletions)** — still far over the 400-line review
budget; no `size:exception` authorized; delivery remains blocked pending a later re-slicing
decision. No code-golfing performed.

### Re-run verification (exact observed results)

| Command                                                                                               | Result                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm test src/quotations/domain`                                                                     | **123 passed / 123 total** (2 suites)                     |
| `pnpm test:integration src/quotations/infrastructure/prisma-quotation.repository.integration.spec.ts` | **20 passed / 20 total** (1 suite)                        |
| `pnpm test src/quotations`                                                                            | **229 passed / 229 total** (5 suites)                     |
| `pnpm build` (`nest build`)                                                                           | **clean — zero TypeScript errors** (previously 2× TS2352) |

### Task status confirmation

- T1.1, T1.2, T1.3, T1.4 remain `[x]` in `tasks.md` (re-read after verification).
- All seven WU2/WU3 tasks (T2.1–T2.4, T3.1–T3.3) remain `[ ]` — untouched.

### Delivery status

- WU1 implementation + verification is COMPLETE (build + focused suites green).
- Delivery (commit/PR/chain) remains BLOCKED: total WU1 diff exceeds the 400-line review
  budget and no `size:exception` was authorized. A later maintainer re-slicing decision
  (split the task-local test surface into a second stacked PR, or accept `size:exception`)
  is required before any PR is created.

### Native attempt settle (exact)

```text
gentle-ai sdd-attempt settle --token sha256:63a6415fb66d192cd493090a4dee426885b2975d179dcd13895a0a0638224d3a \
  --request-id "wu1-seam-settle-20260915-2216-01" --outcome passed \
  --evidence-revision sha256:553e32d2ae6548902bf2540ef85a78bdb9137b982a15fff688133a4ebc69597d \
  --harness-disposition reused --untracked-scope select \
  --expected-untracked-inventory sha256:dab4b728a28850e0c04a8433b7617ee49085ae3f9eb28cea1ebea001fbff9a81
```

- Evidence-revision derivation (documented): `sha256` over the candidate snapshot tree
  `54f0e637b25a67be9d7faa5ec3f2fdf6c5553112` — a temp-index git snapshot of the exact
  verified worktree state (`git read-tree HEAD^{tree}` + all tracked modifications + the
  intended untracked files), taken immediately after the final verification pass.
- Result: harness returned `state: complete` — the WU1 runtime objective is terminal.
  Attempt ordinal 2 closed as `passed`; no reset or rescope performed.

---

## Continuation — native review correction `R3-incomplete-snapshot-pipeline` (3rd session)

Native review lineage `review-7e0fda032df4cbe6`, CRITICAL finding
`R3-incomplete-snapshot-pipeline` (`src/quotations/domain/quotation.entity.ts:677`):
the candidate activated the new wire contract before its snapshot producer exists —
`toResponse()` removed legacy `taxRate`/`taxCents` and emitted an all-or-nothing
empty `ivaBreakdown` while add-item calls cannot yet populate snapshots (WU2/T2.2).

### Correction applied (response-compatibility route — no WU2 behavior)

1. `src/quotations/domain/quotation.entity.ts` — `toResponse()` restored to the
   legacy wire contract (emits `taxRate` and informational `taxCents` again);
   `ivaBreakdown` removed from the wire; `computeIvaBreakdown()` retained verbatim
   as an internal domain capability.
2. `src/quotations/dto/quotation-response.dto.ts` — temporary compile seam REVERTED:
   `taxRate: number; taxCents: number;` back, `ivaBreakdown` + its import removed;
   public interface matches the retained WU1 response again.
3. `src/quotations/domain/quotation.entity.spec.ts` — response-contract test FLIPPED
   (not deleted): pins `taxRate`/`taxCents` present, `ivaBreakdown` absent on the
   wire, `computeIvaBreakdown()` still working internally; other tests unchanged.
4. `tasks.md` — T1.1/T1.2 no longer claim public response activation in WU1; T2.3
   now owns activating `ivaBreakdown` + removing legacy response fields alongside
   the T2.2 producer pipeline and runtime DTO validation.
5. No WU2/WU3 behavior implemented; all seven WU2/WU3 tasks remain `[ ]`.

### Correction verification (exact observed results)

| Command                                                                                               | Result                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `pnpm test src/quotations/domain`                                                                     | **123 passed / 123 total** (2 suites)      |
| `pnpm test:integration src/quotations/infrastructure/prisma-quotation.repository.integration.spec.ts` | **20 passed / 20 total** (1 suite, exit 0) |
| `pnpm test src/quotations`                                                                            | **229 passed / 229 total** (5 suites)      |
| `pnpm build` (`nest build`)                                                                           | **clean — zero TypeScript errors**         |
| `npx eslint` on the three touched source files                                                        | **0 problems**                             |

### Correction diff budget & delivery status

Correction diff: **≤120 changed lines** (entity 14, DTO 13, spec 37, tasks.md 10,
this section 40). No code-golfing: no test or comment deleted to fit. WU1 stays
implementation- and verification-complete; the full WU1 diff remains **over the
400-line review budget**, **no `size:exception` authorized** — delivery stays
blocked pending a maintainer re-slicing decision. No commit/push/PR/sync/archive;
no migration against any non-test DB; `protect-confirmed-sales`, WU2/WU3 untouched.

---

## Apply Progress — WU2 (Snapshot orchestration & response contract)

Artifact store: openspec. Cumulative WU1 (above) + WU2 (T2.1–T2.4, this section).
Worktree branch `feat/quotation-product-iva-wu2-snapshot-orchestration`, HEAD
`c90f3557951166a6e381f7457b58f22f335637ff`. Execution mode: task-local RED → GREEN
per T2.1/T2.2 and TRIANGULATE per T2.4 (global apply TDD is `false` per
`openspec/config.yaml`; those tasks explicitly mandate test-first evidence).
All tests run synchronously.

## Completed tasks (persisted checkbox status in `tasks.md`)

- [x] **T2.1** — product service tax metadata widening (RED → GREEN).
- [x] **T2.2** — addItem snapshot + DRAFT reprice resnapshot (RED → GREEN).
- [x] **T2.3** — DTO: validated `ivaBreakdown[]` contract (wire activation).
- [x] **T2.4** — TRIANGULATE: aggregate invariant and legacy isolation.

WU1 history (T1.1–T1.4 `[x]`) preserved above, untouched.

## TDD Cycle Evidence (observed, synchronous runs)

| Cycle | Task | RED (observed)                                                                                                                                                                                                                                                                                                                                                                                      | GREEN (observed)                                                                                                               |
| ----- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1     | T2.1 | `pnpm test src/products/products.service-pos-helpers.spec.ts` → **3 failed / 27 passed** (missing `ivaRate`/`chargeProductTaxes` on the response; TS "property does not exist" errors were the missing-API signal). No production code changed yet.                                                                                                                                                 | `pnpm test src/products` → **482 passed / 482 total (22 suites)**; pos-helpers spec alone **30/30**.                           |
| 2     | T2.2 | `pnpm test src/quotations/application/quotations.service.spec.ts` → **6 failed / 64 passed**: addItem snapshots, variant inheritance, PRICE_LIST resnapshot+base, dedup, CUSTOM base re-derive, SENT-read guard (this one initially failed on a test-side fixture bug — `mock.results[0].value` is a Promise for async mocks — fixed in-test BEFORE any production change so the RED stays honest). | Same spec → **70/70**, then the four-dir focused run → **696/696**.                                                            |
| 3     | T2.3 | — (wire activation shipped as one deployable boundary with the T2.2 producer; entity-spec legacy-wire test flipped, not deleted).                                                                                                                                                                                                                                                                   | dto spec (new, untracked) **11/11**; domain+application+dto → **193/193**; four-dir focused → **709/709**; `pnpm build` clean. |
| 4     | T2.4 | — (TRIANGULATE phase; cases added on top of green).                                                                                                                                                                                                                                                                                                                                                 | four-dir focused → **714/714 (27 suites)**; `pnpm build` clean; `git diff --check` clean.                                      |

## Files changed (vs HEAD `c90f3557`; tracked numstat, excludes the new untracked spec)

| File                                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/products/products.service.ts`                      | +17/-0 — `getProductInfoForSale` returns `{ ivaRate, chargeProductTaxes }` from BOTH branches, sourced from the already-loaded parent `product` (variant rows never queried for tax).                                                                                                                                                                                                                  |
| `src/products/products.service-pos-helpers.spec.ts`     | +83/-4 — 3 new T2.1 tax-pair tests; 2 pre-existing exact-match `toEqual` fixtures extended with the widened fields (forced by the additive widening; assertions unchanged); removed pre-existing unused `MapType` + unused `Product` import (WU1 precedent).                                                                                                                                           |
| `src/quotations/application/quotations.service.ts`      | +131/-13 — addItem snapshots the pair via item props and seeds the request-local `(productId, variantId)` metadata cache; recompute step (2b) resnapshots ONLY lines that received a resolved price (dedup via cache); step (7) re-derives `taxableBaseCents` for every non-null-pair line after promotions; `setTaxRate` adapter now calls `setDeprecatedTaxRate` (WU1-authorized alias dropped).     |
| `src/quotations/domain/quotation.entity.ts`             | +21/-30 — `toResponse()` emits `ivaBreakdown: computeIvaBreakdown()` and REMOVES legacy `taxRate`/`taxCents` (T2.3 activation, same deployable unit as T2.2 producer); `vetoedPromotionIds`/`optedInManualPromotionIds` made optional in `QuotationFromPersistenceProps` (WU1-documented fixture tolerance); removed the `setTaxRate` alias + pre-existing unused `BusinessRuleViolationError` import. |
| `src/quotations/dto/quotation-response.dto.ts`          | +42/-8 — converted to class; `QuotationIvaBreakdownEntryDto` (`@IsEnum(QUOTATION_IVA_CLASSIFICATIONS)`, `@IsInt() @Min(0)`); `ivaBreakdown` with `@IsArray() @ValidateNested({each:true}) @Type(...)`; legacy `taxRate`/`taxCents` removed. `set-tax-rate.dto.ts` untouched.                                                                                                                           |
| `src/quotations/domain/quotation.entity.spec.ts`        | +282/-61 — WU1 legacy-wire test flipped to pin the activated wire (not deleted); 2 T2.4 triangulation tests (mixed-discount invariant 1440+741+0 = 21340−19159; root-rate 0.42 moves no total).                                                                                                                                                                                                        |
| `src/quotations/application/quotations.service.spec.ts` | +506/-2 — 8 T2.2 orchestration tests, 2 T2.3 externally observable wire tests, 3 T2.4 isolation/invariant tests; 2 pre-existing addItem mocks extended with the required tax pair.                                                                                                                                                                                                                     |
| `src/quotations/dto/quotation-response.dto.spec.ts`     | NEW (untracked) — 185 lines, 11 tests: closed 5-value enum, fractional/negative/non-integer amounts, non-array, nested-poison via ValidateNested, represented-only arrays incl. zero buckets.                                                                                                                                                                                                          |
| `openspec/changes/quotation-product-iva/tasks.md`       | T2.1–T2.4 checkboxes `[x]` (WU1 checkboxes untouched).                                                                                                                                                                                                                                                                                                                                                 |

**Tracked diff: 1,200 changed lines (1,082 additions / 118 deletions); whitespace-ignoring 1,184 (≈16 lines formatting-only pi-lens canonicalization).** Plus the new untracked DTO spec: **185 lines. Total ≈ 1,385.**

## Test commands run (exact, all synchronous)

| Command                                                                                                             | Result                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Baseline `pnpm test src/products/products.service-pos-helpers.spec.ts src/quotations/application`                   | 89 passed / 89 total (2 suites)                                                 |
| Baseline `pnpm test src/quotations/domain`                                                                          | 123 passed / 123 total                                                          |
| Baseline `pnpm build`                                                                                               | clean (exit 0)                                                                  |
| T2.1 RED `pnpm test src/products/products.service-pos-helpers.spec.ts`                                              | **3 failed / 27 passed**                                                        |
| T2.1 GREEN `pnpm test src/products`                                                                                 | **482 passed / 482 total (22 suites)**                                          |
| T2.2 RED `pnpm test src/quotations/application/quotations.service.spec.ts`                                          | **6 failed / 64 passed**                                                        |
| T2.2 GREEN same spec                                                                                                | **70/70**; four-dir focused → **696/696**                                       |
| T2.3 `pnpm test src/quotations/dto/quotation-response.dto.spec.ts`                                                  | **11/11**; domain+application+dto → **193/193**; four-dir focused → **709/709** |
| T2.3 `pnpm build`                                                                                                   | clean (exit 0)                                                                  |
| T2.4 final `pnpm test src/products src/quotations/application src/quotations/dto src/quotations/domain --runInBand` | **714 passed / 714 total (27 suites)** — re-run twice, identical                |
| Final `pnpm build`                                                                                                  | **clean (exit 0)**                                                              |
| Final `git diff --check`                                                                                            | **clean (exit 0)**                                                              |

## Runtime behavior + rollback boundary

- **Runtime harness:** N/A beyond the service-level wire tests — no HTTP server/DB runtime boundary exists in this slice; the designed runner is the co-located Jest unit harness (`jest.config.js` unit config). No integration spec was required by T2.1–T2.4 (repository round-trip is WU1's T1.4, still green). No API deployment, DB migration, or network service was run; the dev DB (port 5432) untouched; disposable test DB only used by the integration harness standard globalSetup in WU1 (not this session).
- **Runtime behavior now observable:** `POST /quotations/drafts/:id/items` snapshots the parent-product pair (variants inherit) and derives the post-promotion base; every DRAFT reprice resnapshots only lines that received a resolved price; `GET /quotations/:id` (+ all read paths) return `ivaBreakdown[]` and no longer carry `taxRate`/`taxCents`; incomplete snapshots yield `[]`; the deprecated PATCH persists only the root column and provably leaves the next breakdown/PDF input byte-identical.
- **Rollback boundary:** revert the 7 tracked WU2 files + delete the untracked DTO spec; WU1's nullable columns remain ignored by the reverted code; `taxRate`/`taxCents` return to the response; `ivaBreakdown` disappears. No schema/migration dependency.

## Deviations from task/design text

1. **Pre-existing exact-match fixtures extended (products spec ×2, quotations spec ×2).** The additive widening + snapshotting force the two `toEqual` product fixtures and the two `addItem` mock fixtures to carry `ivaRate`/`chargeProductTaxes`. Assertions were NOT weakened or restyled — fields added verbatim. The T2.1 acceptance's "pass unmodified except for the new assertions" is unachievable against exact-match `toEqual` assertions; this is the minimal forced change, disclosed here.
2. **Entity `QuotationFromPersistenceProps` veto/opt-in props made optional.** Restores WU1's documented fixture tolerance (10 pre-existing type errors in the entity spec verified at HEAD via `git stash`).
3. **WU1 alias cleanup completed here** (authorized in WU1's deviation #1): service call site switched to `setDeprecatedTaxRate`; the temporary entity alias `setTaxRate` dropped. Behavior identical.
4. **Pre-existing unused declarations removed in touched files** (WU1 precedent): `MapType` + unused `Product` import (products spec), unused `BusinessRuleViolationError` import (entity). All verified unused at HEAD.
5. **Pre-existing lint debt NOT mass-fixed (documented, not widened):** `products.service-pos-helpers.spec.ts` carries 90 eslint messages at HEAD (stash-verified); my 3 new tests trigger +13 more through the file's pre-existing untyped mock harness (same pattern as all 27 pre-existing tests). `quotations.service.spec.ts` carries pre-existing TS errors at HEAD (L144/L592–593 equivalents: `makeMailer` cast, `findAll` scalar-vs-array fixtures) — left untouched because "fixing" the `findAll` fixtures would change pre-existing test semantics. Per the no-restyle/no-minify contract, mass-fixing 100+ pre-existing lint errors was rejected: it would explode the review diff and alter pre-existing code.
6. **One transient GREEN-time fixture error:** the reprice resnapshot test initially used map key `prod-1:::pl-1` (3 colons) while the service builds `prod-1::::pl-1` (empty variant slot); fixed in-test before declaring T2.2 green. RED evidence unaffected.

## Remaining tasks

- WU3: T3.1–T3.3 (`- [ ]` at tasks.md lines 101, 108, 115) — conditional PDF aggregate + `Deprecation: true` header + full-slice verification. Out of scope for this launch.

## Workload / PR boundary + bounded slicing proposal (one honest pass)

- Chain strategy remains `stacked-to-main` (PR 2 on PR 1); **no commit, staging, push, or PR was created** — implementation only per the launch authorization.
- **Authored WU2 size: 1,385 changed lines** (1,082+/118− tracked + 185-line new untracked spec; ≈16 lines of the tracked delta are formatting-only pi-lens canonicalization).
- One-pass cohesive slicing (in dependency order):
  1. **Slice A = T2.1** (`products.service.ts` + `products.service-pos-helpers.spec.ts`): **104 changed lines** — independently reviewable and clean-revertable (verified green standalone: 482/482).
  2. **Slice B = T2.2 + T2.3 producer→wire boundary** (`quotations.service.ts`, `quotation.entity.ts`, `quotation-response.dto.ts`, new DTO spec, the T2.2/T2.3 test blocks, the entity-spec flip): **≈ 790 changed lines**. This is the task-mandated single deployable boundary (T2.3 text: wire activates "only once its snapshot producer pipeline (T2.2) can populate it") and it cannot shrink: T2.2's ~260-line test block is the task-mandated RED/GREEN evidence for the recompute order/cache-key contract. **Over the 400-line budget; no cohesive split exists below it.**
  3. **Slice C = T2.4 triangulation** (~290 lines across the two spec files): fits under 400 on top of B.
- **Per contract, no `size:exception` was authorized and none is silently applied.** Recommendation: accept a maintainer `size:exception` for Slice B, OR split Slice B's co-located test surface into a second stacked PR (task text requires the tests as T2.2 evidence; splitting them out of the producer/wire PR weakens the review-unit story, so the exception is the cleaner option).

## Native attempt (exact)

- Acquire: request-id `wu2-apply-20260916-01`, work-unit `WU2 Snapshot orchestration & response contract`, evidence goal "Implement T2.1-T2.4: product tax metadata widening, request-local snapshot/recompute pipeline, wire activation of ivaBreakdown with DTO validation, triangulation invariants", max-attempts 2, max-changed-lines 400 → state **proceed**, token `sha256:06f4ef2065e7e91e55870700189a07ec3fe157f21fba8c44baeb18c78af07591`.
- Budget: the attempt was bounded at the canonical 400 changed lines; the run honestly exceeds it (see slicing proposal) — `changed_line_budget_exceeded` is expected to be recorded by settle.
- Settle (observed, exact): request-id `wu2-settle-20260916-01`, outcome `passed`, evidence-revision `sha256:d5d8dddc073fce66c87d196354284db8a3595eb01d03d6680e5d3dfb591eb0c6` (sha256 over candidate snapshot tree `b1baae9461c1508dd989bbd61a28964d7e3d91fe`, derivation convention verified against WU1's recorded pair), untracked inventory `sha256:10e925dfd20438c0c4d61dc08abc67673648f429913fe040c733642caff94975` (7 intended files). **Harness returned `state: blocked` / `maintainer_decision`** — the 400-line attempt budget was honestly exceeded (authored ≈1,385; harness cumulative 1,478 across the live objective), so closing the attempt requires a maintainer decision. The WU2 runtime attempt remains live/unclosed; a maintainer may `gentle-ai sdd-attempt reset` (current revision `sha256:fb5b2d7de3ea9342722cfc02a1ce9b1104bb434c9c3d11417ade67ec33e14c15`) after a scope decision, or accept the overage. No reset was performed by this phase — reset requires an explicit maintainer scope decision.

---

## Correction — WU2 bounded correction pass (user-authorized; 4th session)

Scope: ONLY the user-authorized bounded WU2 correction plan (new correction task,
not replay of initial WU2 implementation). One native objective reset was executed
by the PARENT (actor aldrich; reset revision
`sha256:2e90e1ba3d8260085c4fdb19d713d8c895a7bce43b8824f64ac857180eb7d252`).
No `sdd-attempt` acquire/settle/finish/reset/rescope/supersede/repair/repair
command was run by this phase; no attempt budget was consumed. No commit, stage,
branch, push, PR, or merge; no migration/install/server/config change. Branch
`feat/quotation-product-iva-wu2-snapshot-orchestration`, HEAD
`c90f3557951166a6e381f7457b58f22f335637ff`. Audited pre-correction baseline:
`/tmp/quotation-wu2-correction-baseline-nnocyxhi/files/` (+`manifest.json`),
read-only; backup never modified.

### Prior fact reconciliation (outdated claims annotated, history preserved)

- The prior WU2 section's "1,385 changed lines" claim is STALE. Exact audited
  baseline: **1,372 source changed lines + 106 runtime artifacts = 1,478 total**
  (per the parent's audited backup accounting). Historic sections below are kept
  verbatim; treat their numbers as outdated. CORRECTION-2 note: the fresh-baseline
  audit supersedes this figure — the candidate immediately before the second
  correction unit measures **1,452 source lines vs HEAD = 1,267 tracked +
  185-line untracked DTO spec** (not 1,453, not 1,372). Persisted tasks stayed
  **8/11 throughout** (T2.2 was only temporarily unchecked during the fix, then
  rechecked after observed green).
- The prior "WU2 runtime attempt remains live/unclosed" claim is OUTDATED: the
  parent completed ONE explicitly authorized native objective reset (actor
  aldrich); there is **no active legacy attempt** and fresh native status routes
  `nextRecommended: apply` with `blockedReasons: []`, 8/11 tasks persisted.
- T2.2 was REOPENED (`[ ]`) before any fix and RECHECKED (`[x]`) only after
  actual acceptance green (RED observed → GREEN 77/77). T2.1/T2.3/T2.4 remain
  `[x]`; WU3 (T3.1–T3.3) remains `[ ]` (3 unchecked) — user authorized ONLY the
  correction, NOT the unchecked WU3 tasks.

### Corrections applied

1. **Cache bug (RED→GREEN, task-specific TDD observed).** `recomputePricingAndPromotions`
   previously ran its resnapshot step with an OPTIONAL cache (`cache?.get/set`),
   so every non-addItem mutation (e.g. `updateItemQuantity`) performed one
   metadata lookup PER repriced line (no dedup) and nothing cached at all.
   Fixed: per-invocation FRESH default `Map<string, ProductTaxMetadata>` inside
   `recomputePricingAndPromotions` (no service field / module cache); helper
   `getProductTaxMetadata` now REQUIRES the cache (plain get/set; no negative/
   null caching introduced); `addItem`'s fresh seeded map is preserved verbatim.
   - RED (observed): `pnpm test src/quotations/application/quotations.service.spec.ts --runInBand`
     → **1 failed / 76 passed** — the new dedup regression failed with
     **2 lookups instead of 1** (Expected 1, Received 2).
   - GREEN (observed): same spec → **77 passed / 77 total**.
2. **New RED regression via public surface** (`updateItemQuantity`): persisted
   DRAFT with two duplicate PRICE_LIST lines sharing `(productId, variantId)`
   and null snapshots; asserts exactly one deduplicated metadata lookup per
   recompute, complete persisted snapshots + re-derived bases (1724c/862c) and
   returned breakdown `{ IVA_16, 414 }`; second public mutation with CHANGED
   mocked metadata asserts exactly one NEW lookup (total 2) and refreshed
   classification IVA_8 with refreshed bases (1852c) and breakdown
   `{ IVA_8, 296 }` — proving no per-request cache leak. Valid `fromPersistence`
   fixtures; no private-method testing.
3. **Actual SENT/EXPIRED table coverage**: the prior SENT-only test was REPLACED
   (not deleted) by `it.each(['SENT','EXPIRED'])` asserting no product lookup,
   no `batchResolvePriceMap` call, stored snapshots unchanged, and the wire
   response carrying the STORED-snapshot breakdown (`IVA_16`/138c, not the
   admin's current IVA_8).
4. **Stray `n` comment debris removed** (service `getProductTaxMetadata`
   docstring and DTO `QuotationIvaBreakdownEntryDto` docstring).
5. **Audited 264-line normalization reversal (step 6).** Applied to HEAD style
   three times; the SEMANTIC reversals persist in the final candidate, the
   pure formatting-only hunks were re-canonicalized by the ambient pi-lens
   autofix hook on every save (documented AUTOFIX HAZARD; PREVIOUS ATTRIBUTION
   UNCONFIRMED — that cause was asserted without observed tool evidence;
   Correction-2 below records the first directly observed instance):
   - SURVIVED (semantic reversals): entity import restoration
     (`BusinessRuleViolationError` back, unused at HEAD — disclosed),
     promotion-array props restored to REQUIRED (the optionality loosening
     undone), products-spec unused `Product` import + `MapType` restoration
     (both unused at HEAD — the audited cleanup hunks reversed per step 6),
     wire/T2.3 activation, alias removal, DTO class+decorators all kept.
   - REVERTED BY AMBIENT TOOLING (formatting-only, 3 attempts each): entity-spec
     212 format lines, service blank-line + 2 signatures (9), service-spec
     `user.findUnique` (5), DTO customer property (7), entity
     optOutManualPromotion/subtotal-reduce/`byPromo` Map (~7). The final
     candidate retains the repo's own canonical formatting for these lines —
     identical to the audited baseline (NO new drift introduced; they are
     unchanged rather than reversed). No suppression/config change used; the
     conflict is disclosed per the one-honest-pass contract.
6. **No other behavior**: negative/null caching NOT introduced; addItem wiring,
   recompute order, DTO validation, deprecated-PATCH isolation unchanged.

### Test commands run (exact, synchronous)

| Command                                                                                                  | Result                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm test src/quotations/application/quotations.service.spec.ts --runInBand` (RED, before fix)          | **1 failed / 76 passed** (dedup: Expected 1 call, Received 2)                                   |
| same (GREEN, after fix)                                                                                  | **77 passed / 77 total**                                                                        |
| `pnpm test src/products src/quotations/application src/quotations/dto src/quotations/domain --runInBand` | **716 passed / 716 total (27 suites)** (baseline 714 − 1 replaced SENT-only test + 3 new tests) |
| `pnpm build`                                                                                             | **clean (exit 0)**                                                                              |
| `git diff --check`                                                                                       | **clean (exit 0)**                                                                              |
| `pnpm exec eslint <7 allowed files>` (NO --fix)                                                          | baseline **315** problems → corrected **320** (+5 net, attributed below)                        |

### Lint attribution (exact, baseline vs corrected; baseline failures DISCLOSED, not claimed clean)

| File                                         | baseline | corrected | net    | cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | -------- | --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `products.service-pos-helpers.spec.ts`       | 93+8w    | 95+8w     | **+2** | the two RESTORED unused declarations (`Product`, `MapType`) — authorized step-6 reversals of the audited cleanup; the file's ~91 pre-existing `no-unsafe-*` mock-harness messages are unchanged (line-shifted +4). Rewriting the shared untyped harness (would clear ~90) is FORBIDDEN by this brief.                                                                                                                                                                                            |
| `quotations.service.ts`                      | 0        | 0         | 0      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `quotations.service.spec.ts`                 | 211+1w   | 213+1w    | **+2** | `require-await` on two mock callbacks in the NEW test surface — same pre-existing untyped-harness pattern as all pre-existing tests; fixing = forbidden harness rewrite.                                                                                                                                                                                                                                                                                                                         |
| `quotation.entity.ts`                        | 0        | 1         | **+1** | restored unused `BusinessRuleViolationError` import (authorized step-6 reversal).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `quotation.entity.spec.ts`                   | 2        | 2         | 0      | `QuotationItem` import + `TENANT` unused at HEAD (baseline, kept).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `quotation-response.dto.ts`                  | 0        | 0         | 0      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `quotation-response.dto.spec.ts` (untracked) | 0        | 0         | 0      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Total**                                    | **315**  | **320**   | **+5** | all +5 are authorized-restoration artifacts or new-test-harness-pattern echoes; **0 new code-path errors**. The +10 type diagnostics on entity-spec `fromPersistence` fixtures (missing `vetoedPromotionIds`/`optedInManualPromotionIds`) are the documented HEAD-baseline state restored by the required-props reversal (apply-progress deviation #2 originally recorded them at HEAD); NOT silently loosened (forbidden) and NOT silently broadened (would alter pre-existing test semantics). |

### Files changed (all within the eight allowed paths)

`src/quotations/application/quotations.service.ts` (cache fix, stray-n),
`src/quotations/application/quotations.service.spec.ts` (dedup regression +
SENT/EXPIRED table), `src/quotations/domain/quotation.entity.ts` (semantic
reversals + prop restoration), `src/quotations/domain/quotation.entity.spec.ts`
(HEAD + wire-flip + T2.4 reconstruction), `src/quotations/dto/quotation-response.dto.ts`
(stray-n), `src/products/products.service-pos-helpers.spec.ts` (Product/MapType
restorations), plus `tasks.md` + this file. `src/products/products.service.ts`
and the untracked DTO spec are UNTOUCHED from the audited baseline.

### Correction budget (A+D vs audited baseline, including docs)

Correction diff vs baseline (tracked): 7 src files + tasks.md + apply-progress.
Measured correction A+D (additions+deletions against the audited baseline):
**exactly 343 lines (206 source + 137 apply-progress/doc)** — CORRECTION-2
replaces the prior "≈ 331" estimate with this exact re-read figure; of that,
the attempted 264-line formatting-only reversal did NOT persist (see the
Correction-2 normalization evidence below), so the persisted correction is
predominantly the semantic correction + new tests. One honest scope check made;
no other file was needed; no size:exception authorized or applied. Whole WU2
candidate remains ~1,372 source lines vs HEAD (Producer+wire B744
stacked-to-main boundary unchanged); the 400-line budget constrains slicing,
never the code, and no comments/tests/blanks were deleted to fit.

### Remaining tasks

- WU3: T3.1–T3.3 (`- [ ]`) — OUT OF SCOPE for this correction (user authorized
  ONLY the WU2 correction; user files must remain within the eight allowed
  paths). Native fresh status: `applyState: ready`, `nextRecommended: apply`
  (8/11 persisted, `blockedReasons: []`) — WU3 remains the next unchecked work.

### Correction-2 — second bounded local correction unit (user-authorized, ≤400 A+D vs fresh baseline)

Baseline: `/tmp/quotation-wu2-cleanup2-baseline-sf9y58vq/files/` (1,128 files,
digest `0e0ab2d6…ca999` = sha256 over the sorted compact manifest JSON; verified
before edits: worktree byte-identical, 0 files differing). One read-only
`gentle-ai sdd-attempt status` before edits: next=apply, apply ready,
blockedReasons [], 8/11. No acquire/settle/reset/rescope; no commit/stage/
branch/push/PR/merge; no config change; no formatter executed by this phase.

**Normalization reversal (44 formatting-only hunks, 246 A+D vs HEAD): applied
as ONE pass and FAILED TO PERSIST — stopped on drift with observed evidence.**
Exact token-identical hunk reversal applied via Python/Git (entity-spec 36
hunks/212 lines, service 3/9, service-spec 1/5, entity 3/13, DTO customer
split 6 del + 1 add). Immediate post-write re-read: **0 formatting-only lines
vs HEAD on all five files** (reported by the correction-2 writer). That writer
reported a subsequent rewrite; retained evidence does not establish the actor
or mechanism. The reported re-read was **byte-identical to the
fresh baseline — 0 of the 246 normalization lines persist on disk**. Per the
one-pass / no-iteration / no-config-change protocol the normalization is
STOPPED here (not retried; no suppression). Semantic content was never
altered (tracked numstat vs HEAD unchanged at that checkpoint). The persisted
correction-1 semantic content (cache fix, 716-test suite, WU1/WU2 semantics,
three restored unused decls, HEAD lint debt) is untouched.

**NEW candidate lint fixed (no behavior change).** All 24 require-await
diagnostics in the NEW WU2 test surface converted to the audited prescribed
form (`findById: jest.fn((id) => Promise.resolve(...))`, `save:
jest.fn((q) => Promise.resolve(q))`; includes the pinned L1914/L1915 pair).
Products: the +6 unsafe-call / +7 unsafe-member-access diagnostics removed via
a narrow typed view (`const typedPrisma = () => prisma as { … jest.Mock … }` +
per-test `db` handles) scoped to the NEW T2.1 describe only; the shared
`makeMockPrisma` harness is untouched; no eslint-disable, no `any` casts, no
HEAD-debt cleanup, no new test semantics. Candidate-caused lint delta vs
HEAD is now **ZERO**: the one remaining +1 unbound-method was removed per
the maintainer gate by asserting on a named local `const save = jest.fn()`
handle (wired into `makeRepo`) instead of extracting `repo.save`'s method
reference in the new T2.2 non-DRAFT-add test — no cast, no suppression,
rejection/no-save semantics unchanged. Exact stdin/JSON rule comparison vs
HEAD: only delta is **prettier −1** (HEAD stdin-format debt, not
reintroduced); unbound-method **38 == HEAD** (max pre-existing line 1717),
require-await **112 == HEAD**. Rule-level parity: products 27 unsafe-call +
50 member-access == HEAD; service-spec 112 require-await == HEAD; the three
restored unused decls
(`Product`, `MapType`, `BusinessRuleViolationError`) preserved. `tasks.md`
untouched: persisted checkbox status stayed **8/11** throughout.

**Correction-2 verification (exact observed results)**

| Command                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test src/quotations/application --runInBand`                                                       | **77 passed / 77 total**                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test src/products src/quotations/application src/quotations/dto src/quotations/domain --runInBand` | **716 passed / 716 total (27 suites)**                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm build`                                                                                             | **clean (exit 0)**                                                                                                                                                                                                                                                                                                                                                                                |
| `git diff --check`                                                                                       | **clean (exit 0)**                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm exec eslint <7 allowed files> --format json` (NO --fix)                                            | **exit 1 (nonzero baseline debt expected, reported not clean)** — source parity vs HEAD(stdin): products spec 82E+8W == HEAD; service spec **189E+1W with rule-level parity (unbound-method 38, require-await 112 == HEAD; only delta prettier −1, HEAD stdin-format debt)**; service 0E; entity 1E (restored unused decl); entity-spec 2E (restored unused decls); DTO 0E; untracked DTO spec 0E |

**Correction-2 counts (exact re-read, source vs artifacts separately)**

- **Source** (`src/**`, A+D vs fresh baseline, exact disk re-read after the
  gatekeeper fix): `quotations.service.spec.ts` **+58/−26 (84)**,
  `products.service-pos-helpers.spec.ts` **+21/−7 (28)** →
  **112 A+D source** (tracked candidate vs HEAD now **1,313 A+D = 1,210+/103−**,
  plus the 185-line untracked DTO spec = **1,498 total source lines**;
  prior correction-1 figures 1,478/1,372 are pre-correction history, not
  mixed into these source counts).
- **Artifacts** (`openspec/**`): this section's annotations + this section
  (exact final re-read: **+88/−5 = 93 A+D**, including its own count
  correction); `tasks.md` byte-identical to baseline (persisted 8/11).
  **Gatekeeper unit total: 112 source + 93 artifacts = 205 A+D vs fresh
  baseline (limit 400).**
- Whole-candidate WU2 producer+wire boundary remains NOT deployable as a
  single ≤400-line PR; no reslicing, no size:exception. Remaining unchecked
  work is WU3 (T3.1–T3.3) — explicitly OUT OF SCOPE for both correction
  units.

---

## Cleanup-3 — stopped after two failed executor gates

Authorized scope: five quotation source files and this evidence file; at most
320 Git A+D against `/tmp/quotation-wu2-cleanup3-baseline-r5aq4v3y/files/`,
including at most 74 evidence A+D. Correction-2 remains recorded as 205/400.

The executor made no source edits. Parent compared all 1,128 baseline paths:
only this artifact differed; source and tasks remained byte-identical.
Equality to the starting baseline proves preservation, not normalization.
The historical pending forecast remains 246 A+D / 44 hunks; it was not
recalculated or resolved by this attempt. No automatic source rewrite was
reproduced in cleanup-3. Attribution to pi-lens remains unproven.

The executor reported 716/716 tests (27 suites), build exit 0, diff-check exit 0,
and lint exit 1, but returned inconsistent lint totals and baseline claims.
These reports do not constitute independent final-candidate verification.
The parent rejected both results and replaced their inaccurate cleanup-3
record with this bounded account. No further normalization retry was made.

Normalization and independent verification remain pending; WU2 is not ready.
Tasks remain 8/11; WU3, configuration changes, native reset, and delivery remain
out of scope. Rollback is limited to this cleanup-3 evidence delta, not WU2.

### ODD continuation — normalization persistence incident
User replaced SDD with ODD; historical artifacts and unit2 ledger 205/400 remain.
Fresh same-model worker computed all five target hashes before writing; immediate
post-write hashes matched. Subsequent hashes matched no targets; checks stopped.
Independent verifier: only one service blank line persists; AST/comments equal,
both WU2 T2.4 test blocks preserved; full source is 1499 A+D versus HEAD.
Raw tool output contains autofix notices in the drift interval; filesystem writer
attribution remains unproven. No configuration changes or automatic retry approved.
Final tests/build/diff-check/lint remain pending; no completion or review claimed.
Same cleanup3 baseline/caps retained; current counts and next step are in the ODD tracker.

### ODD final verification — exact normalization persisted
All five target hashes from Engram8264 persisted; independent AST/comments/fixtures/tests equality confirmed.
Independent `pnpm test src/products src/quotations/application src/quotations/dto src/quotations/domain --runInBand`: 716/716, 27 suites; `pnpm build` and `git diff --check`: exit 0.
No-fix ESLint: 336 diagnostics versus HEAD stdin 339, zero new; LSP: 13 known spec diagnostics, three files inconclusive; full suite/WU3 not run.
Cleanup3: 246 source + 48 apply-progress + 20 tracker + 5 temporary isolation = 319/320; evidence 73/74. Isolation must survive pending settlement; unit2 remains 205/400.
