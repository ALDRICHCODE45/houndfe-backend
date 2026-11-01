# All-context offered subjects

`selectEditorialOfferedSubjectsV2` computes E from a complete observation of one
Product and every already-resolved available catalog context of its actual tenant.
It returns unique variant IDs, or `[null]` for an offered simple Product, preserving
input variant order. It never fabricates a base subject for a variant Product.

The caller establishes authorization, tenant/product/child ownership, referential
identity, valid persisted scalar types, complete collections and coherent reads.
This pure function neither proves those preconditions nor establishes SQL locks.
Variant prices reference their actual product-price-list row IDs.

No contexts, SERVICE or an excluded parent means no offered subjects. A visible
simple Product needs a positive price in an available, allowlisted context; an
empty allowlist permits all available contexts. A visible variant additionally
needs its own positive price linked to that same positive product-price row and
must not be OFF. Prices from different contexts cannot satisfy BOTH together.
Hidden-price and prescription Products bypass prices and allowlists, but never
parent, available-context or non-OFF membership gates.

Default-list identity/order, stock, search, category and pagination do not select
E. There is no legacy global-default fallback. Existing exact-context list/detail
semantics are preserved; cart reconciliation is not redefined by this function.

The offline tests cover union membership and input preservation. Transactional
observation, writer coverage, publication/receipt composition and public C3.3
remain separate; this module is not wired into HTTP or persistence yet.
