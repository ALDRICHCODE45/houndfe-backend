# Fresh production candidate policy assertion V2

`assertProductionBindingPoliciesV2(family: FamilyV2): void` checks one fresh candidate without changing it. It is dormant, not adoption or publication authorization.

## Caller contract

First parse with `parseFamilyShapeV2`, validate definitions with `validateDefinitionV2`, establish unique actual IDs/codes, and call `assertFamilyReferencesV2` against that index. Keep inputs stable during the synchronous assertion. Success returns void; mismatch throws `TypeError`.

## Exact production boundary

For the seven `FAMILY_CODES`, bindings must have exactly the mapped definition-code set, version 2, sellable ownership, searchable=false, exact exposure and publicationCheck, and fact_rule with the mapped family/ruleId/bound-code parameter. Even restrictive FACET→INTERNAL changes reject. The private read-only lookup expands CHOICES/NUMBERS/OTHER (including ALL and optional OTHER routes), not a copied manifest table.

Custom family codes are separate: any fact_rule rejects; pending/option_cases remain outside this proof. Their identities, codes and other metadata gain no extra constraints or validity certification beyond caller preconditions.

## Preservation and exclusions

Labels, actual IDs, ordering and definition metadata (including aliases/archive state) are not rewritten, normalized or synthesized. Codes are not database IDs. See [mapping §1/§3](catalog-editorial-production-vocabulary-policy-mapping.md) and S14 in the [task](../odd/tasks/editorial-production-vocabulary.md).

Do not use this helper on historical reads, replays or provisioning, even for canonical-name legacy rows. Explicit legacy adoption requires a separate future gate; matching code/policy does not authorize adoption. This is not full vocabulary admission, seven-family completeness, option inventory, numeric-domain proof, rule evaluation, care/legal confirmation, activation or HTTP integration. S2/S4–S8 are covered only at this metadata-policy boundary; downstream publication remains pending.
