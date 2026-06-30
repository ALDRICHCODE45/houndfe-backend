# Design: Sale Cancellation

## Technical Approach

A single transactional `SalesService.cancelSale` use case mirrors `chargeDraft` (`sales.service.ts:1384`): `runInTransaction → findByIdForUpdate (row lock) → sale.cancel(reason, actor) → incrementStockForRestock(tx) → persistCancellation → outbox.publish('sale.canceled')`. All-or-nothing. Both the admin controller and chatbot controller call the same use case. Refunds use a dedicated `SaleRefund` model (audit trail; originals preserved). Income exclusion falls out naturally because every reporting path already scopes to `status: 'CONFIRMED'`. Delivered in chained slices A→D.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|----------|--------|----------|-----------|
| Refund model | NEW `SaleRefund` table | Negative `SalePayment` rows | Clean audit; avoids breaking `@Min(1)` + positive-sum KPIs |
| Atomicity | Same `runInTransaction` tx for restock+refund+status+outbox | Event-driven listeners | Money path must be all-or-nothing; lag = inconsistent money/stock |
| Financials | Preserve `paidCents`/`totalCents`; exclude via `status=CANCELED` | Zero the fields | Audit integrity; reporting already CONFIRMED-scoped |
| Restock primitive | NEW bulk `incrementStockForRestock` mirroring decrement | Reuse `Product.increaseStock` | Existing helper rejects variants + ignores `useStock` |
| RBAC | Reuse `delete:Sale` + `sales:write` | New `cancel` action/scope | Locked; no new RBAC in v1 |
| Reason | Mandatory enum (`@IsEnum`) | Free text | Locked; consistent reporting/analytics |
| CREDIT vs PAID | Branch on `paymentStatus`/`paidCents` | Always full refund | Locked: CREDIT = restock only, refund 0, debt cleared |

## Data Flow

    Controller (admin | chatbot) ──> SalesService.cancelSale
              │                              │
              ▼                              ▼ runInTransaction(tx)
        cancel-sale.dto          findByIdForUpdate ─ sale.cancel(guards)
                                       │
              ┌────────────────────────┼──────────────────────┐
              ▼                        ▼                        ▼
   ProductsService.increment   persistCancellation     OutboxWriter.publish
   StockForRestock(tx)         (status, refunds)        ('sale.canceled', tx)

## Schema Changes (Slice A)

```prisma
enum SaleStatus { DRAFT CONFIRMED CANCELED }          // add CANCELED (schema.prisma:121)
enum SaleCancelReason { CUSTOMER_REQUEST ORDER_ERROR OUT_OF_STOCK DUPLICATE_SALE OTHER }  // NEW

model Sale {                                            // add fields
  // ...existing...
  canceledAt       DateTime?
  cancelReason     SaleCancelReason?
  canceledByUserId String?
  refunds          SaleRefund[]
}

model SaleRefund {                                      // NEW
  id            String           @id @default(cuid())
  tenantId      String
  saleId        String
  salePaymentId String?                                  // null for CREDIT (no source payment)
  method        SalePaymentMethod                        // reuse existing enum
  amountCents   Int
  reason        SaleCancelReason
  createdAt     DateTime         @default(now())
  sale          Sale             @relation(fields: [saleId], references: [id])
  salePayment   SalePayment?     @relation(fields: [salePaymentId], references: [id])
  @@index([tenantId, saleId])
  @@index([tenantId, createdAt])
}
```
Migration: additive only (rollback = drop column/table/enum value). Run before code deploy.

## Domain (Slice A)

`SaleStatus` type (`sale.entity.ts:13`) gains `'CANCELED'`. NEW `Sale.cancel(reason, actor)`:
- Guard `status !== 'CONFIRMED'` → throw `SALE_NOT_CANCELLABLE`.
- Guard `deliveryStatus IN (SHIPPED, DELIVERED)` → throw `SALE_DELIVERED_CANNOT_CANCEL`.
- Sets `status='CANCELED'`, `canceledAt`, `cancelReason`, `canceledByUserId`.
- Refund computation: `paymentStatus === 'CREDIT'` (or `paidCents === 0`) → `refundedCents = 0`, debt cleared; else `refundedCents = paidCents` (one `SaleRefund` per recorded `SalePayment`).
- NEW `SaleCanceledEvent` (`sale.events.ts`): `{ saleId, tenantId, actorId, folio, reason, refundedCents, restockedItems, canceledAt }`.

