# Product price-list update coordination

`ProductsService.updatePriceList` joins the ambient tenant transaction without
requesting a new isolation level. It locks the tenant/product-qualified Product
before reading Product cost and the qualified PriceList. Validation, nested
price/tier replacement and response enrichment use that same transaction.

Missing Product takes precedence over missing PriceList and tier validation.
The existing price omission/zero behavior, tier omission/empty/replacement,
ascending thresholds, decimals and margin calculations are unchanged. Reads and
updates retain explicit tenant/product confinement; the repository Product read
uses its existing ambient client. No stock or alert mutation is introduced.

## Boundary

This operation cooperates at the Product gate. It does not acquire lifecycle or
Tenant gates afterward; ambient callers own their earlier lock order and
isolation. Fresh post-wait observation assumes normal Read Committed operation.
No retry, privilege, timeout or isolation-policy change is introduced.

Variant-price writers, mixed Product updates and global-list lifecycle still need
coordination. This leaf operation alone does not make E commit-stable, complete
publication or enable browser testing. Existing completed writers stay unchanged.

## Evidence

The focused offline spec checks separate root/transaction clients, SQL identity,
ordering, fresh cost, error precedence, tier validation, mutation failures and
price/tier responses. Mock transaction failures are not PostgreSQL rollback proof.
The existing service and variant coordination suites remain applicable.

Three appended opt-in live scenarios cover waiting/fresh cost with unrelated
Product progress, ambient price/tier rollback and release, and fresh not-found
after a cooperating deletion. These use explicit Product gates, not a V2 publisher
or a certified global-list lifecycle. They require separately authorized disposable
PostgreSQL execution and are excluded from offline Jest. No server, grants or
real stored data are changed by implementing this unit.
