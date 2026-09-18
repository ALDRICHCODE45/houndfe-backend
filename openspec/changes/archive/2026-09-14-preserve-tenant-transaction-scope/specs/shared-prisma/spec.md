# Shared Prisma Specification

## Purpose

Define the tenant-scoping contract enforced by `TenantPrismaService` at the shared Prisma boundary, and the observable invariants that hold for any client obtained through `TenantPrismaService.getClient()` while a CLS (Continuation Local Storage) interactive transaction is active. This specification covers the outer transaction, nested transaction reuse, and the CLS lifecycle. Raw SQL handling and direct/CLS-external transaction consumers are static design boundaries, not runtime requirements; they are recorded as non-goals below and carry no runtime coverage obligation. It is the shared-Prisma security prerequisite that `protect-confirmed-sales` WU7 depends on.

## Requirements

### Requirement: Tenant-Extended Root Owns The Outer Interactive Transaction

`TenantPrismaService.runInTransaction(work)` MUST invoke the outer `$transaction` on a client produced by `createTenantScopedPrisma(this.prisma, this.cls)` (the tenant-extended root). The outer `$transaction` MUST NOT be invoked on the raw `PrismaService` instance. The callback client passed to `work` MUST therefore originate from the tenant-extended root. The implementation and tests MUST NOT use the presence of `$extends` on the callback client as evidence of extension propagation, because interactive transaction clients intentionally omit `$extends` per the Prisma 6.19 interactive transaction denylist.

#### Scenario: Outer $transaction is invoked on the extended root

- GIVEN no CLS transaction is active and `runInTransaction(work)` is invoked
- WHEN the outer `$transaction` call is observed
- THEN the calling client is the result of `createTenantScopedPrisma(this.prisma, this.cls)`
- AND the raw `PrismaService` instance is NOT used as the calling client

#### Scenario: $extends presence on callback client is not asserted as proof

- GIVEN `runInTransaction(work)` is in progress
- WHEN the implementation or its tests inspect the callback client
- THEN no test asserts `'$extends' in tx` to prove extension propagation
- AND provenance is established by starting the outer transaction from the extended root

### Requirement: CLS Transaction Slot Restoration On Success And Failure

`TenantPrismaService.runInTransaction(work)` MUST capture the prior CLS transaction slot before the transaction starts, store the active callback client in CLS for the transaction lifetime, and restore the prior value in a `finally` block on both the success path and the failure path. After completion (whether `work` returned normally or threw), `isInTransaction()` MUST report the same state it reported before the call. The original error from `work` MUST be propagated to the caller unchanged.

#### Scenario: CLS state restored after a successful work callback

- GIVEN no CLS transaction is active and `isInTransaction()` reports `false`
- WHEN `runInTransaction(work)` is invoked and `work` returns normally
- THEN the prior CLS transaction slot value is restored
- AND `isInTransaction()` reports `false`
- AND `getClient()` outside the transaction returns a non-transaction tenant-extended client

#### Scenario: CLS state restored after a failing work callback

- GIVEN no CLS transaction is active and `isInTransaction()` reports `false`
- WHEN `runInTransaction(work)` is invoked and `work` throws an error
- THEN the prior CLS transaction slot value is restored
- AND `isInTransaction()` reports `false`
- AND the original error is re-thrown to the caller

#### Scenario: CLS state restored when work returns a rejected promise

- GIVEN no CLS transaction is active
- WHEN `runInTransaction(work)` is invoked and `work` returns a rejected promise
- THEN the prior CLS transaction slot value is restored
- AND `isInTransaction()` reports `false`
- AND the rejection is propagated to the caller

### Requirement: Nested runInTransaction Reuses The Active Outer Transaction

A nested `runInTransaction(nestedWork)` invoked while a CLS transaction is active MUST execute `nestedWork` against the existing outer ambient callback client. The nested call MUST NOT invoke `$transaction` on any client. Across the outer call (including any number of nested calls), the outer `$transaction` MUST be invoked exactly once on the tenant-extended root. The CLS transaction slot MUST be restored to the outer callback client when each nested call returns or throws.

#### Scenario: Nested call does not open a new interactive transaction

- GIVEN a CLS transaction is active (outer `runInTransaction` is on the stack)
- WHEN `runInTransaction(nestedWork)` is invoked from inside `work`
- THEN exactly one `$transaction` call is observed on the tenant-extended root across the entire outer execution
- AND `nestedWork` runs against the same ambient callback client that the outer transaction exposes

#### Scenario: Nested call leaves the CLS slot intact on success

