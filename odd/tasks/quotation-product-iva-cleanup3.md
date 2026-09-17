# Quotation product IVA — cleanup3 (ODD)
Objective: remove only the approved 44 formatting hunks; preserve WU2 behavior and tests.
Reason: finish the interrupted normalization; user explicitly replaced SDD with ODD.
Baseline: `/tmp/quotation-wu2-cleanup3-baseline-r5aq4v3y/files`; no budget restart.
Budget: 320 Git A+D total; source 246; evidence <=74 including this tracker and existing 31.
Scope: five quotation files from Engram8264; `apply-progress.md` evidence; parent-owned tracker.
Excluded: WU3, semantic/import/test/fixture edits, unrelated configuration, reset, staging and delivery.
TDD: off (`openspec/config.yaml`, apply.tdd=false); runner `pnpm test`; build `pnpm build`.
- [x] C1: Revalidate branch/HEAD, empty index, 1498 source A+D and 1128-path global hash.
- [x] C2: Exact 44-hunk normalization persisted; all five in-memory and final hashes match Engram8264.
- [x] C3: Independent 716/716 tests, build, diff-check, AST/comments and zero-new-lint verification; evidence reconciled.
- [x] B1: User authorized reversible isolation; installed resolver confirms all three mutation controls disabled.
Checks: focused Jest 716/716 (27 suites), build and diff-check passed; ESLint 336 vs HEAD 339, zero new.
Acceptance: exact five target hashes persist; AST/comments unchanged; WU2 tests preserved; no source scope drift.
Progress: all five target hashes persisted after isolated writes, independent verification and parent readback.
Limits: LSP reports 13 known spec diagnostics and three inconclusive files; full suite/WU3 not run.
Tool transcript: autofix notices appeared between write proof and drift; filesystem actor attribution remains unproven.
Budget: source 246 + apply-progress 48 + tracker 20 + temporary config 5 = 319/320; evidence 73/74.
History: OpenSpec retained; unit2 205/400 immutable; only local reversible mutation isolation authorized.
Next: native review preflight; remove only temporary .pi-lens.json after safe parent settlement, then recheck hashes.
