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
