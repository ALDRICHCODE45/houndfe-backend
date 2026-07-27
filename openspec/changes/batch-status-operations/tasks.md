# Tasks: batch-status-operations

## Work units

### Unit 1 — Employees batch terminate/reactivate (commit 1)

- [x] 1.1 Repo: extend `IEmployeeRepository` + `PrismaEmployeeRepository` with `updateStatusMany(ids, status)`
- [x] 1.2 Spec: unit tests for `EmployeesService.batchTerminate` / `batchReactivate` (mock repo)
- [x] 1.3 Service: implement `batchTerminate` + `batchReactivate` on `EmployeesService`
- [x] 1.4 Spec: controller unit tests for `POST /admin/employees/batch-terminate` + `batch-reactivate`
- [x] 1.5 Controller: add `@Post('batch-terminate')` + `@Post('batch-reactivate')` handlers
- [x] 1.6 Spec: integration coverage of the two endpoints (happy path, 400, 404, terminate-then-reactivate)

### Unit 2 — Promotions batch end (commit 2)

- [x] 2.1 Spec: unit tests for `PromotionsService.batchEnd` (mock repo)
- [x] 2.2 Service: implement `batchEnd` on `PromotionsService` (transactional, reuses `Promotion.end()` + repo.updateStatus)
- [x] 2.3 Spec: controller unit tests for `POST /promotions/batch-end`
- [x] 2.4 Controller: add `@Post('batch-end')` handler

### Unit 3 — Final pass

- [ ] 3.1 Run full test suite + build (`pnpm run test` + `pnpm run build`)
- [ ] 3.2 Commit 1: `feat(employees): add batch terminate and reactivate endpoints`
- [ ] 3.3 Commit 2: `feat(promotions): add batch end endpoint`

## Notes

- Both endpoints reuse `BatchDeleteDto` (`{ ids: string[] }`).
- Permissions:
  - `batch-terminate` / `batch-reactivate` → `['update', 'Employee']`
  - `batch-end` → `['update', 'Promotion']`
- No new permission actions.
- Inline pattern (no shared batch-status module) — mirrors the batch-delete approach.
- Review budget: 400 lines.
