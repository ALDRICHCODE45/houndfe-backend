# Reject contradictory historical V2 responses without rewriting metadata

`materializeHistoricalVocabularyResponseV2(unknown)` is a dormant pure boundary. It returns the canonical `{contractVersion:2,vocabularyRevision,vocabulary}` envelope or fails the entire call. No reader, HTTP handler, SQL or stored data changes.

## Composition and declaration truth

1. Materialize the complete stored root through `materializeStoredVocabularyV2`, including generic shape, uniqueness, reference and policy checks.
2. Index the validated definitions by actual ID and call `assertFamilyLegacyCompatibilityV2` for **every** family, including families sharing definitions.
3. Only after all gates pass, delegate to `createVocabularyResponseV2`. Its repeated generic validation is intentional; it owns canonical UTF-8 ordering, detached output and the exact hash preimage `{contractVersion:2,vocabulary}`.

S23/S29 reject declared V1 families containing range, resolved numeric metadata or any nonpending binding policy. No automatic promotion, pruning, omission or rewriting occurs. Pending legacy families, declared V2 advanced metadata, originally unbound advanced definitions and empty/custom subsets remain representable. There is no seven-family/full-production gate or historical graph round-trip.

Submitted strings and semantic metadata survive unchanged; canonical ordering never sorts stored input. All delegated errors propagate unchanged, including Unicode runtime/dependency failures: this composition has no catch-all representation-error conversion.

## Future integration

Raw structural validity does **not** certify complete/coherent SQL observation provenance; the caller must establish it. Success does not authorize adoption, publication, write stability or V2 activation. V1 remains unchanged.

S27 approves future transport failure as HTTP 500 `EDITORIAL_VOCABULARY_UNREPRESENTABLE` with the existing `{statusCode,error}` body. That HTTP mapping is **not yet implemented** here; domain/dependency errors retain their original identity.
