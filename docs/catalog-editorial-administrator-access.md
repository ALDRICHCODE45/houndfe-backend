# Editorial administrator access (T48a/T48b)

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

## Global HTTP scope (T48b)

Both registered modules explicitly inject `EditorialHttpScope` from their supplied
PrismaService. Null tenant mode requires the existing JWT global flag, then fresh
active-actor and persisted global-role proof. Only after that proof may an id-only
Product lookup resolve its actual tenant. The concrete actor/tenant/Product scope
continues through existing core authorization, including transaction-client write
checks. Blank actor/tenant values are not global mode; lookup/proof outages deny.
A selected tenant is never inferred or switched, even for a global administrator.
Vocabulary has no Product: null mode checks persisted global authority without
inventing a tenant or membership. Query/body tenant overrides fail; tenant headers
are ignored. Existing shape/idempotency admission precedes global Product lookup.

The new registered-module matrix covers vocabulary, document, context, initialize,
save, publish and discard: global/null success, selected confinement, ordinary and
tenant-wildcard boundaries, stale/inactive/missing/lookalike proof, outages, blank
identities, lookup failures and caller overrides. It uses synthetic authentication
and mocked persistence. Its business core is mocked and delegates real capability
checks: this proves routing/qualification, not transactional publication, CAS,
receipt replay or live database/JWT role semantics. Existing coordinated-write
HTTP tests retain initialize/save admission and invalid-document checks unchanged.
Private-media policy and all downstream business/transaction code are unchanged.
S56 authorizes550 authored lines for T48b only; later units retain400. No stored
permission, database, activation, deployment or push operation is authorized.
