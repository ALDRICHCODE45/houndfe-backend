# Proposal — Protect confirmed and canceled sales from draft operations

Status: UNVALIDATED DRAFT — created prematurely; retained for user review, not approved.

## Intent

Enforce a single lifecycle rule: draft item mutations and draft sale deletion are permitted only while a sale is `DRAFT`. Reject these operations for `CONFIRMED` and `CANCELED` sales without changing persisted state. This protects historical financial records used by tenant staff, audit, and reporting while preserving ownership checks, tenant isolation, and valid draft workflows.

## Current-state gap

Draft route naming does not enforce lifecycle eligibility. Current `SalesService.addItem`, `updateItemQuantity`, `clearItems`, and `deleteDraft` check existence and ownership but do not reject non-DRAFT sales before mutation or deletion. `removeItem` already has a DRAFT guard and must retain that protection.

Prior exploration identifies missing guards in domain item mutation/recomputation paths. The Prisma repository's shared `save` deletes existing item rows and recreates them from domain state; an unauthorized lifecycle mutation can therefore replace historical items, potentially diverging from stored financial totals. Draft deletion can remove historical sale records and cascade into related records.

These are deterministic lifecycle enforcement gaps identified through static evidence, not a reproduced concurrency failure. This proposal does not claim that implementation or tests have been performed.

## Scope

### In scope

- Reject adding an item, updating item quantity, clearing items, and deleting a draft sale whenever its lifecycle is not `DRAFT`, including both `CONFIRMED` and `CANCELED`.
- Preserve the existing DRAFT-only restriction on single-item removal as part of the draft item mutation family.
- Cover shared domain and repository persistence paths needed to prevent bypassing the same item-mutation/deletion invariant. Rejection must precede destructive item replacement or sale deletion.
- Preserve persisted sale fields, item rows, and related records on rejected operations; do not emit success events for rejected mutations or deletion.
- Preserve tenant isolation, ownership enforcement, and existing valid DRAFT behavior, including item stacking, quantity validation, pricing/promotions, clearing an empty draft, and draft deletion.
- Define focused regression coverage in later phases for lifecycle rejection, state preservation, and authorized DRAFT behavior.

This is not a blanket prohibition on saving non-DRAFT sales: legitimate confirmation, cancellation, payment, and other existing lifecycle workflows must remain unchanged. Shared persistence protections must distinguish prohibited draft item writes from those legitimate operations.

### Explicit non-goals

- Stale-write prevention, concurrent transition races, optimistic locking, or a broader concurrency strategy.
- Refunds or refund-settlement semantics.
- Analytics, reports, historical debt, cash-ledger redesign, migrations, or event sourcing.
- Broad lifecycle redesign, new historical correction workflows, or repair of previously corrupted records.

The outcome is deterministic lifecycle integrity for draft operations, not a guarantee against concurrent stale writes or a reporting initiative.

## Affected areas

| Area                                                      | Expected responsibility in a later implementation                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/sales/sales.service.ts`                              | Enforce eligibility for draft item operations and `deleteDraft`; preserve ownership and success-event behavior.             |
| `src/sales/domain/sale.entity.ts`                         | Protect item mutation and associated recomputation entry points from non-DRAFT use without breaking legitimate transitions. |
| `src/sales/infrastructure/prisma-sale.repository.ts`      | Protect the relevant shared item replacement and deletion paths; avoid rejecting unrelated valid non-DRAFT persistence.     |
| `src/sales/domain/sale.repository.ts`                     | Adjust the persistence contract only if required to express the scoped invariant.                                           |
| Existing sales domain, service, and repository test areas | Add focused lifecycle and persisted-state regression coverage in a separately authorized phase.                             |

No schema, configuration, frontend, or reporting changes are proposed.

## Risks and tradeoffs

| Risk                                                                                           | Mitigation or boundary                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A broad guard on shared `save` could break confirmation or other legitimate non-DRAFT updates. | Review shared callers and scope protection to prohibited item writes/deletion rather than all non-DRAFT persistence.                                 |
| A guard applied after item replacement could leave partial changes despite rejection.          | Require eligibility rejection before any destructive write and verify complete persisted-state preservation.                                         |
| Clients may currently rely on invalid draft requests succeeding against historical sales.      | Return an explicit lifecycle business-rule failure using existing error conventions; retain valid DRAFT contracts.                                   |
| Lifecycle error handling could weaken ownership or tenant protections.                         | Preserve access checks and verify wrong-owner and cross-tenant behavior.                                                                             |
| Static lifecycle guards do not solve stale-state races or repair existing history.             | Keep concurrency and data remediation explicitly excluded; do not advertise those guarantees.                                                        |
| Later implementation may exceed the review budget.                                             | Pause for a delivery decision under `ask-on-risk` if a work unit risks exceeding 400 added/deleted lines; no chaining or exception is preauthorized. |

## Rollback

The current artifact changes no runtime behavior and can be withdrawn without data work. A later implementation should remain code-only, with no migrations or historical rewrites.

If a deployed guard causes regressions, prefer a narrow correction that retains historical protection. Reverting the implementation restores the prior vulnerability, so rollback requires an explicit operational decision and temporary restriction of affected draft mutation/deletion access where feasible. Do not delete or rewrite historical records as part of rollback. Recheck valid draft workflows, tenant/ownership enforcement, and historical-state preservation after any correction; rollback cannot restore records already altered before protection existed.

## Measurable success criteria

These are acceptance targets for later phases, not completed verification:

1. For each of add item, update quantity, clear items, and draft deletion, both `CONFIRMED` and `CANCELED` fixtures are rejected: eight required operation/status combinations. Single-item removal also retains rejection for both statuses.
2. Every rejected case leaves persisted sale fields, item identities/content, and associated financial records unchanged; no mutation/deletion success event is emitted. Clearing an empty non-DRAFT sale is rejected rather than treated as a successful no-op.
3. Authorized DRAFT fixtures continue to support add/stack, update quantity, remove, clear (including empty), and delete, with existing validation and pricing behavior preserved.
4. Relevant shared domain/persistence entry points cannot bypass the scoped non-DRAFT item mutation/deletion protection; legitimate confirmation, cancellation, and payment workflows retain existing behavior.
5. Wrong-owner and cross-tenant requests remain denied, and missing-sale behavior remains consistent with existing contracts.
6. Verification demonstrates the above without relying on concurrency fixes, schema changes, historical backfills, or reporting changes.

## Draft status and provenance

This proposal was created prematurely and is retained as an unvalidated draft, not an approved phase result. Prior claims that the pre-proposal gates and launch authorization had been satisfied are withdrawn. Corrected planning aliases and native artifact status do not retroactively validate its creation or establish human approval.

The retained scope covers confirmed and canceled history and the whole draft item mutation family, not only clearing items. The user's current authorization is limited to correcting this draft's status and provenance; it does not approve the proposal or authorize another SDD phase.

Historical sources cited by the original draft: `openspec/config.yaml`; service and repository source inspection; Engram observations 6980, 6977, 6979, 6904, 6907, 6888, and 6892. These references are retained as provenance, not freshly validated evidence. Engram observations 6979, 6999, and 7003 record the premature creation and subsequent contract reread. No change-local exploration or research artifact was present. Separate analytics research is not completed or incorporated here.

## Next step

Return this proposal for user review in interactive mode. Do not advance to specifications, design, tasks, or implementation without further authorization.
