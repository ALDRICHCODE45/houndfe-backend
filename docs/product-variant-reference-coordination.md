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
3. **Stock inversion — reproduced deadlock.** `decrementStockForCharge` with the
   batch `[Variant adjustment, parent Product adjustment]` updates the Variant row,
   then the Product row; `removeVariant` takes the Product gate, then deletes the
   Variant. Forcing that interleaving, PostgreSQL detected the cycle (`40P01`) and
   aborted the removal; the charge committed (Variant and Product quantity 10 → 9)
   and membership/prices stayed intact. The test asserts exactly one rejection whose
   SQLSTATE is `40P01`, extracted from the engine error
   (`PrismaClientUnknownRequestError` → the structured `PostgresError { code: "40P01" }`
   fragment of its message), not from wording heuristics such as "deadlock"; the
   winner's persisted state is checked for either branch.
   The removal was the aborted side in every observed run (parent and verifier).

Limits. This proves the internal service route accepts a same-parent mixed batch and
that the interleaving deadlocks; it does NOT establish that upstream sale/charge
callers build such batches, how often the window occurs, or that callers retry.
PostgreSQL resolves the cycle by aborting one transaction, so no partial state was
observed. No production change is made here; ordering stock adjustments
Product-first, or retrying `40P01`, is a separate decision. External writers,
triggers and DDL remain out of scope.
