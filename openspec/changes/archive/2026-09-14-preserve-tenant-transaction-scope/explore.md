# Exploration — Preserve tenant transaction scope

## Status and boundary

Exploration only; no production source, schema, migration, service outside shared Prisma, WU8 work, commit, push, or PR was performed. This is an independent prerequisite to `protect-confirmed-sales` WU7, not sales behavior.

The required invariant is:

> Every client returned by `TenantPrismaService.getClient()` while a CLS transaction is active MUST retain the query extension that enforces the current CLS tenant for every model in `TENANT_SCOPED_MODELS`. A nested `runInTransaction` MUST reuse that same transaction and invariant.

## Current implementation and gap

### Shared Prisma boundary

| Path                                                 | Current behavior                                                                                                                                                                                                                                                                      | Finding                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/prisma/tenant-prisma.factory.ts`         | `createTenantScopedPrisma(base, cls)` uses `$extends({ query: { $allOperations } })` to inject `tenantId` for allowlisted models. It forces tenant attribution on creates, applies tenant predicates to reads/updates/deletes, and permits the documented super-admin global context. | This is the sole reusable tenant-scoping mechanism.                                                                                                                                                                                                   |
| `src/shared/prisma/tenant-prisma.service.ts`         | Outside a transaction, `getClient()` creates an extended `PrismaService`. In a CLS transaction it sees the callback `tx`; because interactive `tx` lacks `$extends`, it casts and returns it directly.                                                                                | `runInTransaction()` begins with **raw** `this.prisma.$transaction(...)`, so that cast returns a transaction client that did not originate from the tenant-extended root. Tenant query interception can therefore be bypassed in the CLS transaction. |
| `src/shared/tenant/tenant-scoped-models.constant.ts` | Maintains the allowlist used by the factory, including `Sale`, `SaleItem`, products, promotions, quotations, delivery routes, payment configuration, and catalog bindings.                                                                                                            | No allowlist or schema change is required.                                                                                                                                                                                                            |

The nested branch already has the desired atomicity behavior: when `prismaTxClient` exists it calls `work()` without opening another database transaction. The defect is the provenance of the outer transaction client, not nested transaction creation.

## Existing test coverage

- `src/shared/prisma/tenant-prisma.service.spec.ts` has four unit cases: exposes an ambient transaction client, reuses it in a nested call, and reports `isInTransaction()` false/true. The mock transaction client has no `$extends`; assertions currently pin identity/reuse, not tenant interception or transaction provenance.
- `src/shared/prisma/tenant-prisma.factory.spec.ts` covers factory-level `findMany`, `create`, global models, super-admin bypass, and `findUniqueOrThrow`, but never runs an interactive transaction.
- `src/shared/prisma/tenant-isolation.spec.ts` is the PostgreSQL integration suite for factory behavior. It proves cross-tenant read/update isolation and forced create attribution through clients created directly by the factory, but never calls `TenantPrismaService.runInTransaction()`.
- Therefore the production failure mode—tenant-scoped `getClient()` calls inside the CLS transaction—is currently untested at both unit and PostgreSQL layers.

## Production consumer map

The following production paths use `TenantPrismaService.runInTransaction()` and depend on `getClient()` resolving an ambient client:

| Consumer                                                                    | Transactional work at risk                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/catalog-settings/infrastructure/prisma-catalog-settings.repository.ts` | Lock, binding replacement, tenant update, and reload in `replace`.                              |
| `src/products/products.service.ts`                                          | Product/variant edit persistence, price-list writes, and stock-alert rearm.                     |
| `src/employees/application/employee-time-off.service.ts`                    | Tenant time-off record and conditional outbox insert.                                           |
| `src/shared/batch-delete/orchestrator/batch-delete.orchestrator.ts`         | Tenant validation and batch mutation atomicity.                                                 |
| `src/promotions/promotions.service.ts`                                      | Batch activation and batch end loops.                                                           |
| `src/sales/infrastructure/prisma-sale.repository.ts`                        | Repository transaction delegation used by sales flows.                                          |
| `src/sales/review/receipt-review.service.ts`                                | Receipt confirmation/rejection together with sale payment and outbox work.                      |
| `src/sales/sales.service.ts`                                                | Charge, cancellation, payment, and related sales transaction flows through the repository seam. |
| `src/delivery-routes/infrastructure/prisma-delivery-route.repository.ts`    | Adapts the ambient client to the route port’s explicit transaction callback.                    |

Several services/repositories also call `tenantPrisma.getClient().$transaction(...)` directly (notably product, promotion, and notification configuration code). They do not establish the CLS slot and are not necessary to fix the identified `runInTransaction()` defect. Their extension propagation should be characterized separately before broadening this change; raw `PrismaService.$transaction(...)` consumers and background pollers are likewise outside this CLS-bound invariant.

