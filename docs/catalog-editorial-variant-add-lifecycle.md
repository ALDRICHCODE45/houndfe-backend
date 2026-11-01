# Variant creation lifecycle

`ProductsService.addVariant` acquires the catalog lifecycle SHARE lock on its
ambient transaction client before the tenant-qualified Product `FOR UPDATE` gate.
Product and price-list observations happen after the awaited lifecycle gate.
The real global price-list deletion endpoint acquires the conflicting exclusive
mode; unrelated shared participants can still progress before an exclusive waiter.

Creation, uniqueness checks, name/stock/cost normalization, zero-price fanout,
parent flag updates and complete response enrichment belong to the same callback.
A response-construction error therefore rolls back creation, prices and flags.
Existing successful responses and business validation remain unchanged. No shared
enrichment helper or completed writer is changed.

Ambient callers retain outer commit/rollback ownership across repeated calls.
They must already respect lifecycle → Tenant (when needed) → Product → children
before earlier observations or locks; never upgrade SHARE to exclusive late.
Fresh post-wait observations assume Read Committed; ambient isolation is retained.

## Evidence and limits

Offline tests cover exact gate ordering, suspension, fresh observations, full
responses, zero/one/multiple price lists, original errors, synthetic rollback and
repeated ambient ownership. These mocks are not PostgreSQL lock proof.

Five PostgreSQL schedules in `products-variant-coordination.live.spec.ts` are
**authored only**: real global deletion first (commit/rollback), and creation first
(outer commit/rollback/enrichment failure). They inspect backend/relation lock
witnesses, full persisted rows/responses, fanout, parent flags, tier cascades and
unrelated progress, and release checkpoints in `finally`.

No PostgreSQL execution, service activation, complete evaluation-set/publication
coverage, frontend/browser readiness or public catalog activation is established.
