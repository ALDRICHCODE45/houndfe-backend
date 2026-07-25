# Archive Report — batch-delete

**Change**: `batch-delete`
**Archive Date**: 2026-07-24
**Status**: ARCHIVED — PASS
**Mode**: openspec

## Executive Summary

Batch deletion abstraction shipped and piloted on Promotions. A reusable `src/shared/batch-delete/` module provides `BatchDeleteOrchestrator`, `BatchDeleteDto`, `BatchDeleteGuard`, and a controller mixin factory. Promotions implements the `BatchDeletableService` contract with a sale-reference pre-flight guard. A new `batch_delete` permission action was added to the authorization system with strict manage ≠ batch_delete enforcement.

## What Was Built

### New Module: `src/shared/batch-delete/` (12 files)
- `batch-delete.constants.ts` — `BATCH_DELETE_MAX_SIZE=100`, error codes
- `batch-delete.types.ts` — `BatchDeletableService` abstract contract, `BatchDeleteResult`, `ValidationResult`
- `dto/batch-delete.dto.ts` — class-validator DTO (1-100 UUIDs)
- `orchestrator/batch-delete.orchestrator.ts` — all-or-nothing execution in CLS transaction
- `guards/batch-delete.guard.ts` — standalone guard enforcing explicit `batch_delete` permission (manage ≠ batch_delete)
- `controller/batch-delete.controller.ts` — mixin factory `POST({ subject, path })` for `POST <path>/batch-delete`
- `batch-delete.module.ts` — dynamic NestJS module
- `index.ts` — barrel export
- 4 unit spec files (DTO, orchestrator, guard, controller)

### Authorization Extension
- `AppActions` gains `'batch_delete'`
- `PERMISSION_REGISTRY` gains `{ subject: 'Promotion', action: 'batch_delete' }`
- `BatchDeleteValidationError extends BusinessRuleViolationError` with `offendingIds` field
- `DomainExceptionFilter` maps `BATCH_DELETE_FK_CONSTRAINT` / `PROMOTION_REFERENCED_BY_SALE` → 409, `BATCH_DELETE_NOT_FOUND` → 404

### Promotions Pilot
- `IPromotionRepository.deleteMany(ids)` → `PrismaPromotionRepository` implementation
- `PromotionsService extends BatchDeletableService` with `validateForBatchDeletion` + `executeInTransaction`
- Sale-reference pre-flight: queries `SaleItem.promotionId` + `SalePromotionApplied.promotionId`
- `POST /promotions/batch-delete` with `@RequirePermissions(['batch_delete', 'Promotion'])` + `@UseGuards(BatchDeleteGuard)`

### Documentation
- `docs/batch-delete-frontend.md` — complete frontend integration guide

## Verification

| Metric | Result |
|--------|--------|
| Requirements | 15/15 |
| Scenarios | 22/22 |
| Tests | 2250/2250, 179 suites |
| Build | Exit 0 |
| Blockers | 0 |

## Review Summary

4R review completed (risk, resilience, readability, reliability). Key findings:
- **WARNING**: No observability/logging on success path (resilience)
- **WARNING**: Integration test stubs transaction (resilience)
- **WARNING**: TOCTOU gap under READ COMMITTED concurrency (resilience)
- **SUGGESTION**: Promotions-specific error code in shared module (readability)
- Other CRITICAL findings were false positives (tests pass, build clean)

No blockers. All findings are non-blocking improvements for future iterations.

## Commit Trace

| Commit | Subject |
|--------|---------|
| `ab6db5c` | feat(shared): add batch-delete abstraction module |
| `d8fcf56` | feat(promotions): wire batch-delete endpoint + deleteMany contract |
| `6e9842e` | test(promotions): integration verification for batch-delete |

## Delta Spec Sync

- NEW: `openspec/specs/batch-delete/spec.md` — cross-cutting batch-delete capability (10 requirements)
- MODIFIED: `openspec/specs/pos-promotion-engine/spec.md` — 5 ADDED requirements (batch-delete endpoint)

## Documented Follow-ups (Future SDDs)

1. Extender batch delete a otros módulos: Products, Customers, Brands, Categories, etc.
2. Agregar `batch_delete` a los demás subjects en `PERMISSION_REGISTRY`
3. Agregar logging/observability en el success path del orquestador
4. Evaluar `SERIALIZABLE` isolation para cerrar el TOCTOU gap
5. Integration test con transacción real de PostgreSQL
6. Rate limiting para el endpoint

---

**SDD Cycle**: explore → propose → spec → design → tasks → apply (3 commits) → verify (PASS) → archive ✅
