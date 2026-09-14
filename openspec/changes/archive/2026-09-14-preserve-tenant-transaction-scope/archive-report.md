# Archive Report — preserve-tenant-transaction-scope

**Change:** `preserve-tenant-transaction-scope`
**Archived path:** `openspec/changes/archive/2026-09-14-preserve-tenant-transaction-scope/`
**Archive status:** PASS
**Artifact store:** `openspec`
**Action context mode:** `repo-local`
**Workspace root:** `/home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend-wu7a`

## Status and decision

| Field                          | Value                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `gentle-ai.sdd-status` v2 consumed | yes — `apply: all_done`, `verify: all_done`, `archive: ready`, `tasks: 17/17`, `remediationState.required: false`, `blockedReasons: []`, `nextRecommended: archive`                  |
| Verify report verdict          | pass (`sha256:f424b5295cffae1c312e49f3451b8874edbeeb02dc3a1d9686839d0cc3ef9cc9`)                                                                                                       |
| Blockers / critical findings   | 0 / 0                                                                                                                                                                                  |
| Requirements / scenarios       | 10 / 10 requirements, 22 / 22 scenarios                                                                                                                                                |
| Stale-checkbox reconciliation  | none — no `- [ ]` implementation tasks remain in `tasks.md`                                                                                                                            |
| Sync fallback approval         | explicit in parent prompt ("syncing its verified delta into canonical source specs as required")                                                                                       |
| Same-domain active change      | none — no other active change under `openspec/changes/*/specs/shared-prisma/`                                                                                                          |
| Destructive merge approvals    | none required — no REMOVED requirements, no MODIFIED blocks targeting existing canonical requirements                                                                                   |
| `protect-confirmed-sales`      | NOT modified; WU7 dependency line was already updated by the verifying commit; this archive leaves that change untouched per scope                                                    |
| Production code / tests / schema / migrations / `.env.test` / dependencies / branches / git history | NOT modified by this archive operation                                                                                                                                          |

## Artifacts read

- `openspec/changes/preserve-tenant-transaction-scope/proposal.md`
- `openspec/changes/preserve-tenant-transaction-scope/specs/shared-prisma/spec.md`
- `openspec/changes/preserve-tenant-transaction-scope/design.md`
- `openspec/changes/preserve-tenant-transaction-scope/tasks.md`
- `openspec/changes/preserve-tenant-transaction-scope/apply-progress.md`
- `openspec/changes/preserve-tenant-transaction-scope/verify-report.md`
- `openspec/config.yaml`
- `openspec/specs/` (canonical inventory — `shared-prisma/` did NOT exist prior to this archive)

## Sync summary (archive-time fallback)

