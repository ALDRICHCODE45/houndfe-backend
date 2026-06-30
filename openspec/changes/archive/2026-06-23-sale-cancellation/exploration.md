# Exploration: Sale Cancellation (`sale-cancellation`)

## Goal

`houndfe-backend` must own the FULL sale cancellation flow (the legacy "pulpos" POS is being deprecated). Any client — WhatsApp chatbot, admin panel, POS — triggers cancellation via API; ALL business logic lives in the backend. The chatbot only CONSUMES the endpoint.

Required behavior to assess:
1. Transition a sale to `CANCELED` with valid-state guards.
2. Refund handling per recorded payments.
3. Re-inject (restock) the sale's products into inventory.
4. Deduct the money from income / financial reporting.

---

## Current State (verified against real code)

### 1. Sale state machine — `CANCELED` does NOT exist in the domain or DB

- Domain type: `src/sales/domain/sale.entity.ts:13` → `export type SaleStatus = 'DRAFT' | 'CONFIRMED';`. NO `CANCELED`.
- Prisma enum: `prisma/schema.prisma:121` → `enum SaleStatus { DRAFT CONFIRMED }`. NO `CANCELED`. **A migration is required.**
- Transitions/guards that exist today on the entity:
  - `Sale.confirm(input)` — `sale.entity.ts:153`. Guards `status !== 'DRAFT'` → throws `SALE_ALREADY_CONFIRMED`.
  - `ensureDraft()` — `sale.entity.ts:284`. Used by `assignCustomer`, `clearCustomer`, `setShippingAddress`.
  - There is **NO `cancel()` method** on the aggregate. Confirmed via grep across `src/sales/**` — no `cancel`, `refund`, `reverse`, or `void` symbols exist anywhere in the sales module.
- `CANCELED` already appears as a *forward-looking placeholder*, never wired:
  - `src/sales/dto/list-sales-query.dto.ts:35` → `ListSalesStatus.CANCELED` is a valid query enum value.
  - `src/sales/infrastructure/prisma-sale.repository.ts:761-763` → the list filter **explicitly strips it**: `status: { in: input.status.filter((status) => status !== 'CANCELED') }`. A spec asserts this (`prisma-sale.repository.spec.ts:401-404`). So today, asking for CANCELED sales returns CONFIRMED-only.
- Reporting/listing/KPI queries hardcode `status: 'CONFIRMED'`:
  - `findManyConfirmed` (repo:827), `countConfirmed` (repo:875), `findOneWithRelations` (repo:915 `status: 'CONFIRMED'`), `groupByPaymentStatusConfirmed`, `countNotDeliveredConfirmed`.

### 2. Stock / inventory — decrement exists; restock (reverse) does NOT

- Inventory is owned by the **Products module** (`src/products/`). `SalesModule` already imports `ProductsModule` (`sales.module.ts:30`).
- Decrement on charge: `SalesService.chargeDraft` → `productsService.decrementStockForCharge(stockAdjustments)` (`sales.service.ts:1561`).
  - `ProductsService.decrementStockForCharge` (`products.service.ts:98`) → `IProductRepository.decrementStockForCharge` (`product.repository.ts:32`).
  - Adapter `PrismaProductRepository.decrementStockForCharge` (`prisma-product.repository.ts:175`): atomic conditional `updateMany` per adjustment with `quantity: { gte }` guard; for variants updates `variant.quantity`, for products updates `product.quantity` (only when `useStock: true`); products with `useStock: false` are skipped; throws `STOCK_INSUFFICIENT_AT_CONFIRM` if the conditional update affects 0 rows. This is the **all-or-nothing** primitive (runs inside the charge transaction).
- Single-item helpers on the entity: `Product.decreaseStock` / `Product.increaseStock` (`product.entity.ts:313,331`) — both throw `PRODUCT_HAS_VARIANTS` for variant products and only handle one product at a time. `ProductsService.increaseStock(productId, quantity)` (`products.service.ts:1478`) wraps the single-product path.
- **GAP**: there is NO bulk `incrementStockForRestock` mirror of `decrementStockForCharge`. The existing `increaseStock` does NOT handle variant lines (it rejects `hasVariants`) and does NOT account for `useStock: false` products. A restock operation needs a new repository method that mirrors the decrement adapter (per-line, variant-aware, `useStock`-aware, transaction-participating).
- Precedent for restock-on-reverse exists in another module: `src/orders/listeners/order-event.listener.ts:46` restores stock via `productsService.increaseStock(productId, quantity)` — but that path is product-only and event-driven, not transactional with the cancel write.

