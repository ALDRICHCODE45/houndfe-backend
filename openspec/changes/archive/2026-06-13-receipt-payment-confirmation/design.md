# Design: Receipt Payment Confirmation

## Technical Approach

Add a dedicated `ReceiptReviewService` + `receipt-review.controller.ts` inside `src/sales/review/`,
mirroring the existing `comments/` sub-module pattern (its own service, repository port, DTOs, module).
Confirmation orchestrates the receipt status change AND the sale payment in ONE transaction, routing
payment creation through the existing `SalesService.addPayment` domain path (idempotency + outbox events)
rather than forking a second write path.

The W-004 root fix replaces the conflated ownership guard in `addPayment` (`sale.service.ts:1770`) with
an explicit **authorization mode** parameter: `'owner'` (cashier path, unchanged) or `'reviewer'`
(receipt-confirmation path, gated by the new `ReceiptEvidence:update` CASL permission at the controller).
Authorization stays at the CASL/controller boundary; the service receives an already-authorized intent,
keeping CASL out of `SalesService`.

The confirmed payment carries a **three-fact audit attribution** (OQ3, resolved) recorded across
EXISTING fields so each fact stays separate and queryable: (1) the money is a customer **bank transfer** →
`SalePayment.method = TRANSFER`; (2) the sale was **bot-originated** → `Sale.channel = ONLINE` plus the
`BotAuditLog` → `ServiceCredential` trail, re-stamped explicitly on `SalePayment.metadataJson.origin`;
(3) a **human reviewer validated** it → `ReceiptEvidence.confirmedByUserId` + `confirmedAt`. The reviewer
is NOT silently written as the payer: `SalePayment.userId` is left NULL for the bot-originated transfer
(it never represents the human), while the human validator is recorded only on the receipt.

Reject is a pure receipt-state transition (no payment), in its own short transaction.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|----------|--------|----------|-----------|
| D1 | Module placement | `ReceiptReviewService` + controller in `src/sales/review/` sub-module | Grow `SalesService` (1834 LOC); standalone `src/receipt-review/` module | Matches `comments/` precedent; reuses Sales DI; avoids cross-module coupling for payment write |
| D2 | W-004 auth fix | Add `authMode: 'owner' \| 'reviewer'` param to `addPayment`; keep CASL at controller | Duplicate `confirmReceipt` payment path; inline CASL in service | One payment path = one idempotency/event surface; no service-layer CASL dependency (LSP/ISP clean) |
| D7 | Audit attribution (OQ3) | 3 separate facts on EXISTING fields: `SalePayment.method=TRANSFER` (money=transfer), `Sale.channel=ONLINE` + `metadataJson.origin` (bot-originated), `ReceiptEvidence.confirmedByUserId`+`confirmedAt` (human validated). `SalePayment.userId = NULL` for the reviewer path | Set `SalePayment.userId = reviewer` (conflates validator with payer); add new `validatedByUserId` payment column | Reviewer is a validator, NOT the payer; reusing `confirmedByUserId` keeps the human on the receipt and the money provenance on the payment — no new column, fully additive |
| D3 | Reviewer routing | `ReceiptReviewService.confirm()` calls `salesService.addPayment(..., authMode:'reviewer')` inside its own tx via shared `runInTransaction` | Reviewer hits `POST /payments` directly | Receipt status + payment + event must be atomic; orchestration owns the boundary |
| D4 | CASL subject | New `ReceiptEvidence` subject (`read`/`update`/`manage`) in `PERMISSION_REGISTRY` | Reuse `update:Sale` | Separates "approve money movement" from "edit sale items"; reviewer role needs neither full Sale access |
| D5 | "Not actionable" guard | Guard on states that EXIST: `sale.status === 'CONFIRMED'` + `receipt.status === 'PENDING'` | Invent a `cancelled` status | `SaleStatus` enum (`schema:121`) has only `DRAFT`/`CONFIRMED`; no cancelled state exists |
| D6 | Idempotency | Reuse `addPayment` SHA-256 + `SaleIdempotency`; layer a `receipt.status !== PENDING` pre-guard | New receipt-level idempotency table | Double-confirm short-circuits on receipt guard before payment; settles the "no duplicate payment/event" scenario |

## Data Flow

