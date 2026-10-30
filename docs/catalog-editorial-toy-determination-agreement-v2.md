# Toy determination agreement

`assertToyDeterminationAgreementV2(selectedToyTypes, determination)` checks one
caller-selected toy subject under T38a / S35/S45. It is an internal, local
publication predicate, not complete publication admission or live wiring.

## Caller preconditions

- Select the known, nonempty, unique, reference-admitted `toy.type` option codes
  for this subject. Resolve the assignment, owner and subject before calling.
- Supply this same subject's qualified dimension determination, or null/undefined
  for an unknown/missing determination. Its type is derived from
  `FactInputsV2['relevantDimensionCodes']`; it is not a raw declaration wrapper.
- Qualification has already checked capture, evidence/basis, unique codes and
  toy types, family permission, axis binding and option references. This helper
  neither repeats those checks nor defines behavior for invalid reference input.
- Inputs and their qualification remain stable throughout the synchronous call.

## Agreement and failure

A missing/null determination fails through the existing plain `Error('MALFORMED')`
contract. Otherwise, its `toyTypes` must equal the selected types as an unordered
set: identical cardinality and exact membership. Subsets, supersets and equal-size
membership mismatches fail with the same error. No sorting, normalization, input
mutation or retained state occurs.

Empty `codes` never waives type agreement. A qualified human negative determination
with empty axes and exactly matching toy types passes this local check; prior
qualification supplies its evidenced basis for every selected use.

## Deliberate boundaries

There is no type-to-axis taxonomy, label inference, axis truth proof or automated
manufacturer verification. Named-axis value requirements, numeric/evidence gates,
E selection/orchestration, subject lookup, qualification and full publication
composition remain separate. This helper does not inspect siblings, infer care or
equipment-only semantics, qualify baselines, register endpoints or activate V2.
Empty selections and duplicate/unadmitted types violate caller preconditions; no
additional business rule for them is introduced here.
