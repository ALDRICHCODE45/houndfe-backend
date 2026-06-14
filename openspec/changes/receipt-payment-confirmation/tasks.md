# Tasks: Receipt Payment Confirmation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 600-700 lines |
| 400-line budget risk | High |
| Chained PRs recommended | No |
| Suggested split | Single PR with work-unit commits |
| Delivery strategy | single-pr |
| Chain strategy | N/A (solo developer) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: N/A
400-line budget risk: High

### Workload Context

This change is above the 400-line budget (~600-700 lines), but the developer is solo on this project with NO external reviewer. The delivery strategy is `single-pr`, so chained PRs are NOT wanted. Instead, the implementation will use **strict work-unit commits** where each commit bundles code + tests + migration as a self-contained, reviewable unit that keeps the tree green and supports git bisect/rollback.

### Suggested Work Units (as commits, not separate PRs)

| Unit | Goal | Commit Scope | Notes |
|------|------|--------------|-------|
| 1 | Schema foundation | Migration + error types | Additive schema; deploy before code |
| 2 | Authorization layer | CASL permissions + tests | Permission-gated review |
| 3 | Domain routing fix | `addPayment` authMode param + tests | W-004 root fix; zero cashier regression |
| 4 | Review repository | Port + Prisma adapter + tests | Data access for review workflow |
| 5 | Review orchestration | Service + DTOs + tests | Confirm/reject business logic |
| 6 | Review HTTP API | Controller + tests + module wiring | Public endpoint; ValidationPipe gate |
| 7 | Event emission | Event types + outbox integration + tests | Domain events for future consumer |
| 8 | Integration verification | Full-flow tests + build check | Zero-regression confirmation |

## Phase 1: Schema & Foundation

- [x] 1.1 **TEST**: Write migration file with additive schema changes (`ReceiptEvidence.rejectionReason String?`, FK `confirmedBy User?` relation, `@@index([tenantId, status])`, `Customer.isTrusted Boolean @default(false)`)
  - Files: `prisma/migrations/<timestamp>_receipt_review/migration.sql`
  - Gate: `pnpm prisma migrate dev --name receipt_review --create-only`, inspect generated SQL
  - Commit: "feat(sales): add receipt review schema migration"

- [x] 1.2 **TEST**: Write failing test for `ReceiptNotActionableError` and `SaleNotReviewableError`
  - Files: `src/sales/review/domain/receipt-review.errors.spec.ts`
  - Test: Errors extend `BusinessRuleViolationError`, correct code/message
  - Gate: `pnpm test src/sales/review/domain/receipt-review.errors.spec.ts` (fails)

- [x] 1.3 **CODE**: Create error types matching `src/sales/domain/sale.errors.ts` pattern
  - Files: `src/sales/review/domain/receipt-review.errors.ts`
  - Exports: `ReceiptNotActionableError`, `SaleNotReviewableError`
  - Gate: `pnpm test src/sales/review/domain/receipt-review.errors.spec.ts` (passes)
  - Commit: "feat(sales): add receipt review error types"

## Phase 2: Authorization & Domain Routing

- [x] 2.1 **TEST**: Write failing test for `ReceiptEvidence` CASL subject registration
  - Files: `src/auth/authorization/domain/permission.spec.ts` (add new test cases)
  - Test: `ReceiptEvidence` in `AppSubjects`, 3 permissions (`read`, `update`, `manage`) in `PERMISSION_REGISTRY`
  - Gate: `pnpm test src/auth/authorization/domain/permission.spec.ts` (fails)

- [x] 2.2 **CODE**: Add `ReceiptEvidence` CASL subject and permissions
  - Files: `src/auth/authorization/domain/permission.ts`
  - Add: `'ReceiptEvidence'` to `AppSubjects` union type
  - Add: 3 `PERMISSION_REGISTRY` entries (`read:ReceiptEvidence`, `update:ReceiptEvidence`, `manage:ReceiptEvidence`)
  - Gate: `pnpm test src/auth/authorization/domain/permission.spec.ts` (passes), `pnpm lint src/auth`
  - Commit: "feat(auth): add ReceiptEvidence CASL permissions"

