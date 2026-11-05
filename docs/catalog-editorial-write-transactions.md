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

## Invalid stored baseline recovery — Implemented: S1–S7

Fresh save validates the candidate strictly, including existing limits. Stored
draft/published selections share the same ordered reference/vocabulary locking
reads, but unresolved stored codes are not lockable and no longer deny the write.
Only a currently valid stored draft authorizes archived-option conservation;
an invalid draft is no baseline, not a source to repair or normalize. Save returns
the candidate as draft and Published exactly as stored, with warnings only from
valid conservation. Initialize copies an invalid Published unchanged and emits
no warnings from it; valid Published behavior is unchanged.

Only stored-document validation failures are recoverable. Authority and SQL
errors still propagate. Matching-receipt save/initialize take the original strict
recheck path. Product gate and lock order, idempotency, conflict precedence,
permissions, error envelope and GET are unchanged. Offline regressions cover
deleted variants, unresolved definitions, missing assets, unbound assignments,
archived conservation and replay rejection; no live database proof is claimed.

## Publish and discard transactions (V2)

Both are V2 writers in one ReadCommitted transaction; the legacy v1 path and
its `editorial-publish-discard.live.spec.ts` are removed.

Publish (`prisma-editorial-publish-writer.ts`): authority read + publish →
catalog lifecycle SHARE (`global_price_lists`) → actual Tenant `FOR SHARE` →
qualified Product `FOR UPDATE` → publish receipt lookup (same key + same intent
replays the recorded result and audit; other intent is `CONFLICT`) → state
`FOR UPDATE` with cycle/revision CAS (`CONFLICT`, also on Published-revision
overflow) → nine vocabulary tables `SHARE` → fresh R equals the pinned R
(`VOCABULARY_CHANGED`) → locked references and offered subjects E →
`assessSavedDraftV2` (shared with the readiness GET) → not ready:
`EditorialPublicationNotReadyError` (400 with `items`/`bySection`), nothing
written → `buildFreshCareAttestationV2` (care requires `review-v1`, others
forbid it) → `publishedDocument = draftDocument` (stored bytes), revision + 1,
Draft cleared, cycle kept → receipt with the private attestation. The lifecycle
→ Tenant → Product order is the one product writers use; save/discard take
Product first and no lifecycle/Tenant lock, so no cycle exists between them.

Discard (`prisma-editorial-discard-writer.ts`) is unchanged: Product lock,
receipt, state CAS, vocabulary SHARE and R pin; it never reads or validates the
discarded Draft.

`prisma-editorial-publish-writer.integration.spec.ts` (real PostgreSQL, real
production vocabulary) proves: per-family publish (food, treat, toy, hygiene,
accessory, care), every blocking problem as 400 with the readiness items and no
writes, care confirmation rules and the stored attestation, stale CAS, R
change, replay without state restoration, same-key conflict, independent
receipt namespaces, stale pairs after initialize, authority (read+publish
without update publishes; discard needs update; foreign tenant), discard of an
invalid Draft, publish vs save and vs discard serialized on the Product with
no deadlock, full rollback after a late receipt `P2010/23505`, vocabulary SHARE
locks held through validation, and that malformed documents never surface a
TypeError in save, readiness, publish or initialize (L5).

