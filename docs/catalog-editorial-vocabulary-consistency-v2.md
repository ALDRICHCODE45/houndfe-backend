# Generic vocabulary V2 consistency

`validateVocabularyConsistencyV2(unknown): VocabularyV2` is a dormant, pure
composition for generic metadata consistency. It has no runtime consumer.

## Check order

1. `parseVocabularyShapeV2` validates the closed root, every family and definition,
   and the four independent ID/code uniqueness namespaces, returning detached data.
2. Index parsed definitions by their actual IDs, not their codes.
3. For each family in submitted order, run `assertFamilyReferencesV2`, then
   `assertFamilyPolicyConsistencyV2`, then `assertFamilyOptionCaseStaticV2`.
4. Return that parsed tree unchanged. Inherited errors propagate without wrapping,
   including the Unicode runtime guard error.

No sorting, normalization, defaults or input mutation occurs. Empty roots, unbound
valid definitions, custom families, mixed owners, archived options, pending
policies, acyclic conditional chains and nonexhaustive disjoint cases remain valid.
Static checks reject impossible individual cases and overlapping pairs; they do
not evaluate product values or require exhaustive coverage.

## Boundary

Passing this API does **not** prove production completeness, even for a family
named `food`. Production numeric, policy and alias assertions are not composed;
neither are the canonical seven-family requirement, legacy compatibility,
minimum-contract-version truth, adoption, vocabulary ordering/R, projection or
HTTP negotiation. Whole admission and activation remain separate future work.