- [x] 2.3 **TEST**: Write failing tests for `addPayment` authMode parameter
  - Files: `src/sales/sales.service.spec.ts` (add new test cases)
  - Test: `authMode: 'owner'` rejects non-owner (existing behavior), `authMode: 'reviewer'` bypasses ownership check
  - Test: Default `authMode` is `'owner'` (zero regression for existing controller calls)
  - Gate: `pnpm test src/sales/sales.service.spec.ts` (fails on new tests)

- [x] 2.4 **CODE**: Add `authMode: 'owner' | 'reviewer'` parameter to `addPayment` in `SalesService`
  - Files: `src/sales/sales.service.ts` (~1770)
  - Modify: Replace `sale.userId !== actorId` ownership guard with conditional check based on `authMode`
  - Default: `authMode = 'owner'` to preserve existing cashier behavior
  - In `'reviewer'` mode: set `SalePayment.userId = NULL`, `method = TRANSFER`, stamp `metadataJson.origin` with bot context
  - Gate: `pnpm test src/sales/sales.service.spec.ts` (passes), `pnpm lint src/sales`
  - Commit: "fix(sales): add authMode to addPayment for reviewer routing (W-004)"

## Phase 3: Review Repository & Data Access

- [x] 3.1 **TEST**: Write failing tests for `ReceiptReviewRepository` port interface
  - Files: `src/sales/review/domain/receipt-review.repository.spec.ts`
  - Test: Interface defines `findPendingForSale`, `findById`, `markConfirmed`, `markRejected`
  - Gate: `pnpm test src/sales/review/domain/receipt-review.repository.spec.ts` (fails)

- [x] 3.2 **CODE**: Create `ReceiptReviewRepository` port interface
  - Files: `src/sales/review/domain/receipt-review.repository.ts`
  - Methods: `findPendingForSale(saleId, tenantId)`, `findById(receiptId, tenantId)`, `markConfirmed(receiptId, userId, timestamp)`, `markRejected(receiptId, reason)`
  - Gate: `pnpm test src/sales/review/domain/receipt-review.repository.spec.ts` (passes)

- [x] 3.3 **TEST**: Write failing tests for Prisma repository adapter
  - Files: `src/sales/review/infrastructure/prisma-receipt-review.repository.spec.ts`
  - Test: Adapter implements port, uses `TenantPrismaService`, filters by `tenantId` + `status === 'PENDING'`, FK writes for `confirmedByUserId`
  - Gate: `pnpm test src/sales/review/infrastructure/prisma-receipt-review.repository.spec.ts` (fails)

- [x] 3.4 **CODE**: Create Prisma repository adapter
  - Files: `src/sales/review/infrastructure/prisma-receipt-review.repository.ts`
  - Implements: `ReceiptReviewRepository` via `TenantPrismaService`
  - Query: `@@index([tenantId, status])` for queue listing, FK relation for `confirmedBy`
  - Gate: `pnpm test src/sales/review/infrastructure/prisma-receipt-review.repository.spec.ts` (passes), `pnpm lint src/sales/review`
  - Commit: "feat(sales): add receipt review repository with Prisma adapter"

## Phase 4: Review Service & Business Logic

- [ ] 4.1 **TEST**: Write failing test for `ConfirmReceiptDto` validation
  - Files: `src/sales/review/dto/confirm-receipt.dto.spec.ts`
  - Test: `amountCents` is integer, min 1, required
  - Gate: `pnpm test src/sales/review/dto/confirm-receipt.dto.spec.ts` (fails)

- [ ] 4.2 **CODE**: Create `ConfirmReceiptDto`
  - Files: `src/sales/review/dto/confirm-receipt.dto.ts`
  - Fields: `amountCents` with `@IsInt()`, `@Min(1)` decorators
  - Gate: `pnpm test src/sales/review/dto/confirm-receipt.dto.spec.ts` (passes)

