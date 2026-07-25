# Design: Batch Deletion

## Technical Approach

A reusable `src/shared/batch-delete/` module ships an abstract `BatchDeleteOrchestrator`, a `BatchDeleteDto`, a `BatchDeletableService` contract, and a `BatchDeleteController.extendController()` factory. Promotions is the pilot: `PromotionsService` implements the contract, the factory generates the `POST /promotions/batch-delete` handler. All-or-nothing deletes run inside the codebase's ambient CLS transaction (`TenantPrismaService.runInTransaction`). A new `batch_delete` action is added to `AppActions`/`PERMISSION_REGISTRY`; because CASL's `manage` implies every action (violating R10), a dedicated strict guard checks for an explicit `batch_delete:<subject>` permission.

## Architecture Overview

```
  POST /promotions/batch-delete
        │
  BatchDeleteDto (class-validator: 1..100 UUIDs)  ── 400 on invalid
        │
  BatchDeleteGuard (strict batch_delete check)     ── 403 on missing
        │
  extendController handler ─► orchestrator.execute(ids)
        │
  runInTransaction(() => {                          ── ambient CLS tx
     service.validateForBatchDeletion(ids)          ── 409 PROMOTION_REFERENCED_BY_SALE / 404 NOT_FOUND
     service.executeInTransaction(ids)              ── deleteMany (cascade joins)
  })
        │
  200 { deleted: number }
```

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Transaction propagation | `TenantPrismaService.runInTransaction()` (ambient CLS) | Explicit `tx` param to service methods | Repositories call `tenantPrisma.getClient()` which reads the CLS tx slot; passing `tx` explicitly would bypass the established pattern and require repo-method overloads. Ambient tx makes validation + delete share one client automatically. Spec R4's `(tx, ids)` is the conceptual model; implementation uses `(ids)`. |
| R10 enforcement (manage ≠ batch_delete) | Dedicated `BatchDeleteGuard` checking explicit `batch_delete:<subject>` in `getEffectivePermissions()` (superadmin bypass) | Reuse `PermissionsGuard` + `ability.can('batch_delete')` | CASL `can('manage', X)` returns true for ANY action incl. `batch_delete`, so `ability.can()` cannot satisfy R10. Effective-permissions are raw DB rows without manage-implication, so an explicit-tuple check works; superadmin (`manage:all`) bypasses explicitly. |
| Abstraction shape | Abstract `BatchDeleteOrchestrator` + `BatchDeletableService` contract + `extendController` factory | Interceptor / decorator-only | Proposal D2 locked. Factory centralizes route + permission wiring; abstract orchestrator owns the tx + error contract so each module only supplies validation + delete logic. |
| HTTP verb | `POST /batch-delete` | `DELETE` with body | Proposal D3 locked. `DELETE` with a body is non-standard; `POST` is widely supported and unambiguous. |
| Failure semantics | All-or-nothing | Partial success | Proposal D4 locked. Pre-flight failure rolls back the whole batch; simpler mental model + data integrity. |
| Permission action | New `batch_delete` action (not reuse `delete`) | Reuse `delete` | Proposal D1 locked. Least privilege: a `delete`-only user must not gain batch capability implicitly. |

## Interfaces / Contracts

```ts
// batch-delete.types.ts
export interface BatchDeleteResult { deleted: number; }
export interface ValidationResult {
  valid: boolean;
  offendingIds?: string[];
  reason?: string;
  code?: string;
}
export interface BatchDeletableService {
  validateForBatchDeletion(ids: string[]): Promise<ValidationResult>;
  executeInTransaction(ids: string[]): Promise<number>;
}
// batch-delete.constants.ts
export const BATCH_DELETE_MAX_SIZE = Number(process.env.BATCH_DELETE_MAX_SIZE ?? 100);
export const BATCH_DELETE_ERROR_CODES = {
  EMPTY: 'BATCH_DELETE_VALIDATION_ERROR',
  OVERSIZED: 'BATCH_DELETE_VALIDATION_ERROR',
  NOT_FOUND: 'BATCH_DELETE_NOT_FOUND',
  FK_CONSTRAINT: 'BATCH_DELETE_FK_CONSTRAINT',
} as const;
// domain-error.ts (addition) — BusinessRuleViolationError subclass
export class BatchDeleteValidationError extends DomainError { /* code: BATCH_DELETE_FK_CONSTRAINT, carries offendingIds */ }
```

`BatchDeleteDto`: `ids: string[]` with `@ArrayMinSize(1)`, `@ArrayMaxSize(BATCH_DELETE_MAX_SIZE)`, `@IsUUID('4',{each:true})`, `@ArrayUnique()`.

