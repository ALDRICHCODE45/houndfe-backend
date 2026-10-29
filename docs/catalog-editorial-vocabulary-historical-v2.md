# Materialize complete V2 responses without rewriting metadata

`materializeHistoricalVocabularyResponseV2(unknown)` is a dormant pure boundary. It returns the canonical `{contractVersion:2,vocabularyRevision,vocabulary}` envelope or fails the entire call. No reader, HTTP handler, SQL or stored data changes.

## Composition (S35/S36 supersedes S29 declaration classification)

1. Materialize the complete stored root through `materializeStoredVocabularyV2`, including generic shape, uniqueness, reference and policy checks.
2. After generic checks pass, delegate to `createVocabularyResponseV2`. Its repeated generic validation is intentional; it owns canonical UTF-8 ordering, detached output and the exact hash preimage `{contractVersion:2,vocabulary}`.

The stored family minimum-version column is omitted from the DTO and R. Range, resolved numeric metadata and nonpending policies remain subject to generic semantic checks, not storage-version classification. S23 still rejects the whole response for unrepresentable metadata; no pruning, omission or storage rewriting occurs. Originally unbound advanced definitions and empty/custom subsets remain representable. There is no seven-family/full-production gate or historical graph round-trip.

Submitted strings and semantic metadata survive unchanged; canonical ordering never sorts stored input. All delegated errors propagate unchanged, including Unicode runtime/dependency failures: this composition has no catch-all representation-error conversion.

## Future integration

Raw structural validity does **not** certify complete/coherent SQL observation provenance; the caller must establish it. Success does not authorize adoption, publication, write stability or V2 activation. V1 remains unchanged.

S27 approves future transport failure as HTTP 500 `EDITORIAL_VOCABULARY_UNREPRESENTABLE` with the existing `{statusCode,error}` body. That HTTP mapping is **not yet implemented** here; domain/dependency errors retain their original identity.
