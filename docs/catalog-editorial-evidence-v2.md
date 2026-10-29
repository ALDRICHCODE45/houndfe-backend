# Evidence V2: shape before fresh capture validation

This dormant domain API separates primitive wire shape from fresh capture bounds for T3d S2 ([wire §7](catalog-editorial-production-vocabulary-contract-proposal.md#7-values-numeric-inventory-and-historical-compatibility-b5), [facts §1](catalog-editorial-production-vocabulary-facts-contract.md#1-one-private-document-shape-w01)). It does not activate V2.

## Layered API

1. `parseEvidenceShapeV2(input: unknown): EvidenceV2` requires exactly the two own enumerable data keys `sourceRef` and `verifiedOn`, both primitive strings, on a plain or null-prototype object. Frozen objects are accepted. Arrays, hidden/symbol/extra keys, accessors and exotic prototypes are rejected without invoking getters.
2. The parser returns a detached ordinary literal preserving both strings exactly. Deliberate rejection throws `TypeError('Expected an evidence shape V2')`; unexpected reflection failures propagate unchanged, including TypeErrors and non-Error values.
3. Only for fresh capture, call `isFreshEvidenceV2(evidence: EvidenceV2): boolean` after parsing. This typed predicate does not clone, mutate or trim stored text.

Shape parsing intentionally accepts blank, overlong, control-containing and lone-surrogate strings and malformed date strings. Pre-receipt shape checks and historical/recorded results must not acquire fresh limits through this primitive parser. Shape parsing alone is not historical document recognition or complete admission.

## Fresh capture bounds

- `sourceRef`: 1–1000 Unicode code points, nonblank under ECMAScript `trim`, no unpaired surrogates, C0 controls U+0000–001F or DEL U+007F. Leading/trailing spaces are preserved; nonblank C1 controls and 1000 astral characters are allowed.
- `verifiedOn`: exactly ten ASCII characters `YYYY-MM-DD`, a real proleptic Gregorian date in years 0001–9999. Leap years use divisibility by 4, except centuries unless divisible by 400. No Date rollover or current-clock checks; future dates are allowed.

Neither function dereferences a locator, requires a URL, authenticates evidence, grants file access or approves legal compliance. No current metadata, evidence arrays, facts, care review, HTTP integration, expiry or recency policy is introduced. Existing helpers and readers remain unchanged.
