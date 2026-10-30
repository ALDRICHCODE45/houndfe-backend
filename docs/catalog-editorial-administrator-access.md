# Editorial administrator capability policy (T48a)

S53/S54 apply only to editorial ficha/publication authority, not private media.
For a concrete tenant scope, both editorial authorities recheck the active actor
and persisted global role proof through the supplied Prisma root/transaction client.
The global predicate matches `AuthService.completeLogin`: a role with `tenantId: null`,
attached through a membership for this actor, and either system `Super Admin` identity
or an `all/manage` permission. Caller flags and tenant-role names confer no authority.
Missing proof grants nothing; dependency failures fail closed.

Otherwise, qualified memberships for exactly this actor and tenant may supply
`all/manage`. Ordinary users still require exact editorial read; create/save/discard
also require update, and publication also requires publish. No grants are stored.
The Product must still match both its id and the concrete selected tenant, including
for global administrators. `activeMember` represents an active, scope-qualified actor;
verified global authority qualifies without requiring membership in that tenant.
Write document authority remains separately required, scope-checked and detached.
Data/publication validation, coordination locks, CAS and receipts are unchanged.

Private media explicitly selects `exact-grants` at its composition boundary:
it retains current tenant membership plus exact read, and read+update for upload.
Neither global identity nor tenant wildcard now grants media access.

## Tested concrete-tenant HTTP scope

Synthetic authenticated HTTP tests cover tenant `all/manage` success for document,
context and vocabulary reads, plus initialize/save with exact response bodies and
read/write effects. Ordinary-grant denials remain covered. Exact read+update and
wildcard save both reject an unowned media reference with 400 `MALFORMED`, zero
writes and unchanged state/counters; unavailable document sources still deny access.
These are Prisma-mocked tests with an overridden JWT guard, not live DB/JWT proof.
They do not establish complete administrator coverage across all seven endpoints.

## Integration still pending (T48b)

This unit does not adapt the four HTTP controllers or DI. Global/null HTTP mode is
not yet supported by this change. T48b must resolve the persisted Product tenant
server-side for global mode, keep global administrators confined to a selected
tenant until switching/returning global, and cover vocabulary/document/context/
initialize/save/publish/discard. Never accept a caller tenant override.
S55 permits up to 525 authored lines for T48a only; later units retain 400.
This does not authorize stored-grant changes, deployment or data operations.
