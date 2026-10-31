# Variant update coordination

`ProductsService.updateVariant` joins `TenantPrismaService.runInTransaction`,
locks the tenant/product-qualified Product row with `FOR UPDATE`, then reads the
Variant and parent stock flag through that transaction client. A missing parent
or qualified Variant retains the existing Variant-not-found error.

Merged stock-presentation validation, SKU/barcode exclusion checks, update and
conditional stock-alert rearm now occur after that gate in the same transaction.
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
callers remain responsible for their earlier lock order and isolation level.
No stronger isolation, retries, timeouts or database privileges are introduced.

This closes only variant-update coordination. Price writers, binding/settings
and global-list lifecycle coordination, complete E observation and publication
remain separate work. This is not proof of commit-stable E or browser readiness.

## Verification boundary

`products-variant-update-coordination.spec.ts` checks SQL qualification, ordering,
fresh reads, no-write rejection, failure propagation and retained behavior with
separate mocked root/transaction clients. Existing product service tests remain.
Mocks prove transaction participation, not PostgreSQL waiting or rollback.

Three additional opt-in scenarios in `products-variant-coordination.live.spec.ts`
cover a held Product gate with post-wait observation and an unrelated Product,
ambient rollback/gate release, and update/remove serialization. They use an
explicit Product gate, not a V2 publication fixture. They require separately
authorized disposable PostgreSQL execution; offline tests never execute them.
No production data, grants, services or public APIs are activated by this unit.
