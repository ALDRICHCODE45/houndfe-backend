# Variant update coordination

`ProductsService.updateVariant` joins `TenantPrismaService.runInTransaction`,
first acquires `LOCK TABLE "global_price_lists" IN SHARE MODE`, then locks the
tenant/product-qualified Product row with `FOR UPDATE` and reads the
Variant and parent stock flag through that transaction client. A missing parent
or qualified Variant retains the existing Variant-not-found error.

Merged stock-presentation validation, SKU/barcode exclusion checks, update and
conditional stock-alert rearm occur after those gates in the same transaction.
Full cost-response enrichment also runs inside its callback: a response-construction
failure propagates and rolls back the update and transactional rearm. The shared
response helper remains unchanged; no production failure-injection hook is added.
The method applies this ordering to every edit, including mixed catalog/stock
updates, rather than having a catalog-only path. Existing DTO normalization,
name selection, cost response, omitted fields and rearm conditions are retained.
Uniqueness repository calls use the existing ambient client; this change does
not introduce tenant-wide uniqueness locks or replace database constraints.

## Coordination boundary

The Product gate cooperates with editorial and variant-membership writers.
It prevents this writer from changing eligibility while a cooperating observer
holds the same gate and ensures merged validation observes post-wait state under
normal Read Committed operation. Ambient transactions are joined, not replaced;
callers must already own lifecycle before earlier Tenant/Product/child locks or
dependent observations. Choose exclusive upfront if global-list deletion is intended;
never upgrade SHARE to exclusive. Repeated ambient calls retain the outer owner.
The existing isolation level is preserved.
No stronger isolation, retries, timeouts or database privileges are introduced.

The shared relation gate pairs with actual `PriceListsService.remove` exclusive
lifecycle acquisition. Deletion first leaves the Variant available for a fresh
update; update first retains lifecycle through its response and outer completion.
Ordinary SELECT remains compatible; global-table DML conflicts with SHARE.

This closes only variant-update lifecycle participation and response ownership.
Remaining writers, binding/settings, complete E observation and publication
remain separate work. This is not proof of commit-stable E or browser readiness.

## Verification boundary

`products-variant-update-coordination.spec.ts` checks SQL qualification, ordering,
fresh reads, no-write rejection, failure propagation and retained behavior with
separate mocked root/transaction clients. Existing product service tests remain.
Mocks prove transaction participation, not PostgreSQL waiting or rollback.
Lifecycle wait/failure, fresh reads, repeated ambient calls, and enrichment failure
assert full synthetic state and rearm restoration as well as response/error identity.

Three additional opt-in scenarios in `products-variant-coordination.live.spec.ts`
cover a held Product gate with post-wait observation and an unrelated Product,
ambient rollback/gate release, and update/remove serialization. They use an
explicit Product gate, not a V2 publication fixture. They require separately
authorized disposable PostgreSQL execution; offline tests never execute them.
Five additional authored-only lifecycle schedules use real global deletion,
commit/rollback, exact backend/relation lock witnesses, response construction failure,
repeated calls and outer completion. They compare full Variant responses and stored
state, membership and price/tier cascades, then prove subsequent progress. Non-stock
live updates do not claim real alert-rearm coverage; that remains offline here.
No PostgreSQL scenarios were executed for this unit.
No production data, grants, services or public APIs are activated by this unit.
