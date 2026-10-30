# Binding-policy evaluation V2

`evaluateBindingPolicyV2(policy, family, values, subjectVariantId, qualifiedFactInputs)`
is an internal exclusive dispatcher implementing the single-contract S35/S45 slice.
It returns `RuleResultV2 | null`, not publication permission.

## Caller preconditions

Metadata is admitted, coherent and stable during evaluation. Values are already
reference-valid and unique for their binding/subject identities. The subject is
already resolved; this helper does not select or aggregate variants.
`qualifiedFactInputs` is the already shape-, evidence- and reference-qualified
known-value projection for that subject, not raw declarations. Missing/null fact
entries retain the existing fact evaluator's unknown semantics.

## Exclusive routes

- `pending`: return `null` without calling either helper or reading other inputs.
- `option_cases`: pass the original policy, family, readonly values and subject to
  `evaluateOptionCasesV2`; do not read qualified facts or call the fact helper.
- `fact_rule`: pass exactly `policy.rule` and the qualified facts to
  `evaluateFactRuleV2`; do not read family/values or attempt option matching.

The selected helper's result is returned unchanged, including null, unresolved
fields and object identity. Unexpected errors propagate unchanged. There is no
fallback, copying, normalization or input mutation.

Raw fact qualification, explicit-NA admission, evaluation-set construction,
completeness, care review, eligibility E, HTTP and transactional registration are
outside this helper. A resolved result alone never authorizes publication.
