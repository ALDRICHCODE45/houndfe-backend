# Proposal: Add Hard-Delete CRUD Operation to Employee Module

## Intent

The Employee module ships with create / read / update / soft-terminate but no hard-delete. Operators have no way to remove a record created in error or scrub data on request — `terminate()` only flips a status flag. This change adds the missing `DELETE /admin/employees/:id` endpoint following the same hard-delete pattern used by every other module in the codebase.

## Scope

### In Scope
- `DELETE /admin/employees/:id` returning `204 No Content` on success.
- `EmployeesService.remove(id)` orchestrating the cascade delete via repository.
- `IEmployeeRepository.delete(id)` + `PrismaEmployeeRepository.delete(id)` implementation.
- Permission gate `@RequirePermissions(['delete', 'Employee'])`.
- Tenant isolation enforced through `tenantPrisma.getClient()`.
- Unit + controller specs (TDD).

### Out of Scope (Non-Goals)
- Batch delete (future SDD; the recent `batch-delete` change shipped the reusable abstraction but Employee is not yet a consumer).
- Soft-delete / undo / audit trail (already covered by `terminate()`).
- Frontend wiring.

## Capabilities

### New Capabilities
- `employee-delete` — single-record hard delete with cascade.

### Modified Capabilities
- `employees` — delta adding the missing D in CRUD; no behavior change to existing methods.

## Approach

Mirror the hard-delete pattern established by `Promotions` (`@Delete(':id') @HttpCode(204) @RequirePermissions(['delete','Promotion'])` → `service.remove()` → `findById` → `repo.delete`). The repository calls `prisma.employee.delete({ where: { id } })`; cascade behavior is defined at the Prisma schema level (`onDelete: Cascade` for salary history, position history, documents, time-off, emergency contacts; `onDelete: SetNull` for the manager self-reference so subordinates are not orphaned-deleted).

Tenant scoping is implicit — `tenantPrisma.getClient()` returns a tenant-filtered Prisma client, so a cross-tenant id resolves to `null` and surfaces as `404` via the existing `EmployeeNotFoundError`. No extra guard needed.

The `delete:Employee` permission already exists in `PERMISSION_REGISTRY` (lines 322-326); no registry change required.

## Affected Areas

| Area | Impact |
|------|--------|
| `src/employees/employees.controller.ts` | New `@Delete(':id')` handler |
| `src/employees/application/employees.service.ts` | New `remove(id)` method |
| `src/employees/domain/employee.repository.ts` | Add `delete(id)` to interface |
| `src/employees/infrastructure/prisma-employee.repository.ts` | Implement `delete(id)` |
| `src/employees/application/employees.service.spec.ts` | New `describe('remove()')` block |
| `src/employees/employees.controller.spec.ts` | New spec for DELETE endpoint |

## Risks

| Risk | Lik | Mitigation |
|------|-----|------------|
| Accidental mass delete from mis-typed id | Low | Single-id endpoint with UUID parse; no batch logic in this slice |
| Orphaned subordinates when manager deleted | Low | Prisma `manager @relation SetNull` keeps them alive; verified in schema |
| Cross-tenant id leak | Low | Tenant-scoped prisma client; `findById` returns `null` outside tenant → 404 |

## Rollback Plan

Revert the four code changes + two test files. No DB migration; no seeded-permission drift (`delete:Employee` already existed). One revert commit.

## Success Criteria

- `DELETE /admin/employees/:id` returns 204 on success.
- Non-existent id (or cross-tenant id) returns 404.
- Cascade deletes salary history, position history, documents, time-off, emergency contacts.
- Subordinates of the deleted employee have `managerId` set to `null` (not deleted).
- `RequirePermissions(['delete', 'Employee'])` enforced; user without it gets 403.
- `pnpm run test` and `pnpm run build` green.

## Size Signal

Small mechanical change. Forecast under 200 lines of code (interface method + service method + controller handler + prisma implementation + tests). No migration, no new permission entry, no module wiring change.