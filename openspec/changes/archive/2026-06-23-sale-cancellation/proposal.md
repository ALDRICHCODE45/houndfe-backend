# Proposal: Sale Cancellation

## Intent

The legacy "pulpos" POS is being deprecated. `houndfe-backend` must own the full sale cancellation flow so any client (WhatsApp chatbot, admin panel, POS) triggers cancellation via API with all business logic centralized in the backend. Today, no cancel/refund/restock capability exists anywhere in the codebase.

## Scope

### In Scope
- Add `CANCELED` to `SaleStatus` enum (Prisma + domain) with cancel metadata fields
- `Sale.cancel()` aggregate method with state guards (CONFIRMED-only, non-delivered)
- `SaleRefund` model for clean refund audit trail (dedicated table, not negative payments)
- Bulk variant-aware `incrementStockForRestock` in Products (mirrors `decrementStockForCharge`)
- Transactional `cancelSale` use case in `SalesService` (restock + refund + status flip + outbox, all-or-nothing)
- `persistCancellation` repo method + listing/KPI audit to exclude CANCELED
- `sale.canceled` outbox event + `SaleCanceledEvent` domain event
- Admin endpoint `POST /sales/:id/cancel` with `@RequirePermissions(['delete','Sale'])`
- Chatbot endpoint `POST /chatbot-api/sales/:saleId/cancel` with `@RequiredScopes('sales:write')`
- Cancel reason DTO with mandatory enum: `CUSTOMER_REQUEST | ORDER_ERROR | OUT_OF_STOCK | DUPLICATE_SALE | OTHER` *(confirmable catalog)*

### Out of Scope
- Partial refunds (v1 = full refund of all recorded payments)
- Automated card/transfer refund processing (refund is recorded, not executed)
- Cancellation of SHIPPED/DELIVERED sales (blocked by guard)
- Admin/POS UI changes
- New RBAC permissions or scopes (reuses existing `delete:Sale` + `sales:write`)

## Capabilities

### New Capabilities
- `sale-cancellation`: Full sale cancellation lifecycle — state transition, refund recording, inventory restock, outbox event, and HTTP surfaces for admin + chatbot

### Modified Capabilities
- `sales`: `SaleStatus` gains `CANCELED`; listing/KPI queries must exclude it; `Sale` entity gains `cancel()` method
- `sale-payments`: Refund concept introduced via `SaleRefund` (no changes to `SalePayment` itself, but payment aggregation context changes — canceled sales preserve original `paidCents` while `SaleRefund` records the reversal)
- `chatbot-api-foundation`: New cancel endpoint added to chatbot API surface

## Approach

Single transactional `cancelSale` use case mirroring `chargeDraft` (`sales.service.ts:1384`):

```
saleRepo.runInTransaction(async (tx) => {
  findByIdForUpdate(saleId)           // row lock
  sale.cancel(reason, actor)          // domain guard: CONFIRMED + not SHIPPED/DELIVERED
  incrementStockForRestock(items, tx) // new Products primitive
  persistCancellation(sale, refunds)  // status=CANCELED + SaleRefund rows
  outbox.publish('sale.canceled')     // transactional outbox
})
```

CREDIT sales: restock only, refund = 0, debt canceled. Idempotency via existing `acquire*Idempotency` primitives.

## Locked Requirements