## PostgreSQL integration harness

`pnpm test:integration` uses `jest.integration.config.js` and runs in band. It loads `.env.test` before Prisma construction, applies `prisma migrate deploy` in `test/integration/setup/global-setup.ts`, protects against the development URL, and uses the PostgreSQL test database. `test/integration/reset-db.ts` offers `integrationPrisma()`, robust tenant/user truncation plus baseline reseeding, and shared-client teardown.

The smallest durable evidence is a new `src/shared/prisma/tenant-prisma.service.integration.spec.ts`, discovered automatically by the existing `*.integration.spec.ts` matcher. It should use a stateful CLS shim (`get` and `set` backed by a map), real `PrismaClient`, and the existing reset helpers.

Required scenarios:

1. Seed tenants A and B with an A-owned tenant-scoped record using the unscoped fixture client; set CLS to B; inside `runInTransaction`, `getClient().<model>.findUnique({ where: { id } })` MUST return `null` for A’s record.
2. Under the same transaction and B context, an update/delete addressed to A’s identifier MUST fail with `P2025` and leave A’s persisted record unchanged.
3. Under B context, a create that supplies A’s `tenantId` MUST persist as B, proving transaction-bound create attribution remains extension-controlled.
4. Call a nested `runInTransaction` inside the outer callback and repeat a tenant-scoped read/write assertion; the database transaction count is covered by unit mocks while PostgreSQL evidence proves the nested CLS path retains scoping.
5. Reload through raw fixture Prisma after commit/rollback to assert exact persisted tenant ownership and unchanged foreign state.

The existing factory integration suite remains the baseline for operation-specific extension semantics; this new service integration test covers the otherwise missing transaction provenance and CLS lifecycle.

## Minimal change proposal

1. In `src/shared/prisma/tenant-prisma.service.ts`, construct the transaction from a client returned by `createTenantScopedPrisma(this.prisma, this.cls)`, rather than from raw `PrismaService`.
2. Store the interactive callback client in CLS as today and preserve the existing `try/finally` restoration and nested no-wrap behavior. Prisma callback clients need not expose `$extends`; the crucial property is that they are created by the extended root transaction, so returning the ambient client does not discard the extension.
3. Strengthen `tenant-prisma.service.spec.ts` with distinct raw and extended mock clients, asserting `$transaction` is invoked on the extended root and that nested execution opens exactly one transaction.
4. Add the focused PostgreSQL integration suite above; do not modify the factory, allowlist, schema, downstream services, or sales work units.

This is expected to be one isolated shared-Prisma work unit with unit and integration evidence. The likely production and test diff is below the 400 changed-line review budget; if the implementation estimate exceeds it, the authoritative `ask-on-risk` policy requires a delivery decision before implementation.

## Risks and mitigations

| Risk                                                                                                                | Mitigation / decision boundary                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma version behavior might not carry query extensions from an extended root into an interactive callback client. | Prove it against the repository’s Prisma 6.19.2 PostgreSQL harness before accepting the design; do not treat mock identity as proof.                                            |
| A unit test can pass while the raw and extended mock clients are the same object.                                   | Use separate mocks and assert the extended client owns the `$transaction` call.                                                                                                 |
| The CLS slot can leak after success or an exception.                                                                | Retain the existing `finally` restoration and add/retain unit coverage for no ambient transaction after completion; integration assertions should use post-transaction reloads. |
| Nested calls could accidentally open a second transaction or lose tenant enforcement.                               | Preserve the `previousClient` early return and test nested interception with a stateful CLS store.                                                                              |
| Direct `getClient().$transaction(...)` paths have different CLS semantics.                                          | Explicitly exclude them from this minimal prerequisite; characterize them as a follow-up only if their behavior is in question.                                                 |
| Reverting this change reopens cross-tenant transaction access.                                                      | Roll back only the shared service and its focused unit/integration tests; no data migration or cleanup is involved, but rollback requires an explicit security decision.        |

## Rollback

The future change is code and tests only. Revert the `TenantPrismaService.runInTransaction()` extended-root transaction change and its focused unit/integration coverage as one work unit. No database schema, backfill, or tenant data repair is required. Because rollback reinstates the identified tenant-isolation exposure for CLS transactions, it must be treated as a security regression decision rather than routine operational rollback.

## Independence from protect-confirmed-sales

`protect-confirmed-sales` WU7 is a sales repository snapshot gate and depends on transaction-bound `getClient()` preserving tenant isolation, but this change neither edits nor tests sales code. Its implementation should land and be verified as a shared-Prisma prerequisite before WU7 proceeds; WU8 and all other sales lifecycle work remain out of scope.
