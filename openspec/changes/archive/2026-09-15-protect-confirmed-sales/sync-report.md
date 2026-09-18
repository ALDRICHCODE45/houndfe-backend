# Sync Report — `protect-confirmed-sales`

- **Status:** synced
- **Store:** `openspec` (authoritative).
- **Change:** Protect confirmed/canceled sales from draft item mutations and draft deletion.
- **Sync target:** `openspec/specs/sales/spec.md` (canonical Sales spec).
- **Date:** 2026-09-15 · **HEAD:** `476aa016d3c6f9c1e0d84c94f1dccfe30ec37ce9` (`feat/protect-confirmed-sales-07b-tenant-transaction-integration`, clean tree at sync start)

## Nature of this sync: generic fallback, not native `sdd-sync`

This is a **generic fallback sync**, not a native `sdd-sync` run, not an SDD attempt, and not an exercise of native v2 status authority. Native `gentle-ai` v2 status for this change is unusable per Gentle AI issue **#4610**; the sync was therefore performed by direct canonical merge under explicit parent (user) delegation, with verification executed locally rather than through the native status contract.

## Verdict

The delta (`openspec/changes/protect-confirmed-sales/specs/sales/spec.md`) contains only `## ADDED Requirements` (5 requirements, 27 scenarios) — additive only. The delta was applied as an append-only update to the canonical `sales` spec: all five requirement blocks were inserted in source order immediately before the existing `## Verification Surface` section. No existing requirement, scenario, or document section was modified, deleted, or renamed. The delta's title (`# Delta for Sales`), `## Scope Boundary` prose, and `## ADDED Requirements` wrapper were **not** copied into the canonical spec.

## Domains synced

| Domain | Canonical path                 | Delta path                                                     | Result                         |
|--------|--------------------------------|----------------------------------------------------------------|--------------------------------|
| sales  | `openspec/specs/sales/spec.md` | `openspec/changes/protect-confirmed-sales/specs/sales/spec.md` | synced (5 ADDED, 27 scenarios) |

## Canonical files updated

- `openspec/specs/sales/spec.md` — pre-sync 638 content lines (`wc -l` reports 637 because the final line carries no terminating newline) / 20 `### Requirement:` blocks; post-sync 866 content lines / 25 `### Requirement:` blocks. The merge is a pure insertion reconstructed from the exact HEAD `476aa01` bytes with only the five delta requirement blocks added immediately before the existing `## Verification Surface` marker: every pre-existing byte outside the insertion is preserved byte-for-byte, including the original no-final-newline EOF style (no edits to existing requirement content, no heading renames, no section removal, no trailing-newline change).

## ADDED requirement names (5)

1. `Draft Item Mutation Operations Reject Non-DRAFT Lifecycles`
2. `Draft Sale Deletion Rejects Non-DRAFT Lifecycles`
3. `Empty Non-DRAFT Clear Is Rejected, Not Treated As A Success`
4. `Lifecycle Eligibility Precedes Destructive Persistence`
5. `Valid DRAFT Behavior And Authorization Contracts Preserved`

All 5 names match the delta's `## ADDED Requirements` blocks verbatim and were preserved with their full Given/When/Then scenario lists (27 scenarios total).

## MODIFIED / REMOVED / RENAMED

- MODIFIED requirements: **none** (delta is additive only; no `## MODIFIED Requirements`).
- REMOVED requirements: **none**.
- RENAMED requirements: **none**.

## Collision / duplicate checks

- Each of the 5 delta requirement headings was checked against the canonical spec pre-insertion: **0 occurrences** (absent — no pre-existing same-heading requirement).
- Post-insertion: each heading occurs **exactly once** in the canonical spec (no duplicates).
- Active same-domain collisions: none — `protect-confirmed-sales` is the only active change under `openspec/changes/` (everything else is dated archive); no other active delta touches `specs/sales/spec.md`.

## Provenance & evidence chain

- HEAD at sync: `476aa016d3c6f9c1e0d84c94f1dccfe30ec37ce9` (verified via `git rev-parse HEAD` before editing; clean working tree).
- Committed generic verification report: `openspec/changes/protect-confirmed-sales/verify-report.md` (committed at `476aa01`) — final generic verification evidence **PASS**; approved/acknowledged by native review `review-86777ff95c33581f`.
- The delta spec text was merged byte-for-byte from the committed delta; no normative wording (MUST/SHALL, scenario GIVEN/WHEN/THEN) was altered.

## Validation performed

| Check                                 | Method                                                                                                                                  | Result                                                                                              |
|---------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Delta requirement count               | block extraction on `### Requirement:` headings                                                                                         | 5                                                                                                   |
| Delta scenario count                  | `#### Scenario:` count inside extracted blocks                                                                                          | 27                                                                                                  |
| Canonical pre-sync requirement count  | `grep -cE '^### Requirement: '`                                                                                                         | 20                                                                                                  |
| Canonical post-sync requirement count | `grep -cE '^### Requirement: '`                                                                                                         | 25 (= 20 + 5 ✓)                                                                                     |
| Heading uniqueness post-sync          | per-heading `canonical.count(heading) == 1`                                                                                             | pass for all 5                                                                                      |
| Exact-block merge                     | extracted delta blocks compared against canonical content                                                                               | all 5 blocks present verbatim                                                                       |
| Diff purity                           | `git diff -U0 -- openspec/specs/sales/spec.md` hunk inventory                                                                           | exactly 1 hunk (`@@ -620,0 +621,228 @@`); 0 hunks in the pre-existing prefix or at the original EOF |
| Byte preservation                     | pre-insertion prefix and post-`## Verification Surface` content compared against `git show HEAD:...` bytes                              | byte-identical                                                                                      |
| Section integrity                     | canonical `## Purpose` / `## Requirements` / `## Verification Surface` intact; no leaked `## ADDED Requirements` wrapper or delta title | clean                                                                                               |
| File termination                      | original EOF style preserved byte-for-byte (no terminating newline on the final line, identical to HEAD)                                | pass                                                                                                |

## Review-budget accounting

- `git diff --numstat` for the canonical file: **228 insertions / 0 deletions** (pure insertion; the five delta blocks plus one blank separator line). Plus this sync report (untracked, 82 lines). Total Git-visible A+D for the sync candidate: **310, below the 400-line cap**.

## Next recommended phase

- **Archive remains pending.** It requires a later **explicit user decision**. No archive paths were created or moved by this sync, and no proposal/design/tasks/apply-progress/verify-report/delta/source/test/package file was modified.

## Notes (non-blocking)

1. No git operations performed (sync is uncommitted; the parent owns commit timing per work-unit convention).
2. Canonical `## Verification Surface` was left untouched; it predates this delta and does not list this change's spec files (same situation as prior additive syncs).
3. A temporary root `.pi-lens.json` (`{"format":{"enabled":false},"autofix":{"enabled":false}}`) was created during this task with explicit parent authorization to keep the environment markdown auto-fixer from reformatting the canonical bytes; it is parent-owned cleanup, not part of the sync candidate, and the parent will delete it.