- [ ] 4.3 **TEST**: Write failing test for `RejectReceiptDto` validation
  - Files: `src/sales/review/dto/reject-receipt.dto.spec.ts`
  - Test: `reason` is string, non-empty, required
  - Gate: `pnpm test src/sales/review/dto/reject-receipt.dto.spec.ts` (fails)

- [ ] 4.4 **CODE**: Create `RejectReceiptDto`
  - Files: `src/sales/review/dto/reject-receipt.dto.ts`
  - Fields: `reason` with `@IsString()`, `@IsNotEmpty()` decorators
  - Gate: `pnpm test src/sales/review/dto/reject-receipt.dto.spec.ts` (passes)
  - Commit: "feat(sales): add receipt review DTOs with validation"

- [ ] 4.5 **TEST**: Write failing tests for `ReceiptReviewService.confirm()`
  - Files: `src/sales/review/receipt-review.service.spec.ts`
  - Test: Confirm full amount → sale `PAID`, partial → `PARTIAL`, real ≠ declared uses real
  - Test: Non-PENDING receipt → `ReceiptNotActionableError`, no payment/event
  - Test: Sale not CONFIRMED → `SaleNotReviewableError`
  - Test: Double-confirm is idempotent (receipt guard + addPayment idem)
  - Mock: `ReceiptReviewRepository`, `SalesService.addPayment`
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (fails)

- [ ] 4.6 **CODE**: Implement `ReceiptReviewService.confirm()`
  - Files: `src/sales/review/receipt-review.service.ts`
  - Logic: Load receipt (PENDING guard), load sale (CONFIRMED guard), runInTransaction { addPayment(authMode:'reviewer'), markConfirmed, emit receipt.confirmed }
  - Inject: `ReceiptReviewRepository`, `SalesService`, transaction helper, outbox writer
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (confirm tests pass)

- [ ] 4.7 **TEST**: Write failing tests for `ReceiptReviewService.reject()`
  - Files: Same `src/sales/review/receipt-review.service.spec.ts`
  - Test: Reject sets REJECTED + reason, sale untouched
  - Test: Reject on non-PENDING → `ReceiptNotActionableError`
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (reject tests fail)

- [ ] 4.8 **CODE**: Implement `ReceiptReviewService.reject()`
  - Files: `src/sales/review/receipt-review.service.ts`
  - Logic: PENDING guard, runInTransaction { markRejected(reason), emit receipt.rejected }
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (all tests pass), `pnpm lint src/sales/review`
  - Commit: "feat(sales): add ReceiptReviewService with confirm/reject orchestration"

- [ ] 4.9 **TEST**: Write failing test for `ReceiptReviewService.listPending()`
  - Files: Same `src/sales/review/receipt-review.service.spec.ts`
  - Test: Returns only PENDING receipts for given sale, includes mediaUrl
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (listPending test fails)

- [ ] 4.10 **CODE**: Implement `ReceiptReviewService.listPending()`
  - Files: `src/sales/review/receipt-review.service.ts`
  - Logic: Call `repository.findPendingForSale(saleId, tenantId)`
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (all tests pass)

## Phase 5: Controller & HTTP API

- [ ] 5.1 **TEST**: Write failing tests for `ReceiptReviewController` endpoints
  - Files: `src/sales/review/receipt-review.controller.spec.ts`
  - Test: `GET /sales/:id/receipts` returns pending queue
  - Test: `POST /sales/:id/receipts/:rid/confirm` requires `ReceiptEvidence:update`, calls service, returns 200/400 on validation
  - Test: `POST /sales/:id/receipts/:rid/reject` requires `ReceiptEvidence:update`, rejects empty reason (400)
  - Use: `Test.createTestingModule`, apply global `ValidationPipe`
  - Gate: `pnpm test src/sales/review/receipt-review.controller.spec.ts` (fails)