### Confirm (one transaction)
```
POST /sales/:id/receipts/:rid/confirm
   │  guard: ReceiptEvidence:update (CASL, controller)
   ▼
ReceiptReviewService.confirm(saleId, receiptId, reviewerId, {amountCents}, idemKey)
   │  load receipt (PENDING?) ── no ─▶ ReceiptNotActionableError
   │  load sale  (CONFIRMED?) ── no ─▶ SaleNotReviewableError
   ▼  runInTransaction:
   ├─ SalesService.addPayment(saleId, reviewerId, {method:'transfer', amountCents}, idemKey, authMode:'reviewer')
   │     └─▶ persistCollectedPayments → SalePayment(method=TRANSFER, userId=NULL,
   │                                                metadataJson.origin={bot, channel:ONLINE})
   │     └─▶ outbox: sale.payment.received  [+ sale.fully.paid if debt==0]
   ├─ receipt → CONFIRMED, confirmedByUserId=reviewer, confirmedAt=now   ← human validator
   └─ outbox: receipt.confirmed  (carries all 3 facts)
```

### Reject (one transaction)
```
POST /sales/:id/receipts/:rid/reject {reason}
   │  guard: ReceiptEvidence:update
   ▼  receipt PENDING? ── no ─▶ ReceiptNotActionableError
   ├─ receipt → REJECTED, rejectionReason=reason
   └─ outbox: receipt.rejected {reason}        (sale untouched)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` (~795) | Modify | `ReceiptEvidence`: add `rejectionReason String?`, `confirmedBy User?` relation, `@@index([tenantId, status])`. `User` (~857): add `reviewedReceipts ReceiptEvidence[] @relation("ReceiptReviewer")`. `Customer` (~931): add `isTrusted Boolean @default(false)` |
| `prisma/migrations/<ts>_receipt_review/` | Create | Additive: nullable column, FK, index, boolean default |
| `src/sales/sales.service.ts` (1718,1770) | Modify | `addPayment` gains `authMode: 'owner' \| 'reviewer'`; guard becomes split (see below) |
| `src/sales/review/receipt-review.service.ts` | Create | `confirm()` / `reject()` / `listPending()` orchestration |
| `src/sales/review/receipt-review.controller.ts` | Create | `GET /sales/:id/receipts`, `POST .../:rid/confirm`, `POST .../:rid/reject` |
| `src/sales/review/dto/confirm-receipt.dto.ts` | Create | `amountCents` (int, min 1) |
| `src/sales/review/dto/reject-receipt.dto.ts` | Create | `reason` (string, non-empty) |
| `src/sales/review/domain/receipt-review.repository.ts` | Create | Port: `findPendingForSale`, `findById`, `markConfirmed`, `markRejected` |
| `src/sales/review/infrastructure/prisma-receipt-review.repository.ts` | Create | Prisma adapter via `TenantPrismaService` |
| `src/sales/review/domain/receipt-review.errors.ts` | Create | `ReceiptNotActionableError`, `SaleNotReviewableError` |
| `src/sales/domain/events/sale.events.ts` | Modify | Add `ReceiptConfirmedEvent`, `ReceiptRejectedEvent` |
| `src/sales/sales.module.ts` | Modify | Register service, controller, repository port |
| `src/auth/authorization/domain/permission.ts` | Modify | Add `'ReceiptEvidence'` to `AppSubjects` + 3 `PERMISSION_REGISTRY` entries (seeder auto-upserts) |

## Interfaces / Contracts

### addPayment guard rework (`sales.service.ts:1770`)
```ts
// authMode threaded from controller; reviewer pre-authorized by CASL guard
const sale = await this.saleRepo.findByIdForUpdate(saleId);
if (!sale) throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
if (authMode === 'owner' && sale.userId !== actorId) {
  throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
}
// reviewer mode: no ownership check — authorization already enforced by ReceiptEvidence:update
```
> Default `authMode` to `'owner'` so the existing controller call and cashier scenario are unchanged.

### Attribution on the reviewer path (no schema change)
In `'reviewer'` mode `persistCollectedPayments` writes `method = TRANSFER`, `userId = NULL`
(the human is a validator, not the payer), and stamps the existing `SalePayment.metadataJson` with the
bot-origin fact derived from `Sale.channel` / `BotAuditLog`:
```ts
// reviewer path only — additive use of existing metadataJson Json? column
metadataJson: { origin: { kind: 'bot', channel: sale.channel /* ONLINE */ },
                validatedByReceiptId: receiptId }
```
The human validator is recorded ONLY on the receipt (`ReceiptEvidence.confirmedByUserId` + `confirmedAt`),
keeping the three facts — transfer / bot-originated / human-validated — separate and queryable.