### 3. Payments — recorded as positive rows; NO refund concept anywhere

- `SalePayment` model (`schema.prisma:714`): `method` (`SalePaymentMethod`: CASH/CARD_CREDIT/CARD_DEBIT/TRANSFER/CREDIT), `amountCents Int`, `reference?`, `metadataJson Json?`. No status column, no sign convention, no refund/reversal type.
- Payments are written via `persistChargeConfirmation` (charge) and `persistCollectedPayment(s)` (add-payment). Aggregates kept on the `Sale` row: `paidCents`, `debtCents`, `paymentStatus` (PAID/PARTIAL/CREDIT), `changeDueCents`.
- DTO for adding payments: `dto/add-sale-payment.dto.ts` (supports legacy single + new `payments[]` array, max 5).
- **GAP**: there is NO refund concept in the repo, schema, domain, or service. A refund must be modeled. Two candidate shapes (design decision):
  - (a) Negative-amount `SalePayment` rows (e.g. a `REFUND`/reversal method or negative `amountCents`) — minimal schema churn but breaks the current `@Min(1)` / positive-sum assumptions in payment aggregation and KPIs.
  - (b) A dedicated `SaleRefund` model linked to `SalePayment` — cleaner audit trail, more schema work.

### 4. Income / financials — NO dedicated module; income is DERIVED from `sales` rows

- There is NO `income`/`revenue`/`financials`/`reporting` module anywhere in `src/` (verified by grep).
- "Income" = aggregation over `sales` rows filtered by `status` and `paymentStatus`/`paidCents`/`totalCents`. The list/KPI repo methods all hardcode `status: 'CONFIRMED'`, so a CANCELED sale is automatically excluded from those queries.
- **Therefore "deduct money from income" concretely means**: set the sale to `CANCELED` so it drops out of the CONFIRMED-scoped revenue/KPI aggregations. Optionally also zero/annotate the financial fields. We must AUDIT every place that computes revenue to confirm none of them count CANCELED. The known surfaces are the `*Confirmed` repo methods; the existing `!== 'CANCELED'` filter at repo:763 already anticipates this.

### 5. Events / outbox — reusable transactional outbox (`bot-sale-domain-events`) is in place

- `OutboxWriterService.publish(tx, tenantId, aggregateType, aggregateId, eventType, payload)` (`src/shared/outbox/outbox-writer.service.ts:23`) writes a `PENDING` row inside the caller's transaction.
- `OutboxEvent` model (`schema.prisma:818`): `aggregateType`, `aggregateId`, `eventType`, `payload Json`, `status` (`OutboxEventStatus`: PENDING/PUBLISHED/FAILED), `retryCount`, `nextAttemptAt`, `lockToken`, `lockedUntil`. Polled + dispatched by `OutboxPollerService` / `OutboxDispatcherService`.
- Existing sale events published this way: `sale.confirmed`, `sale.payment.received`, `sale.fully.paid` (`sales.service.ts:354,397,429`). `SalesModule` imports `OutboxModule` and injects `OutboxWriterService`.
- A `SaleCanceledEvent` should follow the same shape (see Approach). Suggested `eventType: 'sale.canceled'`, `aggregateType: 'Sale'`, payload: `{ saleId, tenantId, actorId, folio, reason, refundedCents, restockedItems, canceledAt }`. Add a matching domain event class in `src/sales/domain/events/sale.events.ts`.

### 6. API surface & RBAC

- **Admin/POS path** — `SalesController` (`src/sales/sales.controller.ts`, base `sales/drafts`) is draft-scoped. A cancellation acts on a CONFIRMED sale, so it belongs either on a new sale-level route on `SalesController` (e.g. `POST /sales/:id/cancel`) or on the query/ops controller (`sales-query.controller.ts`). Guards stack: `JwtAuthGuard, TenantContextGuard, PermissionsGuard` + `@RequirePermissions([...])`.
- **RBAC (CASL)**: subject `Sale` with actions `create/read/update/delete/manage` already exists (`src/auth/authorization/domain/permission.ts:149-154`; documented in `docs/RBAC.md:736-740`). Cancellation is destructive/financial — recommend `@RequirePermissions(['delete', 'Sale'])` (or `manage`), NOT `update`. No new permission strictly required, but a dedicated `cancel:Sale`-style action could be added if finer control is wanted (design decision).
- **Chatbot path** — `ChatbotApiController` (`src/chatbot-api/presentation/chatbot-api.controller.ts`, base `chatbot-api`), guarded by `ServiceAuthGuard` + `@RequiredScopes(...)` (scope strings like `sales:create`, `sales:write`). The chatbot already has `sales:write` routes (`attachReceipt`, `setDeliveryMetadata`). A bot cancel route → `POST /chatbot-api/sales/:saleId/cancel` with `@RequiredScopes('sales:write')` (or a new `sales:cancel` scope). The bot endpoint delegates to the SAME `SalesService` use case as the admin route.

