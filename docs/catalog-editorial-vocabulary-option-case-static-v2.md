# Static option-case checks V2 (dormant)

`assertFamilyOptionCaseStaticV2(family, definitionsById): void` rejects impossible
individual cases and every overlapping pair within each option-case binding,
including custom families and pairs with identical results. Failures throw TypeError.

## Trusted caller boundary

First parse the family with `parseFamilyShapeV2`, validate every definition with
`validateDefinitionV2`, establish unique definition IDs/codes, and build the map
using actual IDs. Pass `assertFamilyReferencesV2` and
`assertFamilyPolicyConsistencyV2` before this assertion. Keep inputs stable during
the synchronous call; ReadonlyMap does not establish provenance or deep immutability.

## Reasoning and exclusions

- Single selectors represent singleton sets: equals/contains need one expected
  option; intersects allows any expected singleton. Shared predicates overlap
  exactly when their allowed singleton sets intersect.
- Multi selectors admit every subset. Equality fixes the set; compare equality
  by exact sets, contains by subset, intersects by nonempty intersection. Without
  equality, positive predicates coexist by union. No inventory enumeration runs.
- Cases AND their predicates. One incompatible shared selector makes a pair
  disjoint; unshared selectors contribute only their individual conditions.
  Empty conditions are true; zero cases and non-exhaustive coverage are allowed.

Archived options, extras, owners, conditional chains and input order are preserved.
No alias/group expansion, result/publication/evidence pruning, hidden limits,
mutation, database access, runtime activation or adoption is introduced. Existing
validators are unchanged; this is not full admission or product evaluation.
