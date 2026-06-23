# Tasks: Sale Cancellation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1000 (A:200, B:200, C:350, D:250) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Sequential work-unit commits A→B→C→D on same branch |
| Delivery strategy | single developer, no PR ceremony |
| Chain strategy | sequential work units on same branch |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: sequential work units on same branch
400-line budget risk: Low

### Delivery Context

Single developer workflow: work on dedicated branch, clean work-unit commits (A→B→C→D), merge to main at completion. Review budget: 800 lines/slice. Each slice is autonomous, test-covered, and reversible.

## Slice A: Schema Migration + Domain

### Phase A.1: Prisma Schema Changes
- [x] A.1.1 Add `CANCELED` to `SaleStatus` enum in `prisma/schema.prisma:121`
- [x] A.1.2 Create `SaleCancelReason` enum with 5 values (CUSTOMER_REQUEST, ORDER_ERROR, OUT_OF_STOCK, DUPLICATE_SALE, OTHER)
- [x] A.1.3 Add cancel metadata to `Sale` model: `canceledAt`, `cancelReason`, `canceledByUserId`, `refunds` relation
- [x] A.1.4 Create `SaleRefund` model with tenantId, saleId, salePaymentId, method, amountCents, reason, createdAt, indexes
- [x] A.1.5 Generate Prisma migration with `npx prisma migrate dev --name add-sale-cancellation`

### Phase A.2: Domain Model (TDD)
- [x] A.2.1 RED: Write spec for `Sale.cancel()` guard: status must be CONFIRMED (`sale.entity.spec.ts`)
- [x] A.2.2 GREEN: Add `'CANCELED'` to `SaleStatus` type and implement guard in `Sale.cancel()` (`sale.entity.ts:13`)
- [x] A.2.3 RED: Write spec for delivery guard: SHIPPED/DELIVERED must be rejected
- [x] A.2.4 GREEN: Add delivery status guard to `Sale.cancel()` throwing `SALE_DELIVERED_CANNOT_CANCEL`
- [x] A.2.5 RED: Write spec for CREDIT sale: refund = 0, debt cleared
- [x] A.2.6 GREEN: Implement `Sale.cancel(reason, actor)` with refund computation: CREDIT → 0, else → paidCents
- [x] A.2.7 Create `SaleCanceledEvent` in `sale.events.ts` with payload: saleId, tenantId, actorId, folio, reason, refundedCents, restockedItems, canceledAt

**Work-unit commit A**: `feat(sales): add CANCELED status, cancel() domain method, and SaleRefund model`

## Slice B: Restock Primitive in Products

### Phase B.1: Repository Port + Adapter (TDD)
- [x] B.1.1 RED: Write spec for `incrementStockForRestock` with variant line (`prisma-product.repository.spec.ts`)
- [x] B.1.2 GREEN: Add port `IProductRepository.incrementStockForRestock(adjustments)` (`product.repository.ts`)
- [x] B.1.3 GREEN: Implement variant increment in adapter: `variant.updateMany({ quantity: { increment } })` (`prisma-product.repository.ts`)
- [x] B.1.4 RED: Write spec for product line with `useStock: true`
- [x] B.1.5 GREEN: Implement product increment: `product.updateMany({ where: { useStock: true }, data: { quantity: { increment } } })`
- [x] B.1.6 RED: Write spec for `useStock: false` → no-op (no error)
- [x] B.1.7 GREEN: Verify skip logic (already implicit via `where: { useStock: true }`)

### Phase B.2: Service Exposure
- [x] B.2.1 Expose `ProductsService.incrementStockForRestock(adjustments)` wrapping repo method (`products.service.ts`)

**Work-unit commit B**: `feat(products): add incrementStockForRestock for sale cancellation restock`

## Slice C: cancelSale Use Case + Persistence

