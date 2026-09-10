# Archive Report — `online-catalog-publishing`

> Local-delivery boundary: this archive was executed locally and left uncommitted.
> No commit, merge, pull request, or push has been performed. The maintainer
> has been warned that archiving relocates the active change artifacts.

## Result

**Status: archived.** The verified, synced `online-catalog-publishing` change
has been moved under the repository convention
`openspec/changes/archive/2026-09-10-online-catalog-publishing/`. The active
path `openspec/changes/online-catalog-publishing/` no longer exists. Every
archived artifact is preserved byte-for-byte; only a new `archive-report.md`
has been added. The canonical `openspec/specs/public-catalog/spec.md`
remains byte-unchanged from sync commit `16ad4b0297bdb38eb31189bb70350be393a521e4`.

## Snapshot at archive time

| Field                     | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Archive date              | `2026-09-10`                                                                                                |
| Clean HEAD                | `16ad4b0297bdb38eb31189bb70350be393a521e4`                                                                  |
| Tree                      | `5c4813a4a3a59ffedd884e42b6e0e472317f48f3`                                                                  |
| Final verification commit | `baa39bea0a950d34422e1cfcc32d69d9260efaab`                                                                  |
| Historical waiver commit  | `2ff1fa2` (three-file canonical waiver diff is **214 A+D**)                                                 |
| Sync commit               | `16ad4b0297bdb38eb31189bb70350be393a521e4` (creates `openspec/specs/public-catalog/spec.md` + report)       |
| Source path               | `openspec/changes/online-catalog-publishing/` (now removed)                                                 |
| Destination path          | `openspec/changes/archive/2026-09-10-online-catalog-publishing/`                                            |
| Artifact store mode       | `openspec` (authoritative, repo-local WU6)                                                                  |
| Action context            | `repo-local`, worktree `/home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend-online-catalog-wu6` |
| Local-delivery state      | uncommitted; no merge, PR, or push                                                                          |

## Archived artifacts

All listed files were relocated from the active change to the archive
directory via `git mv` so git detected them as renames. Their content bytes
are identical to the prior active path; no historical evidence file was
omitted, edited, regenerated, extended, or fabricated.

| Artifact                        | Path inside archive                               |
| ------------------------------- | ------------------------------------------------- |
| README                          | `README.md`                                       |
| Proposal                        | `proposal.md`                                     |
| Design                          | `design.md`                                       |
| Tasks                           | `tasks.md`                                        |
| Apply progress                  | `apply-progress.md`                               |
| Verify report                   | `verify-report.md`                                |
| Sync report                     | `sync-report.md`                                  |
| Review ledger                   | `review-ledger.md` (immutable — bytes preserved)  |
| Publication/settings delta spec | `specs/01-publication-and-settings/spec.md`       |
| Price-context delta spec        | `specs/02-price-context/spec.md`                  |
| Stock-presentation delta spec   | `specs/03-stock-presentation/spec.md`             |
| Contracts/evidence delta spec   | `specs/04-contracts-and-evidence/spec.md`         |
| Archive report (this file)      | `archive-report.md` (newly added at archive time) |

## Phase outcomes prior to archive

| Phase   | State      | Notes                                                            |
| ------- | ---------- | ---------------------------------------------------------------- |
| Apply   | `all_done` | 32/32 implementation tasks complete; task 123 `[x]`              |
| Verify  | `pass`     | verdict `pass`, blockers `0`, critical findings `0`              |
| Sync    | `all_done` | commit `16ad4b0` created `openspec/specs/public-catalog/spec.md` |
| Archive | `executed` | this report                                                      |

Canonical `openspec/specs/public-catalog/spec.md` carries **23 requirements
/ 29 scenarios** and the canonical authenticated settings route
`/tenants/:tenantId/catalog-settings`. No `MODIFIED` or `REMOVED` requirements
were applied during sync; no `RENAMED Requirements` section exists.

## Domains synced

All four delta domains were added to the new capability specification:

| Domain source                 | Canonical destination                   | Requirement disposition |
| ----------------------------- | --------------------------------------- | ----------------------- |
| `01-publication-and-settings` | `openspec/specs/public-catalog/spec.md` | ADDED (full capability) |
| `02-price-context`            | `openspec/specs/public-catalog/spec.md` | ADDED (full capability) |
| `03-stock-presentation`       | `openspec/specs/public-catalog/spec.md` | ADDED (full capability) |
| `04-contracts-and-evidence`   | `openspec/specs/public-catalog/spec.md` | ADDED (full capability) |

There were no `MODIFIED Requirements` and no `REMOVED Requirements`; the
canonical target was absent before sync, so this sync created the capability.
No active same-domain change was detected.

## Task completion record (preserved verbatim inside `tasks.md`)

- **Implementation tasks: 32/32 complete.** No unchecked implementation
  task remains.
- **Task 122 — bounded review governance**: `[x]` with a **WAIVED** disposition
  under the **maintainer-authorized historical governance exception** for
  managed objective `F3.WU10-task122-historical-exception`. The disposition
  resolves the parent action as a waiver only; it MUST NOT be read as a
  claim that the original bounded-review procedure occurred.
- **Task 123 — F3 completion gate**: `[x]`. Evidence reconciled from the
  canonical receipts listed below; full integration remains explicitly
  non-green, with four proven base-only failures reported rather than fixed;
  frontend remains paused.

