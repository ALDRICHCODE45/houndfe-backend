# Variant-removal lifecycle coordination

`ProductsService.removeVariant` joins the ambient transaction or owns a new one. It acquires `LOCK TABLE "global_price_lists" IN SHARE MODE` before the qualified Product `FOR UPDATE`, Variant lookup/deletion, remaining-member count and final `hasVariants` update.

## Preserved endpoint behavior

- Missing or foreign-qualified Product/Variant remains `ENTITY_NOT_FOUND` for Variant; no Product existence is disclosed.
- Successful removal returns `undefined` (the existing controller returns HTTP 204). Last-member removal clears `hasVariants`; sibling membership preserves it.
- Read, delete, count, flag and transaction-completion failures propagate. There is no postcommit response enrichment to move or add.
- Variant price/tier descendants retain their existing database cascade behavior. Global-list deletion does not delete the Variant itself.

## Lock order and ambient ownership

Actual `PriceListsService.remove` acquires the exclusive lifecycle mode. If it runs first, Variant removal waits before Product access; if removal runs first, global deletion waits through the void result and outer transaction completion. Repeated shared acquisition is allowed.

Ambient callers must already own lifecycle before any earlier Tenant/Product/child locks or dependent observations. Choose exclusive upfront if the transaction will delete a global list; never upgrade SHARE to exclusive. Preserve ambient isolation; fresh post-wait observations assume Read Committed. No late first-time lock is added to repositories or lookup helpers. No grants are changed; existing lock privileges are required.

## Evidence limits

Offline tests pin exact SQL/order, waiting, qualified effects, original errors, transaction-completion rejection and outer rollback. Synthetic persistence is not PostgreSQL proof.

Four authored-only PostgreSQL schedules pair actual global deletion commit/rollback and removal outer commit/rollback, witness exact PID/relation lock modes, check unrelated shared progress before the exclusive queue, and verify membership, Product flags and descendant restoration/deletion. They require separate authorization to execute. No runtime activation, complete E/publication claim or coverage of all other writers follows from this unit.
