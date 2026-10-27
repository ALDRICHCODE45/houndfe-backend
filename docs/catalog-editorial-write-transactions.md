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

Rollback boundary: remove this helper, optional constructor seam, focused config,
tests, and this document together; no domain contract or runtime wiring changes.
