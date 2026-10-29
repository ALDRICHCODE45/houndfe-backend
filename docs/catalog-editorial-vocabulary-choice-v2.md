# Dormant choice metadata shape parser (C1)

`parseChoiceDefinitionShapeV2(unknown)` accepts closed `single`/`multi` metadata.
It is **not full admission**: alias namespace collisions (S11/S12) are not checked.
No dispatcher, persistence, HTTP transport or vocabulary activation is added.

## C1 contract

- All root, option, group and alias keys are required; extra keys are rejected.
- Identities are nonblank strings. Options require boolean `archived` and
  safe-integer `sortOrder`, including negative values.
- Option/group codes are unique within their respective namespaces. Group members
  are unique within each group and reference exact existing option codes.
- Alias targets reference exact existing option codes, including archived options.
- Empty arrays and overlapping groups are valid. The canonical JSON guard runs
  before submitted properties are read; output is detached without changing
  original strings, array order or input. No sorting, defaults or normalization.

## Pending in C2

- Exact duplicate original alias-label rejection and comparison-key collisions.
- Key-to-target-set indexing that preserves homonymous option labels, excludes
  groups and propagates unsupported Unicode runtime errors unchanged.
- Final `validateChoiceDefinitionV2` admission API; follow the
  [alias namespace rules](catalog-editorial-alias-comparison-v1.md#future-namespace-rules-not-implemented-here).
