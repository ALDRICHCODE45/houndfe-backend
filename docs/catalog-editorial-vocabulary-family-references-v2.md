# Assert V2 family references without admitting a vocabulary

`assertFamilyReferencesV2(family, definitionsById): void` synchronously checks family-local references and selector dependencies. It is dormant: no endpoint, persistence or production activation calls it.

## Trusted-input preconditions

- Parse the family with `parseFamilyShapeV2` first; validate every definition with `validateDefinitionV2`.
- The caller establishes unique definition IDs/codes and keys the map by actual definition IDs.
- Keep all inputs unchanged during the synchronous check. `ReadonlyMap` is a TypeScript view, not runtime provenance or deep immutability.

This is **not an unknown-input parser or full vocabulary/publication admission**. It does not repeat canonical-tree or leaf validation, construct a global unique index, or return an admitted/normalized DTO.

## Checks and preserved behavior

| Area                  | Assertion                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| All bindings          | Resolve definitionId and require the exact matching definitionCode, including pending and fact_rule routes.                                     |
| Option-case selectors | Require a same-family binding and its resolved single/multi definition. Reject product→sellable; preserve the other three owner pairs (S44).                           |
| Expected options      | Every code belongs exactly to the selector's options; archived options are accepted. No trimming, case folding, alias or group expansion.       |
| Dependency graph      | Union dependent→tested-binding edges across all cases; deduplicate pairs. Reject self-dependencies and cycles in any component.                 |
| Valid graphs          | Empty families, chains, diamonds and repeated dependencies are accepted. Iterative cycle detection avoids recursive stack growth on large DAGs. |

Success returns `undefined`; reference failures throw `TypeError`. Neither successful nor failed checks mutate the family, definitions, arrays or map; input order is preserved.

## Deliberate next-layer boundaries

No policy evaluation, required/publicationCheck consistency, allowNA/applicability matrix, unconditional-root inference, overlap/contradiction solver or single-selector cardinality restriction is implemented. A single selector intersecting several options is legitimate here.
Pending is not universally rejected. Fact rules undergo binding ID/code resolution only: no selector traversal, evaluation or production-triple check. Whole-vocabulary compatibility, production mapping, ordering/digest R and publication admission remain separate work; see [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4).
