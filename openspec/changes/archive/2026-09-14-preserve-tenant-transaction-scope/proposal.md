# Proposal — Preserve tenant scope in CLS interactive transactions

## Intent

Make `TenantPrismaService.runInTransaction()` start interactive Prisma transactions from the tenant-extended root client. This preserves tenant query interception for every `TenantPrismaService.getClient()` call made while the CLS transaction is active, including nested `runInTransaction()` calls.

This is a reusable shared-Prisma security prerequisite for `protect-confirmed-sales` WU7. `protect-confirmed-sales` WU7 MUST NOT proceed until this change has landed with the required evidence.

## Current-state gap

`TenantPrismaService` currently starts its outer interactive transaction from raw `PrismaService`, then stores the raw callback client in CLS. Because extension state originates at the transaction caller, the callback client has no tenant query extension to preserve. Returning that ambient client from `getClient()` can therefore bypass tenant predicates and forced create attribution for models in `TENANT_SCOPED_MODELS`.

The nested transaction branch already reuses the CLS callback client and restores the previous value in `finally`; the defect is outer-client provenance, not atomicity or nested transaction creation.

## Scope

### In scope

- Start the outer `$transaction` from `createTenantScopedPrisma(this.prisma, this.cls)` rather than raw `PrismaService`.
- Preserve the active callback client in CLS for the transaction lifetime and restore the prior value in `finally` on success and failure.
- Preserve nested `runInTransaction()` reuse: a nested call MUST execute within the active transaction and MUST NOT open another interactive transaction.
- Add focused unit evidence that the extended root owns `$transaction`, nested execution opens one transaction, CLS restoration is retained, and `getClient()` exposes the ambient callback client.
- Add real PostgreSQL integration evidence that, inside `runInTransaction()`, tenant-scoped reads, writes, deletes, and creates retain the existing tenant isolation/attribution behavior; include a nested CLS path and post-transaction persistence assertions.
- Validate the approach against official Prisma ORM 6.19 evidence and the repository's Prisma 6.19.2 PostgreSQL harness.

### Explicit non-goals

- Prisma schema, migrations, tenant-model allowlist, backfills, or data repair.
- Sales repository changes or any `protect-confirmed-sales` WU7 implementation.
- WU8 or other sales lifecycle work.
- Changes to direct `getClient().$transaction(...)` consumers, raw `PrismaService.$transaction(...)` consumers, background pollers, or unrelated transaction patterns.
- Pushes, pull requests, or delivery execution as part of this proposal.

## Affected areas

| Area                                                          | Intended responsibility                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/prisma/tenant-prisma.service.ts`                  | Establish the outer interactive transaction from the tenant-extended root while retaining CLS lifecycle and nested reuse. |
| `src/shared/prisma/tenant-prisma.service.spec.ts`             | Verify extended-root provenance, one outer transaction for nesting, ambient access, and restoration.                      |
| `src/shared/prisma/tenant-prisma.service.integration.spec.ts` | Provide real PostgreSQL tenant-isolation evidence through the service transaction boundary.                               |
| `src/shared/prisma/tenant-prisma.factory.ts`                  | Reused unchanged as the existing tenant query-extension boundary.                                                         |
| `openspec/changes/protect-confirmed-sales/`                   | Downstream dependency only; WU7 waits for this prerequisite and receives no code changes here.                            |

## Design basis: Prisma 6.19

Official Prisma ORM 6.19.0 source and functional tests establish that an interactive transaction callback client is constructed from its calling client and reapplies client/model extensions. Therefore, a transaction started from the tenant-extended root carries the tenant query extension into its callback client.

The same official evidence establishes that callback transaction clients intentionally do not expose `$extends` or `$transaction`. The implementation and tests MUST NOT use the presence of `$extends` on the callback client as proof of extension propagation. Provenance is established by starting the outer transaction from the extended root; real PostgreSQL behavior is the acceptance evidence for this repository.

The validated source set is recorded in `research.md`: Prisma ORM 6.19.0 runtime transaction and extension code, interactive-transaction denylist, official extension functional tests, and the 6.19.0 release. The project runtime boundary is `prisma`/`@prisma/client` 6.19.2.

## Security impact

This change closes a tenant-isolation gap at the shared CLS transaction boundary. Without it, code that correctly obtains its client through `TenantPrismaService.getClient()` during an active CLS transaction can operate through a callback client missing the tenant query extension, risking cross-tenant reads or mutations and caller-supplied tenant attribution on creates.

The change preserves the existing allowlist and super-admin semantics rather than defining new authorization policy. It does not make raw SQL safe: raw SQL remains responsible for explicit, parameter-bound tenant qualification. Direct transaction consumers outside CLS remain excluded and MUST NOT be represented as protected by this work.

## Risks and mitigations

| Risk                                                                         | Mitigation                                                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma extension propagation differs from the proposed behavior.             | Require both official Prisma 6.19 source/functional evidence and repository PostgreSQL integration evidence before acceptance.                     |
| Unit mocks hide provenance by using one object for raw and extended clients. | Use distinct mocks and assert that `$transaction` is invoked on the extended root.                                                                 |
| CLS state leaks after completion or errors.                                  | Retain `try`/`finally` restoration and cover success/failure restoration in unit tests.                                                            |
| Nested work opens another transaction or loses isolation.                    | Preserve the existing early nested return, assert one transaction in unit tests, and execute nested service-bound tenant assertions in PostgreSQL. |
| Work exceeds the 400 changed-line review budget.                             | Under `ask-on-risk`, pause for an explicit delivery decision before implementation; no chain strategy or size exception is preauthorized.          |
| Rollback reopens tenant exposure.                                            | Treat rollback as an explicit security decision, not routine operational recovery.                                                                 |

## Rollback

The future implementation is code-and-tests only. Revert the extended-root transaction change and its focused unit/integration coverage together; no schema rollback, data migration, or tenant-data cleanup is required.

Because reverting restores the identified CLS transaction tenant-isolation exposure, rollback requires explicit security/operational approval and should be followed by restricting affected transactional access where practical. It cannot be presented as a neutral rollback.

## Success criteria

1. The outer `runInTransaction()` calls `$transaction` on a tenant-extended root client, not raw `PrismaService`.
2. During an active CLS transaction, every `getClient()` result retains existing tenant query enforcement for `TENANT_SCOPED_MODELS`.
3. Nested `runInTransaction()` calls reuse the outer callback client, open exactly one interactive transaction, and preserve/restores the CLS value correctly on success and error paths.
4. Real PostgreSQL tests prove that a tenant cannot read another tenant's record through the service transaction path; cross-tenant update/delete fail without persistence changes; and a supplied foreign `tenantId` on create is overwritten with the CLS tenant.
5. Real PostgreSQL tests exercise the nested CLS path and verify persisted state after transaction completion through the unscoped fixture client.
6. The evidence is compatible with official Prisma 6.19 behavior and the repository's Prisma 6.19.2 dependency boundary.
7. No schema, sales repository, WU8, direct transaction-consumer, push, or PR work is introduced.
8. `protect-confirmed-sales` WU7 records and honors this change as its shared-Prisma prerequisite.

## Delivery boundary

This proposal defines one shared-Prisma work unit expected to fit the 400-line review budget and is part of the selected `feature-branch-chain`. If the implementation forecast exceeds that budget, execution MUST pause under the session's `ask-on-risk` policy for a delivery decision; the selected chain does not preauthorize a size exception.
