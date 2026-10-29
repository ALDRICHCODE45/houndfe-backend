# Parse the dormant V2 vocabulary root

`parseVocabularyShapeV2(unknown): VocabularyV2` validates a closed root, guards
its entire JSON data tree before property reads, and composes the existing family
shape and six-type definition validators. It has no runtime consumers.

- Required keys: `semanticsVersion`, `families`, `definitions`; no extras/defaults.
- Version is exactly `editorial-production-1`; both arrays may be empty.
- Family IDs, family codes, definition IDs and definition codes are four independent
  exact uniqueness namespaces. Cross-namespace equality and homonymous labels are valid.
- Output is fully detached. Submitted text, array order, nulls and archive flags
  are preserved; nothing is normalized or sorted.
- Root/guard/duplicate failures throw `TypeError('Expected a vocabulary shape V2')`.
  Family/definition errors, including Unicode runtime failures, propagate unchanged.

## Not full admission

Custom families, pending policies and unresolved global references can pass shape
validation. This does not prove reference consistency, production mapping/seven-family
completeness, policy consistency, legacy compatibility or explicit adoption authority.
No snapshot, digest ordering, transport, persistence or activation is added.