- GIVEN a CLS transaction is active with ambient callback client `outerTx`
- WHEN a nested `runInTransaction(nestedWork)` completes successfully
- THEN `getClient()` continues to return `outerTx`
- AND `isInTransaction()` remains `true`

#### Scenario: Nested call leaves the CLS slot intact on failure

- GIVEN a CLS transaction is active with ambient callback client `outerTx`
- WHEN a nested `runInTransaction(nestedWork)` throws
- THEN the CLS transaction slot is restored to `outerTx`
- AND `isInTransaction()` remains `true`
- AND the error propagates so the outer transaction can observe it

### Requirement: getClient Returns The Ambient Callback Client Inside An Active CLS Transaction

While a CLS transaction is active, `TenantPrismaService.getClient()` MUST return the ambient callback client as-is. It MUST NOT synthesize, replace, or wrap the ambient callback client, and it MUST NOT return the raw `PrismaService` instance from inside the transaction.

#### Scenario: getClient returns the ambient callback client inside the outer transaction

- GIVEN `runInTransaction(work)` is in progress
- WHEN `TenantPrismaService.getClient()` is invoked from inside `work`
- THEN the returned client is the same ambient callback client that Prisma supplied to `work`

#### Scenario: getClient returns the ambient callback client inside a nested CLS transaction

- GIVEN a CLS transaction is active with ambient callback client `outerTx`
- WHEN `getClient()` is invoked from inside a nested `runInTransaction` callback
- THEN the returned client is `outerTx`

### Requirement: Tenant Enforcement For Reads Inside CLS Transactions

While a CLS transaction is active and the CLS context carries tenant B, every `getClient()` read (for example `findUnique`, `findFirst`, `findMany`, `count`, `aggregate`) against any model listed in `TENANT_SCOPED_MODELS` MUST enforce tenant B. A read that targets a record owned by a different tenant MUST return no record. This requirement covers both the outer CLS transaction and any nested CLS transaction.

#### Scenario: Tenant-scoped find inside the outer CLS transaction returns no cross-tenant record

