# Product-first variant membership

## U3 — S3, bounded by S1/S5/S6

`ProductsService.addVariant` joins or opens `TenantPrismaService.runInTransaction`.
Its first database operation locks the qualified `products` row by tenant and
Product ID with `FOR UPDATE`, matching the editorial Product gate. Only then
are Product facts and SKU/barcode availability read through existing repository
helpers, whose `getClient()` resolves the ambient transaction. Variant creation,
zero-price initialization and conditional Product flag updates use that same
client. Missing Product and uniqueness errors, naming, stock normalization,
INHERIT/null overrides and cost response enrichment retain their existing rules.
`hasVariants` controls the existing flag update only, never membership existence.

## Evidence and limits

The focused offline config includes the new public-method coordination regression
and existing ProductsService unit tests; it enables ts-jest diagnostics and disables
Jest caching. The new fixture models staged versus committed effects, checking
unchanged persistence on rejected checks and a late write failure. This proves
service ordering/client use against mocks, **not PostgreSQL locking or rollback**.
No live database, transport/bootstrap or external service is invoked. A focused
ts-jest pass is not a global TypeScript or ESLint claim.

Rollback boundary: revert only this unit's addVariant changes, its fixture
adaptations, focused test/config and this document. No editorial-file dependency
is introduced. U4 below adds atomic removal separately; T4 SQL
concurrency/rollback proof still requires separate authorization.
No new endpoint, response/status contract or runtime activation is included.

## U4 — S3/S5 atomic removal (T2, formerly T3)

`removeVariant` captures tenant/Product/Variant identifiers and joins or opens the
existing ambient transaction. The qualified Product `FOR UPDATE` gate precedes
Variant observation. Qualified Variant read, single-row delete, remaining-count
read and last-Variant Product flag update all use one captured transaction client;
there is no root Product update. Non-last removal leaves flags unchanged. Success
remains void; an empty Product gate or missing qualified Variant retains
`EntityNotFoundError('Variant', variantId)`. SQL and late failures propagate without
retry. Intentional observable change: deletion and flag maintenance fail atomically.

The removal fixture checks gate ordering/parameters, explicit predicates, last and
non-last effects, error precedence, no root writes and modeled rollback on late
count/flag failure. Existing service and U3 addition regressions remain included.
Fixture effects are not real SQL rollback or concurrency proof: T4 must establish
cross-route behavior, including potential stock-path lock interactions. No stock,
sales, global transaction service, HTTP transport or production activation changes.

U4 rollback boundary: only the `removeVariant` hunk, removal fixture adaptations,
new removal spec, its config entry and this U4 documentation; retain accepted U3.
Risk item 4 / consumed-contract item 3 require parent independent verification.

## Live evidence (U7, T4)

`src/products/products-variant-coordination.live.spec.ts` runs against the
disposable PostgreSQL 16 target through the live config
(`docs/catalog-editorial-coordination-postgres.md`), with real `ProductsService`,
`PrismaProductRepository`, `TenantPrismaService` and CLS. Each actor owns one
connection. A test-only Prisma query extension on that actor's client pauses one
statement before it is sent; pausing between two statements of one transaction takes
and releases no lock, so it only fixes an interleaving the scheduler could produce.
Witnesses are `pg_blocking_pids` edges and persisted readbacks, not timing.

1. **Membership gate.** While an actual coordinated editorial create is paused just
   before its state INSERT (Product gate and reference locks held), `removeVariant`
   waits on the editorial backend and `addVariant` waits behind it (PostgreSQL may
   report the second waiter as blocked by the first queued waiter's tuple lock).
   A removal on another Product completes while the gate is held. After release the
   draft commits, both membership writers complete, the Product keeps exactly the
   added Variant with `hasVariants = true`, its price row is initialized at 0 for the
   Product's price list, and the removed Variant's prices are gone.
2. **Late rollback.** `addVariant` fails after its Variant INSERT executed (witness:
   `RowExclusiveLock` on `variants` held by its backend); the failure is injected at
   the client boundary before `variantPrice.createMany`. Readback: only the seeded
   Variant, unchanged flags, one tenant price row; the Product gate is released.
   No database-native late failure exists here: `variants` has no unique SKU/barcode
   index (uniqueness is the application `isSkuTaken`/`isBarcodeTaken` check).
3. **Stock inversion — fixed for charges (T8a).** RED reproduced `40P01` against
   removal with `[Variant, parent Product]`; GREEN commits both, removal waiting on
   the charge's Product gate. The pause remains before the Product UPDATE: formerly
   after the Variant UPDATE, now before the first stock UPDATE. Readback: parent
   quantity 9, no Variants or removed-Variant prices, `hasVariants = false`.

Precondition caveat. The test still forces parent `quantity = 10` (`useStock` true)
with Variants. The old cycle needed the guarded parent UPDATE to match; quantity 0
would avoid that wait (inference, not separately tested). T7 found this state
reachable through cancellation/restock of an old parent sale after adding Variants;
PATCH can also diverge flags and membership. It is not an unreachable invariant.

Charges and restocks now lock distinct qualified parents in one ascending-id sequence: UPDATE
for parent-row adjustments, KEY SHARE for Variant-only parents. Mixed modes cannot
be split into two ordered groups without risking inversion. KEY SHARE protects
membership without serializing sibling Variant charges. Stock and alert/outbox keys
then follow Product id, parent row first, Variant id; crossings retain input order.
The live spec proves opposite-order charges commit (exact quantities 8/8), and
sibling charges finish while one is paused holding locks, with no observed blockers.

T8b reuses the unchanged lock helper for restocks, including deterministic rearm
ordering. RED reproduced exact SQLSTATE `40P01` for opposite-order restocks and a
Variant-first mixed restock versus a parent-first mixed charge. GREEN commits both
actors in each case: opposite restocks persist 12/12; mixed restock (+2) then charge
(-1) persists parent and Variant quantities 11/11. Each witness pauses after the
first stock UPDATE and observes the second backend waiting before release.
Restock still skips nonpositive/no-match entries, guards Product `useStock`, and
rearms only strictly above the minimum; no crossing/outbox contract changes.

Ordering convention: the helper uses JavaScript code-unit string comparison (`<`
and `>`), not locale/collation order. Future multi-Product lockers must use this
same ordering. These live cases exercise stock-row contention and real rearm calls,
not competing alert-state rows or alert-contention behavior. Restock into a
now-variant parent, bot parent+variant validation, and PATCH flag/member divergence
remain open product decisions. No retry policy, HTTP/runtime activation,
external-writer, trigger or DDL guarantee is introduced.