| # | Decision | Rule |
|---|----------|------|
| 1 | Refund scope | Full refund of all recorded payments (no partial in v1) |
| 2 | Delivered sales | BLOCK cancellation when `deliveryStatus` is SHIPPED or DELIVERED |
| 3 | CREDIT sales | Restock only, refund = 0, cancel outstanding debt |
| 4 | Cancel reason | Mandatory, fixed enum catalog (not free text) |
| 5 | Refund persistence | Dedicated `SaleRefund` model (not negative `SalePayment` rows) |
| 6 | RBAC | Reuse `delete:Sale` (admin) + `sales:write` (chatbot) |
| 7 | Financial fields | Preserve originals; exclusion via `status=CANCELED` |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Add `CANCELED` to enum, cancel metadata on `Sale`, new `SaleRefund` model |
| `prisma/migrations/` | New | Migration for schema changes |
| `src/sales/domain/sale.entity.ts` | Modified | `CANCELED` status, `cancel()` method with guards |
| `src/sales/domain/events/sale.events.ts` | Modified | Add `SaleCanceledEvent` |
| `src/sales/domain/sale.repository.ts` | Modified | Add `persistCancellation` port |
| `src/sales/infrastructure/prisma-sale.repository.ts` | Modified | Implement `persistCancellation`, adjust listing filter at line 763 |
| `src/sales/sales.service.ts` | Modified | New `cancelSale` transactional use case |
| `src/sales/dto/` | New | `cancel-sale.dto.ts` with reason enum |
| `src/sales/sales.controller.ts` | Modified | `POST /sales/:id/cancel` route |
| `src/chatbot-api/presentation/chatbot-api.controller.ts` | Modified | `POST /chatbot-api/sales/:saleId/cancel` route |
| `src/chatbot-api/application/chatbot-api.service.ts` | Modified | Delegate to `SalesService.cancelSale` |
| `src/products/domain/product.repository.ts` | Modified | Add `incrementStockForRestock` port |
| `src/products/infrastructure/prisma-product.repository.ts` | Modified | Implement bulk variant-aware restock |
| `src/products/products.service.ts` | Modified | Expose `incrementStockForRestock` |

## Chained Delivery Slices

| Slice | Scope | Budget Est. |
|-------|-------|-------------|
| A | Schema migration + domain (`SaleStatus`, `Sale.cancel()`, `SaleCanceledEvent`, `SaleRefund` model) | ~200 lines |
| B | `incrementStockForRestock` in Products (repo port + adapter + service) | ~200 lines |
| C | `cancelSale` use case + `persistCancellation` + outbox + listing/KPI audit | ~350 lines |
| D | HTTP surfaces: admin controller + chatbot controller + DTOs | ~250 lines |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cross-module transaction (Products restock inside Sales tx) | Med | Mirror `decrementStockForCharge` — same `tx` client passed to Products |
| Listing filter change breaks existing spec | Low | Update `prisma-sale.repository.spec.ts:401-404` deliberately in slice C |
| Cancel reason enum needs business iteration | Low | Mark catalog as confirmable; enum is extensible without migration |
| Double-restock on bot retry | Low | Reuse `acquire*Idempotency` primitives with cancel-specific operation key |

## Rollback Plan

- **Schema**: down-migration removes `CANCELED` from enum and drops `SaleRefund` table. No data loss if no cancellations were performed.
- **Code**: revert the feature branch. No existing behavior is modified destructively — the cancel path is purely additive.
- **Data**: if cancellations were already recorded, a data script must re-confirm affected sales and reverse restock. Document this in the migration.

## Dependencies

- Prisma migration must run before any domain/service code deploys
- Products module `incrementStockForRestock` (slice B) must land before `cancelSale` use case (slice C)

## Success Criteria

- [ ] `POST /sales/:id/cancel` returns 200 for a CONFIRMED, non-delivered sale and transitions status to CANCELED
- [ ] `SaleRefund` rows are created with correct amounts matching original `SalePayment` totals
- [ ] Inventory is restored: product and variant quantities increment by the canceled sale's item quantities
- [ ] CREDIT sales cancel with restock, zero refund, and cleared debt
- [ ] SHIPPED/DELIVERED sales are rejected with 409 Conflict
- [ ] Already-canceled sales are idempotent (no double restock/refund)
- [ ] `sale.canceled` outbox event is published inside the transaction
- [ ] KPI/revenue queries exclude CANCELED sales (no financial impact)
- [ ] Chatbot cancel endpoint works with `sales:write` scope
