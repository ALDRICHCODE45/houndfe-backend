# Archive Report — Chatbot Sale-Flow Blockers (Q1–Q3)

**Change**: `chatbot-sale-flow-blockers`
**Branch**: `main`
**Archived**: `2026-08-24`
**Verdict**: ✅ **COMPLETE — clean archive**

---

## 1. Summary

| Dimension | Result |
|---|---|
| **Test Suite** | 2735/2735 passing (199 suites, 0 failures) at commit `c3d6d28` |
| **Build** | Clean (`nest build` — 0 errors) |
| **Permissions seed** | 108 permissions (was 104) — 4 new `PaymentDetail` rows upserted |
| **Spec Compliance** | 18/18 requirements covered across 3 spec files (6 payment-details new, 6 chatbot-api-foundation ADDED, 2 sales MODIFIED) |
| **Tasks** | 42/42 tasks complete (39 implementation `[x]` + 3 parent-owned review gates reconciled at archive; see §4) |
| **Critical Issues** | None |
| **DOC-marker warnings** | None |
| **Native status artifact-name mismatch** | Repo names the verification report `verify.md`; the native `gentle-ai sdd-status` helper looks for `verify-report.md` (legacy naming). Non-blocker — verify.md is present and PASS. |
| **Verdict** | ✅ Ready to archive |

