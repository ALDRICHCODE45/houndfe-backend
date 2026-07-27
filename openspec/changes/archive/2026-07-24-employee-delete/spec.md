# Spec: Employee Hard-Delete

## Capability

`employee-delete` — single-record hard delete with cascade.

## Requirements

### R1 — DELETE endpoint returns 204 on success

The system **SHALL** expose `DELETE /admin/employees/:id` returning HTTP `204 No Content` when the employee record exists within the current tenant and was successfully removed.

```gherkin
Given an employee "emp-1" exists in tenant "tenant-1"
When the operator sends DELETE /admin/employees/emp-1 with valid delete:Employee permission
Then the response status is 204
And the response body is empty
```

### R2 — Non-existent ID returns 404

The system **SHALL** return HTTP `404 Not Found` when `:id` does not match any employee in the current tenant.

```gherkin
Given no employee exists with id "missing" in tenant "tenant-1"
When the operator sends DELETE /admin/employees/missing
Then the response status is 404
And the body carries an "Employee not found" error code
```

### R3 — Cascade deletes children

The system **SHALL** remove the following child rows atomically as part of the parent delete:

- `EmployeeSalaryHistory` rows referencing `employeeId`
- `EmployeePositionHistory` rows referencing `employeeId`
- `EmployeeDocument` rows referencing `employeeId`
- `EmployeeTimeOff` rows referencing `employeeId`
- `EmployeeEmergencyContact` rows referencing `employeeId`

The mechanism **SHALL** be Prisma `onDelete: Cascade` foreign keys (already configured in `schema.prisma`).

```gherkin
Given employee "emp-1" has 3 salary history rows, 2 documents, and 1 time-off request
When the operator deletes employee "emp-1"
Then those 6 child rows no longer exist in the database
And the parent employee row no longer exists
```

### R4 — Permissions enforced via `@RequirePermissions(['delete', 'Employee'])`

The system **SHALL** reject requests from users lacking `delete:Employee` with HTTP `403 Forbidden`.

```gherkin
Given a user authenticated as "operator" with no delete:Employee permission
When the operator sends DELETE /admin/employees/emp-1
Then the response status is 403
```

### R5 — Tenant isolation (cross-tenant id returns 404)

The system **SHALL** resolve IDs only within the authenticated user's tenant. An ID that belongs to a different tenant **MUST** surface as 404, not 403, to avoid leaking existence.

```gherkin
Given employee "emp-other" exists in tenant "tenant-2"
And the request context is tenant "tenant-1"
When the operator sends DELETE /admin/employees/emp-other
Then the response status is 404
```

### R6 — Manager relation uses SetNull (subordinates survive)

The system **SHALL** preserve employees whose `managerId` pointed to the deleted record by setting their `managerId` to `NULL`. They **MUST NOT** be cascade-deleted.

```gherkin
Given employee "manager-1" has a subordinate "sub-1" with managerId="manager-1"
When the operator deletes employee "manager-1"
Then employee "sub-1" still exists
And employee "sub-1" has managerId = NULL
```

## Out of Scope

- Batch delete — separate change (`batch-delete` abstraction exists; Employee not yet a consumer).
- Soft-delete / undo — `terminate()` already provides lifecycle control.
- Audit trail of who deleted what.
- Frontend wiring.