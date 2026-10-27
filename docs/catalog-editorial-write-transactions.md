# Editorial write transaction seam (S2 / U1)

`PrismaCatalogEditorial` accepts an optional fifth constructor argument,
`EditorialWriteAuthorityFactory`. Each create, initialize, or save attempt that
reaches its transaction callback constructs authority once using that callback's
actual Prisma transaction client. A supplied factory that throws, rejects, or
returns null denies access; legacy authorities are never a fallback.

`createPrismaEditorialWriteAuthority(tx, documentProviderFactory)` composes the
existing `PrismaEditorialAuthority`: exact read/update capabilities and captured
actor/tenant/Product qualification are checked first. A tenant-qualified Product
`FOR UPDATE` gate then precedes document-provider construction and resolution.
Returned document authority still undergoes qualification and `structuredClone`.
The core's existing second Product gate remains in the same transaction.

Omitting the fifth argument preserves trusted noncoordinated fixtures. Read uses
only its existing authority. No runtime/module/HTTP activation is included.

Offline callback-client tests cover client binding, port selection, ordering,
denials with unchanged fake state/receipts, and compatibility. Existing authority
regressions remain included. These are not SQL concurrency or rollback proofs;
no reference SQL reader, membership serialization, atomic permission revocation,
postcommit integrity, or broader historical replay guarantee is established.
T2 must supply the real transaction-bound reference reader; runtime composition
and separately authorized SQL verification remain later dependencies.

U1 rollback boundary: remove its helper, optional constructor seam, focused config,
tests, and documentation together; retain subsequent units when reverting them separately.

## U2b1: preparation at validation boundaries

The optional factory result may supply `prepareDocuments`, bound to its transaction.
It receives recursively frozen, detached scope/documents/prior authority and a
`create`, `create-replay`, or `stored` mode. The factory still receives only `tx`.
Returned authority is qualification-checked and cloned; null/invalid results deny,
and callback rejection propagates without fallback or persistence effects.

Prepared create acquires the core Product gate before candidate preparation.
Legacy ordering is unchanged. Create replay prepares only its draft, not unrelated
published history. Save/initialize prepare candidate/draft/published documents after
existing receipt/revision conflict selection and stored-envelope checks. Existing
strict validation and conservation rules remain authoritative.

Offline tests pin these boundaries, caller mutation, denial/no-effects, and legacy
compatibility. U2b2 composition is described in [reference locks](catalog-editorial-reference-locks.md);
this callback alone supplies no SQL, authorization, rollback, or concurrency proof. H1 and public
core method signatures are unchanged. Revert only U2b1 callback/types, invocation
sites, added tests and this section; preserve accepted U1/U2a/U3/U4.

## Fresh-save document limits

After matching-receipt replay and stale-state checks, save validates only the
caller's candidate against title ≤ 200 Unicode code points, description ≤ 20 000
code points, mediaRefs ≤ 20 entries, and values ≤ 200 entries. Astral characters
count once; combining marks count separately. Nothing is trimmed or normalized.
An excess throws `Error('MALFORMED')` before state or receipt writes.

Precedence stays request shape → authorization → key/revision syntax → Product
lookup → receipt replay/mismatch → state `CONFLICT` → document validation (including
limits). Thus stale state wins over an over-limit candidate. Limits never apply
to GET, recorded replay acknowledgements, stored baselines, initialize's Published
copy, or internal create. An oversized initialized draft must be reduced to save.
Offline core tests cover exact boundaries, code points, no-write rejection,
historical replay, initialize, and unchanged internal create; these are not SQL
rollback or concurrency proofs.