## Canonical receipts and evidence caveats (preserved verbatim across reports)

The receipts below are canonical prior evidence and were not re-executed
during the archive phase:

| Receipt type                        | SHA256                                                             | Result                                                   |
| ----------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Safe final run (Prisma + unit)      | `3a844852fb3b41cc64e2633164a6fdcc01566307b074be06a0681b9b3db262d9` | Prisma validate/generate passed; unit 237 suites / 3,539 |
| Full isolated integration           | `19f69bd62876354945b1a3fbb2a8ec2811a2e0c4eb541ff01e1f53e56b63c901` | **non-green** — 5 failing suites / 42 tests              |
| Post-correction focused integration | `a06fddc0209d0f0bca4252c211103fd78b4d3bdda458f345c0e762c0b3b7a13b` | 24/24 passed                                             |
| TS2352 canonical correction         | `6d4b4f0412af0fb7141790a752e4efe46d4db28617238b22f8b69ac5547deb26` | LSP clean; focused Jest 3 suites / 119; build exit 0     |
| Waiver candidate native review      | `review-b954871b4b4b36da`                                          | approved / acknowledged / burned for target SHA256 below |
| Waiver candidate target             | `39464a7a68afe5e5d96d6f08b6ec9a08593daf2876ba94882147642732db4d4d` | —                                                        |
| Sync native review                  | `review-4af60d3af10dbcad`                                          | approved / acknowledged / burned for target SHA256 below |
| Sync target                         | `726945cfcc130473078b1e924495b2391d08d2be6dfa3728dd3c8cddce2cffcc` | —                                                        |

Stale formatter-contaminated receipts `sha256:78b785...`,
`sha256:bce444...`, and target `sha256:96c1...` remain excluded.

### Base-only integration failures (out of scope, unfixed)

The full isolated integration receipt at
`sha256:19f69bd62876354945b1a3fbb2a8ec2811a2e0c4eb541ff01e1f53e56b63c901`
remains **explicitly non-green**. Four proven base-only failures are
reported rather than fixed by this change:

1. **Promotions** — base-only failure, out of scope.
2. **Buy-x-get-y** — base-only failure, out of scope.
3. **PDF** — base-only failure, out of scope.
4. **Employees** — base-only failure, out of scope.

These failures are NOT re-labeled and are NOT fixed as part of this
archive. The focused correction receipt
`sha256:a06fddc0209d0f0bca4252c211103fd78b4d3bdda458f345c0e762c0b3b7a13b`
passed 24/24 against the change-specific surface.

## Waiver claim boundary (binding)

The task 122 disposition is precise:

- It is a **governance waiver**, not a claim of completed bounded reviews.
- `review-ledger.md` is **read-only and unchanged** at archive time.
- Review evidence ends at **WU3**.
- **WU4–WU10** lack complete per-slice lineages.
- **WU9** includes `c57bfe6` at **801 A+D** plus unrelated `.gitignore`
  commit `f4604e7`.
- No historical reviews were rerun, recreated, or fabricated.
- The previously approved native review
  `review-b954871b4b4b36da` is **acknowledged and burned** for the listed
  waiver target.

Any future reader must reproduce this claim boundary verbatim.

## Destruction / merge guard

- No `MODIFIED Requirements` were applied during sync.
- No `REMOVED Requirements` were applied during sync.
- No partial `MODIFIED` delta was dropped silently.
- No same-domain active change collision was reported.
- This archive introduces zero `git rm` of historical artifacts.

The merge was constructive-only: a new capability specification
`openspec/specs/public-catalog/spec.md` was created at sync time, and the
active change folder was relocated into the dated audit trail. No merge was
destructive and no explicit destructive approval was required.

## Frontend pause binding (preserved)

Frontend work remains **paused by product decision**. This archive delivers
backend contracts and evidence only; it contains no frontend deliverables
and does not reactivate frontend work. The frontend resumes solely on an
explicit user instruction after the backend publishes contracts and
evidence.

## Allowed edit surfaces used

- `openspec/changes/online-catalog-publishing/**` (active path relocated out
  via `git mv`; directory no longer exists after archive).
- `openspec/changes/archive/2026-09-10-online-catalog-publishing/**` (the
  new archive directory, plus this report).

No other workspace paths were touched. Canonical
`openspec/specs/public-catalog/spec.md` was not modified.

## Rollback

To revert this archive locally without pushing or merging:

```text
git reset HEAD -- openspec/changes/archive/2026-09-10-online-catalog-publishing
git restore --source=HEAD --staged --worktree openspec/changes/online-catalog-publishing/
```

`review-ledger.md` content is **immutable**. If the archive operation is
reverted, `review-ledger.md` must keep its byte-for-byte content from HEAD;
do not regenerate, extend, or fabricate its history. The pre-archive SHA
of `review-ledger.md` was
`fabb36af43079bf295f7bd2514754d6d3e96ddcf91c236fd0e5d50c066ff80d1`.

## Local-delivery boundary

This archive was performed locally under the explicit instruction **not to
commit, merge, open a pull request, or push**. Final staging, commits,
pushes, and PR creation are deferred to a follow-up phase or to the
maintainer. The phase envelope's exact A+D and the binary-diff SHA are
recorded in the SDD result contract returned by this archive phase.
