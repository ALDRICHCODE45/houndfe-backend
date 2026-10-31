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
This is not live database/JWT or browser proof, seven-family production admission,
provisioning, or document/write/publication integration. Incomplete stored metadata
must be reported, not silently repaired. The descriptor also retains its focused
header, secrecy, identity and interleaved-call tests.
