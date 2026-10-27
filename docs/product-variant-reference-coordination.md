# Product-first variant addition

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
is introduced. Next dependencies are parent seam/independent verification, T3
atomic removal and a separately authorized T4 SQL concurrency/rollback proof.
No new endpoint, response/status contract or runtime activation is included.