### Phase C.1: Repository Method (TDD)
- [ ] C.1.1 RED: Write spec for `persistCancellation` flipping status, writing refunds (`prisma-sale.repository.spec.ts`)
- [ ] C.1.2 GREEN: Add port `ISaleRepository.persistCancellation(sale, refunds)` (`sale.repository.ts`)
- [ ] C.1.3 GREEN: Implement in adapter: update Sale with cancel metadata, insert SaleRefund rows, clear debtCents for CREDIT (`prisma-sale.repository.ts`)
- [ ] C.1.4 RED: Write spec for listing with CANCELED → update `:401-404` expectation deliberately
- [ ] C.1.5 GREEN: Remove `!== 'CANCELED'` strip at line 763 so listing returns CANCELED when filtered

### Phase C.2: Use Case (TDD)
- [ ] C.2.1 RED: Write spec for `cancelSale` happy path: CONFIRMED non-delivered → status CANCELED, restock, refund, outbox (`sales.service.spec.ts`)
- [ ] C.2.2 GREEN: Implement `SalesService.cancelSale(saleId, actor, dto)`: idempotency → runInTransaction → findByIdForUpdate → sale.cancel → incrementStockForRestock → persistCancellation → outbox.publish (`sales.service.ts`)
- [ ] C.2.3 RED: Write spec for idempotent retry (same operation key → no double restock/refund)
- [ ] C.2.4 GREEN: Add `acquire*Idempotency` with `sale:cancel:{saleId}` key + `mark*IdempotencySucceeded`
- [ ] C.2.5 RED: Write spec for CREDIT sale: refund = 0, debt cleared
- [ ] C.2.6 GREEN: Verify refund computation branches on `paymentStatus === 'CREDIT'` or `paidCents === 0`
- [ ] C.2.7 RED: Write spec for SHIPPED/DELIVERED → 409 Conflict
- [ ] C.2.8 GREEN: Map `SALE_DELIVERED_CANNOT_CANCEL` exception to 409

**Work-unit commit C**: `feat(sales): add cancelSale use case with restock, refund, and outbox`

## Slice D: HTTP Surfaces

### Phase D.1: DTO + Admin Route (TDD)
- [ ] D.1.1 Create `cancel-sale.dto.ts` with `reason: SaleCancelReason` (@IsEnum, required) (`src/sales/dto/`)
- [ ] D.1.2 RED: Write spec for admin route RBAC: `delete:Sale` required (`sales.controller.spec.ts`)
- [ ] D.1.3 GREEN: Add `POST /sales/:id/cancel` route with `@RequirePermissions(['delete','Sale'])` (`sales.controller.ts`)
- [ ] D.1.4 RED: Write spec for 409 mapping (invalid state) + 404 (not found) + DTO validation
- [ ] D.1.5 GREEN: Wire route to `cancelSale` use case; map exceptions to HTTP status codes

### Phase D.2: Chatbot Route (TDD)
- [ ] D.2.1 RED: Write spec for chatbot route scope: `sales:write` required (`chatbot-api.controller.spec.ts`)
- [ ] D.2.2 GREEN: Add `POST /chatbot-api/sales/:saleId/cancel` with `@RequiredScopes('sales:write')` (`chatbot-api.controller.ts`)
- [ ] D.2.3 GREEN: Delegate to `SalesService.cancelSale` from `chatbot-api.service.ts`

**Work-unit commit D**: `feat(api): add sale cancellation endpoints for admin and chatbot`

## Verification Alignment

| Spec Scenario | Task Coverage |
|---------------|---------------|
| Confirmed non-delivered sale is canceled | C.2.1, C.2.2 |
| CREDIT sale cancels without money refund | C.2.5, C.2.6 |
| Invalid state rejected with 409 | C.2.7, C.2.8 |
| Idempotent retry | C.2.3, C.2.4 |
| Admin RBAC | D.1.2, D.1.3 |
| Chatbot scope | D.2.1, D.2.2 |
| Listing returns CANCELED when filtered | C.1.4, C.1.5 |
| Refund audit preserves originals | C.1.1, C.1.3 |

## Dependencies

- Prisma migration (A.1.5) MUST run before domain/service code (A.2, B, C, D)
- Slice B MUST land before Slice C (C.2.2 calls `incrementStockForRestock`)

## Rollback Safety

Each slice is independently reversible: A = down-migration, B = revert Products changes, C = revert use case, D = revert routes. No destructive changes to existing behavior.
