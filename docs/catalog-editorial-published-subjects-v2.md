# Published subjects (P4 S5)

A Published editorial version covers the offered subjects E that publish
evaluated. A variant that becomes offered after that publish stays hidden from
the public catalog until the product is republished (D5 a); covered variants
keep showing.

## Storage

`catalog_editorial_states."publishedSubjects" JSONB NULL`
(migration `20261105020000_catalog_editorial_published_subjects`).

| Value                  | Meaning                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `["<variantId>", ...]` | Variants the current Published covers (E order: variant id asc) |
| `[null]`               | The simple-product presentation is covered                      |
| `[]`                   | Published covers no subject (E was empty at publish)            |
| `NULL`, Published set  | Not recorded: covers every subject                              |
| `NULL`, no Published   | Nothing published: covers nothing                               |

SQL CHECK `catalog_editorial_states_published_subjects_check`: a recording
requires a Published revision and must be a JSON array. Writers: publish
records E in the same transaction as the Published copy; unpublish clears it
with Published. Receipt replay never rewrites it.

## Existing published rows (safe default)

The migration backfills every row that already had a Published revision with
every subject the product has at migration time: all its variant ids when
`hasVariants`, otherwise `[null]`. This is a superset of the subjects offered
then, so nothing visible before the migration is hidden by it; offering rules
still apply on top in the public catalog. Variants created after the migration
are hidden until the next publish. Rows written later without a recording
(test fixtures, direct SQL) stay `NULL` and cover every subject.

## Reader

`readEditorialPublishedCoverageV2(db, tenantId, productIds)`
(`src/catalog-editorial/infrastructure/prisma-editorial-published-coverage-v2.ts`)
returns a `Map<productId, { publishedRevision, subjects }>` holding only products
with a Published version. It is explicitly tenant-qualified, lock-free and one
query. Answer «is subject X covered by the current Published revision?» with
`coversPublishedSubjectV2(map.get(productId), variantId | null)`
(`src/catalog-editorial/domain/editorial-published-subjects-v2.ts`): `false`
when there is no Published version. A malformed stored recording throws a
`TypeError`; it is never treated as covered.

Proof: `prisma-editorial-published-coverage-v2.integration.spec.ts` (reader,
tenant scope, CHECK, and the migration backfill statement run and rolled back).
