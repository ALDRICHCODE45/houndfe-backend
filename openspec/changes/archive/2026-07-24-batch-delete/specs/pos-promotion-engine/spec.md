# Delta for POS Promotion Engine

## ADDED Requirements

| # | Requirement | RFC 2119 | Summary |
|---|---|---|---|
| R11 | Batch delete endpoint | MUST | `POST /promotions/batch-delete` with `@RequirePermissions(['batch_delete', 'Promotion'])` |
| R12 | Sale-reference guard | MUST | Pre-flight rejects promotions referenced by `SaleItem.promotionId` or `SalePromotionApplied.promotionId` |
| R13 | Cascade deletes | MUST | Join tables (PromotionTargetItem, PromotionCustomer, PromotionPriceList, PromotionDayOfWeek) cascade |
| R14 | State-agnostic | MUST | Promotion state (ACTIVE, ENDED, SCHEDULED) does NOT block batch delete |
| R15 | Service contract | MUST | `PromotionsService` implements `BatchDeletableService` |

### R11: Batch Delete Endpoint

`POST /promotions/batch-delete` MUST accept `{ ids: string[] }` and delegate to the `BatchDeleteOrchestrator`. The endpoint MUST be guarded by `@RequirePermissions(['batch_delete', 'Promotion'])`.

#### Scenario: Happy path — batch delete 5 unreferenced promotions
- GIVEN 5 promotions with no sale references, user has `batch_delete:Promotion`
- WHEN `POST /promotions/batch-delete { ids: [p1..p5] }`
- THEN all 5 are deleted; response `200 { deleted: 5 }`; join-table rows cascade

#### Scenario: Empty batch → validation error
- GIVEN `{ ids: [] }`
- WHEN `POST /promotions/batch-delete` runs
- THEN DTO validation returns 400

#### Scenario: Batch exceeds 100 → validation error
- GIVEN 101 UUIDs
- WHEN `POST /promotions/batch-delete` runs
- THEN DTO validation returns 400

#### Scenario: Missing batch_delete permission → forbidden
- GIVEN user has `delete:Promotion` but NOT `batch_delete:Promotion`
- WHEN `POST /promotions/batch-delete` runs
- THEN guard returns 403

### R12: Sale-Reference Pre-Flight Guard

Pre-flight MUST query `SaleItem` and `SalePromotionApplied` for any of the requested promotion IDs. If any reference exists, the ENTIRE batch is rejected with `PROMOTION_REFERENCED_BY_SALE`.

#### Scenario: FK guard — one promotion referenced by a SaleItem
- GIVEN 3 promotions, where p2 is referenced by `SaleItem.promotionId`
- WHEN pre-flight validates
- THEN the entire batch is rejected; response `400 { code: 'PROMOTION_REFERENCED_BY_SALE', offendingIds: [p2], reason }`; none deleted

#### Scenario: Mix of valid and referenced → all-or-nothing
- GIVEN 5 promotions, p1 valid, p2 referenced by `SalePromotionApplied.promotionId`, p3-p5 valid
- WHEN `POST /promotions/batch-delete` runs
- THEN the transaction rolls back; `offendingIds: [p2]`; zero rows deleted

#### Scenario: All valid, none referenced → proceeds
- GIVEN 3 promotions with no `SaleItem` or `SalePromotionApplied` references
- WHEN pre-flight validates
- THEN `offendingIds` is empty; orchestrator proceeds

### R13-R14: Cascade and State

Join-table rows (PromotionTargetItem, PromotionCustomer, PromotionPriceList, PromotionDayOfWeek) MUST cascade on delete. Promotion state MUST NOT block batch delete.

#### Scenario: Cascade cleans join tables
- GIVEN promotion P1 with 2 TargetItems and 1 PromotionCustomer row
- WHEN P1 is batch-deleted
- THEN all associated join-table rows are also removed

#### Scenario: ENDED promotion is deletable
- GIVEN a promotion with effective status ENDED, unreferenced by sales
- WHEN included in a batch delete call
- THEN the promotion is deleted successfully