### 7. Prisma schema — migration needed

A migration is required for at minimum:
- `enum SaleStatus { DRAFT CONFIRMED CANCELED }` (add `CANCELED`).
- Cancellation metadata on `Sale`: `canceledAt DateTime?`, `cancelReason String?`, optionally `canceledByUserId String?`.
- Refund persistence (depending on design decision in §3): either a new `SaleRefund` model or a reversal-aware extension of `SalePayment` (e.g. allow a refund method / negative amounts — would also require relaxing `@Min(1)` validation and revisiting aggregation).

### 8. Transactional pattern to mirror

`chargeDraft` (`sales.service.ts:1384-1648`) is the canonical template the cancel use case should mirror:
```
saleRepo.runInTransaction(async () => {
  findByIdForUpdate(saleId)            // row lock
  // guards (status, tenant, ownership)
  productsService.decrementStockForCharge(adjustments)   // ← cancel uses the RESTOCK inverse
  persistChargeConfirmation(...)        // ← cancel writes status=CANCELED + refund rows + zeroed financials
  outboxWriter.publish(... 'sale.confirmed')  // ← cancel publishes 'sale.canceled'
})
```
Cancel must use the same `runInTransaction` + `findByIdForUpdate` + outbox-in-transaction discipline so restock, refund, status flip, and event are atomic (all-or-nothing). Idempotency primitives also exist (`acquire*Idempotency` / `mark*IdempotencySucceeded`) and should be reused so a retried cancel (bot or POS) is safe.

---

## Affected Areas

- `prisma/schema.prisma` — add `CANCELED` to `SaleStatus`; add cancel metadata to `Sale`; add refund persistence (new model or `SalePayment` extension). New migration under `prisma/migrations/`.
- `src/sales/domain/sale.entity.ts` — add `'CANCELED'` to `SaleStatus`; add `cancel()` aggregate method with state guards.
- `src/sales/domain/events/sale.events.ts` — add `SaleCanceledEvent`.
- `src/sales/domain/sale.repository.ts` (port) + `src/sales/infrastructure/prisma-sale.repository.ts` (adapter) — add a `persistCancellation(...)` method (status flip + refund rows + financial fields); remove/adjust the `!== 'CANCELED'` filter at line 763 so listing CANCELED works.
- `src/products/domain/product.repository.ts` + `src/products/infrastructure/prisma-product.repository.ts` + `src/products/products.service.ts` — add a bulk, variant-aware, `useStock`-aware `incrementStockForRestock(adjustments)` mirroring `decrementStockForCharge`.
- `src/sales/sales.service.ts` — new `cancelSale(saleId, actor, dto)` use case (transactional, mirrors `chargeDraft`).
- `src/sales/sales.controller.ts` (or `sales-query.controller.ts`) — `POST /sales/:id/cancel` with `@RequirePermissions(['delete','Sale'])`.
- `src/chatbot-api/presentation/chatbot-api.controller.ts` + `application/chatbot-api.service.ts` — `POST /chatbot-api/sales/:saleId/cancel` with `@RequiredScopes('sales:write')` delegating to `SalesService`.
- `src/sales/dto/` — new `cancel-sale.dto.ts` (reason, optional refund instructions).
- Possibly `src/auth/authorization/domain/permission.ts` + `docs/RBAC.md` if a dedicated cancel action/scope is chosen.

---

## Approaches

1. **Single transactional cancel use case in `SalesService` (mirror `chargeDraft`)** — recommended
   - One `cancelSale` method runs `runInTransaction(findByIdForUpdate → guard → incrementStockForRestock → persistCancellation(status=CANCELED + refunds + financials) → outbox 'sale.canceled')`. Both the admin controller and the chatbot controller call it.
   - Pros: atomic (all-or-nothing) matching the established charge pattern; reuses outbox + idempotency primitives; single source of truth for both clients; consistent with hexagonal layering.
   - Cons: requires the new restock repo primitive and refund persistence up front.
   - Effort: Medium.

2. **Event-driven restock/refund (cancel writes status + emits, listeners restock & refund)** — like `order-event.listener`
   - `cancelSale` flips status + emits `sale.canceled`; separate listeners do restock and refund asynchronously.
   - Pros: decoupled; smaller core write.
   - Cons: NOT atomic — stock/refund can lag or fail after the sale is already CANCELED, producing inconsistent inventory/money (worse for a financial flow); harder idempotency. Rejected for the money-critical path.
   - Effort: Medium-High (eventual-consistency handling).

