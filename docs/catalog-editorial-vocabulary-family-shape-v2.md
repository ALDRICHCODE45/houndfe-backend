# Family V2 shape parsing

`parseFamilyShapeV2(unknown)` exports a dormant, detached `FamilyV2` with
`BindingV2[]`. This is shape parsing, **not full admission**, and grants no
publication authority. It has no runtime consumers or activation wiring.

## Validated boundary

The parser guards the complete canonical JSON tree before submitted property
access. Family and binding keys are exact, required and default-free. Nonblank
identities/labels retain their spelling; family codes need not be production
codes. Versions are exactly 1 or 2; owners, exposure and publication checks use
the contract enums. Searchability is a boolean; order is a signed safe integer.
Empty bindings are valid. Duplicate binding definition IDs or codes are rejected
independently within the family. Every policy delegates to
`parseBindingPolicyShapeV2`, preserving its errors outside the family guard catch.
All containers are detached, including policy nesting; array order is retained.

## Still required before admission

No external references or ID/code correspondence, same-family selectors,
cycles, overlapping cases, contextual result consistency, production triples,
production sellable-only ownership, minimum-version compatibility with advanced
metadata, whole-vocabulary uniqueness, canonical ordering or revision R are
checked here. No HTTP, schema, database or publication gate is changed.

See [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4)
and [policy boundary](catalog-editorial-vocabulary-policy-shape-v2.md).
