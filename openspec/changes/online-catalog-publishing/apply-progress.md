# Apply Progress — online-catalog-publishing

## F1.WU4 → F3.WU10 — final evidence reconciliation

**Status:** reconciled to current HEAD `baa39bea0a950d34422e1cfcc32d69d9260efaab` (tree `7671b1ff7a682d91eb38890d4cc209063baef69b`) on `feat/online-catalog-publishing-wu6`. All 19 WU4–WU10 implementation rows are complete; task 123 is complete; task 122 is `[x]` with a **WAIVED** maintainer-authorized historical governance disposition for managed objective `F3.WU10-task122-historical-exception`. This disposition resolves the parent action as a waiver only and does not claim that the original bounded-review procedure occurred. This section supersedes stale final-candidate claims; the WU3 and WU2b sections below remain explicitly historical.

### Canonical receipts

- Safe final run `sha256:3a844852fb3b41cc64e2633164a6fdcc01566307b074be06a0681b9b3db262d9`: Prisma validate/generate passed; full unit passed **237 suites / 3,539 tests**.
- Full isolated integration `sha256:19f69bd62876354945b1a3fbb2a8ec2811a2e0c4eb541ff01e1f53e56b63c901`: **5 failing suites / 42 tests**, explicitly non-green. Only public-catalog shape mismatch was candidate-caused; promotions, buy-x-get-y, PDF, and employees are four proven base-only failures and remain unfixed.
- Post-correction focused integration `sha256:a06fddc0209d0f0bca4252c211103fd78b4d3bdda458f345c0e762c0b3b7a13b`: **24/24 passed**.
- TS2352 correction `sha256:6d4b4f0412af0fb7141790a752e4efe46d4db28617238b22f8b69ac5547deb26`: LSP clean, focused Jest **3 suites / 119 tests**, `pnpm build` once exit 0, exact **36 A+D**, committed as `582056a`.
- Native review `review-7733873461481cab` approved and acknowledged/burned for target `sha256:6b5298cc307e30111e3349e1f38d004a3be7b425170c7110a07cd2b44afe0010`.
- Formatter-contaminated receipts `sha256:78b785...`, `sha256:bce444...`, and target `sha256:96c1...` are stale and excluded.

These are canonical historical receipts; no unit, integration, build, Prisma, lint, Docker, or unrelated command ran in this reconciliation.

### Provenance and review boundary

- WU4–WU10 source/test/doc coverage is present in current HEAD; older commit ranges in `tasks.md` are implementation provenance, not fresh execution claims.
- Repository review evidence ends at WU3. WU4–WU10 lack complete per-slice lineages; WU9 includes `c57bfe6` at **801 A+D** and unrelated `.gitignore` commit `f4604e7`. These deficits are explicitly retained as the accepted historical deviation; review history is not fabricated or repaired.
- `review-ledger.md` is read-only and unchanged. No historical reviews were rerun, recreated, or fabricated.
- WU10 current commit reference is `582056a`; older WU2b/WU3 evidence below remains historical.

### Parent task 122 governance disposition

```yaml
task_122:
  status: complete
  disposition: WAIVED
  objective: F3.WU10-task122-historical-exception
  authority: maintainer-authorized historical governance exception
  claim_boundary: waiver/disposition only; original bounded-review procedure is not claimed
```

Task 123 remains `[x]`. Full integration remains explicitly non-green: promotions, buy-x-get-y, PDF, and employees are four proven base-only failures, out of scope and unfixed.

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
- `verify-report.md`: not updated for WU3 at the time (still WU2b-only); it was later updated for WU3-era verification and a superseded candidate snapshot at `9ca0237` / tree `4090ceb` — this bullet is historical. Historical WU3 provenance conflict, preserved not normalized: this section records the focused run as **13 suites / 148 tests**, while the WU3-era verify report records **15 suites / 162 tests** for the same era.

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
