# Design: Preserve tenant scope in CLS interactive transactions

## Technical Approach

Correct transaction-client provenance in `src/shared/prisma`, implementing `specs/shared-prisma/spec.md` without changing tenant policy. Start the outer interactive transaction from `createTenantScopedPrisma(this.prisma, this.cls)`. Preserve `getClient()` unchanged, including its existing conditional branch: normal Prisma interactive transaction clients already pass through as-is. The sole production change is outer transaction provenance in `runInTransaction()`.

The official Prisma 6.19.0 evidence recorded in `research.md` (C1–C4, S1–S6) establishes extension inheritance and the callback denylist. Repository acceptance still requires real PostgreSQL evidence with Prisma 6.19.2; source research alone is insufficient.

## Architecture Decisions

| Option                                     | Tradeoff                                                              | Decision                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Extended root owns outer `$transaction`    | Reuses existing query policy without duplicating predicates           | Selected: fixes the provenance defect at its source.                                                                                   |
| Extend the callback client                 | `$extends` is intentionally unavailable on Prisma transaction clients | Rejected as the fix: preserve the existing `getClient()` conditional branch unchanged; normal Prisma ITX clients already return as-is. |
| Add transaction-specific tenant predicates | Duplicates factory policy and risks divergence                        | Rejected: reuse the factory unchanged.                                                                                                 |
| Reuse ambient transaction for nesting      | No independent nested commit or savepoint                             | Retain: preserves existing atomicity and avoids another transaction.                                                                   |

## Data Flow

```text
Caller -> runInTransaction(): capture previous CLS client
  active client -> work() -> same ambient client; no slot mutation
  no client -> tenant-extended root.$transaction(callback)
    Prisma -> callback(tx with inherited query extension)
    callback -> CLS.set(tx) -> await work()
      work -> getClient() -> identical tx -> tenant query policy -> PostgreSQL
      nested runInTransaction -> work() using identical tx
    finally -> CLS.set(previous)
    Prisma -> commit or rollback -> caller result/original error
```

Nested failures leave the outer slot intact because the nested branch never changes it. If propagated, the failure reaches the outer `finally` and Prisma rollback. Slot restoration is not itself evidence of commit.

## File Changes

| File                                                          | Action | Responsibility                                                                            |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `src/shared/prisma/tenant-prisma.service.ts`                  | Modify | Change only outer transaction provenance; preserve `getClient()` and lifecycle unchanged. |
| `src/shared/prisma/tenant-prisma.service.spec.ts`             | Modify | Distinct raw/extended mocks; provenance, identity, nesting, restoration.                  |
| `src/shared/prisma/tenant-prisma.service.integration.spec.ts` | Create | Real PostgreSQL service-bound isolation and persistence evidence.                         |

Factory, allowlist, schema, migrations, sales repositories, and direct transaction consumers remain unchanged.

## Interfaces / Contracts

Preserve `runInTransaction<T>(work: () => Promise<T>): Promise<T>`, `getClient()`, and `isInTransaction()`. The service callback receives no transaction argument: callers obtain the Prisma callback client through CLS. Preserve existing client types/casts without expanding the public API; the callback does not support root-only `$transaction` or `$extends` methods.

Keep `prismaTxClient` as the CLS slot. Return work results and propagate original thrown errors/rejections unchanged. Preserve missing-tenant and super-admin policy in the factory. Raw SQL still requires explicit parameter-bound tenant qualification. No protection claim extends to CLS-external consumers.

## Testing Strategy

| Layer      | Planned evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit       | Raw `$extends` returns a distinct extended root; only that root opens one transaction. Assert ambient identity, result forwarding, nested success/caught failure, exact prior-slot restoration after success/synchronous throw/rejection, and outside-transaction extended access. Never assert callback `$extends` presence.                                                                                                                                                                                      |
| PostgreSQL | Use existing integration configuration, guarded `integrationPrisma()` fixture client, reset/seed cleanup, and a writable CLS get/set shim. Seed tenants A/B and a simple allowlisted Product. Under B, outer and nested reads of A return null; separate failing update/delete transactions reject with P2025, followed by unscoped reloads proving unchanged A state. Outer and nested creates supplying A persist under B; verify ownership after commit with unscoped reloads. Include own-tenant read success. |
| Regression | Run focused unit/integration suites, existing tenant-isolation integration coverage, and build. Skipped database suites are not acceptance evidence.                                                                                                                                                                                                                                                                                                                                                               |

Integration tests run serially against the dedicated test database, never development/production databases. Existing harness cleanup is reused, not redesigned.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary changes. Tenant isolation is covered above.

## Migration / Rollout

No migration required. Land only after verified unit and PostgreSQL evidence. `protect-confirmed-sales` WU7 remains blocked until landing and evidence verification; downstream tasks must reference that prerequisite. No WU7/WU8 implementation, push, or PR execution occurs here.

Tasks must forecast total authored changes against 400 lines. The current session explicitly selected `feature-branch-chain`. Delivery remains `ask-on-risk`: pause if budget risk requires a delivery decision; the selected chain does not authorize a `size:exception`. Reverting reopens tenant exposure and requires explicit security/operational approval.

## Open Questions

None blocking design; database execution evidence remains pending implementation.
