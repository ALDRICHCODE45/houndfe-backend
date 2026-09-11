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
| Locks/versioning                                          | Addresses concurrent races, not this scope                                               | Exclude                                                  |

### Service and domain

After tenant-scoped lookup and ownership, call existing `Sale.ensureDraft()` (make public), retaining `BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT')`. Guard all five operations before dependent reads/mutations. Move removal's ownership before lifecycle, preserving `SALE_UPDATE_FORBIDDEN`. Preserve other ownership messages and missing errors: `EntityNotFoundError('Sale', id)` versus removal's `SALE_NOT_FOUND`. Cross-tenant lookup remains missing without disclosure.

Guard `Sale.addItem`, `updateItemQuantity`, `removeItem`, `clearItems` before mutation, including empty clears; guard `recomputePricingAndPromotions` before discount mutation. Keep mutable item exposure for pricing; repository validation prevents persisted bypass.

Preserve product+variant stacking, existing identity, summed quantities, stock checks, quantity validation, pricing/promotions, removal opt-out cleanup, and clear's no-recompute behavior.

### Repository contract

Add `ISaleRepository.saveDraftItems(sale: Sale): Promise<Sale>` for the four item-service callers; retain `save(sale)` and `delete(id)` signatures. Both save methods enter one private implementation with explicit draft intent; generic save is not an unchecked escape hatch.

Before **any** write, use the existing tenant-scoped client to load persisted sale plus items:

- Draft intent requires both incoming and existing status DRAFT; missing existing sale raises `EntityNotFoundError('Sale', sale.id)`, never creates.
- Generic save against existing non-DRAFT rejects incoming DRAFT or changed item snapshots with `SALE_NOT_DRAFT`.
- Compare identity-keyed, order-independent snapshots using every item column currently mapped by `save`, including quantity, product/variant, names/image, price source/list, discount/promotion/reward fields and timestamps. Normalize enum case, nulls and Date values consistently with persistence; exclude database-only audit fields. Reuse the write projection rather than duplicate field lists.
- Unchanged-item legitimate generic saves retain their current write behavior. Generic creation and DRAFT persistence remain unchanged. This is not a new transition validator.

`delete` reads persisted lifecycle before deletion and rejects non-DRAFT. Missing rows continue through the existing Prisma deletion failure; service missing contracts stay unchanged. No write, timestamp update, promotion-junction change, or success emission precedes rejection. No new concurrency guarantee is claimed.

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

No migrations, refunds changes, reports, history repair, or concurrency work. Deploy code-only after authorized verification. Prefer narrow correction; rollback reopens the vulnerability and requires operational approval/restricted draft access. Forecast implementation against 400 added/deleted lines per work unit; ask-on-risk grants neither chaining nor exceptions.

Threat matrix: N/A—no routing, shell, subprocess, VCS, executable classification, or process integration changes.

Open questions: none. Next: user review; tasks require separate authorization.
