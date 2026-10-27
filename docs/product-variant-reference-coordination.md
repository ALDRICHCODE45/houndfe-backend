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
