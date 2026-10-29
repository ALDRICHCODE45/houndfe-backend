# Dormant numeric-definition V2 parser

`validateNumericDefinitionV2(input: unknown)` validates one generic numeric metadata
DTO and returns a detached `NumericDefinitionV2`. It exports `UnitV2` and
`NumericPolicyV2` too. Invalid input throws `TypeError` with exactly
`Expected a numeric definition V2`; no defaults or coercion are applied.

## Contract and preservation

- Implements the numeric-definition subset of [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4).
- Required/closed keys, nonblank identities/text, safe signed unit ordering,
  unique nullable number units, and non-null range units are checked.
- Pending policies are valid generic metadata. Resolved magnitude accepts any
  string, including empty; production mapping is a separate boundary.
- Bounds are finite or null; null is exclusive/unbounded. Bounds are ordered;
  equality requires both inclusive. Empty unit arrays are allowed.
- The existing canonical JSON guard rejects non-data properties, undefined,
  malformed arrays and lone surrogates before property access. Strings, nulls,
  Unicode, whitespace, signed numbers and unit order are preserved, not sorted.

## Scope and review

This is T3c's S2/S4–S8 **metadata subset**, not completion of those policies or T3c.
No runtime/HTTP consumer is activated. Full vocabulary admission, sorting/digest R,
assignment values, legacy projection, coherent snapshots, production mapping,
publication and care review remain downstream. Existing legacy readers are unchanged.
Rollback is removal of this module, its spec and this page; no runtime rollback is needed.
