# Design: Protect confirmed sales

## Technical approach

Implement the approved five requirements/27 scenarios in [sales/spec.md](specs/sales/spec.md) through service/domain eligibility checks and persisted-state repository validation. Authorization is prospective; the proposal's historical unvalidated provenance remains unchanged. This document proposes implementation, not executed verification.

## Architecture decisions

| Option                                                    | Tradeoff                                                                                 | Decision                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Service guards alone                                      | Shared callers bypass them                                                               | Reject                                                   |
| Readonly items alone                                      | `ReadonlyArray<SaleItem>` exposes mutable elements; status readonly is compile-time only | Reject as enforcement                                    |
| Reject every non-DRAFT save                               | Breaks due-date/seller persistence                                                       | Reject                                                   |
| Explicit draft-write entry plus persisted item comparison | Adds a port method and comparison, preserves other signatures                            | Choose: separates operation intent from aggregate status |
| Parent-row lock + transaction                             | Serializes repository writers while preserving legitimate lifecycle workflows            | Choose: lock, reread, compare, and write atomically      |

### Service and domain

After tenant-scoped lookup and ownership, call existing `Sale.ensureDraft()` (make public), retaining `BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT')`. Guard all five operations before dependent reads/mutations. Move removal's ownership before lifecycle, preserving `SALE_UPDATE_FORBIDDEN`. Preserve other ownership messages and missing errors: `EntityNotFoundError('Sale', id)` versus removal's `SALE_NOT_FOUND`. Cross-tenant lookup remains missing without disclosure.

Guard `Sale.addItem`, `updateItemQuantity`, `removeItem`, `clearItems` before mutation, including empty clears; guard `recomputePricingAndPromotions` before discount mutation. Keep mutable item exposure for pricing; repository validation prevents persisted bypass.

Preserve product+variant stacking, existing identity, summed quantities, stock checks, quantity validation, pricing/promotions, removal opt-out cleanup, and clear's no-recompute behavior.

### Repository contract

Add `ISaleRepository.saveDraftItems(sale: Sale): Promise<Sale>` for the four item-service callers; retain `save(sale)` and `delete(id)` signatures. Both save methods enter one private implementation with explicit draft intent; generic save is not an unchecked escape hatch.

Before **any** write, reuse `TenantPrismaService.runInTransaction()`; its ambient CLS client is the only client used by the operation. Take a parameterized tenant-qualified `Sale ... FOR UPDATE` parent-row lock, then reread persisted status and items inside that same transaction:

- Draft intent requires both incoming and existing status DRAFT; missing existing sale raises `EntityNotFoundError('Sale', sale.id)`, never creates.
- Generic save against existing non-DRAFT rejects incoming DRAFT or changed item snapshots with `SALE_NOT_DRAFT`.
- Compare identity-keyed, order-independent snapshots using every item column currently mapped by `save`, including quantity, product/variant, names/image, price source/list, discount/promotion/reward fields and timestamps. Normalize enum case, nulls and Date values consistently with persistence; exclude database-only audit fields. Reuse the write projection rather than duplicate field lists.
- Unchanged-item legitimate generic saves retain their current write behavior. Generic creation and DRAFT persistence remain unchanged. This is not a new transition validator.

`delete` remains the separate WU8 lifecycle guard. The parent lock serializes only repository writers that honor this lock; it is not a global stale-write or optimistic-locking guarantee.

### WU8 delete — atomic sequence

`delete(id)` follows the same transaction-and-lock pattern as the WU7 `save` gate:

1. Enter `TenantPrismaService.runInTransaction()` with the ambient tenant-scoped CLS client.
2. Acquire the parameterized tenant-qualified `Sale … FOR UPDATE` parent-row lock (the same lock taken by `save`/`saveDraftItems`).
3. After the lock is held, reread persisted status and the persisted item set inside the same transaction via a tenant-scoped read. The post-lock reread satisfies the normative atomic observation/preservation contract for lock-honoring writers.
4. If the row exists and `status !== 'DRAFT'` → `BusinessRuleViolationError('SALE_NOT_DRAFT','SALE_NOT_DRAFT')`, zero writes.
5. If the row is DRAFT → call the existing `prisma.sale.delete({ where: { id } })` inside the same transaction. The eligible delete is atomic with the lock and reread.
6. If the row is missing (not found) or cross-tenant (tenant-scoped read returns `null`) → fall through to the existing `prisma.sale.delete({ where: { id } })` so `PrismaKnownRequestError(P2025)` surfaces as the observable contract. No cross-tenant row is disclosed by the tenant-scoped read; the delete call raises P2025 for any missing or unauthorized row.

