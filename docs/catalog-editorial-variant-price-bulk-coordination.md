# Coordinated bulk variant-price upsert

`ProductsService.bulkUpsertVariantPrices` joins the ambient transaction or owns a new one. It first acquires the shared catalog lifecycle gate (`LOCK TABLE "global_price_lists" IN SHARE MODE`), then locks the tenant-qualified Product before fresh Product/Variant reads, requested PriceList lookup, validation, writes and the full response.

## Preserved behavior

- Missing unique IDs are reported in first-request order before product mismatch; all tier validation finishes before any write, even for overwritten duplicate items.
- Original item order is retained. Duplicate items are not collapsed. Omitted tiers preserve, empty tiers clear, and supplied tiers replace.
- PUBLICO remains writable. Empty input still reads all visible prices; untouched lists remain in the response. Existing list-name/tier-threshold sorting, decimals and zero/null cost and margin rules are unchanged.
- The ordinary two-argument `getVariantPrices` retains its original root collection query and behavior. Only the explicit internal transaction/tenant scope selects the coordinated response read.

## Atomicity and scope

Requested lists, tier deletions and response rows are tenant-qualified. Invisible requested lists report `ENTITY_NOT_FOUND`; visible lists belonging to another Product retain `PRICE_LIST_PRODUCT_MISMATCH`. Post-write Product/Variant rereads, collection reads and enrichment remain inside the transaction: their failures roll back the complete batch, including inserted rows and replaced tiers. Ambient ownership is retained; a later outer failure rolls everything back.

## Lifecycle and ambient callers

The shared gate pairs with exclusive lifecycle acquisition in `PriceListsService.remove`. A deletion that finishes first is observed by fresh requested-list reads; a deletion queued afterward waits through every mutation, complete collection read, enrichment and outer transaction completion. Empty batches also acquire the gate. Repeated ambient calls retain the same owner and may reacquire SHARE.

Ambient callers must acquire lifecycle before any earlier Tenant/Product/child locks or dependent observations. Choose exclusive upfront when global deletion is intended; never upgrade shared to exclusive. Propagate participant failures and abort the enclosing transaction rather than swallowing errors and committing earlier writes. No first-time acquisition is added to repositories, lookup helpers or ordinary GET.

Existing ambient isolation is preserved; fresh post-wait observations assume Read Committed. Participants need existing privileges for the relation lock; no grants are added. SHARE conflicts with global-table DML, while ordinary SELECT remains compatible. This does not establish complete E, publication or cooperation by all other writers.

## Evidence boundary

The focused map-backed suite observes transaction ordering, exact predicates, full responses, persisted multi-list effects, duplicate/tier semantics, rejection precedence, late failures and ordinary GET preservation. Synthetic rollback is not PostgreSQL rollback proof.

The live suite authors lock-wait/fresh-cost/unrelated-Product, multi-list full-response waiter, later-item/response/ambient rollback and Variant/PriceList disappearance scenarios. Five additional lifecycle schedules pair real global deletion commit/rollback with multi-list bulk writes, repeated calls, outer commit/rollback and collection-read failure. They witness backend PIDs and exact relation lock modes, check unrelated shared progress before the exclusive queue, full responses, inserted/untouched rows and tier identities, and drain every actor. These require separately authorized isolated PostgreSQL execution; they have not been executed for this unit. No running service, deployment, database permissions or operational data is changed.
