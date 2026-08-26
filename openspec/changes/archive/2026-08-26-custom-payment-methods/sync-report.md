# Sync Report — `custom-payment-methods`

Status: **synced**

Sync executor: SDD sync executor (direct inline, no child agents)
Date: 2026-08-26

---

## Structured status (reconstructed)

`gentle-ai sdd-status` was not run; status reconstructed from disk and the
upstream `verify-report.md` (PASS).

```yaml
schemaName: spec-driven
changeName: custom-payment-methods
artifactStore: openspec
artifactPaths:
  syncReport: [openspec/changes/custom-payment-methods/sync-report.md]
artifacts:
  proposal: done
  specs: done
  design: done
  tasks: done
  applyProgress: done
  verifyReport: done
  syncReport: done
dependencies:
  apply: all_done
  verify: all_done
  sync: done
  archive: ready
actionContext:
  mode: repo-local
  workspaceRoot: /Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend
  allowedEditRoots: [/Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend]
  warnings: []
nextRecommended: sdd-archive
isNonAuthoritative: false
skillResolution: paths-injected
```

`actionContext.mode` is `repo-local` (not `workspace-planning`), so the
empty-`allowedEditRoots` guard does not apply. Workspace path matches the
verify-report claim (`/Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend`).

---

## Domains synced

| Domain            | Delta operation               | Canonical file                              | Mode                          |
|-------------------|-------------------------------|---------------------------------------------|-------------------------------|
| `payment-methods` | NEW domain (full copy)        | `openspec/specs/payment-methods/spec.md`    | created (file did not exist)  |
| `sales`           | `## ADDED Requirements` × 2   | `openspec/specs/sales/spec.md`              | appended (existed)            |
| `sale-payments`   | `## ADDED Requirements` × 4   | `openspec/specs/sale-payments/spec.md`      | appended (existed)            |

---

## Canonical files updated

```text
openspec/specs/payment-methods/spec.md        (NEW)    351 lines / 14784 bytes — byte-identical to delta spec
openspec/specs/sales/spec.md                 (MOD)    23 -> 13 requirements preserved; +2 appended
openspec/specs/sale-payments/spec.md         (MOD)     3 ->  3 requirements preserved; +4 appended
```

### Canonical `payment-methods/spec.md` (NEW domain)

Copied verbatim from
`openspec/changes/custom-payment-methods/specs/payment-methods/spec.md`.
`diff -q` confirms byte-identical content.

Includes 7 requirements:

1. PaymentMethod Model
2. PaymentMethod Field Validation
3. PaymentMethod Admin CRUD Endpoints
4. PaymentMethod RBAC Permissions
5. Tenant Isolation of PaymentMethod Reads and Writes
6. POS Read Projection of Active Catalog Methods
7. (plus the canonical `## Purpose`, `## Verification Surface`, and `## Notes for Implementation` sections)

### Canonical `sales/spec.md` (APPEND-ONLY)

Appended the two `### Requirement:` blocks from
`openspec/changes/custom-payment-methods/specs/sales/spec.md` `## ADDED Requirements`:

1. `Charge Resolves a Custom Method and Snapshots the Catalog` (7 scenarios)
2. `Sale Detail and Timeline Expose the Custom Method Name` (4 scenarios)

Pre-snapshot: 11 requirements (`Bot Sale Registration` → `Remove Endpoint For AUTOMATIC Promotions Feeds The Veto Set`).
Post-snapshot: 13 requirements (11 originals in their original order + 2 appended).

Preserved unchanged: `# Sales Specification` title, `## Purpose`, `## Verification Surface`, and the original 11 requirement blocks verbatim.

### Canonical `sale-payments/spec.md` (APPEND-ONLY)

Appended the four `### Requirement:` blocks from
`openspec/changes/custom-payment-methods/specs/sale-payments/spec.md` `## ADDED Requirements`:

1. `Add-Sale-Payment Resolves a Custom Method and Snapshots the Catalog` (3 scenarios)
2. `Idempotency Hashes Include paymentMethodId` (3 scenarios)
3. `Snapshot Semantics for Historical SalePayments` (2 scenarios)
4. `Refunds on Custom-Method Payments Stay Base-Category` (1 scenario)

Pre-snapshot: 3 requirements (`Sale payment authorization and reviewer routing` → `Cancellation Refund Audit Preserves Payment History`).
Post-snapshot: 7 requirements (3 originals in their original order + 4 appended).

Preserved unchanged: `# sale-payments Specification` title and the original 3 requirement blocks verbatim.

---

## ADDED requirement names

`sales`:
- Charge Resolves a Custom Method and Snapshots the Catalog
- Sale Detail and Timeline Expose the Custom Method Name

