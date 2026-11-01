# Global price-list creation coordination

`PriceListsService.create` validates tenant context and trimmed name first, then
joins the ambient transaction or opens one through `TenantPrismaService`.
It acquires the catalog lifecycle **SHARE ROW EXCLUSIVE** gate before the fresh
global-name lookup, insertion, product discovery and all child writes.

The namespace is global, but product lists and variant prices are initialized
**only for the selected tenant**. Explicit tenant predicates/data are retained.
Global/no-tenant creation remains rejected, including for a global administrator.
Existing endpoint permissions, trimming, duplicate errors, zero prices,
`hasVariants` filtering, unmatched-variant skipping and returned global row remain
unchanged. No controller, schema or shared factory changes are required.

The outer transaction owns completion: errors during any child initialization or
an outer abort roll back the global row and both child collections together.
There is no root pre-read or nested root transaction. An ambient caller must
already own exclusive lifecycle before earlier observations or row locks; never
upgrade an existing SHARE lock late. Order is lifecycle → Tenant when applicable
→ Product → children. Ambient isolation is preserved; fresh post-wait observations
assume Read Committed.

## Verification boundaries

Offline stateful tests cover gate ordering/waiting, fresh duplicate state,
validation precedence, selected-tenant matrices, branches, original errors and
ambient rollback. Synthetic storage is not PostgreSQL locking proof.

Five PostgreSQL schedules are authored in
`price-lists-delete-coordination.live.spec.ts`: addVariant-first, create-first
commit/rollback, and same-name creators in different selected tenants with first
commit/rollback. They use the real service operations, blocker/relation witnesses,
complete matrix observations and finally-release/drain. Existing `test:live`
discovers this suite; discovery does not execute it or authorize a database.

No PostgreSQL execution, service activation, browser readiness, complete E or
publication guarantees are claimed by this bounded unit.
