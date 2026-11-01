# Single variant-price upsert coordination

`ProductsService.upsertVariantPrice` joins the ambient transaction without
replacing isolation, or opens one when absent. Lifecycle SHARE precedes the
tenant-qualified Product gate and every Product/Variant/PriceList observation,
tier validation and write.
The result lookup and cost-based response construction finish before commit.
Result-read or enrichment failures therefore roll back price and tier changes.

Missing Product → Variant → PriceList errors precede tier validation. Same-tenant
ownership mismatches remain explicit; a foreign-tenant PriceList is now not-found,
not a disclosed ownership mismatch. PUBLICO remains upsertable. Zero prices and
zero Variant costs remain valid; only null Variant cost falls back to Product cost.
Omitted tiers retain, empty tiers clear and supplied tiers replace. Response
identities, names, decimals, ordering and margin calculations remain unchanged.

Lifecycle must precede caller-owned Tenant/Product/child locks. An ambient caller
already holding rows must own lifecycle first; a transaction also deleting a global
list must choose exclusive upfront, never upgrade shared to exclusive. Both gates
last through response enrichment and outer completion; repeated SHARE is no upgrade.
Fresh post-wait reads assume Read Committed; ambient isolation is unchanged.
The shared relation gate conflicts with global deletion and other global-list DML,
not ordinary SELECT. Existing privileges must permit SHARE; no grants are added.
Only single upsert changes here: bulk, GET, deletion and shared helpers stay unchanged.
This does not establish complete writer coverage or stable publication E.

Focused tests exercise transaction-only access and synthetic rollback. Five live
cases describe fresh costs, waiting through response reads, unrelated-Product
progress, ambient rollback and Variant/PriceList disappearance. They are authored
but **not executed** here. No PostgreSQL, service activation or browser-readiness
claim follows from these tests. Five additional authored-only lifecycle schedules
pair actual global deletion commit/rollback with fresh upsert results, hold exclusive
waiters through response/repeated upsert/outer commit or rollback, and inject a
result-read failure. They assert full responses, preserved omitted tiers, rollback
and release using backend-PID/relation-lock witnesses and finally drains.
