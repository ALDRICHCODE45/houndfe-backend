# Private declaration wire shape V2

`parseDeclarationShapeV2(unknown)` returns a detached `DeclarationShapeV2`.
This dormant parser checks primitive pre-receipt shape, not fresh admission.

## Branches

- Unknown: exactly `key`, `state: 'unknown'`, `evidence: null`.
- Known: exactly `key`, `state: 'known'`, `value`, non-null evidence and string `basis`.
- Keys discriminate the value type: five booleans, content magnitude, presentation
  kind, closed dimension subsets, or the four other string-array subsets.
- Referenced codes intentionally remain strings; later membership/family gates
  resolve them. Unknown never means false or not applicable.

Only enumerable data properties in plain/null-prototype records and dense plain
arrays are accepted. Outputs preserve strings, array order and duplicates.
Evidence uses the existing primitive parser; no fresh string/date bounds apply.
Intentional declaration rejection is `TypeError('Expected a declaration shape V2')`;
leaf and unexpected reflection failures propagate unchanged.

No facts-row/root transport, metadata, publication, care approval or HTTP activation
is provided. See the [facts contract](catalog-editorial-production-vocabulary-facts-contract.md)
§1 and [admission boundary](catalog-editorial-production-vocabulary-contract-proposal.md) §3.
