# Archive Report — `custom-payment-methods`

**Change**: `custom-payment-methods`
**Archived**: `2026-08-26` (ISO date — today's archive stamp)
**Verdict**: ✅ **PASS — clean archive, pure ADDED sync**

---

## 1. Summary

| Dimension | Result |
|---|---|
| **Verify status** | PASS (re-verification, both prior CRITICAL blockers B1 + B2 resolved) |
| **Sync status** | synced (3 domains — 1 NEW, 2 APPEND-ONLY) |
| **Spec compliance** | 13 requirements merged across 3 canonical specs (1 new domain + 6 ADDED across 2 existing domains) |
| **Tasks** | 46/46 implementation tasks `[x]`; 4 unchecked lines are parent-owned lifecycle (out of archive-blocking scope; see §4) |
| **Tests** | 204 suites / 2850 tests passing (full unit suite, exit 0; +32 tests vs init baseline 199/2735) |
| **Build** | `npx nest build` exit 0; `npx tsc --noEmit` exit 0 |
| **Destructive operations** | None — pure ADDED (no MODIFIED, REMOVED, RENAMED) |
| **Same-domain collisions** | None — only one active change under `openspec/changes/` |
| **Verdict** | ✅ Ready to archive |

This change introduces a tenant-scoped, admin-configurable **payment method catalog** for the POS surface, with branded tender methods mapped to one of four base categories (`cash | card_credit | card_debit | transfer`). Charging and add-payment accept an optional `paymentMethodId`; the backend resolves the base category for the canonical `SalePayment.method` and writes a `{ paymentMethodId, name, subtitle }` snapshot into `SalePayment.metadataJson.catalog`. The custom name flows through to sale detail, the `PAYMENT_RECEIVED` timeline event, and the receipt PDF. Legacy flows (no `paymentMethodId`), the "A Crédito" built-in, refunds, idempotency, the WhatsApp bot, and all existing `SalePaymentMethod` semantics are untouched.

---

## 2. Artifacts Read

| Artifact | Path | Status |
|---|---|---|
| Proposal | `openspec/changes/custom-payment-methods/proposal.md` | present |
| Specs (delta) | `openspec/changes/custom-payment-methods/specs/{payment-methods,sales,sale-payments}/spec.md` | present (3 files) |
| Design | `openspec/changes/custom-payment-methods/design.md` | present |
| Tasks | `openspec/changes/custom-payment-methods/tasks.md` | present (50 owners: 46 implementation, 4 parent) |
| Apply progress | `openspec/changes/custom-payment-methods/apply-progress.md` | present |
| Verify report | `openspec/changes/custom-payment-methods/verify-report.md` | present (PASS, re-verification) |
| Sync report | `openspec/changes/custom-payment-methods/sync-report.md` | present (status: synced) |
| Config | `openspec/config.yaml` | present (`apply.tdd: false`, `archive` rule: warn before destructive merges) |

---

## 3. Specs Synced

Sync was completed by the parent before archive-time handoff; no archive-time sync fallback was required.

| Domain | Operation | Canonical file | Mode |
|---|---|---|---|
| `payment-methods` | NEW domain (full copy) | `openspec/specs/payment-methods/spec.md` | created (file did not exist) |
| `sales` | `## ADDED Requirements` × 2 | `openspec/specs/sales/spec.md` | append-only (existed) |
| `sale-payments` | `## ADDED Requirements` × 4 | `openspec/specs/sale-payments/spec.md` | append-only (existed) |

### ADDED requirement names (6 total + 7 net-new canonical)

**`sales` (2 added, appended):**
- `Charge Resolves a Custom Method and Snapshots the Catalog`
- `Sale Detail and Timeline Expose the Custom Method Name`

**`sale-payments` (4 added, appended):**
- `Add-Sale-Payment Resolves a Custom Method and Snapshots the Catalog`
- `Idempotency Hashes Include paymentMethodId`
- `Snapshot Semantics for Historical SalePayments`
- `Refunds on Custom-Method Payments Stay Base-Category`

**`payment-methods` (7 net-new, new domain — full copy of delta spec):**
- `PaymentMethod Model`
- `PaymentMethod Field Validation`
- `PaymentMethod Admin CRUD Endpoints`
- `PaymentMethod RBAC Permissions`
- `Tenant Isolation of PaymentMethod Reads and Writes`
- `POS Read Projection of Active Catalog Methods`
- *(plus the canonical `## Purpose`, `## Verification Surface`, and `## Notes for Implementation` sections)*

### MODIFIED / REMOVED / RENAMED

**None.** All three delta specs are pure `## ADDED Requirements`. No MODIFIED, REMOVED, or RENAMED sections. The `rules.archive` guardrail ("warn before merging destructive deltas") was not triggered; no destructive-merge approval was required.

### Active same-domain collisions

**None.** Verified before sync (per sync-report §"Active same-domain collisions"):
- Only one active change (`custom-payment-methods`) existed under `openspec/changes/`.
- None of the 6 ADDED requirement names exist in the canonical `sales/spec.md` or `sale-payments/spec.md`.
- None of the 7 `payment-methods` requirements exist anywhere else (the canonical `payment-methods/` directory did not exist prior to this sync).
- No `## RENAMED Requirements` sections (RENAMED sync is intentionally unsupported and would have blocked).

### Post-merge requirement counts (canonical)

- `openspec/specs/payment-methods/spec.md` — 7 requirements (all new)
- `openspec/specs/sales/spec.md` — 11 → 13 (11 original preserved + 2 appended)
- `openspec/specs/sale-payments/spec.md` — 3 → 7 (3 original preserved + 4 appended)

---

## 4. Task Completion Gate (Final Re-read)

Re-read of `openspec/changes/custom-payment-methods/tasks.md` immediately before archive execution:

| Metric | Count | Verdict |
|---|---|---|
| Total task checkboxes | 50 | — |
| `- [x]` (complete) | 46 | All `<!-- sdd-owner: implementation -->` owners |
| `- [ ]` (unchecked) | 4 | All `<!-- sdd-owner: parent -->` lifecycle actions |
| Unchecked with `sdd-owner: implementation` | **0** | **Archive gate PASSES** |

The 4 unchecked lines are explicitly **parent-owned lifecycle** (`<!-- sdd-owner: parent -->`), not implementation work:

```text
- [ ] After the implementation PR is merged, run `pnpm test` at the repo root and confirm all unit specs ... <!-- sdd-owner: parent -->
- [ ] Run `pnpm build` and confirm a clean compile ... <!-- sdd-owner: parent -->
- [ ] Perform a bounded review against the design's WU1/WU2 revert boundaries ... <!-- sdd-owner: parent -->
- [ ] Apply the change lifecycle: archive `openspec/changes/custom-payment-methods/` per the OpenSpec archive rule, then close the SDD change. <!-- sdd-owner: parent -->
```

These are deferred parent actions (post-verify bounded review and the archive lifecycle itself) and are out of `sdd-archive`'s blocking scope. No mechanical checkbox reconciliation was performed at archive time because no implementation checkbox is stale — every `- [ ]` line is intentionally a parent-lifecycle gate.

The verify report corroborates this state with a `^\s*- \[ \].*sdd-owner: implementation` scan returning **nothing**.

---

## 5. Final-State Handoff (Post-sync, Post-verify Reconciliation)

The verify-report.md was authored BEFORE the parent resolved two non-blocking WARNING findings. The actual final-state facts — recorded in `apply-progress.md` (Round 2 + production remediation) and corroborated by re-verification — are:

### B1 — Add-payment idempotency hash (production, RESOLVED)

`src/sales/sales.service.ts` `addPayment` now passes `normalizedPayments` DIRECTLY to `sortPaymentsForHash` (removed the prior `.map(({ method, amountCents, reference }) => ...)` that silently stripped `paymentMethodId`). This matches the charge path (`sales.service.ts:2414`).

**Why this matters:** the prior `.map()` projection violated the `sale-payments/spec.md` "Idempotency Hashes Include paymentMethodId" requirement (spec D8 + task 2.4), enabling silent same-category collisions — e.g., two custom `transfer` methods (`Mercado Pago`, `OXXO Pay`) at the same amount would hash identically and one would silently replay the other.

**Verification:** `npx nest build` exit 0; full unit suite = **204 suites / 2850 tests passing** (exit 0). The new `sales.service.spec.ts` idempotency tests (charge + collection, 3 each) include a non-tautological collision regression that computes the hash independently in the test body via `crypto.createHash('sha256')` and asserts that two payments sharing `{ method, amountCents }` but with different `paymentMethodId` produce distinct hashes.

### Add-payment type-hygiene fix (production, RESOLVED)

The `addPayment` inline `dto` object type now declares `paymentMethodId?` on **both** the legacy single-payment branch and the `payments[]` array branch. This prevents a future edit from silently re-introducing B1 by widening the DTO without a matching type declaration — `paymentMethodId` now flows from the controller DTO into `normalizeCollectionRequestPayments` and into the hash without `as never` casts.

**Verification:** `npx tsc --noEmit` (production, non-spec) exit 0.

### Test summary

- Round-1 baseline: 199 suites / 2735 tests
- Round-2 final: 204 suites / 2850 tests (net +32 tests across WU2 idempotency + collection threading + getSaleDetail + repository mapper + build-sale-timeline + payments-list snapshot tests)

---

## 6. Non-blocking WARN Findings (Closed Out)

The verify report listed two WARNING-level findings (W1 + W2) as non-blocking. Both are now resolved in the production code per §5:

- **W1 (apply-progress.md did not record the B1 production fix):** now recorded in `apply-progress.md` "Round 2 — WU2 unit specs + production remediation" — the two production edits (B1 hash fix + addPayment type-hygiene fix) are explicitly documented alongside the test round.
- **W2 (addPayment inline DTO type omitted `paymentMethodId`):** now fixed in production via the inline `dto` type widening.

No new CRITICAL / BLOCKED findings. The verify report's PASS verdict is sustained.

---

## 7. Archive Move

```text
openspec/changes/custom-payment-methods/   →   openspec/changes/archive/2026-08-26-custom-payment-methods/
```

The active changes directory no longer contains `custom-payment-methods`; the dated archive folder is created at `openspec/changes/archive/2026-08-26-custom-payment-methods/`. The archive is an audit trail — archived contents are preserved without modification.

### Archived folder contents (preserved for audit)

- `proposal.md` ✅
- `explore.md` ✅ (exploration artifact kept)
- `design.md` ✅
- `tasks.md` ✅ (46/46 implementation `[x]` + 4 parent lifecycle `- [ ]`)
- `apply-progress.md` ✅ (incl. Round 2 + production remediation)
- `verify-report.md` ✅ (verdict PASS)
- `sync-report.md` ✅ (status: synced)
- `archive-report.md` ✅ (this document)
- `specs/payment-methods/spec.md` ✅ (delta, archived for audit trail)
- `specs/sales/spec.md` ✅ (delta, archived for audit trail)
- `specs/sale-payments/spec.md` ✅ (delta, archived for audit trail)

### Files NOT touched (intentional)

- `openspec/specs/**` — already synced by `sdd-sync`; archive did not modify canonical specs.
- No git commit was made (per parent delegation: "Do NOT commit").
- No child subagents were launched (delegation explicitly forbidden for this phase).
- `openspec/changes/archive/2026-08-26-custom-payment-methods/` content is preserved byte-identical to the active folder at move time.

---

## 8. Structured Status (Archive-Close)

```yaml
schemaName: spec-driven
changeName: custom-payment-methods
artifactStore: openspec
artifactPaths:
  proposal: [openspec/changes/archive/2026-08-26-custom-payment-methods/proposal.md]
  specs:
    - openspec/changes/archive/2026-08-26-custom-payment-methods/specs/payment-methods/spec.md
    - openspec/changes/archive/2026-08-26-custom-payment-methods/specs/sales/spec.md
    - openspec/changes/archive/2026-08-26-custom-payment-methods/specs/sale-payments/spec.md
    - openspec/specs/payment-methods/spec.md
    - openspec/specs/sales/spec.md
    - openspec/specs/sale-payments/spec.md
  design: [openspec/changes/archive/2026-08-26-custom-payment-methods/design.md]
  tasks: [openspec/changes/archive/2026-08-26-custom-payment-methods/tasks.md]
  applyProgress: [openspec/changes/archive/2026-08-26-custom-payment-methods/apply-progress.md]
  verifyReport: [openspec/changes/archive/2026-08-26-custom-payment-methods/verify-report.md]
  syncReport: [openspec/changes/archive/2026-08-26-custom-payment-methods/sync-report.md]
  archiveReport: [openspec/changes/archive/2026-08-26-custom-payment-methods/archive-report.md]
artifacts:
  proposal: archived
  specs: archived + synced
  design: archived
  tasks: archived (46/46 implementation complete)
  applyProgress: archived
  verifyReport: archived (PASS)
  syncReport: archived (synced)
  archiveReport: written (this file)
taskProgress:
  total: 50
  complete: 46
  remaining: 4
  uncheckedParentLifecycle: 4
  uncheckedImplementation: 0
applyState: all_done
dependencies:
  apply: all_done
  verify: all_done
  sync: done
  archive: done
actionContext:
  mode: repo-local
  workspaceRoot: /Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend
  allowedEditRoots: [/Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend]
  warnings: []
isNonAuthoritative: false
archivedPath: openspec/changes/archive/2026-08-26-custom-payment-methods
nextRecommended: close-sdd-change (parent lifecycle)
skillResolution: paths-injected
```

`actionContext.mode` is `repo-local` (not `workspace-planning`), so the empty-`allowedEditRoots` guard does not apply. Workspace path matches the verify-report claim.

---

## 9. Destructive Merge Approvals

Not applicable. The delta is pure ADDED with no REMOVED or large-MODIFIED blocks. The `rules.archive` "warn before merging destructive deltas" guardrail was not triggered. No parent approval for destructive sync was required.

---

## 10. Verdict

✅ **Clean archive.** The `custom-payment-methods` change is verified PASS, synced (3 domains), task-complete (46/46 implementation `[x]`), and the final-state production remediations (B1 idempotency hash + addPayment type-hygiene) are documented in `apply-progress.md`. The 4 unchecked parent lifecycle lines are deferred parent actions (post-merge review gates and the archive lifecycle itself) and are explicitly out of `sdd-archive`'s blocking scope. No CRITICAL, BLOCKED, or FAIL findings remain. Archive is unblocked.

**Archived to:** `openspec/changes/archive/2026-08-26-custom-payment-methods/`
**Date:** `2026-08-26`
