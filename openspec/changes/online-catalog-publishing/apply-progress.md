# Apply Progress — online-catalog-publishing

## F1.WU4 → F3.WU10 — committed implementation reconciliation (final slice)

**Status:** reconciled at HEAD `9ca0237` (tree `4090ceb`) on `feat/online-catalog-publishing-wu6`. All 19 WU4–WU10 implementation rows in `tasks.md` are marked complete (progress parses 32/34); the two parent lifecycle rows remain intentionally pending. **Final verification is explicitly incomplete:** no fresh test, integration, build, or Prisma receipt exists at this HEAD. This section replaces the stale WU4a/WU3 top snapshot; the WU3 and WU2b sections below are preserved as historical records.

### Provenance distinctions

- **Committed implementation (source inspection):** a final read-only audit at HEAD `9ca0237` mapped every previously unchecked WU4–WU10 row to committed source, tests, or docs; this reconciliation adds no execution claims.
- **Committed test coverage:** the suites named in the WU4–WU10 rows exist in the committed tree at HEAD `9ca0237`; their presence does not prove they were executed at this HEAD.
- **Historical test executions:** WU1b/WU2b (and WU3-local) suite runs recorded below are historical only and cannot prove final-HEAD behavior.
- **Missing final-HEAD execution:** no post-WU10 execution receipt exists; final verification remains blocked pending fresh safe verification.

### Committed WU ranges

| WU      | Commits               | Scope (committed)                                                                                                  |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| F1.WU4  | `27df7f4` → `292a365` | Product/variant catalog fields, validation, atomic allowlists, variant tenant scoping                              |
| F1.WU5  | `aeab44a` → `ac5e324` | Publication gates, catalog-default resolution, PostgreSQL gate coverage                                            |
| F2.WU6  | `fb02c3d` → `cf4400d` | Price-context resolver, error contract, context-explicit list/detail reads, two-context proof                      |
| F2.WU7  | `6cba5d5` → `4c01845` | Context-bound cart validation through legacy-cart retirement (adjacent throttle-bucket fix `3f9ff1b` precedes WU8) |
| F2.WU8  | `f6f00aa` → `452715b` | Frontend response guide, guide corrections, published response contract tests                                      |
| F3.WU9  | `9d91dfc` → `6251adb` | Stock-presentation inheritance/mapper/aggregates through contextual card exposure (includes repo chore `f4604e7`)  |
| F3.WU10 | `637552f` + `9ca0237` | Cart stock-safety regression lock and final contract documentation                                                 |

### Deferred

- Route drift `/admin/...` versus `/tenants/...` in proposal/design/spec wording remains deferred and untouched.

---

## WU3 — Catalog-settings HTTP contract and dedicated authorization (LOCAL checkpoint)

**Status:** completed and passed locally on the WU3 branch only. Never describe WU3 as published or merged; the WU2b section below is historical and describes WU2b only.

### Boundary

Authenticated catalog-settings HTTP contract and dedicated authorization around WU2a/WU2b: response/update DTOs, update use case, controller, module registration, actor audit logging, `TenantCatalogSettings` `read`/`update` permissions with idempotent bootstrap seeding, and co-located tests. No product/variant, public-catalog, WU1a/WU1b schema/migration, or frontend work. Depends on WU2b. Canonical route: `/tenants/:tenantId/catalog-settings` (stale `/admin/...` design wording is superseded; proposal/design/specs remain untouched).

### Delivery (local branch state)

- Branch/HEAD: `feat/online-catalog-publishing-wu3` @ `95dc022` in the dedicated worktree `houndfe-backend-online-catalog-wu3` (clean base; branch was built from a clean base commit).
- No upstream tracking, no push, no merge, no PR, and no main/planning-worktree mutation for WU3.
- 8 bounded commits `50d5539` → `95dc022`; **2,147 A+D total; max slice 381; every slice ≤400.** No size exception was required.

| Commit    | A+D | RDD lineage               |
| --------- | --: | ------------------------- |
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
- `verify-report.md`: not updated for WU3 at the time (still WU2b-only); it was later updated for WU3-era verification and then reconciled at the final HEAD `9ca0237` — this bullet is historical. Historical WU3 provenance conflict, preserved not normalized: this section records the focused run as **13 suites / 148 tests**, while the WU3-era verify report records **15 suites / 162 tests** for the same era.

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
