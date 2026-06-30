# Archive Report: Sale Cancellation

## Final Verdict: ARCHIVED — PASS

- **Change**: sale-cancellation
- **Branch**: `feat/sale-cancellation`
- **Archive folder**: `openspec/changes/archive/2026-06-23-sale-cancellation/`
- **Archived at**: 2026-06-23
- **Verified commit**: `f8e204a` — "fix(sales): scope cancellation eligibility to tenant+RBAC and fix CANCELED listing filter"
- **Verify verdict**: PASS (740/740 tests, build exit 0, 14/14 spec scenarios COMPLIANT)
- **Tasks**: 41/41 complete, 0 unchecked

## Commits Archived (5 work-unit commits)

| Hash | Slice | Title |
|------|-------|-------|
| `684e5ee` | A | feat(sales): add CANCELED status, cancel() domain method, and SaleRefund model |
| `4a19f47` | B | feat(products): add incrementStockForRestock for sale cancellation restock |
| `9c789b3` | C | feat(sales): add cancelSale use case with restock, refund, and outbox |
| `494512e` | D | feat(api): add sale cancellation endpoints for admin and chatbot |
| `f8e204a` | fix | fix(sales): scope cancellation eligibility to tenant+RBAC and fix CANCELED listing filter |

## Specs Synced into Source of Truth

| Domain | Action | Requirements |
|--------|--------|--------------|
| `sale-cancellation` | CREATED | 5 new requirements (Confirmed Sale Cancellation, Credit Sale Cancellation, Cancellation Guard and Reason, Idempotent Cancellation, Admin Cancellation Access) |
| `sales` | UPDATED | +1 new requirement (Canceled Sales Remain Queryable But Are Excluded From CONFIRMED Reporting); converted header from delta-style `# Delta for sales` to proper main spec `# Sales Specification`; preserved all 3 prior MODIFIED requirements (Bot Sale Registration, Bot Sale Event Emission, Bot Sale Idempotency) with their `(Previously: ...)` historical context |
| `sale-payments` | UPDATED | +1 new requirement (Cancellation Refund Audit Preserves Payment History); preserved both existing requirements (Sale payment authorization and reviewer routing, Sale payment idempotency and events are preserved) |
| `chatbot-api-foundation` | UPDATED | +1 new requirement (Chatbot Sale Cancellation Endpoint); preserved all 9 existing requirements |

No requirements were REMOVED or RENAMED in this merge.

## Archive Contents

- `proposal.md` ✅
- `exploration.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (41/41 tasks complete, 0 unchecked)
- `verify-report.md` ✅ (final verdict PASS at top; superseded FAIL appendix retained for audit traceability only)
- `specs/sale-cancellation/spec.md` ✅
- `specs/sales/spec.md` ✅
- `specs/sale-payments/spec.md` ✅
- `specs/chatbot-api-foundation/spec.md` ✅

## Source-of-Truth Files Updated

The following main specs now reflect sale cancellation as first-class behavior:

- `openspec/specs/sale-cancellation/spec.md` (NEW)
- `openspec/specs/sales/spec.md` (UPDATED)
- `openspec/specs/sale-payments/spec.md` (UPDATED)
- `openspec/specs/chatbot-api-foundation/spec.md` (UPDATED)

## Resolved Blockers (from verify-report)

- **CRITICAL-1 (Listing by CANCELED returned zero rows)** — RESOLVED in `f8e204a`. `buildExtendedWhere` no longer ANDs a contradictory base `status:'CONFIRMED'` when an explicit status filter is present. RED-first regression test at `prisma-sale.repository.spec.ts:418`.
- **CRITICAL-2 (Ownership gate blocked legitimate admin/chatbot cancellations)** — RESOLVED in `f8e204a`. The `sale.userId !== actorId` clause removed from `sales.service.ts:1758-1770`; tenant isolation enforced by tenant-scoped `findByIdForUpdate`. RED-first regression test at `sales.service.spec.ts:2603` (actor ≠ creator succeeds); cross-tenant cancel still rejected (no tenant-scoped row found).

## Remaining Non-Blocking Findings

These do NOT gate archive. They are pre-existing or cosmetic and unrelated to cancellation correctness.

- **WARNING-1 (non-blocking)** — Admin `delete:Sale` RBAC is asserted via decorator presence + unit-level delegation, but lacks an HTTP-level 403 negative test (the chatbot side has one). Not introduced by this change. Recommend adding an HTTP-level guard test for parity in a follow-up.
- **SUGGESTION-1** — `npx tsc --noEmit` on the root tsconfig reports 20+ errors, ALL in `*.spec.ts` files (loose partial mocks). These files are excluded from the build path (`tsconfig.build.json`) and tolerated by `ts-jest` per-file `isolatedModules`. Pre-existing test-file looseness; consider a `tsconfig.spec.json` typecheck in CI to tighten.
- **SUGGESTION-2** — `SaleCanceledEvent` class is defined but never instantiated; emission is via the outbox `sale.canceled` payload (which satisfies the spec). Wire it to a listener or remove as dead code.
- **SUGGESTION-3** — `findById` deliveryStatus cast (`prisma-sale.repository.ts:153`) omits `'SHIPPED'`. Cosmetic type-honesty debt; runtime-safe (casts erased) and off the cancellation decision path. Align with `findByIdForUpdate` for consistency.

## Archive Notes

- The verify-report.md retains its "Appendix: Superseded Original Verdict" section for audit traceability. That FAIL text is historical (pre-`f8e204a`) and must not be acted on; the authoritative PASS verdict is at the top of the document.
- The `sales/spec.md` main spec was converted from delta-style to proper main-spec format (`# Sales Specification` + `## Requirements`) to accommodate the new ADDED requirement, while preserving the three prior MODIFIED requirements (Bot Sale Registration, Bot Sale Event Emission, Bot Sale Idempotency) with their `(Previously: ...)` annotations as historical context.
- No application source code was modified during archive. No git operations performed (orchestrator handles commit/merge).

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived. Ready for the next change.