- [ ] 5.2 **CODE**: Create `ReceiptReviewController`
  - Files: `src/sales/review/receipt-review.controller.ts`
  - Routes: `GET /sales/:id/receipts`, `POST /sales/:id/receipts/:rid/confirm`, `POST /sales/:id/receipts/:rid/reject`
  - Guards: `@CheckPolicies()` with `ReceiptEvidence:update` for confirm/reject
  - Inject: `ReceiptReviewService`
  - Gate: `pnpm test src/sales/review/receipt-review.controller.spec.ts` (passes), `pnpm lint src/sales/review`
  - Commit: "feat(sales): add receipt review HTTP controller with CASL guards"

- [ ] 5.3 **TEST**: Write failing test for module registration
  - Files: `src/sales/sales.module.spec.ts` (add new test case)
  - Test: `ReceiptReviewService`, `ReceiptReviewController`, repository port + adapter are registered
  - Gate: `pnpm test src/sales/sales.module.spec.ts` (fails)

- [ ] 5.4 **CODE**: Register review components in `SalesModule`
  - Files: `src/sales/sales.module.ts`
  - Add: `ReceiptReviewController` to `controllers`, `ReceiptReviewService` to `providers`, repository port + Prisma adapter to `providers`
  - Gate: `pnpm test src/sales/sales.module.spec.ts` (passes), `pnpm lint src/sales`
  - Commit: "feat(sales): wire receipt review into SalesModule"

## Phase 6: Event Emission

- [ ] 6.1 **TEST**: Write failing tests for `ReceiptConfirmedEvent` and `ReceiptRejectedEvent` types
  - Files: `src/sales/domain/events/sale.events.spec.ts` (add new test cases)
  - Test: `ReceiptConfirmedEvent` includes receiptId, saleId, tenantId, amountCents, paymentMethod, origin, validatedByUserId, validatedAt, resultingPaymentStatus, occurredAt
  - Test: `ReceiptRejectedEvent` includes receiptId, saleId, tenantId, validatedByUserId, reason, occurredAt
  - Gate: `pnpm test src/sales/domain/events/sale.events.spec.ts` (fails)

- [ ] 6.2 **CODE**: Add event type definitions to domain events
  - Files: `src/sales/domain/events/sale.events.ts`
  - Add: `ReceiptConfirmedEvent` and `ReceiptRejectedEvent` interfaces matching outbox event contract
  - Gate: `pnpm test src/sales/domain/events/sale.events.spec.ts` (passes)

- [ ] 6.3 **TEST**: Write failing test for outbox event emission
  - Files: Same `src/sales/review/receipt-review.service.spec.ts` (extend existing tests)
  - Test: Confirm emits `receipt.confirmed` via `outboxWriter.publish` with all 3 audit facts (TRANSFER, bot-origin, validatedByUserId)
  - Test: Reject emits `receipt.rejected` with reason
  - Spy: `outboxWriter.publish` call args
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (new event assertions fail)

- [ ] 6.4 **CODE**: Wire outbox event emission in service
  - Files: `src/sales/review/receipt-review.service.ts`
  - Logic: After `markConfirmed`, call `outboxWriter.publish('receipt.confirmed', aggregateType: 'ReceiptEvidence', payload)`
  - Logic: After `markRejected`, call `outboxWriter.publish('receipt.rejected', payload with reason)`
  - Gate: `pnpm test src/sales/review/receipt-review.service.spec.ts` (all tests pass), `pnpm lint src/sales`
  - Commit: "feat(sales): emit receipt.confirmed and receipt.rejected outbox events"

## Phase 7: Integration & Verification

- [ ] 7.1 **TEST**: Write failing integration test for full confirm flow
  - Files: `src/sales/review/receipt-review.integration.spec.ts`
  - Test: End-to-end confirm with real DB (test DB), real transaction, verify receipt CONFIRMED + sale PAID/PARTIAL + events emitted
  - Gate: `pnpm test src/sales/review/receipt-review.integration.spec.ts` (fails)