## Restock Primitive (Slice B) — NEW

Port `IProductRepository.incrementStockForRestock` + adapter mirror of `decrementStockForCharge` (`prisma-product.repository.ts:175`):

```ts
incrementStockForRestock(adjustments: Array<{ productId; variantId?: string|null; quantity }>): Promise<void>
```
- Same tenant Prisma client (participates in caller's tx). Per-line loop.
- Variant line → `variant.updateMany({ quantity: { increment } })` (no `useStock` guard, matching decrement).
- Product line → `product.updateMany({ where: { useStock: true }, data: { increment } })`; `useStock: false` skipped (no error — increment can't fail like decrement). Exposed via `ProductsService.incrementStockForRestock`.

## Use Case (Slice C)

`SalesService.cancelSale(saleId, actor, dto)`:
1. `acquire*Idempotency` with cancel-specific operation key (e.g. `sale:cancel:{saleId}`) — retry-safe; if already CANCELED, return prior result (no double restock/refund).
2. `runInTransaction(tx)`: `findByIdForUpdate(saleId)` (row lock) → tenant/ownership guard.
3. `sale.cancel(reason, actor)` (domain guards).
4. Build restock adjustments from sale items → `productsService.incrementStockForRestock(adjustments)` (same tx).
5. Compute refunds; `persistCancellation(sale, refunds)` — NEW repo method: flips `status=CANCELED`, writes cancel metadata, inserts `SaleRefund` rows, clears `debtCents` for CREDIT; preserves `paidCents`/`totalCents`.
6. `outboxWriter.publish(tx, tenantId, 'Sale', saleId, 'sale.canceled', payload)`.
7. `mark*IdempotencySucceeded`.

## Reporting Audit (Slice C)

Remove the `!== 'CANCELED'` strip at `prisma-sale.repository.ts:763` so listing CANCELED works. CONFIRMED-scoped methods already exclude CANCELED (no change needed, verify): `findManyConfirmed` (827), `countConfirmed` (875), `findOneWithRelations` (915), `groupByPaymentStatusConfirmed`, `countNotDeliveredConfirmed`.

## HTTP Surfaces (Slice D)

| Route | Guards | Decorator |
|-------|--------|-----------|
| `POST /sales/:id/cancel` | `JwtAuthGuard, TenantContextGuard, PermissionsGuard` | `@RequirePermissions(['delete','Sale'])` |
| `POST /chatbot-api/sales/:saleId/cancel` | `ServiceAuthGuard` | `@RequiredScopes('sales:write')` (delegates to `SalesService.cancelSale`) |

`cancel-sale.dto.ts` (NEW): `{ reason: SaleCancelReason (@IsEnum, required) }`. Response: `{ saleId, status: 'CANCELED', refundedCents, restockedItems, canceledAt }`. Error map: invalid state (`SALE_NOT_CANCELLABLE`/`SALE_DELIVERED_CANNOT_CANCEL`) → **409 Conflict**; not found → 404; forbidden → 403.

## Testing Strategy (strict TDD, Jest, `pnpm run test`)

| Slice | Specs |
|-------|-------|
| A | `sale.entity.spec` — cancel guards (CONFIRMED-only, SHIPPED/DELIVERED block, CREDIT refund=0) |
| B | `prisma-product.repository.spec` — variant + product + `useStock:false` restock parity |
| C | `sales.service.spec` (cancelSale atomicity, idempotency, outbox); `prisma-sale.repository.spec` — **deliberately update `:401-404`** (listing now returns CANCELED) |
| D | controller specs — RBAC/scope guards, 409 mapping, DTO validation |

## Migration / Rollout

Additive migration runs first (slice A). Slice B before C (dependency). No destructive change to existing behavior; cancel path is purely additive. Rollback = drop enum value/column/table (safe if no cancellations recorded).

## Open Questions

- [ ] Confirm `SaleCancelReason` catalog is final (marked confirmable; enum extensible without data migration).
- [ ] Confirm `changeDueCents` (cash overpayment) handling on refund — assumed excluded from `refundedCents` (refund = `paidCents`).
