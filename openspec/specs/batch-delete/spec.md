# Batch Delete Specification

## Purpose

Cross-cutting abstraction for all-or-nothing batch deletion via `POST /<module>/batch-delete`. Orchestrator, DTO, controller factory, abstract service contract, and `batch_delete` permission action.

## Requirements

| # | Requirement | RFC 2119 | Summary |
|---|---|---|---|
| R1 | Orchestrator transaction | MUST | All-or-nothing batch delete in `prisma.$transaction(tx => ...)`. Any guard failure rolls back. |
| R2 | DTO validation | MUST | `ids: string[]` — non-empty UUID array, max 100 (env `BATCH_DELETE_MAX_SIZE`). |
| R3 | Controller factory | MUST | `BatchDeleteController.extendController({ subject })` generates a `POST batch-delete` NestJS controller. |
| R4 | Service contract | MUST | `BatchDeletableService` — `validateForBatchDeletion(tx, ids)` + `executeInTransaction(tx, ids)`. |
| R5 | Pre-flight in-tx | MUST | Validates: IDs exist in tenant, pass entity guards, no FK violations. Returns `offendingIds` + `reason`. |
| R6 | Response contract | MUST | Success: `200 { deleted: number }`. Failure: `4xx { code, offendingIds, reason }`. |
| R7 | AppActions | MUST | `'batch_delete'` added to `AppActions` type. |
| R8 | Permission registry | MUST | `batch_delete` entries seeded via `PERMISSION_REGISTRY` for applicable subjects. |
| R9 | Guard enforcement | MUST | `@RequirePermissions(['batch_delete', '<Subject>'])` on batch delete endpoints. |
| R10 | manage isolation | MUST | `manage` does NOT imply `batch_delete` — explicit opt-in required. |

### R1: Orchestrator Transaction

The `BatchDeleteOrchestrator` MUST execute batch deletes atomically within `prisma.$transaction`. Any pre-flight or FK failure rolls back the entire batch.

#### Scenario: All valid → committed
- GIVEN 5 valid IDs, all passing pre-flight
- WHEN orchestrator executes
- THEN transaction commits; response `{ deleted: 5 }`

#### Scenario: One fails pre-flight → rollback
- GIVEN 5 IDs, 1 referenced by a SaleItem
- WHEN orchestrator executes
- THEN rollback; response `4xx { code, offendingIds: [failedId], reason }`

#### Scenario: FK violation → rollback
- GIVEN an FK constraint blocks one deletion
- WHEN transaction attempts commit
- THEN rollback; response includes `offendingIds`

### R2: DTO Validation

`BatchDeleteDto` MUST validate `ids` as non-empty UUID array (max 100, env-configurable).

#### Scenario: Valid batch → accepted
- GIVEN `{ ids: ["uuid-1", "uuid-2"] }`
- WHEN DTO validates
- THEN passes

#### Scenario: Empty → 400
- GIVEN `{ ids: [] }`
- WHEN DTO validates
- THEN 400 `ArrayMinSize`

#### Scenario: >100 → 400
- GIVEN 101 UUIDs with default max 100
- WHEN DTO validates
- THEN 400 `ArrayMaxSize`

### R3: Controller Factory

`BatchDeleteController.extendController({ subject })` MUST generate a controller with `@Post('batch-delete')` and `@RequirePermissions(['batch_delete', subject])`.

#### Scenario: Factory output
- GIVEN `extendController({ subject: 'Promotion' })`
- WHEN registered in a NestJS module
- THEN `POST /promotions/batch-delete` accepts `{ ids }` and routes to orchestrator

### R4: Service Contract

`BatchDeletableService` MUST expose `validateForBatchDeletion(tx, ids): Promise<ValidationResult>` and `executeInTransaction(tx, ids): Promise<number>`.

#### Scenario: Contract fulfilled
- GIVEN `PromotionsService extends BatchDeletableService`
- WHEN `validateForBatchDeletion` returns no offending IDs
- THEN orchestrator proceeds to `executeInTransaction`

### R5: Pre-Flight Validation

Pre-flight MUST run inside the `$transaction`, verify tenant ownership, entity guards, and FK constraints.

#### Scenario: Cross-tenant → rejected
- GIVEN an ID from another tenant
- WHEN pre-flight validates
- THEN `offendingIds` includes it with `reason: 'NOT_FOUND'`

#### Scenario: All clear → proceed
- GIVEN 3 current-tenant IDs, no FK blockers
- WHEN pre-flight validates
- THEN `offendingIds` is empty

### R7-R10: Permission System

`batch_delete` MUST be in `AppActions` and seeded via `PERMISSION_REGISTRY`. `@RequirePermissions` enforces it on batch endpoints. `manage` does NOT imply `batch_delete`.

#### Scenario: User with batch_delete → allowed
- GIVEN `batch_delete:Promotion` granted
- WHEN calling `POST /promotions/batch-delete`
- THEN guard passes

#### Scenario: delete without batch_delete → 403
- GIVEN `delete:Promotion` but NOT `batch_delete:Promotion`
- WHEN calling `POST /promotions/batch-delete`
- THEN 403

#### Scenario: manage without batch_delete → 403
- GIVEN `manage:Promotion` but NOT `batch_delete:Promotion`
- WHEN calling `POST /promotions/batch-delete`
- THEN 403
