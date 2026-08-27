# Archive Report — `delivery-routes`

**Change**: `delivery-routes`
**Archived**: `2026-08-27` (ISO date — per parent-delegated handoff; matches `sync-report.md` sync date stamp)
**Verdict**: ✅ **PASS — clean archive, single-domain sync (delivery-routes), additive change**

---

## 1. Summary

| Dimension | Result |
|---|---|
| **Verify status** | PASS (full unit suite 211/2929 + integration `markSaleDelivered` 4/4 + `prisma-delivery-route.repository` 9/9; `nest build` exit 0) |
| **Sync status** | `synced` — 1 domain (`delivery-routes`) — 7 drift areas reconciled during sync |
| **Spec compliance** | Canonical `openspec/specs/delivery-routes/spec.md` reconciled to match implemented behavior (ADR-7 single-layer 409, `start` does not re-validate eligibility, outbox payload field shape, etc.) |
| **Tasks** | 55 implementation tasks `[x]` (1.1 through 3.24); 4 unchecked lines are parent-owned lifecycle (`sdd-owner: parent`) — Phase 0 already resolved; Phase 4 bounded-review items declared N/A by parent under ordinary repo policy (RDD OFF) |
| **Tests** | **211 suites / 2929 tests passing** (full unit suite); **13 integration tests passing** (`markSaleDelivered` 4/4 + `prisma-delivery-route.repository` 9/9) |
| **Build** | `pnpm build` (nest build) exit 0; `prisma validate` valid; `prisma migrate deploy` clean (incl. partial unique index + `ALTER TYPE ... ADD VALUE 'DELIVERY_NEXT_STOP'`) |
| **Destructive operations** | None — pure additive (no MODIFIED, REMOVED, RENAMED on any canonical requirement) |
| **Same-domain collisions** | None — only one active change under `openspec/changes/` at archive time |
| **WU chain** | WU1 `d37d261` → WU2 `aad4e40` → WU3 `3b45d19` (stacked-to-`main`) |
| **Verdict** | ✅ Ready to archive |

This change introduces a tenant-scoped **delivery-route bounded context** that groups eligible `Sale`s into an ordered `DeliveryRoute` assigned to a driver `User`. The route goes through a four-state lifecycle (`DRAFT → ACTIVE → COMPLETED` or `DRAFT|ACTIVE → CANCELLED`). Completing a stop atomically flips `DeliveryRouteStop.status` to `COMPLETED`, mirrors `Sale.deliveryStatus = 'DELIVERED'` in the same transaction, and emits a durable `delivery.next_stop.notify` outbox event that drives an opt-in "arriving soon" email through the proven outbox → dedicated poller → Inngest → `MAILER` pipeline. The "one active route per sale" invariant is enforced by a Postgres partial unique index, with `P2002` mapped to HTTP 409. Driver ownership is enforced by a CASL subject-instance re-check in `PermissionsGuard`. The change is fully additive across three stacked WUs.

---

## 2. Artifacts Read

| Artifact | Path | Status |
|---|---|---|
| Proposal | `openspec/changes/delivery-routes/proposal.md` | present |
| Specs (delta) | (none — spec written directly to canonical at `openspec/specs/delivery-routes/spec.md` in commit `0d76621`) | n/a |
| Design | `openspec/changes/delivery-routes/design.md` | present |
| Exploration | `openspec/changes/delivery-routes/exploration.md` | present |
| Tasks | `openspec/changes/delivery-routes/tasks.md` | present (59 lines: 55 implementation + 4 parent lifecycle) |
| Apply progress | `openspec/changes/delivery-routes/apply-progress.md` | present (per-WU verification sections recorded) |
| Verify report | `openspec/changes/delivery-routes/verify-report.md` | present (PASS) |
| Sync report | `openspec/changes/delivery-routes/sync-report.md` | present (status: synced; 7 drift areas reconciled) |
| Config | `openspec/config.yaml` | present (`schema: spec-driven`; `rules.archive: warn before destructive merges`; `apply.tdd: false`) |
| Canonical spec | `openspec/specs/delivery-routes/spec.md` | present (reconciled during sync) |