PostgreSQL race and cascade evidence: the parent-row `FOR UPDATE` lock blocks all concurrent lock-honoring writers on that row's key until the transaction commits or rolls back, preventing interleaving of the reread and the delete. `prisma.sale.delete` cascades `SaleItem` rows through the database's foreign-key `ON DELETE CASCADE`; the cascade executes atomically inside the transaction — P2025 is preserved as the missing/cross-tenant delete contract only; any other database failure rolls back the transaction atomically without prescribing a Prisma error code. The tenant-scoped post-lock reread ensures the status and item set observed inside the delete transaction are the committed state at the moment the lock was acquired; no in-flight uncommitted change from a lock-honoring writer can be observed.

Concurrency claim: the atomic sequence holds only for repository operations that acquire and release the parent-row lock. It does not constrain writers that bypass the lock, does not prevent stale reads from non-transactional queries, and does not replace optimistic concurrency tokens. The six specialized contracts (`persistChargeConfirmation`, `persistCancellation`, `persistCollectedPayments`, `persistCollectedPayment`, `updatePaymentReference`, `markSaleDelivered`) retain their existing code paths and valid preconditions; none routes through the draft-delete guard.

## Data flow

```mermaid
sequenceDiagram
    participant S as SalesService
    participant D as Sale
    participant R as Repository
    participant P as Tenant Prisma
    S->>R: findById
    R->>P: scoped read
    S->>S: missing / ownership
    S->>D: ensureDraft; mutate; recompute if existing flow
    S->>R: saveDraftItems / delete
    R->>P: read persisted lifecycle and items
    alt prohibited
        R-->>S: SALE_NOT_DRAFT, zero writes
    else eligible
        R->>P: existing persistence
        R-->>S: success
        S->>S: existing success event
    end
```

## Changes and source handles

All paths below are under `src/sales/`; only this design is written now.

| Future file changes                           | Relevant symbols                                    |
| --------------------------------------------- | --------------------------------------------------- |
| `sales.service.ts`                            | Five draft methods; `recomputePricingAndPromotions` |
| `domain/sale.entity.ts`                       | `ensureDraft`, four item methods                    |
| `domain/sale.repository.ts`                   | Add draft-item persistence contract                 |
| `infrastructure/prisma-sale.repository.ts`    | `save`, `delete`, shared projection/validation      |
| Corresponding three existing `.spec.ts` files | Domain fixtures, service mocks, `makeMockPrisma`    |

Preservation readback: `chargeDraft`/`confirmBotSale` recompute while DRAFT and use `persistChargeConfirmation`; `cancelSale` uses `persistCancellation`; `addPayment` uses `persistCollectedPayments`. Leave these specialized contracts/preconditions untouched. `setDueDate`, `assignSeller`, `clearSeller` retain generic save; delivery setters/transitions remain available.

## Future testing

Cover all 27 scenarios: ten operation/status rejections, empty clears, DRAFT behavior and authorization. Assert unchanged aggregate/persisted snapshots and zero writes/events. Exercise direct domain calls, draft persistence, forged DRAFT generic saves, mutable-item bypass, deletion, unchanged legitimate saves, confirmation/cancellation/payments/delivery. Existing Jest repository mocks prove ordering, not database integration; add stateful snapshots, without claiming E2E coverage.

## Rollout and boundaries

No migrations, refunds changes, reports, or history repair. The atomic lock is scoped to repository writers honoring the parent lock; unrelated writers and generic stale-write prevention remain out of scope. Deploy code-only after authorized verification. Prefer narrow correction; rollback reopens the vulnerability and requires operational approval/restricted draft access. Forecast implementation against 400 added/deleted lines per work unit; ask-on-risk grants neither chaining nor exceptions.

Threat matrix: N/A—no routing, shell, subprocess, VCS, executable classification, or process integration changes.

Open questions: none. Next: user review; tasks require separate authorization.