- GIVEN tenants A and B, an A-owned tenant-scoped record R, and CLS tenant B
- WHEN inside `runInTransaction`, `getClient().<model>.findUnique({ where: { id: R.id } })` is called
- THEN the result is `null` (A's record is not visible to B)

#### Scenario: Tenant-scoped find inside a nested CLS transaction returns no cross-tenant record

- GIVEN tenants A and B, an A-owned tenant-scoped record R, and an active CLS transaction under tenant B
- WHEN inside a nested `runInTransaction`, `getClient().<model>.findUnique({ where: { id: R.id } })` is called
- THEN the result is `null`
- AND the nested CLS path retains the same scoping as the outer call

### Requirement: Tenant Enforcement For Updates And Deletes Inside CLS Transactions

While a CLS transaction is active and the CLS context carries tenant B, every `getClient()` update or delete against any model listed in `TENANT_SCOPED_MODELS` MUST fail with Prisma error `P2025` when the targeted identifier is owned by a different tenant. The failed operation MUST NOT alter the persisted record.

#### Scenario: Cross-tenant update inside the outer CLS transaction fails and leaves state unchanged

- GIVEN tenants A and B, an A-owned tenant-scoped record R, and CLS tenant B
- WHEN inside `runInTransaction`, `getClient().<model>.update({ where: { id: R.id, * }, data: ... })` is called
- THEN the update is rejected with `P2025`
- AND R's persisted state is unchanged
- AND the change is observable through the unscoped fixture Prisma client after rollback

#### Scenario: Cross-tenant delete inside the outer CLS transaction fails and leaves state unchanged

- GIVEN tenants A and B, an A-owned tenant-scoped record R, and CLS tenant B
- WHEN inside `runInTransaction`, `getClient().<model>.delete({ where: { id: R.id, * } })` is called
- THEN the delete is rejected with `P2025`
- AND R's persisted state is unchanged
- AND the change is observable through the unscoped fixture Prisma client after rollback

### Requirement: Tenant Attribution For Creates Inside CLS Transactions

While a CLS transaction is active, a `create` issued through `getClient()` against any model listed in `TENANT_SCOPED_MODELS` MUST persist with the current CLS tenant as the owner, even when the caller supplies a different `tenantId` in the create payload. The persisted ownership MUST be observable through the unscoped fixture Prisma client after the transaction commits.

#### Scenario: Foreign tenantId on create is overwritten with the CLS tenant

- GIVEN CLS tenant B
- WHEN inside `runInTransaction`, `getClient().<model>.create({ data: { tenantId: <A>, ... } })` is called
- THEN the persisted record is owned by tenant B
- AND no record is persisted under tenant A
- AND the persisted ownership is observable through the unscoped fixture Prisma client after commit

#### Scenario: Create inside a nested CLS transaction retains attribution

- GIVEN an active CLS transaction under tenant B
- WHEN a nested `runInTransaction` calls `getClient().<model>.create({ data: { tenantId: <A>, ... } })`
- THEN the persisted record is owned by tenant B
- AND the unscoped fixture Prisma client observes the persisted ownership under tenant B after commit

### Requirement: Post-Transaction Persistence Reload Through Unscoped Fixture

Real PostgreSQL evidence for this specification MUST include a post-commit reload through an unscoped fixture Prisma client for any create inside `runInTransaction()`, and a post-rollback reload for any failed update or delete inside `runInTransaction()`. The reloads MUST confirm tenant ownership exactly matches the CLS tenant for creates and remains unchanged for the failing update/delete scenarios.

#### Scenario: Post-commit reload confirms tenant ownership for a transaction create

- GIVEN a CLS transaction that creates a tenant-scoped record under CLS tenant B
- WHEN the transaction commits
- THEN reloading through the unscoped fixture Prisma client shows the persisted record owned by tenant B
- AND no record appears under tenant A

#### Scenario: Post-rollback reload confirms unchanged state for a failing transaction update or delete

- GIVEN a CLS transaction under tenant B whose update or delete against an A-owned record is rejected
- WHEN the transaction rolls back
- THEN the unscoped fixture Prisma client shows the A-owned record unchanged
- AND no record was created or deleted by the failed operation

## Static Design Boundaries (Non-Goals — Not Runtime Requirements)

The following boundaries are design decisions recorded for reviewers and downstream work. They intentionally impose no runtime requirement and carry no scenario, so verification neither tests them nor counts their absence as a coverage gap. The implementation and tests MUST NOT add runtime coverage for these out-of-scope behaviors in this change.

- **Raw SQL remains the caller's responsibility.** Statements executed through `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, or `$executeRawUnsafe`, inside or outside `runInTransaction()`, bypass the tenant query extension by design. Any tenant qualification comes from the SQL itself through parameter-bound statements; this work does not make raw SQL tenant-safe and does not claim otherwise.
- **Direct and CLS-external transaction consumers carry no protection claim.** Direct `getClient().$transaction(...)` consumers, raw `PrismaService.$transaction(...)` consumers, background pollers, and other CLS-external transaction patterns do not populate the CLS transaction slot. This specification does not represent them as protected by the CLS transaction invariants above.

### Requirement: Prisma 6.19 Source Compatibility

The implementation MUST be compatible with the project's Prisma 6.19.2 dependency boundary. The behavior MUST match the official Prisma 6.19.0 evidence: an interactive transaction callback client is constructed from its calling client and inherits the calling client's applied query extensions. The implementation MUST NOT depend on `$extends` being exposed on the callback client.

#### Scenario: Outer transaction started from the extended root propagates extension state

- GIVEN the project's Prisma 6.19.2 runtime
- WHEN `createTenantScopedPrisma(this.prisma, this.cls).$transaction(work)` is invoked
- THEN `work` receives a callback client whose tenant query extension state is non-empty for models in `TENANT_SCOPED_MODELS`

#### Scenario: Implementation does not rely on $extends on the callback client

- GIVEN the project's Prisma 6.19.2 runtime
- WHEN the implementation or its tests reference the callback client
- THEN no production code or test relies on `'$extends' in tx` to prove extension propagation

### Requirement: Downstream Gate For protect-confirmed-sales WU7

The `protect-confirmed-sales` WU7 implementation MUST NOT begin any destructive persistence step until this change has landed AND the evidence required by the proposal's success criteria 1–6 has been verified against the repository's Prisma 6.19.2 PostgreSQL harness. The WU7 work unit MUST record this prerequisite in its tasks or dependencies and MUST reference the verified evidence before proceeding.

#### Scenario: WU7 implementation is blocked until the prerequisite is verified

- GIVEN `protect-confirmed-sales` WU7 is in scope
- AND this change has not landed with verified unit and PostgreSQL evidence
- WHEN WU7 is scheduled to begin
- THEN WU7 implementation MUST NOT start
- AND WU7 tasks MUST list this prerequisite as a blocking dependency

#### Scenario: WU7 implementation is unblocked once the prerequisite is verified

- GIVEN `protect-confirmed-sales` WU7 is in scope
- AND this change has landed
- AND the unit and PostgreSQL evidence covers success criteria 1–6 of the corresponding proposal
- WHEN WU7 begins
- THEN WU7 MAY proceed using `TenantPrismaService.runInTransaction()` and `TenantPrismaService.getClient()` as documented
- AND no additional shared-Prisma migration is required for WU7
