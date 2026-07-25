# Proposal: Batch Deletion

## Intent

The codebase has 29 single-item `@Delete(':id')` endpoints and no batch operation. Users retiring stale promotions must loop one call at a time. This change ships a reusable batch-delete abstraction and its first consumer: **Promotions**.

## Scope

**In**: `BatchDeleteOrchestrator` (all-or-nothing `$transaction`), `BatchDeleteDto`, controller factory, abstract `BatchDeletableService`, new `batch_delete` permission, `POST /promotions/batch-delete` with sale-reference guard.

**Out**: batch delete for other entities (future SDDs), soft-delete / undo / audit, frontend wiring, batch `end()`.

## Capabilities

- **New**: `batch-delete` — cross-cutting abstraction.
- **Modified**: `pos-promotion-engine` — delta for batch-delete endpoint.

## Approach

| # | Decision | Choice |
|---|---|---|
| **D1** | Permission | New `'batch_delete'` action in `AppActions` + `PERMISSION_REGISTRY` (auto-seeded). Guard `['batch_delete','Promotion']`; `manage` does NOT imply it. |
| **D2** | Abstraction | Abstract base + factory. `BatchDeletableService` exposes `validateForBatchDeletion(ids)` + `executeInTransaction(tx, ids)`. `BatchDeleteController.extendController({subject})` wires the endpoint. |
| **D3** | Endpoint | `POST /promotions/batch-delete`. REST convention. |
| **D4** | Response | All-or-nothing. Success `{ deleted: number }`. Failure `4xx { code, offendingIds, reason }`. |
| **D5** | Transaction | `prisma.$transaction(async tx => …)`. |
| **D6** | Validation | Pre-flight in-tx: IDs exist in tenant, pass entity guards, no FK violation. Any failure aborts. |
| **D7** | Max size | 100 (env `BATCH_DELETE_MAX_SIZE`). |

**Promotions guard**: pre-tx query rejects ids referenced by `SaleItem.promotionId` OR `SalePromotionApplied.promotionId` with `PROMOTION_REFERENCED_BY_SALE`. State is NOT a guard. Cascade runs on join tables; `SetNull` FKs never trigger because the guard blocks them.



## Affected Areas

| Area | Impact |
|---|---|
| `src/auth/authorization/domain/permission.ts` | Modified — `batch_delete` in `AppActions` + registry |
| `src/shared/batch-delete/` | New — orchestrator, DTO, factory, abstract base |
| `src/promotions/promotions.controller.ts` | Modified — wire factory extension |
| `src/promotions/promotions.service.ts` | Modified — extend base; sale-reference guard |
| `prisma/seed.ts` | Verify `batch_delete` rows seeded |

## Risks

- **FK violation** → pre-flight in `$transaction`; clear error with offending IDs.
- **Permission escalation** → separate action; `manage` does NOT imply `batch_delete`.
- **Accidental mass delete** → cap 100; pre-flight; tx rollback.
- **Perf with 100 + cascade** → `$transaction` batches; promo cascade is small.
- **Future modules forget grant** → `extendController` reads `PERMISSION_REGISTRY`; boot throws if missing.

## Rollback

Revert `AppActions`/`PERMISSION_REGISTRY`, drop controller extension, delete `src/shared/batch-delete/`. Seeded rows remain unused; strict checks → no risk.

## Success Criteria

- `POST /promotions/batch-delete` deletes N promotions atomically; no rows persist if any guard fails.
- `RequirePermissions(['batch_delete','Promotion'])` enforced; `delete`-only user rejected with 403.
- Pre-flight rejects promotions referenced by `SaleItem` or `SalePromotionApplied` with offending IDs.
- Unit tests: empty, oversized (>100), non-existent IDs, cross-tenant IDs, FK violation, all-or-nothing rollback.
- `pnpm test` + `pnpm build` pass; `batch_delete` visible in admin role permissions UI.
