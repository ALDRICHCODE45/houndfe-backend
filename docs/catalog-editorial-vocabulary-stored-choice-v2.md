# Materialize stored choice rows without losing semantics

`materializeStoredChoiceDefinitionV2(unknown)` is a dormant, pure leaf boundary for raw snapshot `single`/`multi` definitions (T3c S2/S23/S27).

## Review path

- Require raw identity fields, all choice arrays, empty `units`, and present null `numericPolicy`.
- Check exact option/group types and all definition/member parents before explicit wire-field copying.
- Convert own `archivedAt: null|string` by nullness only; even an empty string means archived.
- Delegate closed DTO shape, uniqueness, targets and Unicode collisions to `validateChoiceDefinitionV2`; propagate its errors unchanged.

Future JSON storage columns, parents and timestamps are deliberately omitted from the DTO. Known incompatible populated branches are rejected, never pruned. The raw JSON guard rejects accessors before property reads; it does not close database-row keys.

All strings, input order and archive semantics survive unchanged in detached output. No sorting, deduplication, normalization, alias expansion or input mutation occurs.

## Not delivered here

Whole-snapshot coherence, simple/numeric leaves, family/root admission, production completeness and runtime activation remain separate. This helper throws no HTTP error: S23 whole-response failure and S27 HTTP 500 `EDITORIAL_VOCABULARY_UNREPRESENTABLE` belong to later transport integration. V1 and stored data remain unchanged.
