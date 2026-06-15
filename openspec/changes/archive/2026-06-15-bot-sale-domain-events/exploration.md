## Exploration: Bot Sale Domain Events (W-004 + S-004)

### Current State

#### Bot Sale Creation (`registerBotSale`)
**File**: `src/chatbot-api/application/chatbot-api.service.ts` (lines 233-338)

`registerBotSale` creates a CONFIRMED CREDIT sale in a single Prisma write, bypassing the entire `SalesService` domain layer:

1. **Idempotency**: Uses `SaleIdempotency` table with key `bot_sale_register` + tenant scope — working correctly.
2. **Direct Prisma write**: `prisma.sale.create()` with hardcoded values:
   - `status: 'CONFIRMED'`, `channel: 'ONLINE'`, `deliveryStatus: 'PENDING'`
   - `paymentStatus: 'CREDIT'`, `paidCents: 0`, `debtCents: totalCents`
   - `confirmedAt: new Date()`
3. **Missing invariants vs SalesService**:
   - **No folio allocation** — `folio` is not set (database default or null)
   - **No stock decrement** — `ProductsService.decrementStockForCharge()` is never called
   - **No price validation** — prices from the cart endpoint are blindly trusted
   - **No domain events** — zero outbox writes, zero `EventEmitter2` emissions
   - **No due date computation** — CREDIT sales in SalesService get a default 15-day due date
   - **No seller assignment** — `sellerUserId` not set

#### Canonical Sale Confirmation (`SalesService.chargeDraft`)
**File**: `src/sales/sales.service.ts` (lines 1358-1617)

The POS (human-cashier) path: `openDraft()` → `addItem()` → `chargeDraft()`. At charge time:

1. Validates idempotency (SHA-256 hash of request payload)
2. Acquires `findByIdForUpdate` lock (SELECT FOR UPDATE)
3. Validates prices against current product catalog (staleness check)
4. Calculates totals (subtotal, discount, total, paid, debt, change)
5. Validates payment business rules (credit requires customer, amounts, methods)
6. **Decrements stock** via `ProductsService.decrementStockForCharge()`
7. **Allocates folio** via `saleRepo.allocateNextFolio()` (format: `A-YYMM-NNNNNN`)
8. **Computes due date** for CREDIT/PARTIAL sales (default: confirmedAt + 15 days)
9. Persists confirmation via `saleRepo.persistChargeConfirmation()`
10. **Emits outbox events**: `sale.confirmed`, then per-payment `sale.payment.received`, then conditionally `sale.fully.paid`

#### Outbox Event Infrastructure
**File**: `src/shared/outbox/outbox-writer.service.ts`

- `OutboxWriterService.publish(tx, tenantId, aggregateType, aggregateId, eventType, payload)` — writes to `outboxEvent` table
- Payload type: `Prisma.InputJsonValue` — **must be plain objects**, not class instances (known serialization gotcha)
- Events are polled by `OutboxPollerService` and dispatched by `OutboxDispatcherService` via `EventEmitter2`
- `OutboxModule` exports `OutboxWriterService` — importable by any module

#### Domain Events emitted by SalesService (outbox path)
- `sale.confirmed` — payload: `{saleId, folio, tenantId, actorId, totalCents, paidCents, debtCents, paymentStatus, confirmedAt}`
- `sale.payment.received` — payload per payment: `{saleId, tenantId, actorId, paymentId, method, amountCents, reference, occurredAt, resultingPaidCents, resultingDebtCents, resultingPaymentStatus}`
- `sale.fully.paid` — payload: `{saleId, tenantId, folio, totalCents, paidAt}`

The `SaleEventListener` (`src/sales/listeners/sale-event.listener.ts`) listens to in-process events via `@OnEvent()` and logs them. This is separate from the outbox (which persists + polls + re-dispatches for reliability).

### Affected Areas

- `src/chatbot-api/application/chatbot-api.service.ts` — `registerBotSale()` must emit events and enforce domain invariants
- `src/chatbot-api/application/chatbot-api.service.spec.ts` — tests must assert event emission
- `src/chatbot-api/chatbot-api.module.ts` — must import `OutboxModule` (and possibly `SalesModule`)
- `src/sales/sales.service.ts` — if Approach A, bot sale routes through existing methods; if Approach B, extract shared event helpers
- `src/sales/domain/events/sale.events.ts` — event classes (already defined, reusable)
- `src/shared/outbox/outbox-writer.service.ts` — already exists, just needs import in chatbot module
- `src/sales/sales.service.spec.ts` — existing tests document expected event behavior (reference for bot tests)

### Approaches

#### 1. **Approach A: Route bot sale through SalesService** — Make `registerBotSale` delegate to SalesService

**How it would work**: Add a new `SalesService.confirmBotSale(input)` method that creates a confirmed sale in one step (no draft→charge lifecycle) but using the domain entity, folio allocation, stock decrement, and outbox event emission from SalesService internals.

- Pros:
  - Single source of truth for all sale creation invariants
  - All future SalesService invariant changes automatically apply to bot sales
  - Event emission is guaranteed by SalesService (no duplication)
  - Folio allocation and stock decrement are handled by proven code paths
  - Less code in `ChatbotApiService` — it delegates to SalesService