`shared-prisma` was a brand-new canonical domain. The change spec contained no `## ADDED Requirements`, `## MODIFIED Requirements`, or `## REMOVED Requirements` section markers; it was authored as a complete domain specification (per `design.md` "preserve `getClient()` unchanged" and the proposal's "single shared-Prisma work unit" framing). Merge path taken:

- **New canonical spec path:** `openspec/specs/shared-prisma/spec.md` was created by direct copy of `openspec/changes/preserve-tenant-transaction-scope/specs/shared-prisma/spec.md`. Byte-identical verified via `diff -q` (returns 0 / files identical). No requirement-name match, replace, or removal logic was required.

### Domain synced

- `shared-prisma` — new domain, 10 requirements, 22 scenarios, plus 2 static non-goal clauses (raw SQL and direct/CLS-external transaction consumers) recorded for downstream reviewers without imposing runtime requirements.

### ADDED / MODIFIED / REMOVED requirement names

- ADDED (10): Tenant-Extended Root Owns The Outer Interactive Transaction; CLS Transaction Slot Restoration On Success And Failure; Nested runInTransaction Reuses The Active Outer Transaction; getClient Returns The Ambient Callback Client Inside An Active CLS Transaction; Tenant Enforcement For Reads Inside CLS Transactions; Tenant Enforcement For Updates And Deletes Inside CLS Transactions; Tenant Attribution For Creates Inside CLS Transactions; Post-Transaction Persistence Reload Through Unscoped Fixture; Prisma 6.19 Source Compatibility; Downstream Gate For protect-confirmed-sales WU7.
- MODIFIED: none.
- REMOVED: none.

### Active same-domain change warnings

None — no other active change under `openspec/changes/*/specs/shared-prisma/spec.md` was found at archive time. The `protect-confirmed-sales` change (active, sibling) is in the `sales` domain and does not conflict.

### Destructive merge guard

Not triggered — zero REMOVED requirements and zero MODIFIED blocks against pre-existing canonical requirements. The sync is a non-destructive new-domain landing.

## Final task completion gate

Immediately before this archive-time sync, the persisted tasks artifact (`openspec/changes/preserve-tenant-transaction-scope/tasks.md`) was re-read. Grep for `^\s*- \[ \]` returned no matches. All 17 implementation tasks across WU1 (8) and WU2 (9) are checked `[x]`. No stale-checkbox reconciliation was required or performed; apply-progress and verify-report already record 11/11 WU1 unit evidence and 8/8 WU2 PostgreSQL integration evidence under the fresh PASS revision.

## Pre-archive final-state handoff (truthful close)

- WU2 was independently reverified after stale/contradictory remediation history.
- Fresh PASS evidence revision `sha256:f424b5295cffae1c312e49f3451b8874edbeeb02dc3a1d9686839d0cc3ef9cc9` is the authoritative bundle digest bound to this archive.
- `.env.test` SHA-256 remained `8e7ae32b553b01fc2b4f5b7b711ae9d6608f8a5bc2d626c23cd7bd848905d9d6`, mode 644; not modified by this archive.
- Native ordinary review lineage `review-1b6f7ed5e0263bbf` approved the pre-archive candidate; acknowledgement was burned.
- Advisory-only warnings (rollback-proof strength, stale downstream WU7 prerequisite wording) did not block approval and remain advisory; the WU7 prerequisite line was updated to "verified" by the verifying commit prior to this archive, so the wording concern is resolved at archive time.
- Local commit `9d6f22f73d7dd655a7e30767735ddfd9e5037ff6` (`test(prisma): verify tenant scope in transactions`) contains the six verified WU2 paths and is the HEAD of the worktree; `git status --short` was empty and `git diff --check HEAD` was clean immediately before this archive.
- The invalid historical retained task remains reversibly quarantined outside the repository for audit and was NOT touched by this archive.

## Move executed

```
openspec/changes/preserve-tenant-transaction-scope/
  -> openspec/changes/archive/2026-09-14-preserve-tenant-transaction-scope/
```

Archive is an audit trail; the moved change is not deleted or silently modified.

## Memory observation IDs

Not applicable — `artifact_store: openspec` (no Engram trace requested by the parent; Engram trace was not used during apply/verify for this change).

## Structured status findings

Native `gentle-ai.sdd-status@2` was authoritative; no recomputation from OpenSpec artifacts was performed. No `actionContext` warnings, no `blockedReasons`, no notes. `allowedEditRoots` was a single root equal to `workspaceRoot`, and every write performed by this archive (`openspec/specs/shared-prisma/spec.md`, the pre-move `openspec/changes/preserve-tenant-transaction-scope/archive-report.md`, and the rename into `openspec/changes/archive/2026-09-14-preserve-tenant-transaction-scope/`) is inside that root.

## Out of scope (not touched by this archive)

- Production code in `src/`
- Test files (`src/shared/prisma/tenant-prisma.service.spec.ts`, `src/shared/prisma/tenant-prisma.service.integration.spec.ts`)
- `.env.test` (gitignored, SHA-256 unchanged)
- `prisma/schema.prisma`, migrations, `TENANT_SCOPED_MODELS` allowlist, factory
- `package.json`, `pnpm-lock.yaml`, Jest configs
- Git history, branches, push, pull requests
- `protect-confirmed-sales` change artifacts and implementation
- The reversibly quarantined invalid historical retained task
