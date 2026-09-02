# Apply Progress — online-catalog-publishing

**Latest checkpoint — WU3: COMPLETE / PASSED LOCALLY on `feat/online-catalog-publishing-wu3` @ `95dc022` (dedicated WU3 worktree). Local-only: not pushed, not merged, not published; no main mutation.** Next phase: `sdd-verify`.

---

## WU3 — Catalog-settings HTTP contract and dedicated authorization (LOCAL checkpoint)

**Status:** completed and passed locally on the WU3 branch only. Never describe WU3 as published or merged; the WU2b section below is historical and describes WU2b only.

### Boundary

Authenticated catalog-settings HTTP contract and dedicated authorization around WU2a/WU2b: response/update DTOs, update use case, controller, module registration, actor audit logging, `TenantCatalogSettings` `read`/`update` permissions with idempotent bootstrap seeding, and co-located tests. No product/variant, public-catalog, WU1a/WU1b schema/migration, or frontend work. Depends on WU2b. Canonical route: `/tenants/:tenantId/catalog-settings` (stale `/admin/...` design wording is superseded; proposal/design/specs remain untouched).

### Delivery (local branch state)

- Branch/HEAD: `feat/online-catalog-publishing-wu3` @ `95dc022` in the dedicated worktree `houndfe-backend-online-catalog-wu3` (clean base; branch was built from a clean base commit).
- No upstream tracking, no push, no merge, no PR, and no main/planning-worktree mutation for WU3.
- 8 bounded commits `50d5539` → `95dc022`; **2,147 A+D total; max slice 381; every slice ≤400.** No size exception was required.

| Commit   | A+D | RDD lineage                |
| -------- | --: | -------------------------- |
| `50d5539` | 335 | `review-c0d5a3c6d10aa2b2` |
| `39996d8` | 112 | `review-67d0bf12e8f79b94` |
| `81917a9` | 245 | `review-7b5f310c3a46eb7e` |
| `653b1e4` | 141 | `review-a2e3611f5ae69dfb` |
| `a9ede51` | 376 | `review-fa2bd9bbd9c1a359` |
| `aff28aa` | 381 | `review-175f373f5b7578b9` |
| `9c3bf74` | 325 | `review-5e19ef00ba8b99c4` |
| `95dc022` | 232 | `review-01d0244648a14c7b` |

### Task mapping

- `tasks.md`: WU3 heading + forecast row updated to truthful actuals (2,147 / 8 commits / max 381); all three WU3 implementation rows marked `[x]` with concise evidence; ambiguous "admin route" wording replaced with canonical `/tenants/:tenantId/catalog-settings`; aggregates reconciled (overall **9,192–9,572**; F1 **7,632–7,737**).
- `review-ledger.md`: WU3 section appended with the 8-commit lineage table, findings summary, consolidated evidence, rollback, and route supersession note.
- `verify-report.md`: intentionally **not** updated for WU3 (still WU2b-only); verification is the next phase (`sdd-verify`).

### Final evidence (captured locally on the WU3 branch)

- Focused catalog-settings Jest: PASS (13 suites / 148 tests).
- Narrow ESLint/Prettier over WU3-touched files: PASS. `pnpm build`: PASS.
- No WU3 candidate TypeScript diagnostics; project-wide `tsc` retains unrelated pre-existing failures (non-regression).

### Excluded future scope

WU4 (product/variant round trips), WU5 (public gate), WU6 (resolver), WU7 (cart binding), WU8 (guide), WU9 (stock projection), WU10 (cart safety/evidence) remain pending/non-blocking. Frontend remains paused by product decision. The change is **not** archived.

### Rollback

Revert the 8 WU3 commits in reverse order `95dc022` → `50d5539`. WU2b/WU2a/WU1 work remains intact; no schema/migration edits belong to WU3.

### Links

- Ledger: `openspec/changes/online-catalog-publishing/review-ledger.md` (WU3 section).
- Historical WU2b verify: `openspec/changes/online-catalog-publishing/verify-report.md` (PASS for WU2b only).

---

## Historical checkpoint — WU2b

**WU2b: COMPLETE / PUBLISHED (historical; describes WU2b only, not WU3).** Recorded at its own apply run.

## WU2b boundary

Transaction-safe Prisma adapter + real-DB integration evidence. No HTTP/DTO/permission/module/audit/public-product work, no WU1a/WU1b schema/migration edits. Depends on WU2a.

## Delivery

- 10 bounded commits (`ee28509` → `13e8f4d`), 11 changed files, **3,648 insertions, 0 deletions**.
- Every slice ≤400 A+D; maximum = 400. **No size exception was required.**
- Direct-main integration at `46957ae` (`chore(catalog): integrate online catalog publishing`) after bounded per-slice reviews. **No PR was used for WU2b.**

## Task mapping

- `tasks.md`: WU2b heading + boundary updated to truthful actuals; both WU2b implementation rows marked complete with concise evidence; forecast totals reconciled at WU2b time (overall **7,375–7,815**; F1 **5,815–5,980**; superseded by the WU3 reconciliation above: overall **9,192–9,572**; F1 **7,632–7,737**).
- `review-ledger.md`: WU2b section appended with full 10-commit RDD lineage map, consolidated verification, partial-slice scope, rollback boundary, and informational/non-blocking findings.

## Excluded future scope

WU3 (HTTP/RBAC/module), WU4 (product/variant), WU5 (public gate), WU6 (resolver), WU7 (cart binding), WU8 (guide), WU9 (stock projection), WU10 (cart safety/evidence). Frontend remains paused by product decision. WU3–WU10 are pending/non-blocking for this partial checkpoint; the change is **not** archived.

## Rollback

Revert the 10 commits in reverse chronological order (`13e8f4d` → `ee28509`). The additive M1–M5 schema/migration remains deployable; do not edit prior migrations.

## Links

- Ledger: `openspec/changes/online-catalog-publishing/review-ledger.md` (WU2b section).
- Verify: `openspec/changes/online-catalog-publishing/verify-report.md` (PASS for WU2b only).
