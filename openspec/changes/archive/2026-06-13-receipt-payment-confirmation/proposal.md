# Proposal: Receipt Payment Confirmation

## Intent

Close gap **W-005**: the WhatsApp bot creates transfer sales as `CONFIRMED` + `CREDIT` and attaches a `PENDING` `ReceiptEvidence`, but **no human-facing workflow exists to review it**. Bot transfer-sales stay stuck forever. This change builds an in-system, permission-gated receipt review queue that replaces the manual WhatsApp "Comprobantes" group entirely — review happens inside the system and never goes back out to WhatsApp here.

## Scope

### In Scope
- Permission-gated receipt review queue per sale: one-click **Validate** or **Reject** (with free-text reason).
- Confirm with the **real** bank amount: full → sale `PAID`, less → sale `PARTIAL` (reuse existing `paymentStatus` model).
- Emit outbox domain events `receipt.confirmed` / `receipt.rejected` (reject carries reason) for a future channel to consume.
- Additive schema only (`rejectionReason`, FK on `confirmedByUserId`, `[tenantId, status]` index).

### Out of Scope
- Delivery zones / postal-code eligibility / dispatch preconditions → `delivery-zones` SDD.
- Bot conversation behavior, stock-while-waiting, conversation memory → `whatsapp-channel-foundation`.
- **Consuming** the events / sending the WhatsApp message to the customer (emit only here).
- Full trusted-customer management (see open question).

## Capabilities

### New Capabilities
- `receipt-review`: review queue + validate/reject actions, partial-amount confirmation, outbox events.

### Modified Capabilities
- `sale-payments`: receipt confirmation registers a payment via the **domain** path; ownership guard reworked into a CASL-permission check.

## Requirements (confirmed business rules)

| # | Rule |
|---|------|
| BR-1 | Partial transfers are valid; confirm the REAL amount → `PAID` if total, `PARTIAL` if less. |
| BR-2 | Permission-gated (CASL), not a fixed role: holder sees the per-sale receipt queue and acts Validate / Reject(+reason). |
| BR-3 | Rejection does NOT cancel the sale; it awaits a new receipt. No retry limit. |
| BR-4 | Trusted/special customers may receive product without full payment (existing CREDIT flow); model as a `Customer` flag — minimal scope here. |
| BR-5 | Confirm/reject MUST emit outbox events for the future WhatsApp channel; partial S-004 debt addressed. |

## Approach

Add a dedicated `ReceiptReviewService` + `receipt-review.controller.ts` inside `src/sales/` (mirrors the existing `SaleComment` sub-concern pattern; avoids bloating the 1834-line `SalesService`). Confirmation routes payment creation through the **unified domain path** that already handles idempotency and emits `sale.payment.received` / `sale.fully.paid`.

**W-004 root fix (authorized):** instead of adding a second parallel payment path, rework `addPayment`'s ownership guard (`sale.userId !== actorId`) into a CASL-permission check. Reviewer becomes the `SalePayment.userId`. This unifies bot-sale receipt payments with staff payments rather than forking a new write path.

New CASL subject `ReceiptEvidence` (`read` / `update` / `manage`) gives granular review permission distinct from `update:Sale`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` (~795) | Modified | Add `rejectionReason`, FK relation for `confirmedByUserId`, `[tenantId, status]` index. |
| `src/sales/` | New | `ReceiptReviewService` + `receipt-review.controller.ts`. |
| `src/sales/sales.service.ts` (~1770) | Modified | Replace ownership guard with CASL-permission check (W-004 unification). |
| `src/auth/authorization/domain/permission.ts` | Modified | Add `ReceiptEvidence` subject + permissions. |
| `src/shared/outbox/` + listeners | New | `receipt.confirmed` / `receipt.rejected` event types. |
| `prisma/migrations/` | New | Additive migration. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Reworking the ownership guard weakens a payment auth boundary | Med | CASL `ReceiptEvidence:update` gates the action; only `PENDING` receipts on `CONFIRMED` sales process; events audit every decision. |
| If NOT unified, a second parallel payment path compounds W-004 | Med | Prefer the unified domain path; treat fork as fallback only, documented. |
| Trusted-customer scope creep | Med | Keep to a single `Customer` flag; defer full management to a future concern. |
| Events emitted with no consumer | Low | Intentional — consumer is `whatsapp-channel-foundation`; events are self-contained. |
| Migration ordering (FK + index) | Low | Additive only; deploy migration before new code. |

## Rollback Plan

Disable/remove the `receipt-review` routes and revoke the `ReceiptEvidence` CASL permissions (queue becomes inaccessible; bot flow returns to current stuck-but-safe state). Revert the guard change to restore the original ownership check. The additive migration can stay (nullable columns + index are inert); roll back only if needed since no data is destroyed.

## Dependencies

- Existing outbox/event infrastructure (`OutboxPoller` → `Dispatcher` → `EventEmitter2`).
- Existing `SalesService.addPayment` idempotency + payment-event emission.

## Success Criteria

- [ ] A permission-holder can list pending receipts per sale and Validate or Reject (with reason) in one action.
- [ ] Confirming the real amount sets the sale to `PAID` (full) or `PARTIAL` (less); idempotent on double-confirm.
- [ ] Rejection records the reason and leaves the sale awaiting a new receipt (not cancelled).
- [ ] `receipt.confirmed` / `receipt.rejected` outbox events are emitted with payload (incl. rejection reason).
- [ ] No second parallel payment-write path is introduced (unified domain path used).
- [ ] All schema changes are additive; existing `PENDING` receipts are unaffected.

## Open Questions

1. **Trusted-customer scope** — confirm a single `Customer.isTrusted` boolean is enough for this slice, or defer the flag entirely to a future `trusted-customers` concern to avoid scope creep here.
2. **Receipt media viewing** — does `mediaUrl` (S3) render directly in the admin panel, or is a signed-URL proxy needed? (Affects spec, not this proposal's shape.)
