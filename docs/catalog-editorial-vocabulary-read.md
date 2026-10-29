# Dormant editorial vocabulary read

`readEditorialVocabulary(source, version)` reads once and returns the existing historical V1 projection or historical V2 envelope. Callers must supply an explicitly validated `1 | 2`; invalid runtime versions reject before reading.

## Boundary

- The awaited source read is outside representation translation. Database rejection and malformed snapshot-adapter errors retain identity.
- V1 receives the exact snapshot and its errors pass through unchanged.
- V2 receives that same object. Only `EditorialVocabularyRepresentationError` becomes a new `EditorialVocabularyUnrepresentableError`, with message `EDITORIAL_VOCABULARY_UNREPRESENTABLE` and the original error in `cause`.
- S23/S29 failures reject the whole response: no metadata omission, version promotion, storage mutation or automatic adoption. Unexpected runtime and Unicode failures retain identity.

## Proof and limits

Tests compose the real `PrismaEditorialVocabularySnapshot` with real projectors over frozen raw storage-shaped fixtures. A mocked `$queryRaw` proves one query invocation and deterministic composition, not SQL execution or Prisma network decoding. The existing adapter uses one SQL statement; this function adds no snapshot-coherence guarantee beyond its source contract.

This is dormant: no controller, module, provider, default version, header negotiation or live-reader replacement. Generic empty/custom vocabularies remain allowed; no full-production gate is introduced. S27's future HTTP `{statusCode,error}` mapping belongs to a transport adapter/filter, not this function. No HTTP behavior or activation is implemented here.
