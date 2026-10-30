# Production fact-rule result evaluation

`evaluateFactRuleV2(rule, facts)` evaluates the twelve production routes from the
policy mapping's `resolve`/`subset`/`flag` table, with target §7 and S46 precedence.
It returns a new five-field `RuleResultV2`, never publication authorization.

## Inputs and qualification

The caller supplies an admitted family/parameter/rule triple and projects only
known, shape/evidence/reference-qualified declaration values into `FactInputsV2`.
Missing keys or null represent omitted/unknown facts; evidenced false and empty
lists remain distinct known findings. Inputs must be stable. The input type is
derived from `DeclarationShapeV2`; it is not a parser, evidence validator or a
projection implementation. Do not turn malformed known facts into unknown.

## Results

| Result | applicability | required | allowNA | evidenceRequired | documentary |
| --- | --- | --- | --- | --- | --- |
| O | applicable | false | false | true | resolved |
| R | applicable | true | false | true | resolved |
| N | not_applicable | false | true | true | resolved |
| U | unresolved | false | false | true | unresolved |

Required and optional routes, conditional booleans, content magnitude, dimension/
capacity subsets, relevance flags and care presentation follow the existing table.
Selected subsets require only their members; unselected axes stay optional. Empty
findings and false flags are not inferred from unknown input. S46 retains O for
accessory optional equipment with unknown electrical relevance, even if a supported
equipment assertion is known. All other checks remain mandatory.

Cross-fact/value contradictions, toy-type equality, capture qualification, numeric
checks, value evidence, NA admission, E evaluation, care review and publication
consumption are separate gates. This module does not inspect assertions or E and
cannot prove they pass. No option-case fallback, storage or endpoint registration.
