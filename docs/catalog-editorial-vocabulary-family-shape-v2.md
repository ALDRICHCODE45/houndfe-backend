# Family V2 shape parsing

`parseFamilyShapeV2(unknown)` exports a dormant, detached `FamilyV2` with
`BindingV2[]`. This is shape parsing, **not full admission**, and grants no
publication authority. It has no runtime consumers or activation wiring.

## Validated boundary

The parser guards the complete canonical JSON tree before submitted property
access. Family and binding keys are exact, required and default-free. Nonblank
identities/labels retain their spelling; family codes need not be production
codes. Family has exactly `id`, `code`, `label`, `bindings`; the obsolete
`minimumContractVersion` key rejects even with value 1 or 2. Owners, exposure and
publication checks use the contract enums. Searchability is a boolean; order is a signed safe integer.
Empty bindings are valid. Duplicate binding definition IDs or codes are rejected
independently within the family. Every policy delegates to
`parseBindingPolicyShapeV2`, preserving its errors outside the family guard catch.
All containers are detached, including policy nesting; array order is retained.

## Still required before admission

No external references or ID/code correspondence, same-family selectors,
cycles, overlapping cases, contextual result consistency, production triples,
production sellable-only ownership, whole-vocabulary uniqueness, canonical ordering or revision R are
checked here. No HTTP, schema, database or publication gate is changed.

S35/S36 [single-contract §§1/5/6](catalog-editorial-single-contract.md) supersedes
older minimum-version requirements. See historical [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4)
and [policy boundary](catalog-editorial-vocabulary-policy-shape-v2.md).
