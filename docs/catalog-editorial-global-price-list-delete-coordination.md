# Coordinated global price-list deletion

`PriceListsService.remove` joins an ambient transaction or starts one, acquires the exclusive catalog lifecycle gate, reads the global list afresh and deletes through that same client. Missing-list precedence, default PUBLICO protection, global/null-context behavior, the void result and HTTP 204 remain unchanged. No tenant predicate or tenant-context requirement is introduced.

## Lifecycle protocol

The gate is the existing `global_price_lists` relation, not an advisory hash/key. `lockCatalogLifecycle` uses `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE` for lifecycle mutation and `SHARE MODE` for matching context participants. Both modes last until transaction end. Relation identity avoids collisions with the application's existing advisory-lock namespaces; no schema or migration is required.

Acquire lifecycle → Tenant → Product → children. Choose the strongest required mode first: never upgrade shared to exclusive or acquire lifecycle after Product locks. Global deletion's mode conflicts with matching shared observers and other global-table writers, including ordinary create/rename DML. Ordinary SELECT remains compatible. This deliberate global serialization protects a cross-tenant operation, not just selected-tenant Products.

Fresh post-wait observations assume Read Committed. Ambient isolation and commit ownership remain caller-owned; this method does not silently replace them. A relation lock requires sufficient existing database privileges (`DELETE` suffices for the deleting role); future shared participants must also have suitable lock privileges. No grants, fallback, retry or runtime activation are added. See [PostgreSQL LOCK](https://www.postgresql.org/docs/current/sql-lock.html).

## Cascades and limits

Existing database cascades remain unchanged: Product price lists, Variant prices/tiers and tenant/Product catalog bindings are removed across tenants. An emptied Product allowlist still means all tenant-public lists; deleting the last entry can therefore widen eligibility in surviving contexts. No tombstones, replacement defaults or business-policy changes are introduced. Gate/read/delete failures propagate; an outer rollback restores the whole operation.

Only the deletion participant is integrated here. Existing Product-only writers do not yet acquire the matching lifecycle gate. This is not complete cooperating-writer coverage, stable E, publication or browser-readiness proof.

## Verification boundary

Focused tests pin ordering, exact SQL/global predicates, errors, fresh state, selected/null contexts, void results and ambient ownership/rollback. Existing sibling tests remain intact. Synthetic rollback is not PostgreSQL rollback proof.

The opt-in live suite authors shared/exclusive wait ordering, fresh disappearance/default protection, cross-tenant price/tier/binding cascades, last-allowlist removal and outer rollback/release. These five scenarios have not been executed for this unit. PostgreSQL execution and service activation require separate authorization.
