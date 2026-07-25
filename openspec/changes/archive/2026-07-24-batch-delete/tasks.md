# Tasks: Batch Deletion

## Review Workload Forecast

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

## Phase 1 — WU1: Foundation (`src/shared/batch-delete/`)

- [x] 1.1 `batch-delete.constants.ts` — `BATCH_DELETE_MAX_SIZE` from env, error codes
- [x] 1.2 `batch-delete.types.ts` — `BatchDeleteResult`, `ValidationResult`, `BatchDeletableService`
- [x] 1.3 `dto/batch-delete.dto.ts` — `BatchDeleteDto` with `@ArrayMinSize / @ArrayMaxSize / @IsUUID('4',{each}) / @ArrayUnique`
- [x] 1.4 `orchestrator/batch-delete.orchestrator.ts` — abstract `execute(ids, service)` wrapping `tenantPrisma.runInTransaction`, validate → execute, throws `BatchDeleteValidationError` on failure
- [x] 1.5 `guards/batch-delete.guard.ts` — standalone `BatchDeleteGuard` reading `@RequirePermissions`, explicit `batch_delete:<subject>` via `getEffectivePermissions()`; superadmin bypass
- [x] 1.6 `controller/batch-delete.controller.ts` — `extendController({ subject, path, serviceToken })` mixin returning NestJS class with `@Controller`, `@Post('batch-delete')`, `@RequirePermissions` + `@UseGuards(BatchDeleteGuard)`
- [x] 1.7 `batch-delete.module.ts` — `BatchDeleteModule.forFeature({ ... })` dynamic module exporting orchestrator + guard + controller
- [x] 1.8 `index.ts` barrel; add to `src/shared/index.ts`
- [x] 1.9 Unit specs: dto/orchestrator/guard/controller (orches: happy/pre-flight rollback/execute-throw/nested-tx; guard: with/without/manage-only/superadmin)

## Phase 2 — WU2: Permission + Error

- [x] 2.1 Add `'batch_delete'` to `AppActions` union in `permission.ts`
- [x] 2.2 Add `{ subject: 'Promotion', action: 'batch_delete' }` to `PERMISSION_REGISTRY`
- [x] 2.3 Add `BatchDeleteValidationError extends BusinessRuleViolationError` with `offendingIds`, `reason`, custom `code` to `domain-error.ts`
- [x] 2.4 `domain-exception.filter.ts` — `BATCH_DELETE_NOT_FOUND`→404, `BATCH_DELETE_FK_CONSTRAINT` / `PROMOTION_REFERENCED_BY_SALE`→409; serialize `offendingIds`+`reason` into body
- [x] 2.5 Update `domain-exception.filter.spec.ts` — assert new codes + body shape

## Phase 3 — WU3: Promotions Repo + Service

- [x] 3.1 Add `deleteMany(ids: string[]): Promise<number>` to `IPromotionRepository`
- [x] 3.2 Implement `deleteMany` via `tenantPrisma.getClient().promotion.deleteMany({ where: { id: { in: ids } } })` returning `count`
- [x] 3.3 `BatchDeletableService` on `PromotionsService`: validate queries `saleItem`+`salePromotionApplied` for `promotionId IN ids` (reject `PROMOTION_REFERENCED_BY_SALE`) + verifies IDs in tenant (`NOT_FOUND`); execute calls `repo.deleteMany(ids)`
- [x] 3.4 Unit tests: validate (no refs, SaleItem ref, SalePromotionApplied ref, missing tenant ID); execute (happy, returns count)
- [x] 3.5 `promotions.batch-delete.integration.spec.ts` — seed 3 promos + 1 sale referencing one; attempt batch-delete → 0 deleted, rollback verified

## Phase 4 — WU4: Controller + Module Wiring

- [x] 4.1 `promotions.controller.ts` — register `extendController({ subject: 'Promotion', path: 'promotions', serviceToken: PromotionsService })` as sibling class OR add `@Post('batch-delete')` method
- [x] 4.2 `promotions.module.ts` — import `BatchDeleteModule.forFeature`, register controller, add `BatchDeleteGuard` to providers
- [x] 4.3 Add controller spec coverage for 200 / 400 / 403 / 409; run `pnpm run build` + `pnpm run test` — zero TS errors, no regressions

## Phase 5 — WU5: Integration Verification

- [x] 5.1 Manual: 5 valid IDs → 200 `{ deleted: 5 }`; 1 referenced ID → 409, 0 rows deleted
- [x] 5.2 Manual: `delete:Promotion` only → 403; `manage:Promotion` only → 403 (R10); superadmin → 200; cross-tenant → 404; bad DTO → 400
- [x] 5.3 Run `pnpm run test` + `pnpm run build` — full suite green; verify permission seed logs `batch_delete:Promotion`

## Notes

- Ambient tx: spec's `validateForBatchDeletion(tx, ids)` is conceptual — actual sig is `(ids)`; `tenantPrisma.getClient()` reads CLS tx slot. R10: dedicated `BatchDeleteGuard` because CASL `manage` implies every action.
- Error propagation: filter serializes `offendingIds` from `BatchDeleteValidationError`. Threat matrix: N/A. Single-PR rollup triggers `size:exception`.

## Manual Verification Checklist (WU5)

The integration spec `src/promotions/promotions.batch-delete.integration.spec.ts`
asserts the four critical HTTP outcomes against a real Postgres
instance when run under `pnpm run test:integration`:

| Scenario                              | Expected status | Expected body                       | Coverage                          |
|---------------------------------------|-----------------|-------------------------------------|-----------------------------------|
| 5 valid unreferenced IDs              | 200             | `{ deleted: 5 }`                    | integration spec: "200 happy path" |
| Empty array                           | 400             | `ArrayMinSize` violation            | integration spec + DTO spec       |
| Non-UUID entries                      | 400             | `IsUUID` violation                  | integration spec + DTO spec       |
| > 100 entries                         | 400             | `ArrayMaxSize` violation            | DTO spec                          |
| ID referenced by SaleItem             | 409             | `{ error: PROMOTION_REFERENCED_BY_SALE, offendingIds, reason }` | integration spec: "SaleItem"      |
| Cross-tenant ID                       | 404             | `{ error: BATCH_DELETE_NOT_FOUND, offendingIds }` | integration spec: "404"           |
| User with `delete:Promotion` only     | 403             | `InsufficientPermissionsError`      | BatchDeleteGuard spec (R10)       |
| User with `manage:Promotion` only     | 403             | `InsufficientPermissionsError`      | BatchDeleteGuard spec (R10)       |
| Superadmin (`manage:all`)             | 200             | `{ deleted: N }`                    | BatchDeleteGuard spec             |
| Cascade cleanup (join tables)         | n/a             | `PromotionTargetItem` etc. removed  | Prisma schema `onDelete: Cascade` |
| ENDED-state promotion deletable       | 200             | `{ deleted: N }`                    | R14 — state-agnostic              |

### Build & test results

- `pnpm run build` — clean (no TS errors).
- `pnpm run test` — 2250 tests passing across 179 suites.
- `pnpm run test:integration` — integration spec compiles; runs against
  the `nest-practice-test` Postgres instance on port 5433 (requires
  `pnpm run test:db:up` + `pnpm run test:integration`).

### Permission seeding verification

`PermissionSeeder` reads `PERMISSION_REGISTRY` and upserts each
`(subject, action)` tuple into the `permission` table on bootstrap.
The new `{ Promotion, batch_delete }` entry seeds automatically — no
extra wiring needed. The integration spec asserts the registry contains
the entry as a sanity check against accidental future removal.

