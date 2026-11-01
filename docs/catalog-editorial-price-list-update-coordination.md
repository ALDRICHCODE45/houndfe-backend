# Product price-list update coordination

`ProductsService.updatePriceList` joins the ambient tenant transaction without
requesting a new isolation level. It acquires the catalog lifecycle SHARE lock
before the tenant/product-qualified Product lock, then reads Product cost and
the qualified PriceList. Validation, nested
price/tier replacement and response enrichment use that same transaction.

Missing Product takes precedence over missing PriceList and tier validation.
The existing price omission/zero behavior, tier omission/empty/replacement,
ascending thresholds, decimals and margin calculations are unchanged. Reads and
updates retain explicit tenant/product confinement; the repository Product read
uses its existing ambient client. No stock or alert mutation is introduced.

## Boundary

The shared lifecycle gate conflicts with global-list deletion's exclusive gate
and other DML on `global_price_lists`; ordinary SELECT remains compatible.
Both lifecycle and Product locks last until the outer transaction ends, including
response enrichment. Repeated shared acquisition is not a lock upgrade.

Ambient callers must acquire lifecycle before any earlier Tenant/Product/child
locks. A transaction also deleting a global list must choose exclusive upfront,
never upgrade this method's shared lock. Arbitrary earlier ambient locks are not
introspected. Fresh post-wait reads assume Read Committed; callers own isolation.
Existing database privileges must permit SHARE locking; no grants, retries,
timeouts or isolation-policy changes are introduced.

Only this endpoint now participates with global deletion. Other variant-price
writers, mixed Product updates and catalog settings still need coordination.
This is not complete writer coverage, stable union-E or publication/browser
readiness. Other completed writers remain unchanged.

## Evidence

The focused offline spec checks separate root/transaction clients, SQL identity,
ordering, deferred/failed lifecycle acquisition, repeated ambient ownership,
fresh cost, error precedence, tier validation, mutation failures and price/tier
responses. Mock transaction failures are not PostgreSQL rollback proof.
The existing service and variant coordination suites remain applicable.

Three appended opt-in live scenarios cover waiting/fresh cost with unrelated
Product progress, ambient price/tier rollback and release, and fresh not-found
after a cooperating deletion. These use explicit Product gates, not the global
lifecycle gate. Additional authored-only schedules exercise actual global
removal commit/rollback before the updater, and deletion waiting through mutation,
response and ambient rollback. They also cover different-Product shared progress
and repeated ambient acquisition with deletion queued. Backend PIDs and pending
relation-lock modes witness the wait, not elapsed time; actors drain in finally.
All live scenarios require separately authorized disposable PostgreSQL execution
and privilege validation and are excluded from offline Jest. None were executed
for this unit; no server, grants or real stored data were changed.