`sale-payments`:
- Add-Sale-Payment Resolves a Custom Method and Snapshots the Catalog
- Idempotency Hashes Include paymentMethodId
- Snapshot Semantics for Historical SalePayments
- Refunds on Custom-Method Payments Stay Base-Category

`payment-methods` (new domain — all 7 requirements are net-new canonical content):
- PaymentMethod Model
- PaymentMethod Field Validation
- PaymentMethod Admin CRUD Endpoints
- PaymentMethod RBAC Permissions
- Tenant Isolation of PaymentMethod Reads and Writes
- POS Read Projection of Active Catalog Methods

---

## MODIFIED / REMOVED / RENAMED

None. All three delta specs are pure `## ADDED Requirements`. No
MODIFIED, REMOVED, or RENAMED sections in any delta. No destructive
operations performed; no approval gate required.

---

## Active same-domain collisions

None. Verified before sync:

- Only one active change (`custom-payment-methods`) exists under
  `openspec/changes/`. The 18 others are dated archived entries in
  `openspec/changes/archive/` (most-recent: `2026-08-24-chatbot-sale-flow-blockers`).
- None of the 6 ADDED requirement names exist in the canonical
  `sales/spec.md` or `sale-payments/spec.md` (confirmed by
  `^### Requirement: <name>` grep — zero matches on both files).
- None of the 7 `payment-methods` requirements exist anywhere else
  (the canonical `payment-methods/` directory did not exist prior
  to this sync).
- No `## RENAMED Requirements` sections — RENAMED sync is intentionally
  unsupported and would have triggered a block.

No archive/sync ordering decision is needed; no parent-recorded
ordering exists because there is nothing to order.

---

## Destructive sync approvals

Not applicable. The delta is pure ADDED with no REMOVED or
large-MODIFIED blocks. Guardrail `rules.archive` ("warn before merging
destructive deltas") was not triggered.

---

## Validation checks performed

```text
# 1. Byte-identical copy for new domain
$ diff -q openspec/changes/custom-payment-methods/specs/payment-methods/spec.md \
          openspec/specs/payment-methods/spec.md
OK: byte-identical

# 2. Pre-flight collision check (no existing canonical requirement name overlap)
$ grep '^### Requirement: (Charge Resolves a Custom Method|Sale Detail and Timeline Expose the Custom Method)' \
      openspec/specs/sales/spec.md
No matches found
$ grep '^### Requirement: (Add-Sale-Payment Resolves a Custom Method|Idempotency Hashes Include paymentMethodId|Snapshot Semantics for Historical SalePayments|Refunds on Custom-Method Payments Stay Base-Category)' \
      openspec/specs/sale-payments/spec.md
No matches found

# 3. Existing canonical requirement preservation
$ grep -c '^### Requirement:' openspec/specs/sales/spec.md
13   # 11 original + 2 new
$ grep -c '^### Requirement:' openspec/specs/sale-payments/spec.md
7    #  3 original + 4 new
$ grep -c '^### Requirement:' openspec/specs/payment-methods/spec.md
7    #  7 new (domain created)

# 4. Doc sections preserved in sales
$ grep -n '^## ' openspec/specs/sales/spec.md
3:## Purpose
7:## Requirements
458:## Verification Surface

# 5. No stale delta-section headers leaked into canonical
$ grep '^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements$' \
      openspec/specs/payment-methods/spec.md \
      openspec/specs/sales/spec.md \
      openspec/specs/sale-payments/spec.md
(no output — clean)

# 6. Active-change scope sanity
$ ls openspec/changes/
archive
custom-payment-methods
# Only one active change; no same-domain contention.
```

No native OpenSpec validator (`openspec validate ...`) is in scope; the
executor relies on the structural checks above and on the upstream
verify-report's `npx nest build` / `npx tsc --noEmit` / `npx jest`
clean exit. All three passed per the verify report.

---

## Files NOT touched (intentional)

- `openspec/changes/custom-payment-methods/` was NOT moved to archive —
  the change folder remains active so the parent can run `sdd-archive`
  next.
- No git commit was made; `git status` still shows the in-progress
  implementation diffs alongside the new canonical spec files.
- No child subagents were launched (delegation explicitly forbidden
  for this phase).
- `rules.sync` is not present in `openspec/config.yaml`, so no
  sync-specific config rules were applied.

---

## nextRecommended

`sdd-archive` — the change is verified PASS, sync is clean, all
canonical files are updated, and no destructive ops / collisions /
blockers remain. The parent's deferred actions (run `pnpm test`,
`pnpm build`, bounded WU1/WU2 revert review, archive) are the
lifecycle's responsibility, not this phase's.
