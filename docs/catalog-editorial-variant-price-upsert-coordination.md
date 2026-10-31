# Single variant-price upsert coordination

`ProductsService.upsertVariantPrice` joins the ambient transaction without
replacing isolation, or opens one when absent. The tenant-qualified Product gate
precedes Product, Variant and PriceList observations, tier validation and writes.
The result lookup and cost-based response construction finish before commit.
Result-read or enrichment failures therefore roll back price and tier changes.

Missing Product → Variant → PriceList errors precede tier validation. Same-tenant
ownership mismatches remain explicit; a foreign-tenant PriceList is now not-found,
not a disclosed ownership mismatch. PUBLICO remains upsertable. Zero prices and
zero Variant costs remain valid; only null Variant cost falls back to Product cost.
Omitted tiers retain, empty tiers clear and supplied tiers replace. Response
identities, names, decimals, ordering and margin calculations remain unchanged.

Callers own earlier lifecycle/Tenant locks and isolation. Fresh observations after
waiting assume Read Committed. This unit changes only the single upsert: bulk,
GET, deletion and shared helpers retain their implementations. It does not prove
complete writer coverage or stability of the publication evaluation set E.

Focused tests exercise transaction-only access and synthetic rollback. Five live
cases describe fresh costs, waiting through response reads, unrelated-Product
progress, ambient rollback and Variant/PriceList disappearance. They are authored
but **not executed** here. No PostgreSQL, service activation or browser-readiness
claim follows from these tests.
