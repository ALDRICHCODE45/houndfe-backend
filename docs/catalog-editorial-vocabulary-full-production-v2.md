# Validate a complete production vocabulary candidate

`validateFullProductionVocabularyV2(unknown): VocabularyV2` is a dormant,
separate function for new full-production candidates. Generic partial/custom
validation remains unchanged. No service, endpoint or consumer is activated.

## Validation order

1. Run `validateVocabularyConsistencyV2`: closed parsing, references, policy
   consistency and static option-case checks; obtain its detached tree.
2. Index definitions by their actual unique IDs, not codes or generated IDs.
3. Require every existing `FAMILY_CODES` entry. Custom families are allowed;
   absence throws `TypeError('Expected a full production vocabulary V2')`.
4. For each family, including custom, run production numeric assertions followed
   by production alias coverage. Their existing policy composition is retained:
   canonical bindings stay exact, and custom families cannot borrow `fact_rule`.

## Preservation and limits

Required definitions follow references and exact canonical bindings, not a second
68-definition inventory/count. Choice option/group/membership/alias coverage uses
existing authorities; validated extras and Unicode-equivalent explicit aliases
remain allowed. Custom families may share definitions, including ranges and resolved
numeric/policy metadata, without a family version. S35/S36 supersedes the S18 gate;
custom `fact_rule` borrowing remains forbidden.

Return the parsed tree without changing labels, order, archives or values.
Inherited errors, including Unicode runtime failures, propagate unchanged.
There is no mutation, completion, defaulting, promotion or implicit adoption.
Success authorizes neither legacy adoption nor publication nor V2 activation.
Historical GET/replay, provisioning and write consumers are not changed.
