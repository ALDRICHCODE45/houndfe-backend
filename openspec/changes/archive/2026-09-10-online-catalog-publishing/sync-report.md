# Sync Report — Online Catalog Publishing

## Result

**Status: synced.** The four verified change deltas are merged into the new canonical capability specification at `openspec/specs/public-catalog/spec.md`. The change remains active and has not been archived.

## Synced capability

| Domain source                 | Canonical destination                   | Requirement disposition |
| ----------------------------- | --------------------------------------- | ----------------------- |
| `01-publication-and-settings` | `openspec/specs/public-catalog/spec.md` | Added                   |
| `02-price-context`            | `openspec/specs/public-catalog/spec.md` | Added                   |
| `03-stock-presentation`       | `openspec/specs/public-catalog/spec.md` | Added                   |
| `04-contracts-and-evidence`   | `openspec/specs/public-catalog/spec.md` | Added                   |

All delta requirements and Given/When/Then scenarios are preserved in one coherent `public-catalog` capability specification. No MODIFIED or REMOVED requirements were applied, and no RENAMED Requirements section exists. The canonical authenticated settings route is `GET`/`PATCH /tenants/:tenantId/catalog-settings`; stale `/admin/...` wording was not propagated.

## Scope and boundaries

- Backend-only delivery is retained; frontend work remains paused.
- Operational stock remains authoritative for cart validation; presentation never changes fulfillment stock decisions.
- Price context is exact and no-fallback: missing, non-positive, or unsupported visible prices are unavailable in the selected context rather than substituted from another list.
- The active-change collision scan found no same-domain collision requiring an archive/sync order.
- The canonical target was absent before sync, so this sync created `openspec/specs/public-catalog/spec.md`.

## Verification gate and evidence caveat

Parent-provided authoritative status is `artifactStore: openspec`, repo-local, apply `all_done` with 32/32 implementation rows complete, verify `pass` with zero blockers and zero critical findings, and sync `ready`. The action context allows writes inside this workspace; both updated paths are within that allowed root.

Task 122 is **WAIVED** by an explicit maintainer-authorized historical governance exception. This is a disposition only and does not claim that WU4–WU10 bounded reviews occurred. Review evidence ends at WU3; WU4–WU10 lack complete per-slice lineages; WU9 includes `c57bfe6` at 801 A+D plus unrelated `.gitignore` commit `f4604e7`; `review-ledger.md` remains read-only and unchanged. No historical reviews were rerun, recreated, or fabricated. Task 123 is complete.

Full isolated integration receipt `sha256:19f69bd62876354945b1a3fbb2a8ec2811a2e0c4eb541ff01e1f53e56b63c901` is non-green at **5 failing suites / 42 tests**. Promotions, buy-x-get-y, PDF, and employees are four proven base-only failures; they remain unfixed and out of scope. The focused correction receipt `sha256:a06fddc0209d0f0bca4252c211103fd78b4d3bdda458f345c0e762c0b3b7a13b` passed **24/24**. Stale formatter-contaminated receipts `sha256:78b785...`, `sha256:bce444...`, and target `sha256:96c1...` are excluded.

## Focused validation

The sync phase performed only structural validation: read-back of both output files, exact authorized two-file scope, `git diff --check`, immutability checks for all delta sources and `review-ledger.md`, requirement/scenario coverage comparison, canonical route check, exact A+D count, and final binary-diff SHA calculation. It did not run unit, integration, build, Prisma, lint, Docker, native review, stage, commit, archive, merge, PR, or push commands.

## Next phase

**Next recommended: `sdd-archive`.** The canonical spec is synced and the change remains active for the archive phase.
