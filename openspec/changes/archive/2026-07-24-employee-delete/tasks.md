# Tasks: Employee Hard-Delete

## Forecast

~80 lines of code + ~120 lines of tests = ~200 lines total.
Decision needed before apply: No
Chained work-slices recommended: No
Chain strategy: not-needed
400-line budget risk: Low

## TDD Discipline

Run `pnpm run test` after every task. RED before GREEN. Never implement then test.

## Work Unit 1 — Repository Contract + Prisma Implementation

Rollback: revert interface + prisma repo edits.

- [x] 1.1 RED extend `IEmployeeRepository` with `delete(id: string): Promise<void>` in `src/employees/domain/employee.repository.ts` (compile error in `PrismaEmployeeRepository`).
- [x] 1.2 GREEN implement `delete(id)` in `PrismaEmployeeRepository`: `prisma.employee.delete({ where: { id } })`.
- [x] 1.3 Boundary `pnpm run test -- src/employees` — no regressions.

## Work Unit 2 — Service `remove()`

Rollback: revert service edit.

- [x] 2.1 RED `src/employees/application/employees.service.spec.ts` — add `describe('remove()')` block with:
  - happy path: `findById` returns record → calls `repo.delete(id)` → resolves void
  - not-found: `findById` returns `null` → throws `EmployeeNotFoundError`, `repo.delete` not called
- [x] 2.2 RED observe RED (test fails on missing `remove()` method).
- [x] 2.3 GREEN add `async remove(id: string): Promise<void>` to `EmployeesService`:
  - `findById(id)` → throw `EmployeeNotFoundError(id)` if missing
  - `await this.employeeRepo.delete(id)`
- [x] 2.4 GREEN observe GREEN.

## Work Unit 3 — Controller Endpoint

Rollback: revert controller edit.

- [x] 3.1 RED `src/employees/employees.controller.spec.ts` — new file; describe DELETE handler:
  - service `remove` called with parsed UUID id
  - controller is decorated with `@RequirePermissions(['delete','Employee'])`
  - controller is decorated with `@Delete(':id')` and `@HttpCode(204)` (smoke test on metadata)
- [x] 3.2 RED observe RED (no controller method yet).
- [x] 3.3 GREEN add `@Delete(':id') @HttpCode(204) @RequirePermissions(['delete','Employee'])` handler in `EmployeesController` delegating to `service.remove(id)`.
- [x] 3.4 GREEN observe GREEN.

## Work Unit 4 — Verification

- [x] 4.1 `pnpm run test` — full suite green, no regressions in `src/employees/**` (2258 passing).
- [x] 4.2 `pnpm run build` — clean (zero TS errors from `nest build`).

## Work Unit 5 — Commit + Persist

- [x] 5.1 `git add` the four code/test files plus `openspec/changes/employee-delete/{proposal,spec,tasks}.md`.
- [x] 5.2 Conventional commit: `feat(employees): add hard-delete endpoint with cascade`.
- [x] 5.3 `mem_save` apply-progress to Engram with `topic_key: sdd/employee-delete/apply-progress`, `capture_prompt: false`.
- [x] 5.4 Tick completed tasks in this file (`[x]`).

## Notes

- `delete:Employee` is **already** in `PERMISSION_REGISTRY` (no registry edit required).
- All children cascade via Prisma `onDelete: Cascade` defined in `schema.prisma` — no DB migration.
- `manager` relation is `onDelete: SetNull` so subordinates survive with `managerId=null`.
- Tenant scoping is automatic via `tenantPrisma.getClient()`; cross-tenant ids resolve to `null` → 404.

## Build & Test Results

- `pnpm run test` — 2258 tests passing across 180 suites (+8 new: 3 service remove + 5 controller).
- `pnpm run build` — clean.
- Pre-existing TS errors (6 in employee spec files, 15 total on main) are unrelated to this change; `nest build` and `ts-jest` tolerate them.