- [ ] 7.2 **CODE**: Fix integration test (if needed, adjust service/controller)
  - Gate: `pnpm test src/sales/review/receipt-review.integration.spec.ts` (passes)

- [ ] 7.3 **TEST**: Write failing integration test for reject flow
  - Files: Same `src/sales/review/receipt-review.integration.spec.ts`
  - Test: End-to-end reject with reason, verify receipt REJECTED + sale untouched + event emitted
  - Gate: `pnpm test src/sales/review/receipt-review.integration.spec.ts` (reject test fails)

- [ ] 7.4 **CODE**: Fix integration test (if needed, adjust service)
  - Gate: `pnpm test src/sales/review/receipt-review.integration.spec.ts` (all tests pass)
  - Commit: "test(sales): add receipt review integration tests"

- [ ] 7.5 **VERIFY**: Run full test suite for zero-regression confirmation
  - Gate: `pnpm test` (all tests pass, no regressions)

- [ ] 7.6 **VERIFY**: Run build to catch ts-jest misses
  - Gate: `pnpm build` (build succeeds, TypeScript compilation passes)
  - Commit: "chore(sales): verify receipt review integration (full test + build)"

## Phase 8: Documentation & Final Checks

- [ ] 8.1 **TEST**: Run migration on test DB to verify schema validity
  - Gate: `pnpm prisma migrate dev` (migration applies cleanly)

- [ ] 8.2 **CODE**: Add inline JSDoc comments for public service methods
  - Files: `src/sales/review/receipt-review.service.ts`
  - Add: JSDoc for `confirm`, `reject`, `listPending` explaining params, guards, and transaction scope
  - Gate: `pnpm lint src/sales` (passes)

- [ ] 8.3 **VERIFY**: Final lint + format check
  - Gate: `pnpm lint`, `pnpm format:check` (all pass)
  - Commit: "docs(sales): add JSDoc for receipt review service"

## Implementation Notes

### Test-First Ordering (Strict TDD)
Every implementation task is preceded by its failing test. The apply phase will run in Strict TDD Mode:
1. RED: Write failing test
2. GREEN: Make it pass with minimal code
3. REFACTOR: Clean up (if needed)
4. COMMIT: Bundle test + code as one work unit

### Work-Unit Commit Strategy
Each commit represents a deliverable unit:
- Commit 1: Schema migration (deploy before code)
- Commit 2: Error types + tests
- Commit 3: CASL permissions + tests
- Commit 4: `addPayment` authMode + tests (W-004 fix)
- Commit 5: Repository + adapter + tests
- Commit 6: Service + DTOs + tests
- Commit 7: Controller + module wiring + tests
- Commit 8: Events + outbox integration + tests
- Commit 9: Integration tests + build verification

### Per-Commit Gates
Each commit must pass:
- Scoped test: `pnpm test <file.spec.ts>` for affected specs
- Scoped lint: `pnpm lint <directory>`
- Final gates: `pnpm test` (full suite), `pnpm build` (TypeScript compilation)

### Dependency Order
Tasks are ordered by dependency:
- Phase 1: Schema must deploy first (additive, safe)
- Phase 2: Authorization + domain routing must exist before service
- Phase 3: Repository must exist before service
- Phase 4: Service orchestrates confirm/reject
- Phase 5: Controller exposes HTTP API
- Phase 6: Events emitted from service
- Phase 7: Integration verification ensures all layers work together

### Schema Safety
Migration is additive only:
- Nullable columns (`rejectionReason String?`)
- FK with `onDelete: SetNull` (safe for existing data)
- Secondary index (`@@index([tenantId, status])`)
- Boolean with default (`isTrusted Boolean @default(false)`)

Deploy migration BEFORE code to avoid runtime errors.

### Zero-Regression Contract
- Existing cashier payment flow MUST remain unchanged (`authMode = 'owner'` default)
- Existing `PENDING` receipts MUST be unaffected by schema changes
- No second parallel payment path introduced (W-004 unified via `authMode`)
