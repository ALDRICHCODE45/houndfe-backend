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

Existing V2 canonical guard catches are still broad and may translate unrelated
failures. This slice does **not** narrow them, implement S27's HTTP 500
`EDITORIAL_VOCABULARY_UNREPRESENTABLE` mapping, or integrate S23's whole-response
failure into the current reader. Those are dependent, separately reviewed work.
V1, validators, readers, HTTP behavior and V2 activation remain unchanged here.

## Verification boundary

Tests exercise both public functions with scalar and nested invalid inputs and
Proxy `ownKeys` failures (Error, TypeError, RangeError and a non-Error sentinel).
Unexpected values must propagate by identity without executing getters. These
reflection tests do not inject Buffer or crypto failures.