---

## 3. Specs Synced

Sync was completed by the parent via `sdd-sync` before archive-time handoff; **no archive-time sync fallback was required** (parent's authoritative final-state facts: "Canonical spec reconciled during sync (7 drift areas resolved). sync-report.md + verify-report.md both present"). The change is single-domain — only `delivery-routes` was reconciled into canonical.

| Domain | Operation | Canonical file | Mode |
|---|---|---|---|
| `delivery-routes` | 7 drift areas reconciled in place (no ADDED/MODIFIED/REMOVED headers — the canonical spec was authored directly during the spec phase; sync reconciled the body against the implemented behavior) | `openspec/specs/delivery-routes/spec.md` | appended inline edits (existed) |

### Drift areas reconciled in canonical spec (per `sync-report.md` §3)

| ID | Drift | Resolution |
|---|---|---|
| **D-1** | "One Active Route Per Sale" — pre-sync spec described two-layer enforcement (app pre-check → 422, DB index → 409 race). Implementation is single-layer (DB index → 409 only). | Requirement renamed to *"One Active Route Per Sale (DB Partial Unique Index)"*; body rewritten to single authoritative layer + aggregate DRAFT-gating; scenario renamed to *"DB partial unique index maps P2002 to 409"*. |
| **D-2** | `DeliveryRoute.start()` — pre-sync spec said it re-validated eligibility (422 on ineligible sale). Implementation only asserts DRAFT + ≥1 stop. | Spec body updated: `start()` asserts DRAFT + ≥1 stop only; eligibility enforced upstream at create-time (422) and via DB index at start-time (409). |
| **D-3** | Outbox payload field shape — pre-sync spec used `payload.stops[]`. Implementation uses `payload.stop` (singular; single next-stop event). | Spec payload field renamed `stop` (singular). |
| **D-4** | `DELIVERY_NEXT_STOP` opt-in semantics — pre-sync spec left ambiguity about whether `enabledActions` default includes it. Implementation defaults to included; tenant can opt out via `PUT /notification-config`. | Spec clarified: default `enabledActions` includes `DELIVERY_NEXT_STOP`; tenant opt-out is the disabler; Inngest re-gates at send time (not just emit time). |
| **D-5** | Email lookup authoritativeness — pre-sync spec implied denormalized snapshot. Implementation re-queries `User.email` inside the Inngest function (authoritative). | Spec clarified: Inngest function performs authoritative email lookup at send time; null → skip; not snapshot-based. |
| **D-6** | `Sale.markDelivered` mirror invariant — pre-sync spec said "in same transaction". Implementation uses `runInTransaction` over the route repository, which itself wraps the `Sale` update. | Spec clarified: mirror is written inside the same `runInTransaction` invoked by the route aggregate's `checkInStop`. |
| **D-7** | Claim-disjointness between dedicated outbox poller and generic poller — pre-sync spec was implicit. Implementation uses a dedicated `DedicatedOutboxPollerService` for `delivery.next_stop.notify` rows; the generic poller excludes them via event-name filter. | Spec clarified: dedicated poller claims `delivery.next_stop.notify`; generic poller excludes that event name. |

### ADDED / MODIFIED / REMOVED requirement names

**None.** The canonical `delivery-routes/spec.md` was authored directly during the spec phase (no `openspec/changes/delivery-routes/specs/` delta directory was created). The sync phase reconciled the existing requirement bodies in place; no requirements were added, modified at the heading level, or removed. The `rules.archive` guardrail ("warn before merging destructive deltas") was not triggered; no destructive-merge approval was required.

### Active same-domain collisions

**None.** Verified before archive:
- Only one active change (`delivery-routes`) existed under `openspec/changes/` at archive time.
- No other active change references the `delivery-routes` canonical spec.
- No `## RENAMED Requirements` sections (RENAMED sync is intentionally unsupported and would have blocked).

---

## 4. Task Completion Gate (Final Re-read)

Re-read of `openspec/changes/delivery-routes/tasks.md` immediately before archive execution:

| Metric | Count | Verdict |
|---|---|---|
| Total task checkboxes | 59 | — |
| `- [x]` (complete) | 55 | All `<!-- sdd-owner: implementation -->` owners (1.1 through 3.24) |
| `- [ ]` (unchecked) | 4 | All `<!-- sdd-owner: parent -->` lifecycle |
| Unchecked with `sdd-owner: implementation` | **0** | **Archive gate PASSES** |

### Unchecked lines (all `sdd-owner: parent`)

Lines 157–160 of `tasks.md`:

```text
- [ ] Start or reuse a bounded review for WU1 once the PR is open; verify migration applies on a clean DB and rollback instructions in `design.md §12` are accurate. <!-- sdd-owner: parent -->
- [ ] Start or reuse a bounded review for WU2 once the PR is open; verify CASL/guard extension behavior against the driver-vs-manager matrix in `spec.md` (*Driver Ownership Enforced by CASL Subject-Instance Condition*). <!-- sdd-owner: parent -->
- [ ] Start or reuse a bounded review for WU3 once the PR is open; verify outbox→Inngest→email end-to-end with `Inngest dev` and a local Resend mock, and that `docs/delivery-routes-frontend.md` matches the actual API surface. <!-- sdd-owner: parent -->
- [ ] Run `openspec archive delivery-routes --yes` after all three WUs are merged and CI is green, per `openspec/config.yaml` `archive:` rule ("warn before merging destructive deltas" — this change is additive, no destructive delta). <!-- sdd-owner: parent -->
```

**Disposition:**

- **Phase 0 parent items** (lines 30–31, both `- [x]`): "Confirm review-mode switch state …" and "Resolve `chain_strategy`" — both **resolved** (verified in the tasks file as `[x]`). Review-mode is **OFF** (default, never enabled); `chain_strategy = stacked-to-main`.
- **Phase 4 bounded-review items** (lines 157–159): **explicitly N/A** per parent's authoritative final-state facts — *"Phase 4 parent-owned 'bounded review' items are NOT applicable because receipt-driven development is OFF (decided by default); delivery follows ordinary repository policy, not RDD review gates."* These are not stale implementation checkboxes; they are parent-owned lifecycle items that the parent has determined are inapplicable under ordinary repo policy. No checkbox repair required.
- **Phase 4 archive-lifecycle item** (line 160): being performed by this archive invocation. Will be marked closed by parent after archive completes (out of archive's blocking scope; matches the `custom-payment-methods` precedent).

No mechanical checkbox reconciliation was performed at archive time because no implementation checkbox is stale — every `- [ ]` line is intentionally a parent-lifecycle gate, and the parent's authoritative handoff explicitly resolves them.

---

## 5. Final-State Reconciliation (Authoritative Parent Handoff)

The parent provided authoritative final-state facts that outrank any stale snapshot in `apply-progress.md` or `tasks.md`:

- **WU1** (`d37d261`) — Prisma models (`DeliveryRoute`, `DeliveryRouteStop`), additive migration with partial unique index `delivery_route_stops_active_sale_uniq`, standalone `ALTER TYPE` migration adding `DELIVERY_NEXT_STOP` to `NotificationActionKey`, `TENANT_SCOPED_MODELS` entries, `AppSubjects`/`PERMISSION_REGISTRY` extension, `NotificationActionKey` union widening.
- **WU2** (`aad4e40`) — Bounded context `src/delivery-routes/**` (domain, application, infrastructure, presentation, dto, module), `IRouteOptimizer` port + `ManualRouteOptimizer` adapter, narrow `Sale.markDelivered` + `ISaleRepository.markSaleDelivered`, `SUBJECT_INSTANCE_RESOLVERS` seam + `PermissionsGuard` change, list-scope discriminator.
- **WU3** (`3b45d19`) — Dedicated outbox poller + dispatcher, Inngest function + React Email template, `DeliveryRouteResponseDto` + `buildDeliveryRouteTimeline`, integration specs, NotificationActionKey drift spec, `docs/delivery-routes-frontend.md`, final `pnpm test` + `pnpm build` gates.

### Final test/build state (re-verified by parent)

| Gate | Result |
|---|---|
| `pnpm build` (nest build) | exit 0 (green) |
| `pnpm prisma validate` | valid |
| `pnpm prisma generate` | client regenerated |
| `prisma migrate deploy` (test DB 5433) | all migrations applied, incl. partial unique index + `ALTER TYPE ... ADD VALUE 'DELIVERY_NEXT_STOP'` |
| `jest --config jest.config.js` (full unit suite) | **211 suites / 2929 tests passed** |
| `jest --config jest.integration.config.js --runInBand` (`markSaleDelivered`) | 4/4 passed |
| `jest --config jest.integration.config.js --runInBand` (`prisma-delivery-route.repository`) | 9/9 passed (ADR-7 P2002 → 409 verified against real Postgres) |

### Key behavioral invariants verified

- **ADR-7 invariant** — partial unique index `delivery_route_stops_active_sale_uniq` exists on Postgres (verified via `pg_indexes`); real `P2002` → `DeliveryRouteSaleAlreadyInActiveRouteError` → HTTP 409 via `DomainExceptionFilter`.
- **Driver ownership (ADR-5)** — CASL subject-instance re-check in `PermissionsGuard` verified at runtime: string subjects short-circuit condition matching, tagged-instance re-check evaluates `{ driverUserId }`. Own route passes; other driver's route → 403.
- **`Sale.markDelivered`** — idempotent, status-only mirror, cross-tenant is a hard `P2025` (no mutation).
- **Email pipeline** — outbox row written inside `checkInStop` transaction; Inngest function re-gates on `DELIVERY_NEXT_STOP` config + authoritative email lookup, null-skip, `MAILER` send.

---

## 6. Non-blocking Findings

None. The verify report's PASS verdict is sustained. No CRITICAL, BLOCKED, or FAIL findings. No WARNING-level findings. The 7 drift areas were reconciled during sync, not flagged as defects.

---

## 7. Archive Move

```text
openspec/changes/delivery-routes/   →   openspec/changes/archive/2026-08-27-delivery-routes/
```

The active changes directory no longer contains `delivery-routes`; the dated archive folder is created at `openspec/changes/archive/2026-08-27-delivery-routes/`. The archive is an audit trail — archived contents are preserved without modification.

### Archived folder contents (preserved for audit)

- `proposal.md` ✅
- `exploration.md` ✅ (exploration artifact kept)
- `design.md` ✅
- `tasks.md` ✅ (55/55 implementation `[x]`; 4 parent lifecycle `- [ ]` resolved as N/A per parent)
- `apply-progress.md` ✅ (per-WU verification sections recorded)
- `verify-report.md` ✅ (verdict PASS)
- `sync-report.md` ✅ (status: synced; 7 drift areas reconciled)
- `archive-report.md` ✅ (this document)
- `README.md` ✅ (change-level readme, kept)
- *(no `specs/` subfolder — the spec was authored directly at canonical path)*

### Files NOT touched (intentional)

- `openspec/specs/delivery-routes/spec.md` — canonical spec, reconciled during sync; archive did not modify it.
- No `src/` or `prisma/` modifications — out of archive scope per parent delegation ("Do NOT modify src/ or prisma/").
- No tests/build re-run — already verified by parent per delegation ("Do NOT run tests/build (already verified)").
- No git commit — per parent delegation ("Do NOT commit (the parent orchestrator commits)").
- No child subagents were launched (delegation explicitly forbidden for this phase per system policy).

---

## 8. Structured Status (Archive-Close)

```yaml
schemaName: spec-driven
changeName: delivery-routes
artifactStore: openspec
artifactPaths:
  proposal: [openspec/changes/archive/2026-08-27-delivery-routes/proposal.md]
  specs:
    - openspec/specs/delivery-routes/spec.md
  design: [openspec/changes/archive/2026-08-27-delivery-routes/design.md]
  tasks: [openspec/changes/archive/2026-08-27-delivery-routes/tasks.md]
  applyProgress: [openspec/changes/archive/2026-08-27-delivery-routes/apply-progress.md]
  verifyReport: [openspec/changes/archive/2026-08-27-delivery-routes/verify-report.md]
  syncReport: [openspec/changes/archive/2026-08-27-delivery-routes/sync-report.md]
  archiveReport: [openspec/changes/archive/2026-08-27-delivery-routes/archive-report.md]
artifacts:
  proposal: archived
  specs: synced (canonical unchanged since sync; no further edits at archive)
  design: archived
  tasks: archived (55/55 implementation complete)
  applyProgress: archived
  verifyReport: archived (PASS)
  syncReport: archived (synced)
  archiveReport: written (this file)
taskProgress:
  total: 59
  complete: 55
  remaining: 4
  uncheckedParentLifecycle: 4
  uncheckedImplementation: 0
  parentLifecycleDisposition:
    phase0_review_mode: resolved (RDD off by default; ordinary repo policy)
    phase0_chain_strategy: resolved (stacked-to-main)
    phase4_bounded_review_WU1: N/A per parent (RDD off; ordinary repo policy)
    phase4_bounded_review_WU2: N/A per parent (RDD off; ordinary repo policy)
    phase4_bounded_review_WU3: N/A per parent (RDD off; ordinary repo policy)
    phase4_archive_lifecycle: closed-by-this-archive
applyState: all_done
dependencies:
  apply: all_done
  verify: all_done
  sync: done
  archive: done
actionContext:
  mode: repo-local
  workspaceRoot: /home/aldrich/Escritorio/workspace/houndfe/houndfe-backend
  allowedEditRoots: [/home/aldrich/Escritorio/workspace/houndfe/houndfe-backend]
  warnings: []
isNonAuthoritative: false
archivedPath: openspec/changes/archive/2026-08-27-delivery-routes
archivedAt: 2026-08-27
nextRecommended: close-sdd-change (parent lifecycle)
skillResolution: paths-injected
```

`actionContext.mode` is `repo-local` (not `workspace-planning`), so the empty-`allowedEditRoots` guard does not apply. Workspace path matches the verify-report claim and the parent's repository reference.

---

## 9. Destructive Merge Approvals

Not applicable. The canonical spec had no ADDED/MODIFIED/REMOVED requirement-level headings applied at archive time — sync reconciled bodies inline during `sdd-sync` (no destructive delta). The `rules.archive` "warn before merging destructive deltas" guardrail was not triggered. No parent approval for destructive sync was required.

---

## 10. Verdict

✅ **Clean archive.** The `delivery-routes` change is verified PASS, synced (1 domain — `delivery-routes`), task-complete (55/55 implementation `[x]`), and all final-state production tests/integration/build gates are green per the parent's authoritative final-state facts. The 4 unchecked parent lifecycle lines are explicitly resolved: Phase 0 items are `[x]`, Phase 4 bounded-review items are explicitly N/A per parent under ordinary repo policy (RDD OFF), and the Phase 4 archive-lifecycle item is being closed by this invocation. No CRITICAL, BLOCKED, or FAIL findings remain. Archive is unblocked.

**Archived to:** `openspec/changes/archive/2026-08-27-delivery-routes/`
**Date:** `2026-08-27`
