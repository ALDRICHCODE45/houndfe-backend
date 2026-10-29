# Canonical JSON invalid-tree errors

`canonicalEditorialJson` and `hashEditorialJson` now reject intentionally invalid
JSON data trees with exported `CanonicalEditorialJsonError extends TypeError`.
This is a prerequisite for precise error classification, not V2 transport wiring.

## Compatibility contract

- The constructor takes no message argument. Its fixed message remains exactly
  `Expected a finite, acyclic JSON data tree`.
- `error.name` remains `TypeError`; `error instanceof TypeError` remains true.
  Consumers can distinguish intentional rejection using
  `error instanceof CanonicalEditorialJsonError`, not a message comparison.
- Accepted inputs, UTF-8 bytes, key ordering, array order, hashes and no-mutation
  behavior are unchanged. Existing literal byte/hash vectors remain pinned.
- Only the shared serializer's intentional `invalid()` throw changes. Unexpected
  thrown values from reflection, Buffer or crypto are not caught or wrapped.
  A runtime TypeError, even with the same message, is not reclassified.

## Remaining limitation

The eleven V2 read-chain guards now translate only this deliberate rejection
into `EditorialVocabularyRepresentationError`; unexpected failures propagate
unchanged. See [the covered boundary](catalog-editorial-vocabulary-representation-errors.md).
S27's HTTP 500 `EDITORIAL_VOCABULARY_UNREPRESENTABLE` mapping and current-reader
integration remain unimplemented. V1, HTTP behavior and V2 activation are unchanged.

## Verification boundary

Tests exercise both public functions with scalar and nested invalid inputs and
Proxy `ownKeys` failures (Error, TypeError, RangeError and a non-Error sentinel).
Unexpected values must propagate by identity without executing getters. These
reflection tests do not inject Buffer or crypto failures.