`BatchDeleteOrchestrator.execute(ids)`:
1. `tenantPrisma.runInTransaction(async () => {`
2. `const v = await service.validateForBatchDeletion(ids)` → if `!v.valid` throw `BatchDeleteValidationError(v.code, v.offendingIds, v.reason)` (rolls back).
3. `const n = await service.executeInTransaction(ids)`.
4. `})` commits → return `{ deleted: n }`.

Promotions `validateForBatchDeletion(ids)`: query `SaleItem` + `SalePromotionApplied` via `tenantPrisma.getClient()` for `promotionId IN ids`; any hit → `{ valid:false, offendingIds, code:'PROMOTION_REFERENCED_BY_SALE' }`. Also verify all `ids` exist in tenant → missing → `NOT_FOUND`.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/shared/batch-delete/batch-delete.types.ts` | Create | `BatchDeletableService`, `BatchDeleteResult`, `ValidationResult` |
| `src/shared/batch-delete/batch-delete.constants.ts` | Create | Max size + error codes |
| `src/shared/batch-delete/dto/batch-delete.dto.ts` | Create | `BatchDeleteDto` class-validator DTO |
| `src/shared/batch-delete/orchestrator/batch-delete.orchestrator.ts` | Create | Abstract `BatchDeleteOrchestrator` (`execute`) |
| `src/shared/batch-delete/controller/batch-delete.controller.ts` | Create | `BatchDeleteController.extendController({subject, serviceToken})` factory |
| `src/shared/batch-delete/guards/batch-delete.guard.ts` | Create | `BatchDeleteGuard` strict `batch_delete` check |
| `src/shared/batch-delete/batch-delete.module.ts` | Create | Dynamic module exporting guard + orchestrator |
| `src/shared/domain/domain-error.ts` | Modify | Add `BatchDeleteValidationError` (carries `offendingIds`) |
| `src/shared/filters/domain-exception.filter.ts` | Modify | Map `BATCH_DELETE_*` / `PROMOTION_REFERENCED_BY_SALE` → 409; `BATCH_DELETE_NOT_FOUND` → 404; map `offendingIds` into response body |
| `src/auth/authorization/domain/permission.ts` | Modify | `'batch_delete'` in `AppActions`; registry entry `{subject:'Promotion', action:'batch_delete'}` |
| `src/promotions/domain/promotion.repository.ts` | Modify | Add `deleteMany(ids: string[]): Promise<number>` to interface |
| `src/promotions/infrastructure/prisma-promotion.repository.ts` | Modify | Implement `deleteMany` via `promotion.deleteMany({where:{id:{in:ids}}})` |
| `src/promotions/promotions.service.ts` | Modify | Implement `BatchDeletableService` (validate + execute); add sale-reference pre-flight |
| `src/promotions/promotions.controller.ts` | Modify | Apply `BatchDeleteController.extendController` mixin / route |
| `src/promotions/promotions.module.ts` | Modify | Import `BatchDeleteModule`, register generated controller + guard |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | `BatchDeleteDto` validation (empty, >100, bad UUID, dup) | class-validator `validate()` |
| Unit | Orchestrator happy path / pre-flight fail / delete-throw rollback | mock `tenantPrisma.runInTransaction`, `validateForBatchDeletion`, `executeInTransaction` |
| Unit | `extendController` decorator metadata (`@Post`, `@RequirePermissions`) | `Reflector` introspection |
| Unit | `BatchDeleteGuard` — manage-only user → 403; explicit batch_delete → allow; superadmin → allow | mock `CaslAbilityFactory.getEffectivePermissions` |
| Unit | Promotions pre-flight (SaleItem ref, cross-tenant missing) | mock `tenantPrisma.getClient()` |
| Integration | All-or-nothing: create promos + sale referencing one → 0 deleted | real DB |
| Integration | Permission: with/without `batch_delete:Promotion` | seeded role |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No schema migration. `PERMISSION_REGISTRY` addition auto-seeds `batch_delete:Promotion` rows on bootstrap; existing roles unaffected (no implicit grant). Rollback: revert `AppActions`/registry, remove module — seeded rows become inert.

## Open Questions

- [ ] **Strict guard vs guard flag**: Should `BatchDeleteGuard` be a standalone guard, or should `PermissionsGuard` gain a `strict` metadata flag to bypass CASL's manage-implication? Standalone is simpler and isolates the non-standard check; recommend standalone pending tasks-phase confirmation.
- [ ] **`extendController` shape**: NestJS controllers are classes, not easily subclassed at runtime. The factory likely returns a mixin class (`@Controller(path)` + `@Post('batch-delete')`) registered separately in the module, OR decorates an existing method. Need to confirm the exact registration mechanism in tasks.
- [ ] **`offendingIds` propagation**: `DomainError` currently has no `offendingIds` field; the exception filter must serialize it. Confirm the cleanest extension (subclass with extra field) in tasks.