- Cons:
  - Requires `ChatbotApiModule` to import `SalesModule` (new module dependency)
  - `SalesService` currently depends on `ProductsService` for price validation and stock checks — bot sales may not need all these (prices are already evaluated by the cart endpoint)
  - `SalesService.chargeDraft` is tightly coupled to the draft→charge lifecycle (ownership check, price staleness check, payment normalization) — cannot be reused directly
  - Need to create a new purpose-built method in SalesService, not reuse `chargeDraft`
  - Testing surface expands in SalesService spec
- Effort: Medium

#### 2. **Approach B: Keep bot Prisma write, add event emission in ChatbotApiService** — Extract the invariant enforcement and event emission into the bot's own code

**How it would work**: `ChatbotApiModule` imports `OutboxModule`. `registerBotSale` adds: folio allocation (needs `ISaleRepository` or direct Prisma), stock decrement (needs `ProductsService`), due date computation, and calls `OutboxWriterService.publish()` for `sale.confirmed`. No `sale.payment.received` (bot sale has zero payments at creation — it's pure CREDIT).

- Pros:
  - Minimal cross-module coupling — chatbot stays isolated
  - No changes to `SalesService` at all
  - Clear ownership boundary — chatbot module is self-contained
- Cons:
  - **Invariant duplication** — folio format, stock decrement logic, due date rules, and event payloads are duplicated between ChatbotApiService and SalesService
  - **Drift risk** — any new invariant added to SalesService (e.g., tax calculation, audit trails) must be manually replicated in ChatbotApiService
  - Requires importing additional dependencies into ChatbotApiModule (ISaleRepository for folio, ProductsService for stock, OutboxWriterService for events)
  - More code to maintain in two places
  - The very problem W-004 warns about (invariant drift) is **not solved**, just deferred
- Effort: Medium

### Recommendation

**Approach A** — Route through `SalesService.confirmBotSale()`.

Rationale:
1. **W-004 explicitly warns about invariant drift** — Approach B doesn't solve this, it perpetuates it.
2. The bot sale is a **domain-legitimate confirmed sale** — it deserves to go through the domain layer.
3. A new `confirmBotSale(input)` method in `SalesService` can be purpose-built:
   - Skip draft creation (no `Sale.create` → `openDraft`)
   - Skip price staleness checks (prices already validated by cart endpoint)
   - Skip payment normalization (bot sale is always CREDIT with zero payments)
   - **Do**: allocate folio, decrement stock, set due date, persist confirmation, emit `sale.confirmed` outbox event
4. The module coupling (`ChatbotApiModule` imports `SalesModule`) is **architecturally correct** — bot sales ARE sales, the chatbot module consuming `SalesService` reflects the real domain relationship.
5. Idempotency stays in `ChatbotApiService` (bot-specific concern), but the actual sale creation delegates to SalesService.
6. Testing is cleaner: SalesService tests verify invariants + events once; ChatbotApiService tests verify delegation + idempotency.

**Implementation shape**:
```
ChatbotApiService.registerBotSale(input)
  ├── Idempotency check (existing code, stays here)
  ├── SalesService.confirmBotSale({...}) ← NEW method
  │   ├── allocateNextFolio()
  │   ├── decrementStockForCharge()
  │   ├── computeDueDate (CREDIT → confirmedAt + 15 days)
  │   ├── prisma.sale.create() (or saleRepo equivalent)
  │   └── outboxWriter.publish('sale.confirmed', ...)
  └── Mark idempotency succeeded (existing code, stays here)
```

### Risks

- **Stock decrement for bot sales**: Currently bot sales don't decrement stock. Adding this is correct but is a behavior change — existing bot sales in production (if any) may have inconsistent stock counts. Need to assess if there are production bot sales.
- **Folio allocation**: Bot sales will now consume folio numbers from the same sequence as POS sales. This is correct (they're real sales) but changes the folio sequence behavior.
- **Due date backfill**: Existing bot CREDIT sales in the database have no `dueDate`. A backfill migration may be needed if downstream systems rely on due dates for credit aging.
- **Module circular dependency**: `ChatbotApiModule` importing `SalesModule` — need to verify no circular imports exist (currently `SalesModule` does NOT import `ChatbotApiModule`, so this is safe).
- **Test effort**: Both `SalesService.spec.ts` (new `confirmBotSale` method) and `ChatbotApiService.spec.ts` (updated `registerBotSale`) need test changes. Strict TDD applies.

### Ready for Proposal

Yes — the codebase investigation is complete. The orchestrator should proceed to `sdd-propose` with:
- **Change name**: `bot-sale-domain-events`
- **Approach**: Approach A — new `SalesService.confirmBotSale()` method
- **Scope**: `src/chatbot-api/` (delegation change) + `src/sales/` (new method + events) + module wiring
- **TDD surface**: `SalesService.spec.ts` (confirmBotSale invariants + event emission), `ChatbotApiService.spec.ts` (delegation + idempotency), chatbot-api module DI test