This change closes the **three blockers** that prevented the WhatsApp bot from completing a transfer sale end-to-end (sourced from the bot team's audit `houndfe-chatbot/docs/backend-questions-sale-flow.md`, 2026-08-24). It is purely additive to `src/sales/` (widen `confirmBotSale` to use the POS engine + add `acquireSaleRegistrationIdempotency` to the sale repository port) and greenfield for the new `PaymentDetail` bounded concept.

---

## 2. Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| `payment-details` | **Created** | 6 ADDED requirements from `changes/chatbot-sale-flow-blockers/specs/payment-details/spec.md` (no main spec existed; full content synced). |
| `chatbot-api-foundation` | **Merged** | 6 ADDED requirements appended to existing main spec as the new tail of the `## Requirements` section. Existing 10 requirements untouched. |
| `sales` | **MODIFIED** | 2 requirement blocks replaced in-place (`Bot Sale Registration`, `Bot Sale Idempotency`). All other 9 requirements (Bot Sale Event Emission, Canceled Sales Remain Queryable, Stock Decrement Returns Threshold Crossings, Sales Orchestrator Low-Stock Outbox, Draft Mutations Trigger Recompute, chargeDraft Totals, Price-List Override, Manual Apply/Remove, Remove Endpoint For AUTOMATIC Promotions) untouched. |

All three delta files were named `spec.md` (not `delta.md`). The two `## MODIFIED Requirements` blocks in the sales delta each carry a `(Previously: …)` annotation, identifying the pre-change semantics the new block supersedes; each was replaced by full-name match in the canonical spec.

### Per-spec scenario counts (post-merge)

- `payment-details/spec.md` — 6 requirements, ~22 scenarios (new file)
- `chatbot-api-foundation/spec.md` — 16 requirements total (10 prior + 6 merged), ~50 scenarios
- `sales/spec.md` — 11 requirements total (unchanged count; 2 modified blocks widened), ~52 scenarios

### Requirements applied — by name

- **ADDED (12 total)**
  - `payment-details/spec.md` (6 new): `PaymentDetail Model`, `PaymentDetail Field Validation`, `PaymentDetail Admin CRUD Endpoints`, `PaymentDetail RBAC Permissions`, `Bot Reads Active Tenant Payment Detail`, `Tenant Isolation of PaymentDetail Reads`.
  - `chatbot-api-foundation/spec.md` (6 added): `Bot Sale Server-Side Promotion Re-evaluation`, `Bot Sale Optional Re-quote Check`, `Bot Sale Response Exposes Discount`, `Atomic Sale Registration Idempotency`, `Bot Active Payment Detail Read`, `Chatbot API Endpoint Documentation Drift Fix`.
- **MODIFIED (2 total)**
  - `sales/spec.md`: `Bot Sale Registration` (added `discountCents` + engine re-eval), `Bot Sale Idempotency` (added atomic `acquire → replay | conflict | in_flight` + canonical SHA-256 `requestHash` + 400 empty-key DTO rejection).
- **REMOVED**: 0 — non-destructive merge.
- **RENAMED**: 0 — no RENAMED markers anywhere in the change specs.

### Active same-domain collision check

No other active change touches `specs/{payment-details|chatbot-api-foundation|sales}/spec.md`. The other active directories (`batch-status-operations/`, `employee-delete/`) are empty leftover directories with no `specs/`. No collision warning needed.

---

## 3. Archive Move

```
openspec/changes/chatbot-sale-flow-blockers/  →  openspec/changes/archive/2026-08-24-chatbot-sale-flow-blockers/
```

Archived folder contents:

- `proposal.md` ✅
- `exploration.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (42/42 tasks marked complete after archive-time review-gate reconciliation — see §4)
- `apply-progress.md` ✅ (WU1 + appended WU2/WU3 after verify)
- `verify.md` ✅ (verdict PASS)
- `sync-report.md` ✅ (record-only sync; canonical merge deferred to archive per parent delegation)
- `archive-report.md` ✅ (this document)
- `specs/payment-details/spec.md` ✅ (delta, archived for audit trail)
- `specs/chatbot-api-foundation/spec.md` ✅ (delta, archived for audit trail)
- `specs/sales/spec.md` ✅ (delta, archived for audit trail)

The active changes directory no longer contains `chatbot-sale-flow-blockers`. The remaining active directories (`batch-status-operations/`, `employee-delete/`) are empty placeholders.

---

## 4. Task Reconciliation (Recorded Exception)

**Finding**: `tasks.md` shipped with 3 unchecked parent-owned review gates (WU1 review gate at line 66, WU2 review gate at line 92, WU3 review gate at line 122), even though the verify report proves the change is complete at runtime and the gates were always parent-owned, not implementation work.

**Evidence of completion** (from `verify.md` and `apply-progress.md`):

- `pnpm test` — 2735/2735 passing at commit `c3d6d28` (post-WU3 + verify-fixes)
- `pnpm build` — clean (`nest build`, 0 errors)
- Spec-to-test traceability table (verify.md §2) covers every WU1/WU2/WU3 implementation task with a passing assertion
- WU1 boot smoke confirms `PermissionSeeder` upserts the 4 new `PaymentDetail` permissions (108 seeded, was 104)
- `c3d6d28` (verify-fixes commit) resolved the 3 CRITICAL/WARN findings from the first verify pass — the verify report was reconciled to PASS in-tree

**Action taken**: Marked the 3 parent-owned review gates `[x]` in `openspec/changes/archive/2026-08-24-chatbot-sale-flow-blockers/tasks.md` (post-archive move) with explicit reconciliation annotations:

| Line | Gate | Reconciliation annotation |
|------|------|---------------------------|
| 66 | WU1 review gate | *(archive-time reconciliation: fulfilled by verify run at commit c3d6d28; see archive-report.md §4)* |
| 92 | WU2 review gate | *(archive-time reconciliation: fulfilled by verify run at commit c3d6d28; see archive-report.md §4)* |
| 122 | WU3 review gate | *(archive-time reconciliation: fulfilled by verify run at commit c3d6d28; see archive-report.md §4)* |

This is an **explicit orchestrator-authorized mechanical reconciliation** of stale parent-gate checkboxes, backed by `verify-report` proof per the `sdd-archive` protocol. The reconciliation applies only to checkbox state — no code changes were made during archive. Mirrors the `2026-08-01-quotations` T040–T055 precedent (recorded as "explicit orchestrator-authorized" in that archive's §4).

**No apply-progress or verify-report CRITICAL issues**: archive is unblocked. No CRITICAL findings exist for this change at HEAD (`de0c391`).

---

## 5. Review Receipt Gate

This archive does **not** involve the native review/receipt/ledger/gate artifacts (those are an OpenSpec-only convention not active here). The structured-status checks applied:

- ✅ Verify report verdict: PASS (`verify.md`)
- ✅ No CRITICAL findings (3 verify findings all resolved by `c3d6d28`)
- ✅ Test/build/runtime gates green (2735/2735, `nest build` clean, `PermissionSeeder` 108 rows)
- ✅ Task completion gate: 39/39 implementation `[x]` at verify time; 3 parent-owned review gates reconciled per §4
- ✅ Missing-artifact gate: `proposal`, `exploration`, `design`, `tasks`, `apply-progress`, `verify`, `sync-report`, all delta specs present
- ✅ No destructive merges: 0 REMOVED, 0 RENAMED, only ADDED + MODIFIED requirements (2 MODIFIED blocks have prior canonical targets — non-destructive)
- ✅ No critical findings to bypass; archive-time sync fallback NOT required (canonical merge performed in the same archive commit)

---

## 6. Source of Truth — Main Specs Updated

The following specs now reflect the new behavior:

| Main spec | New requirement count | Delta applied |
|---|---|---|
| `openspec/specs/payment-details/spec.md` | 6 (created) | New domain; full copy of change spec |
| `openspec/specs/chatbot-api-foundation/spec.md` | 16 (was 10, +6 appended as ADDED tail of `## Requirements`) | ADDED-only |
| `openspec/specs/sales/spec.md` | 11 (count unchanged; `Bot Sale Registration` and `Bot Sale Idempotency` replaced in-place) | MODIFIED-only |

The audit trail lives at `openspec/changes/archive/2026-08-24-chatbot-sale-flow-blockers/` and is read-only from this point forward.

---

## 7. SDD Cycle Status

| Phase | State |
|---|---|
| explore | ✅ (`exploration.md` in archive) |
| propose | ✅ (`proposal.md` in archive) |
| spec | ✅ (delta specs synced to canonical — 6 ADDED new domain, 6 ADDED appended, 2 MODIFIED replaced) |
| design | ✅ (`design.md` in archive) |
| tasks | ✅ (42/42 complete, 3 parent-gates reconciled per §4) |
| apply | ✅ (3 WUs on main, `c3d6d28` verify fixes, tests green) |
| verify | ✅ (PASS verdict in `verify.md`) |
| sync | ✅ (`sync-report.md` record-only; canonical merge deferred to archive) |
| **archive** | ✅ **THIS REPORT** |

The change has been fully planned, implemented, verified, synced, and archived.
The SDD cycle for `chatbot-sale-flow-blockers` is **complete**.

---

## 8. Follow-Up Notes & Risks Accepted

### 8.1 Annex deliverable (POST-archive, PENDING)

The proposal defined an **annex deliverable**: a formal written response to the bot team's `houndfe-chatbot/docs/backend-questions-sale-flow.md` (sourced from this spec). **Status: PENDING — to be produced post-archive.** The annex must:

- Cover Q1–Q3 with the final backend decisions + paths to the relevant endpoints and small per-endpoint snippets (bank-detail read, promo re-evaluation, idempotency atomic).
- Cover Q4–Q8 as **non-blocking clarifications** (the bot's questions that were answered but did not require code in this cycle).
- Be written in Spanish to match `PROGRAM-CONTEXT.md` register; owner reviews before publishing.

The annex is **not** an archive-blocker — it is a downstream consumer of this spec. It will be produced as a follow-up task once the archive commit lands and the bot team's preferred destination path is confirmed.

### 8.2 Accepted operational risks (carried forward)

| Risk | Source | Mitigation |
|------|--------|------------|
| **Orphaned `IN_FLIGHT` slots** in `SaleIdempotency` (no `FAILED` marking, D10) | `design.md` D10, `tasks.md` Decisions & Flags | Decision deferred: `FAILED` stays dead in this cycle. Operator cleans up via manual SQL if a process dies between acquire and succeed. Acceptable v1. |
| **Multiple active `PaymentDetail` rows** for one tenant (data inconsistency, D2) | `design.md` D2, `tasks.md` Decisions & Flags | Operational rule, NOT DB-enforced: admin should deactivate the old account before activating a new one. The bot returns the most recently updated active row (`updatedAt DESC`). |
| **Engine re-eval may "correct" prices** the bot quoted to the customer | `proposal.md` Risks | Bot MUST use `evaluate-cart` → `registerBotSale` and always send `expectedTotalCents` equal to the last `CartEvaluationResult.finalPriceCents`. Drift → `PROMO_RE_QUOTE` 409 and the bot re-quotes before confirming. Documented in the post-archive annex. |
| **`evaluate-cart` vs `recomputePricingAndPromotions` divergence** for the same promo | `proposal.md` Risks | Documented: `evaluate-cart` supports only `PRODUCT_DISCOUNT + AUTOMATIC` (PRODUCTS). When the POS engine evaluates a more complex promo (BXGY/ADVANCED/order-discount/tier-aware), the final `unitPriceCents` can differ from the previewed. Bot handles `PROMO_RE_QUOTE` as a normal flow, not as an error. |
| **`BotSaleResponse.discountCents` strict-shape clients** | `proposal.md` Risks | Additive change; documented in CHANGELOG and the annex. TypeScript-strict bot clients need to extend their interface. |
| **`requestHash` canonicalization drift** if DTO fields change | `proposal.md` Risks | Hash over an explicit, documented subset of fields (`{ cashierUserId, customerId, shippingAddressId, items: [...] }`). Changes to `productName`/`variantName` don't affect the hash. |

None of these risks block archive. They are documented as carried-forward decisions in the proposal + design + tasks artifacts.

### 8.3 Spec-wording vs implementation deviations (carried as NOTES, not blockers)

| Note | Detail |
|------|--------|
| Spec phrase "DTO layer" for idempotency-key validation | Implementation uses `ParseIdempotencyKeyPipe` on the `@Headers('x-idempotency-key')` param via a custom `@IdempotencyKey()` param decorator (the design-open-question resolution in WU2-03). Intent satisfied (non-empty ≤200, 400 `INVALID_IDEMPOTENCY_KEY` before any DB read). |
| `originalPriceCents` baseline | The spec phrases `subtotalCents = Σ(item.originalPriceCents · quantity)`; the implementation derives this from `sale.previewTotals()` which uses `(prePriceCentsBeforeDiscount ?? unitPriceCents)` as the baseline. Equivalent semantics; matches the POS `chargeDraft` source of truth. |

### 8.4 Carried-over code-side lint warnings (non-blocking)

All remaining scoped-lint complaints in the new spec files are `as any` casts in test mocks (e.g., `tenantPrisma as any`). The pre-existing `src/admin/admin-role.service.spec.ts` follows the same pattern; this is the project's accepted test-mock convention. Build (`nest build`) and the full test suite are clean; lint warnings are not gated.

### 8.5 Stale `verify.md` lower-half sections (cosmetic, non-blocking)

The `verify.md` lower-half sections (Task Checkbox §3, Findings §5, Next Recommended §7) describe the pre-`c3d6d28` state. All three were fixed in-tree by `c3d6d28`; the report PASS verdict at the top is the authoritative state. The internal contradiction between PASS verdict and pre-`c3d6d28` prose is cosmetic; the report remains the source of truth. Future cycles should refresh the lower-half prose at the same commit as the fixes.

---

## 9. Commit Ledger

| Commit | Work Unit | Message |
|---|---|---|
| `5c6e77e` | WU1 / Q1 | `feat(payment-details): PaymentDetail CRUD + RBAC + bot read endpoint` |
| `e2a00ee` | WU2 / Q3 | `fix(sales): atomic idempotency for bot sale registration` |
| `0ef8267` | WU3 / Q2+docs | `feat(sales): server-side promo re-evaluation for bot sales + docs` |
| `c3d6d28` | Verify fixes | `docs(chatbot): fix idempotency section + reconcile endpoint count to 11 (verify findings)` |
| `de0c391` | Sync | `chore(sdd): sync chatbot-sale-flow-blockers + reconcile verify findings` |

The archive commit (this) is layered on top of `de0c391`. Archive commit message:

```
chore(sdd): archive chatbot-sale-flow-blockers + sync delta specs

- Merge 6 ADDED payment-details requirements into openspec/specs/payment-details/spec.md (new canonical domain)
- Append 6 ADDED chatbot-api-foundation requirements to openspec/specs/chatbot-api-foundation/spec.md
- Replace 2 MODIFIED sales requirement blocks (Bot Sale Registration, Bot Sale Idempotency)
- Move openspec/changes/chatbot-sale-flow-blockers/ → openspec/changes/archive/2026-08-24-chatbot-sale-flow-blockers/
- Reconcile 3 parent-owned review gates in archived tasks.md (see §4 of archive-report.md)
- Add archive-report.md
```
