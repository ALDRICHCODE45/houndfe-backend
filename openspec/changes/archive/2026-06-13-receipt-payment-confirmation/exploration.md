# Exploration: Receipt Payment Confirmation

## Current State

HoundFe's WhatsApp chatbot registers sales via `src/chatbot-api/` with `paymentStatus: CREDIT` and `paidCents: 0` (transfer flow v1). When a customer sends a transfer receipt, `attachReceipt` creates a `ReceiptEvidence` record with status `PENDING`. **No staff-facing endpoint exists to review, approve, or reject these pending receipts.** This is the W-005 gap from the archived `chatbot-api-foundation` slice.

### Bot Sale Flow (verified in code)

1. `registerBotSale` (chatbot-api.service.ts:233) creates a `Sale` with:
   - `status: CONFIRMED`, `channel: ONLINE`, `deliveryStatus: PENDING`
   - `paymentStatus: CREDIT`, `paidCents: 0`, `debtCents: totalCents`
   - **NOTE**: Bot writes directly via Prisma, bypassing `SalesService` (warning W-004)
   - **NOTE**: No domain events emitted (warning S-004)

2. `attachReceipt` (chatbot-api.service.ts:344) creates `ReceiptEvidence`:
   - Fields populated: `saleId`, `tenantId`, `mediaUrl`, `declaredAmountCents`, `declaredDate` (optional), `declaredReference` (optional)
   - Always `status: PENDING`
   - Does NOT modify the Sale record at all

### Existing Payment Infrastructure

`SalesService.addPayment` (sales.service.ts:1718) handles post-confirmation payment collection:
- **Ownership guard**: `sale.userId !== actorId` — the actor MUST be the original cashier. This is a critical constraint for receipt review because the bot's `cashierUserId` owns bot sales, not the reviewing staff member.
- **Idempotency**: SHA-256 hash + idempotency key via `SaleIdempotency`
- **Events**: Publishes `sale.payment.received` (per payment) and `sale.fully.paid` (when `debtCents === 0`) via outbox
- **Payment methods**: `cash | card_credit | card_debit | transfer` (note: `credit` is only for `chargeDraft`, not `addPayment`)
- **RBAC**: `@RequirePermissions(['update', 'Sale'])` on controller

---

## Affected Areas

- `prisma/schema.prisma` (line 795) — `ReceiptEvidence` model needs review fields (rejectionReason, reviewedAt, reviewerUserId alias)
- `src/sales/sales-payments.controller.ts` — New receipt review endpoint(s) needed, or a new controller
- `src/sales/sales.service.ts` (line 1770) — `addPayment` ownership guard (`sale.userId !== actorId`) blocks non-cashier staff from adding payments to bot sales
- `src/auth/authorization/domain/permission.ts` — May need new CASL subject `ReceiptEvidence` or use existing `Sale` subject
- `src/chatbot-api/application/chatbot-api.service.ts` (line 344) — `attachReceipt` is fine as-is; no changes needed
- `src/sales/listeners/sale-event.listener.ts` — New event listener for `receipt.confirmed` / `receipt.rejected` events
- `src/shared/outbox/` — Outbox events for receipt decisions (for future chatbot notification path)

---

## Question 1: ReceiptEvidence Model Shape

**Verified** (prisma/schema.prisma:795-813):

```prisma
model ReceiptEvidence {
  id                  String                @id @default(uuid())
  saleId              String
  tenantId            String
  mediaUrl            String
  declaredAmountCents Int
  declaredDate        DateTime?
  declaredReference   String?
  status              ReceiptEvidenceStatus @default(PENDING)
  confirmedByUserId   String?               // Already exists! Reviewer field
  confirmedAt         DateTime?             // Already exists! Review timestamp
  createdAt           DateTime              @default(now())

  sale   Sale   @relation(...)
  tenant Tenant @relation(...)

  @@index([tenantId, saleId])
}

enum ReceiptEvidenceStatus {
  PENDING
  CONFIRMED
  REJECTED
}
```

**Finding**: The schema already has `confirmedByUserId` and `confirmedAt` fields, plus the `CONFIRMED | REJECTED` enum values. What's MISSING:
- `rejectionReason` field (staff should explain why a receipt was rejected)
- A `User` relation on `confirmedByUserId` (currently just a raw String, no FK)
- Index on `[tenantId, status]` for listing pending receipts efficiently

## Question 2: addPayment End-to-End

**Verified** (sales.service.ts:1718-1833, sales-payments.controller.ts:1-46):

