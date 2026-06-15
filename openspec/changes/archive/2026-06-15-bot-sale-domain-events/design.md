# Design: Bot Sale Domain Events & Invariants

## Technical Approach

Add `SalesService.confirmBotSale()` (Approach A) as the single source of truth for
bot-channel confirmations. `registerBotSale` keeps idempotency and delegates the
sale creation to it. The bot has no DRAFT lifecycle, so `confirmBotSale` **mirrors**
`chargeDraft`'s invariant set but creates-and-confirms in one step. It **reuses** the
existing canonical primitives — `decrementStockForCharge`, `allocateNextFolio`,
`resolveDueDate`, `persistChargeConfirmation`, `publishSaleConfirmedEvent` — inside
one `saleRepo.runInTransaction()` unit-of-work. `chargeDraft` is left untouched.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|----------|--------|----------|-----------|
| Reuse vs mirror `chargeDraft` | New `confirmBotSale` that reuses sub-steps | Call `chargeDraft` directly | `chargeDraft` requires a pre-existing DRAFT + `findByIdForUpdate` + status check; bot has no draft. Reusing the leaf helpers keeps invariants single-sourced without forcing a draft lifecycle. |
| Sale row creation | `saleRepo.save(Sale.create + items)` then `persistChargeConfirmation` | New repo `createConfirmedSale` method | `persistChargeConfirmation` updates an existing row (`updateMany`). Creating the row first (CONFIRMED-bound) then confirming reuses the exact confirm path POS uses; no new repo surface. |
| Transaction boundary | Wrap whole flow in `saleRepo.runInTransaction()` | Per-step writes | `TenantPrismaService` stores the tx client in CLS; `getClient()` returns it inside the tx, so stock + sale + outbox all join one transaction automatically. Event is never emitted for an uncommitted sale. |
| Outbox events | `sale.confirmed` only | Emit payment events | Bot CREDIT sale tenders 0 → `paymentStatus=CREDIT`, no payments created → no `sale.payment.received`, debt>0 → no `sale.fully.paid`. |
| Seller identity | `sellerUserId = cashierUserId` (bot service user) | Null seller / new bot column | The bot service-user is already the `userId` (FK to User). Reusing it as seller is consistent with existing chatbot-api attribution; bot identity detail stays in BotAuditLog. |
| Folio | `allocateNextFolio(confirmedAt)` (shared POS sequence) | Separate bot sequence | Locked decision; bot sales are sales. Format `A-YYMM-NNNNNN`. |
| Due date | `resolveDueDate(undefined, confirmedAt, 'CREDIT')` → +15d | Hardcode in bot path | Reuse the canonical helper so the rule never drifts. |

## Data Flow

    ChatbotApiService.registerBotSale(input)
      ├─ idempotency check / reserve slot        (stays in chatbot-api)
      └─ SalesService.confirmBotSale({...})       ◄── NEW
           └─ saleRepo.runInTransaction(  ── single tenant tx (CLS) ──┐
                ├─ Sale.create(CONFIRMED-bound, channel=ONLINE) + save items
                ├─ price validation (trusted-cart guard)
                ├─ productsService.decrementStockForCharge(items)
                ├─ allocateNextFolio(confirmedAt)
                ├─ resolveDueDate → confirmedAt + 15d (CREDIT)
                ├─ persistChargeConfirmation({ paymentStatus:'CREDIT',
                │     channel:'ONLINE', deliveryStatus:'PENDING',
                │     sellerUserId, dueDate, folio, ... })
                └─ publishSaleConfirmedEvent(...)  → outboxEvent (plain object)
              )  ◄────────────────────────────────────────────────────┘
      └─ mark idempotency SUCCEEDED + cache response   (stays in chatbot-api)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/sales/sales.service.ts` | Modify | Add `confirmBotSale(input)`; reuse existing private publish/folio/dueDate/persist helpers. |
| `src/sales/sales.service.spec.ts` | Modify | New `confirmBotSale` unit tests (RED first). |
| `src/chatbot-api/application/chatbot-api.service.ts` | Modify | Inject `SalesService`; `registerBotSale` delegates to `confirmBotSale` (idempotency stays). |
| `src/chatbot-api/application/chatbot-api.service.spec.ts` | Modify | Delegation tests; assert idempotency + delegation contract. |
| `src/chatbot-api/chatbot-api.module.ts` | Modify | `imports: [..., SalesModule]`. |

## Interfaces / Contracts

```ts
// SalesService — new method (input is the bot-shaped cart already validated upstream)
async confirmBotSale(input: {
  cashierUserId: string;          // bot service-user; becomes userId AND sellerUserId
  customerId: string;
  shippingAddressId?: string | null;
  items: Array<{
    productId: string;
    variantId?: string | null;
    productName: string;
    variantName?: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
}): Promise<{
  saleId: string;
  folio: string;
  paymentStatus: 'CREDIT';
  channel: 'ONLINE';
  deliveryStatus: 'PENDING';
  totalCents: number;
  paidCents: 0;
  debtCents: number;
  confirmedAt: string; // ISO
}>
```

- Emitted event: `sale.confirmed` with `paymentStatus:'CREDIT'`, `paidCents:0`,
  `debtCents:totalCents`, `actorId:cashierUserId`. Payload is a **plain object**
  (no class instance) — `OutboxWriterService.publish` takes `Prisma.InputJsonValue`.
- `registerBotSale` return shape (`BotSaleResponse`) is preserved by mapping from
  the `confirmBotSale` result; idempotency replay path is unchanged.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (`sales.service.spec.ts`) | `confirmBotSale`: folio allocated, stock decremented, dueDate=+15d, seller=cashier, prices validated, exactly one `sale.confirmed` published with correct payload, all within `runInTransaction` | Mock `saleRepo`, `productsService`, `outboxWriter`, `tenantPrisma`; assert call order + plain-object payload |
| Unit (`chatbot-api.service.spec.ts`) | `registerBotSale` delegates to `confirmBotSale`; idempotency reserve→succeed preserved; replay returns cached response without re-delegating | Mock `SalesService.confirmBotSale`; assert delegation + idempotency |
| Regression | `chargeDraft` POS path unchanged; no new calls to its branch | Existing specs must stay green |

## Migration / Rollout

No migration required. Greenfield — zero legacy bot sales, no backfill.

## Open Questions

- [ ] None blocking. Confirm whether `confirmBotSale` should re-validate prices
      against the live catalog (mirror `chargeDraft`) or trust the upstream
      cart-evaluation use case already wired in chatbot-api — default: mirror the
      catalog check for parity unless tasks phase decides the cart endpoint is canonical.