### Schema delta
```prisma
model ReceiptEvidence {
  // ...existing...
  rejectionReason String?
  confirmedBy User? @relation("ReceiptReviewer", fields: [confirmedByUserId], references: [id], onDelete: SetNull)
  @@index([tenantId, saleId])
  @@index([tenantId, status])   // queue listing
}
```

### Events (mirror `sale.payment.received` emit via `outboxWriter.publish`)
```ts
// eventType 'receipt.confirmed' | 'receipt.rejected', aggregateType 'ReceiptEvidence'
// receipt.confirmed carries all 3 audit facts for the future WhatsApp channel + reporting:
//   paymentMethod=TRANSFER (money), origin (bot-originated), validatedByUserId+validatedAt (human)
ReceiptConfirmedEvent { receiptId, saleId, tenantId, amountCents, paymentMethod: 'TRANSFER',
                        origin: { kind: 'bot', channel },   // fact 2: bot-originated
                        validatedByUserId, validatedAt,      // fact 3: human validator (reviewer)
                        resultingPaymentStatus, occurredAt }
ReceiptRejectedEvent  { receiptId, saleId, tenantId, validatedByUserId, reason, occurredAt }
```
`validatedByUserId` names the human reviewer explicitly (not a generic "payer"), so the WhatsApp
channel and audit reports can state "customer transfer, bot-attended, validated by <user>".
Emit-only — no listener added in this change (consumer is `whatsapp-channel-foundation`).

## Testing Strategy (strict TDD, Jest + ts-jest, co-located `*.spec.ts`)

| Layer | Test | Seam |
|-------|------|------|
| Service | confirm full → `PAID`; partial → `PARTIAL`; real ≠ declared uses real | mock repo + mock `SalesService.addPayment` |
| Service | reject sets `REJECTED` + reason; sale untouched | mock repo |
| Service | confirm/reject on non-PENDING → error, no payment/event | mock repo returns CONFIRMED/REJECTED |
| Service | sale not CONFIRMED → `SaleNotReviewableError` | mock sale state |
| Service | double-confirm idempotent (receipt guard + addPayment idem) | spy addPayment call count |
| Auth | `addPayment` owner path still rejects non-owner; reviewer path bypasses | unit on guard branch |
| Controller | confirm/reject require `ReceiptEvidence:update`; missing reason → 400 | `Test.createTestingModule` + ValidationPipe |
| Event | confirm emits `receipt.confirmed` + `sale.payment.received`; reject emits `receipt.rejected` | assert `outboxWriter.publish` args |

## Migration / Rollout

Additive only — deploy migration BEFORE code. New nullable column, FK (`onDelete: SetNull`),
secondary index, and a defaulted boolean are inert against existing `PENDING` rows. Rollback: revert
controller/routes + `authMode` default stays `'owner'`; migration may remain (no data destroyed).

The OQ3 audit-attribution model needs **no new schema**: `SalePayment.method` already has `TRANSFER`
(`schema:130`), `SalePayment.metadataJson Json?` already exists (`schema:721`) for the bot-origin stamp,
and `ReceiptEvidence.confirmedByUserId` + `confirmedAt` (`schema:804-805`) already record the human
validator. `Sale.channel` enum already carries `ONLINE` (`schema:142`) for bot-originated sales.

## isTrusted interaction

`Customer.isTrusted Boolean @default(false)` is added as schema scaffolding ONLY. It records that a
customer may receive product before full payment via the EXISTING `CREDIT` flow. No read/write logic,
endpoint, or branch is built here. Full trusted-customer management is deferred (see Open Question 1).

## Open Questions

- [x] **OQ1 — Trusted scope** — RESOLVED: a single `Customer.isTrusted Boolean @default(false)` is sufficient and in-scope as scaffolding now. No separate `trusted-customers` concern needed for this change.
- [x] **OQ2 — Media viewing** — RESOLVED: `mediaUrl` is a direct DigitalOcean Spaces reference rendered directly in the admin panel. No signed-URL proxy is required.
- [x] **OQ3 — Audit attribution** — RESOLVED (product owner): a confirmed receipt payment MUST record THREE separate facts — (1) customer **bank transfer** via `SalePayment.method = TRANSFER`; (2) **bot-originated** via `Sale.channel = ONLINE` + `BotAuditLog`/`ServiceCredential`, re-stamped on `SalePayment.metadataJson.origin`; (3) **human-validated** via `ReceiptEvidence.confirmedByUserId` + `confirmedAt`. The reviewer is NOT silently the payer: `SalePayment.userId` stays NULL on this path. Captured entirely on existing fields — no new column. See D7.
