# Runtime option-case selection

`evaluateOptionCasesV2(policy, family, values, subjectVariantId)` implements only
option-case selection from the single-contract target §7. It returns a fresh
`RuleResultV2` with exactly applicability, required, allowNA, evidenceRequired and
documentary, or `null` when zero or multiple cases match (even equal results).
A selected unresolved field remains unresolved; selection is not readiness.

## Selected case identity

`selectOptionCaseV2(policy, family, values, subjectVariantId)` uses the same single
matching implementation and returns `{ caseCode, result }`, or `null` for zero or
multiple matches. Both the envelope and its five-field result are fresh, detached
objects. Unresolved result fields do not erase a uniquely selected case identity.

A caller may resolve `caseCode` against the same stable admitted policy to inspect
only that case's `when` dependencies. Do not infer identity from result equality:
distinct cases can produce identical results. An unconditional case has no selector
dependencies. This API does not traverse dependencies or construct an evaluation
set; callers still own subject scheduling and publication admission.

The existing `evaluateOptionCasesV2` projects only `result`, preserving its exact
five-field contract, matching behavior and error propagation. Neither API adds
metadata validation or permission to publish.

## Caller preconditions

Supply the `option_cases` branch belonging to the given family, coherent admitted
metadata (including S44 owner restrictions and exact option references), and
parsed, reference-valid values with unique identities. Inputs must remain stable.
This helper does not parse unknown input or establish reference validity. Missing
selector bindings or encountered known non-choice payloads throw an internal
`TypeError('Expected admitted option-case inputs')`, not a public error contract.
Other invalid input remains outside the API; this is not a replacement validator.

## Matching

- Read each selector's binding owner: product uses null, sellable uses the supplied
  subject identity (null for a simple sellable). Never read a sibling as fallback.
- All tests must match; empty `when` is unconditional. Missing, unknown and NA
  values do not match. Evidence is not a matching prerequisite.
- Known single is a singleton; multi is its exact set. `equals_set` is equality,
  `contains_all` includes every expected code, `intersects` shares any code.
  Expected sets are admitted nonempty; order does not matter, identity is exact.
- No normalization, aliases, group expansion, aggregation or input mutation.

Pending/fact-rule dispatch, dependency evaluation, NA permission, conservation,
E/completeness/care gates and HTTP/transaction registration remain separate work.
`null` cannot waive a required evaluation. This module activates no endpoint.
