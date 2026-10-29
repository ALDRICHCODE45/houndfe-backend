# Production nonnumeric definition type assertion V2

`assertProductionNonnumericDefinitionTypesV2(family, definitionsById)` checks exact types for bound production choice, text and boolean definitions. It is dormant, synchronous and non-mutating; success returns `void`, not an admitted vocabulary.

## Caller contract

1. Parse the family with `parseFamilyShapeV2`.
2. Validate definitions with `validateDefinitionV2`; establish unique IDs/codes and index by actual IDs, not canonical codes.
3. Check family references with `assertFamilyReferencesV2`; keep inputs stable during assertion.

The helper calls `assertProductionBindingPoliciesV2` **first**, preserving its failures unchanged. Outside the seven production family codes, it adds no type restrictions to generic custom-family semantics. Canonical candidates resolve each bound CHOICES/OTHER code by actual definition ID and require matching code and exact canonical type. The private lookup derives from the existing pure domain catalog; no second 43-code inventory or domain-to-Prisma import exists.

## Proof boundary

| Proven here                                                              | Not proven here                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Exact type for 32 choice and 11 text/boolean rows                        | Numeric type, units or numeric policy (separate numeric assertion)           |
| Composed production binding-policy contract                              | Canonical option/group/alias inventory or global vocabulary admission        |
| Preserved IDs, labels, order, aliases, archive flags, groups and options | Whole-family legacy compatibility or arbitrary option-case overlap semantics |

This assertion neither compares option/group/alias inventories for equality nor forbids additional members. Canonical inventory coverage and the approved allowance for validated extra members belong to later checks, as do required static custom-rule contradiction/overlap checks. None is implemented here. Global admission and legacy compatibility also remain separate. Existing generic leaf validation still applies independently; no leaf/collision matrix is duplicated here.

Use only for fresh candidates explicitly classified for production validation. Do not gate historical reads/replay, provisioning or legacy adoption with it; it supplies no adoption, publication, HTTP or activation permission. See [mapping §1/§3](catalog-editorial-production-vocabulary-policy-mapping.md) and the [numeric boundary](catalog-editorial-vocabulary-production-numeric-v2.md).
