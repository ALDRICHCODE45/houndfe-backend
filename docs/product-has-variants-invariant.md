# Product PATCH: Variant membership guard

An explicit `hasVariants: false` update is rejected while the tenant-qualified
Product still has at least one Variant. Remove the Variants first, then retry
the update. This prevents a false flag (and parent stock) from diverging from
actual membership.

The rejection is a `BusinessRuleViolationError` with code
`PRODUCT_HAS_VARIANTS` and details `{ productId, variantCount }`. The existing
domain exception filter's default mapping returns HTTP **422**, including the
code; no filter mapping is added.

## Transaction and ordering

The check starts the existing persistence transaction, before price-list writes,
Product save, variant cascades, alert rearm, or ServiceDetail synchronization.
It locks the tenant-qualified Product row `FOR UPDATE`, then counts Variants by
both `tenantId` and `productId` using the same ambient transaction client. The
lock is held through commit. Add/remove Variant use this same Product gate, so
an add either commits before the count (and is detected) or waits until after
the update; it cannot insert between the count and save.

Existing pre-persistence validation retains precedence: allowlist shape and
bindings, Product lookup, stock-presentation validation, type-change rules,
SKU/barcode uniqueness, SAT validation, and tax/cost construction all still run
before this new check. A disappeared/unqualified Product at the gate yields the
existing Product-not-found error. Membership errors now precede persistence
failures, intentionally leaving no writes from the rejected update.

## Unchanged behavior and evidence limits

- Omitted `hasVariants` does not trigger this guard, even for legacy divergence.
- `hasVariants: true` with no Variants is still allowed.
- A final true flag still silently normalizes parent quantity to zero.
- A false flag with zero Variants still allows parent stock.

Offline unit tests cover rejection/code/details/no save, qualified locking and
count order, empty membership, unrelated edits, omitted flags, and normalization.
They are not live database contention or SQL rollback evidence. No data repair,
new endpoint, exception-filter change, or runtime activation is included.