3. **Status-flip only now, defer refund/restock to a later slice**
   - Add `CANCELED` + guards + listing un-filter + KPI exclusion; refunds/restock as follow-up.
   - Pros: smallest first slice; unblocks reporting correctness ("deduct from income") immediately.
   - Cons: leaves money in payments and stock un-restored — incomplete vs the stated business goal.
   - Effort: Low.

---

## Recommendation

Approach **1** (single transactional `cancelSale` mirroring `chargeDraft`), delivered in **chained slices** to respect the review budget:
- Slice A: schema migration (`CANCELED` + cancel metadata + refund persistence) and domain (`SaleStatus`, `Sale.cancel()`, `SaleCanceledEvent`).
- Slice B: `incrementStockForRestock` in Products (repo + service) with variant/`useStock` parity.
- Slice C: `SalesService.cancelSale` transactional use case + `persistCancellation` repo method + outbox event + listing un-filter / KPI audit.
- Slice D: HTTP surfaces — admin `POST /sales/:id/cancel` and chatbot `POST /chatbot-api/sales/:saleId/cancel`.

This matches the existing all-or-nothing charge discipline, keeps both clients on one backend use case, and makes "deduct from income" fall out naturally from the CONFIRMED-scoped reporting.

---

## Risks

- **Transactional boundary across inventory + payments + income**: restock (Products module) + refund + status flip + outbox must be ONE transaction. `decrementStockForCharge` runs inside the sale transaction today; the new restock primitive must also participate in the same `runInTransaction` (tenant-scoped Prisma client) or atomicity is lost.
- **Restock variant gap**: `Product.increaseStock` rejects variant products (`PRODUCT_HAS_VARIANTS`) and ignores `useStock`. A naive reuse would fail to restock variant lines and would wrongly mutate non-stock products. New mirror primitive required.
- **Refund modeling is undecided**: negative `SalePayment` rows vs a `SaleRefund` table. Negative rows collide with `@Min(1)` validation and positive-sum aggregation in KPIs/`paidCents`. Needs an explicit human decision.
- **Partial vs full refund**: full refund of all recorded payments vs partial/configurable, and how `changeDueCents` (cash) is treated. Business decision needed.
- **Which statuses may be canceled**: presumably CONFIRMED only (DRAFT already has `deleteDraft`). Behavior for already-delivered sales (`deliveryStatus: DELIVERED`/`SHIPPED`) and for CREDIT (unpaid) sales (no money to refund, but stock still restocks) needs rules.
- **Idempotency**: bot/POS retries must not double-restock or double-refund. Reuse `acquire*Idempotency` primitives; cancel needs its own idempotency operation key.
- **Reporting audit**: must verify EVERY revenue/KPI surface excludes CANCELED (all `*Confirmed` repo methods already scope to CONFIRMED; confirm no other aggregation counts cancelled sales).
- **Listing filter change**: removing the `!== 'CANCELED'` strip at `prisma-sale.repository.ts:763` will change behavior of an existing spec (`prisma-sale.repository.spec.ts:401-404`) — update tests deliberately (TDD).
- **RBAC/scope choice**: reuse `delete:Sale` + `sales:write`, or introduce dedicated `cancel`/`sales:cancel`. Human call.

---

## Open Questions (need a human decision)

1. Refund persistence shape: negative `SalePayment` rows vs new `SaleRefund` model?
2. Full refund of all payments by default, or support partial/configurable refunds?
3. Rules for cancelling DELIVERED/SHIPPED sales — allowed? blocked? require a flag?
4. Cancelling CREDIT (unpaid) sales — restock only, refund = 0? Confirm.
5. RBAC: reuse `delete:Sale` / `sales:write`, or add dedicated `cancel` action + `sales:cancel` scope?
6. Should financial fields on the CANCELED sale be zeroed, or preserved-but-excluded (status alone)?
7. Is a `cancelReason` mandatory? Free-text vs enum?

---

## Ready for Proposal

**Yes.** The feasibility is clear: cancellation does not exist yet (confirmed — no `cancel`/`refund` symbols), but every building block needed (transactional outbox, idempotency, all-or-nothing stock primitive, CONFIRMED-scoped reporting, CASL + chatbot scopes) is already in place and can be mirrored. The proposal should lock down the 7 open questions (especially refund modeling and cancellable states) before spec/design, and plan the work as chained slices A–D.
