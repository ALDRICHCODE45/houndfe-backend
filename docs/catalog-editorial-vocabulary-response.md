# Registered vocabulary response

`GET /catalog-editorial/vocabulary` authorizes the current principal, then uses
`PrismaEditorialVocabularySnapshot` and `createEditorialVocabularyHttpResponse`.
The single SQL observation supplies stored metadata, families, bindings and
complete definitions to the existing materializers and canonical hasher. The old
bare vocabulary reader is not used by this endpoint; no starter defaults are added.

## Response contract

- Success returns `{contractVersion:2,vocabularyRevision,vocabulary}` with matching
  `Editorial-Vocabulary-Revision`, `Editorial-Contract-Version: 2` and no-store.
- Any occurrence of the five prohibited request headers fails with 400 MALFORMED
  before snapshot access. Authentication and persisted editorial authority run first.
- `vocabulary.definitions[].description` is optional es-MX help text for the store
  user (one line, at most 200 characters; the shipped production texts stay within
  160). It is **omitted, never `null`**, for definitions without one, so a vocabulary
  with no descriptions is byte-identical to the previous response. Example:
  `{"id":"…","code":"text.clinical_analysis","label":"Análisis clínico","type":"text","description":"Análisis de la etiqueta del fabricante (proteína, grasa, fibra…). Interno, no se publica."}`.
  Clients must treat it as optional and show it only when present.
- **The revision does not cover descriptions.** `vocabularyRevision` is the digest of
  the vocabulary without them; descriptions are attached to the body only after the
  digest is computed, so adding, editing or removing one never changes the revision,
  the `Editorial-Vocabulary-Revision` header, the raw snapshot or the install
  before-image. Consequence: a client caching by revision may keep showing stale help
  text until it reloads the vocabulary, and the body can no longer be re-hashed
  field-for-field by a client that includes `description`; strip it first.
- **Form sections (presentation metadata, pure code).** Each production family
  (`food`, `treat`, `toy`, `hygiene`, `accessory`, `habitat`, `care`) may carry
  `vocabulary.families[].sections: [{code,label,sortOrder}]`, and each of its
  bindings `sectionCode` and `sectionSortOrder` (0-based position inside the
  section). `sectionSortOrder` is used because `bindings[].sortOrder` already
  exists (binding order) and is unchanged. Labels are es-MX sentence case; codes are
  stable kebab-case and mean the same in every family (`para-quien`, `que-es`,
  `caracteristicas`, `formula`, `medidas-ajuste`, `medidas`, `equipo-electrico`,
  `contenido-empaque`, `uso`). Section `sortOrder` is the section's fixed position
  in its family and may have gaps: only sections with at least one bound definition
  are listed. Keys are **omitted, never `null`**, for non-production (starter)
  families and for bindings outside every section; clients show those under their
  own fallback group. Example:
  `{"code":"food","label":"Alimento","sections":[{"code":"para-quien","label":"Para quién","sortOrder":0},…],"bindings":[{"definitionCode":"animal.target","sortOrder":0,…,"sectionCode":"para-quien","sectionSortOrder":0},…]}`.
  The map lives in `src/catalog-editorial/domain/editorial-production-vocabulary-sections.ts`;
  nothing is stored, so no migration, seed or apply command exists or is needed.
- **The revision does not cover sections either.** Like descriptions, they are
  attached after the digest; strip `sections`, `sectionCode` and `sectionSortOrder`
  before re-hashing the body.
- Missing semantic metadata or unrepresentable content fails the whole response
  with 500 EDITORIAL_VOCABULARY_UNREPRESENTABLE. Unexpected read failures return
  500 INTERNAL_ERROR, without messages, causes, partial metadata or revision headers.
- Descriptor errors contain exactly `{statusCode,error}` and retain no-store and
  the informational version header. Shared guard/filter errors and CORS exposure
  are separate integration work, not established by this vocabulary unit.
- Global/null administrators require persisted active/global proof; selected tenant
  authority and ordinary exact grants remain unchanged. No stored grants are changed.

## Proof limits

Registered-module tests retain actual authority, snapshot adapter, materializers,
canonical hashing and response composition, substituting only Prisma I/O and JWT
authentication. An independent JSON/crypto oracle checks the fixture digest.
Existing authority tests retain tenant boundaries, ordering, archives and null units.
Description handling has its own real-PostgreSQL proof
(`prisma-editorial-vocabulary-description.integration.spec.ts`, opt-in like the
snapshot proof): pre-migration definition rows, raw snapshot sha256 and revision are
unchanged by the column and by filling it, and the HTTP projection exposes it.
**Rollout: run `prisma migrate deploy` BEFORE deploying the new code.** The snapshot
statement selects `editorial_definitions.description`, so new code against an
unmigrated database fails every vocabulary read and the editorial write paths that
share it. Older code against a migrated database keeps serving the same revision (it
ignores the column), but its raw snapshot gains a `description` key, so do not run the
old production-vocabulary installer after migrating. To fill existing rows run
`pnpm seed:editorial-descriptions` (sets only NULL descriptions; idempotent; never
overwrites a customized one; later edits to the shipped text do not propagate).
This is not live database/JWT or browser proof, seven-family production admission,
provisioning, or document/write/publication integration. Incomplete stored metadata
must be reported, not silently repaired. The descriptor also retains its focused
header, secrecy, identity and interleaved-call tests.