- **DTO** (`AddSalePaymentDto`): Supports single payment (method + amountCents + reference) or batch (payments array, max 5). Transfer requires reference.
- **Ownership guard** (line 1770): `sale.userId !== actorId` — **CRITICAL BLOCKER** for receipt review. Bot sales have `userId = cashierUserId` (the bot's mapped human user). A reviewing staff member would fail this check.
- **Events**: `sale.payment.received` → outbox; `sale.fully.paid` → outbox (when debt reaches 0)
- **RBAC**: `@RequirePermissions(['update', 'Sale'])` — any user with `update:Sale` can call the endpoint, but the service-level ownership check rejects non-owners

**Implication**: Receipt confirmation CANNOT directly reuse `addPayment` without either (a) bypassing the ownership guard, or (b) creating a new service method that skips it. Option (b) is cleaner — a dedicated `confirmReceipt` method.

## Question 3: Bot Sales vs Staff Sales

**Verified** (chatbot-api.service.ts:276-307):

Bot sales:
- `paymentStatus: CREDIT` (mapped to `SalePaymentStatus.CREDIT`) — this is a real enum value
- `paidCents: 0`, `debtCents: totalCents`
- `channel: ONLINE`
- `deliveryStatus: PENDING`
- Created directly via Prisma (not via `SalesService.openDraft` → `chargeDraft`)

Staff POS sales:
- Go through `openDraft` → `addItem` → `chargeDraft` flow
- `paymentStatus` is set at charge time: `PAID` (full), `PARTIAL`, or `CREDIT` (zero payment, e.g., fiado/credit)
- `channel: POS`
- `deliveryStatus: NOT_APPLICABLE` (default) or `DELIVERED`

**Key difference**: Bot sales skip the draft→confirm flow and domain events entirely. They land as CONFIRMED+CREDIT immediately.

## Question 4: RBAC for Payment Confirmation

**Verified** (permission.ts, RBAC.md):

Current subjects relevant to payment:
- `Sale` — `create | read | update | delete | manage`
- No `ReceiptEvidence` subject exists

Current payment endpoint: `POST /sales/:id/payments` → `@RequirePermissions(['update', 'Sale'])`

**Options**:
1. **Reuse `update:Sale`** — simplest, but conflates "modify sale items" with "approve money movements"
2. **New subject `ReceiptEvidence`** — add to `AppSubjects`, create CRUD permissions, seed them. Gives granular control: "this role can review receipts but not modify sales"
3. **New action on Sale** — e.g., `approve:Sale`. Non-standard but possible with CASL

**Recommendation**: Option 2 (`ReceiptEvidence` subject). Receipt review is a distinct responsibility from sale editing. A "receipt reviewer" role could exist without full sale management access.

## Question 5: Where Receipt Review Naturally Lives

**Repo conventions** (verified in `src/sales/`):
- Hexagonal: `domain/`, `infrastructure/`, `dto/`, `listeners/`
- Feature controllers: `sales.controller.ts`, `sales-payments.controller.ts`, `sales-query.controller.ts`, `sales-catalog.controller.ts`
- All under `src/sales/sales.module.ts`

**Options**:

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| **A. Extend `src/sales/`** | New `receipt-review.controller.ts` + service method in `SalesService` or dedicated `ReceiptReviewService` | Follows existing pattern (multiple controllers in sales module); receipt review is conceptually tied to sales lifecycle; reuses outbox/event infrastructure | SalesService is already 1834 lines; further growth risks god-service | Low |
| **B. New `src/receipt-review/` module** | Standalone bounded context with its own controller, service, repository | Clean separation; single responsibility; avoids growing sales module | More boilerplate; needs to import SalesService or repository for payment creation; cross-module dependency | Medium |
| **C. Extend `src/sales/` with dedicated service** | New `receipt-review.controller.ts` + new `ReceiptReviewService` (separate from SalesService), both in `src/sales/` | Keeps receipt logic separate from the 1834-line SalesService; still under sales module; reuses module DI context | Two services in one module (but this already exists: SalesService + SaleCommentService) | Low-Medium |

**Recommendation**: Option C. New `ReceiptReviewService` + `receipt-review.controller.ts` inside `src/sales/`. This follows the existing pattern where `SaleComment` has its own sub-directory within sales. The service handles receipt-specific logic and calls through to the repository for payment creation, avoiding the SalesService ownership guard issue.

## Question 6: Audit Trail

**Verified** (prisma/schema.prisma:284-299):

- `BotAuditLog` — tracks bot actions only (linked to `ServiceCredential`, has `credentialId`). NOT suitable for human action auditing.
- **Sale domain events** via outbox (`sale.payment.received`, `sale.fully.paid`) — audit of payment movements. Currently only logged by `SaleEventListener` (logger.log).
- `SalePayment` model records each payment with `userId` (who created it).
- `ReceiptEvidence` already has `confirmedByUserId` + `confirmedAt` for basic audit.

**Gap**: No general human action audit log. Options:
1. **Outbox events** — add `receipt.confirmed` and `receipt.rejected` events. This is the most consistent approach (matches existing `sale.payment.received` pattern). Also enables future notification to chatbot service.
2. **ReceiptEvidence itself** is the audit record (confirmedByUserId + confirmedAt + status change). No separate log needed for v1.

**Recommendation**: Use outbox events (`receipt.evidence.confirmed`, `receipt.evidence.rejected`) + the ReceiptEvidence record itself. No need for a separate audit table in v1.

## Question 7: Notification Path Back to Bot/Customer

**Verified** (src/shared/outbox/, src/sales/listeners/):

- Outbox → `OutboxPollerService` → `OutboxDispatcherService` → `EventEmitter2` (in-process)
- `SaleEventListener` subscribes to `sale.*` events but only logs them
- No external consumer (no Redis/RabbitMQ/webhook push)

**Path for chatbot notification**:
1. Receipt confirmation publishes `receipt.evidence.confirmed` to outbox
2. This also triggers `sale.payment.received` + potentially `sale.fully.paid` (if receipt amount covers debt)
3. Future chatbot service can poll outbox or subscribe via webhook/SSE to these events
4. **S-004 context**: Bot sales currently don't emit `sale.confirmed` events. Receipt confirmation should NOT try to backfill this gap — that's a separate concern.

**Recommendation**: Emit `receipt.evidence.confirmed` and `receipt.evidence.rejected` via outbox. When confirming, also call the payment creation logic (which naturally emits `sale.payment.received` / `sale.fully.paid`). The chatbot service can then listen for these events to notify customers.

## Question 8: Migration Considerations

**Required schema changes** (all additive):

1. **Add `rejectionReason` to ReceiptEvidence**:
   ```prisma
   rejectionReason String?
   ```

2. **Add FK relation for `confirmedByUserId`**:
   ```prisma
   confirmedBy User? @relation("ReceiptReviewer", fields: [confirmedByUserId], references: [id], onDelete: SetNull)
   ```
   This requires adding `reviewedReceipts ReceiptEvidence[] @relation("ReceiptReviewer")` to the User model.

3. **Add index for listing pending receipts**:
   ```prisma
   @@index([tenantId, status])
   ```

4. **New permissions in `PERMISSION_REGISTRY`**:
   ```typescript
   { subject: 'ReceiptEvidence', action: 'read', description: 'View receipt evidence' },
   { subject: 'ReceiptEvidence', action: 'update', description: 'Review (confirm/reject) receipt evidence' },
   { subject: 'ReceiptEvidence', action: 'manage', description: 'Full receipt evidence management' },
   ```

5. **Update `AppSubjects` type** to include `'ReceiptEvidence'`

**No destructive changes needed.** All migrations are additive. Existing `ReceiptEvidence` records with `PENDING` status are unaffected.

## Question 9: Edge Cases Visible in Code

1. **Declared amount vs sale total mismatch**: `declaredAmountCents` on receipt may not match `sale.debtCents`. The reviewer needs to see both values and decide. Options: (a) allow partial confirmation (receipt covers part of debt), (b) require exact match, (c) allow staff to override amount. Recommendation: Allow staff to confirm any amount ≤ debt; show warning if `declaredAmountCents !== debtCents`.

2. **Multiple receipts per sale**: `Sale` has `receiptEvidences ReceiptEvidence[]` (one-to-many). A customer could send multiple receipts for the same sale (e.g., split payment across banks). Each receipt should be reviewable independently. Confirming multiple receipts for the same sale should accumulate `paidCents`.

3. **Partial payments via transfer**: A customer may transfer less than `totalCents`. The confirmed amount should reduce `debtCents` but leave the sale as `PARTIAL` until fully paid. The existing `addPayment` → `persistCollectedPayments` logic already handles this correctly.

4. **Sale cancelled or modified before review**: If a sale is cancelled or items are modified while receipts are PENDING, the review flow should detect this. The reviewer should see the current sale state. Since bot sales are CONFIRMED (not DRAFT), modification risk is low — but cancellation could be a concern. Guard: receipt confirmation should verify `sale.status === 'CONFIRMED'`.

5. **Double confirmation**: Idempotency for receipt confirmation — if a reviewer clicks "confirm" twice, the second attempt should be a no-op. Use `ReceiptEvidence.status !== 'PENDING'` as guard.

6. **Receipt already rejected, customer re-sends**: The customer would call `attachReceipt` again, creating a NEW `ReceiptEvidence` record. Previous rejected receipt remains as audit trail. No special handling needed.

7. **Ownership guard bypass**: The core challenge. `addPayment` checks `sale.userId !== actorId`. For receipt confirmation, we need a new method that skips this check but still creates the `SalePayment` record and emits events. This new method should use the REVIEWER's userId as the `SalePayment.userId` (who authorized the payment, not who owns the sale).

---

## Approaches

1. **Extend sales module with ReceiptReviewService** — New `ReceiptReviewService` + `receipt-review.controller.ts` in `src/sales/`. New CASL subject `ReceiptEvidence`. Confirmation flow: validate receipt PENDING + sale CONFIRMED → create SalePayment (bypassing ownership guard) → update ReceiptEvidence status → publish outbox events. Rejection flow: update ReceiptEvidence status + rejectionReason → publish rejection event.
   - Pros: Follows existing patterns (SaleComment has its own service in sales/); reuses outbox infrastructure; minimal cross-module coupling; clear RBAC separation
   - Cons: Sales module grows (but with separate service, not SalesService bloat)
   - Effort: **Low-Medium**

2. **New `src/receipt-review/` bounded context** — Standalone module with own controller, service, repository. Imports `SalesModule` for `SaleRepository` access or creates own Prisma queries.
   - Pros: Clean module boundary; maximum separation of concerns
   - Cons: More boilerplate; cross-module DI needed; repository sharing complicates testing; receipt review is intrinsically tied to sale payment lifecycle
   - Effort: **Medium**

3. **Add confirmReceipt method directly to SalesService** — Minimal approach: add `confirmReceipt` and `rejectReceipt` methods to existing `SalesService`, new endpoint on `SalesPaymentsController`.
   - Pros: Simplest implementation; all payment logic in one service
   - Cons: SalesService is already 1834 lines; conflates receipt review with general sale operations; harder to assign distinct RBAC
   - Effort: **Low**

---

## Recommendation

**Approach 1: Extend sales module with dedicated ReceiptReviewService.**

Rationale:
- Follows the established pattern (SaleComment already lives as a sub-concern within sales/)
- Keeps receipt review logic isolated from the 1834-line SalesService
- Enables clean RBAC with new `ReceiptEvidence` CASL subject
- Payment creation bypasses the ownership guard safely via a dedicated repository method
- Outbox events (`receipt.evidence.confirmed`, `receipt.evidence.rejected`) enable future chatbot notification
- All schema changes are additive; no destructive migrations

---

## Open Product Questions (for Proposal Phase)

1. **Confirmation amount flexibility**: Should staff confirm the exact declared amount, or can they adjust it? (e.g., customer declared 500 but only transferred 450 — does staff enter 450 or reject?)
2. **Partial receipt confirmation**: If `declaredAmountCents < sale.debtCents`, should the system automatically leave the sale as PARTIAL, or require staff acknowledgment?
3. **Rejection notification**: When a receipt is rejected, should the bot notify the customer immediately? What should the message say? (This affects whether we need the notification path in v1 or can defer.)
4. **Who can review?**: Should any user with `update:Sale` be able to review receipts, or should there be a dedicated role? (Impacts whether we create a new CASL subject.)
5. **Listing UX**: Should the admin panel show pending receipts as a queue/inbox, or as part of the sale detail view? (Affects API design — standalone list endpoint vs nested under sale.)
6. **Receipt media viewing**: The `mediaUrl` points to S3. Can the admin panel display it directly, or does it need a signed URL proxy? (Check existing file serving patterns.)

---

## Risks

1. **`addPayment` ownership guard bypass** — Creating a parallel payment path without the `sale.userId === actorId` check introduces a potential security surface. Mitigation: the new method MUST require `ReceiptEvidence` update permission (separate from Sale update), and MUST only process receipts in PENDING status. Rate limiting and audit logging (outbox events) provide additional protection.
2. **W-004 compounding** — Bot sales bypass SalesService entirely. Receipt confirmation will create payments via a new path too. Two non-standard payment paths increases complexity. Mitigation: document clearly; consider addressing W-004 (making bot sales go through SalesService) as a separate future slice.
3. **S-004 event gap** — Bot sales don't emit `sale.confirmed` events. Receipt confirmation will emit `sale.payment.received` / `sale.fully.paid`, but listeners expecting a prior `sale.confirmed` event may be confused. Mitigation: receipt confirmation events should be self-contained; don't depend on `sale.confirmed` having been emitted.
4. **Schema migration coordination** — Adding FK relation on `confirmedByUserId` and new index requires a Prisma migration. Low risk since all changes are additive, but needs to be deployed before the new code.

---

## Ready for Proposal

**Yes** — the codebase has excellent infrastructure for this feature. The `ReceiptEvidence` model already has review fields (`confirmedByUserId`, `confirmedAt`) and status enum values (`CONFIRMED`, `REJECTED`). The main implementation work is:

1. Add `rejectionReason` field + index + FK relation (schema migration)
2. New `ReceiptReviewService` with `confirmReceipt` / `rejectReceipt` methods
3. New `receipt-review.controller.ts` with list pending + confirm + reject endpoints
4. New CASL subject `ReceiptEvidence` with permissions
5. Outbox events for receipt decisions

The orchestrator should resolve the open product questions (especially confirmation amount flexibility and rejection notification) before moving to proposal.
