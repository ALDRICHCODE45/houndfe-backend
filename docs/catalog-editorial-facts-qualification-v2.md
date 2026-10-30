# Qualified fresh facts inputs

`qualifyFactsV2(parsedRow, admittedFamily, coherentDefinitionsMap)` returns
`FactInputsV2` for the existing binding-policy dispatcher. It is an internal,
synchronous helper, not publication admission or a registered transport route.

## Preconditions and qualification

The caller supplies a parsed `SellableFactsShapeV2` and coherent, admitted family
and definition metadata, indexed by actual definition ID. Inputs must remain
stable during the call. Whole-document subject uniqueness and current subject
membership must already be admitted upstream. A missing row is the caller's
concern; this helper accepts a present row, including one without declarations.

The helper calls `assertFreshFactsCaptureV2` first, then
`assertFreshFactsReferencesV2`, unchanged. Only after both succeed does it project
known declarations. Invalid known evidence, basis, duplicate keys or references
are rejected, never downgraded to unknown. Errors propagate unchanged.

Unknown declarations are omitted, not represented as false, null or empty sets.
Known false and empty sets remain explicit. Returned arrays and both nested
dimension arrays are mutable detached copies; inputs are neither mutated nor
frozen by this helper. Evidence, basis, presentation and care capture are not
included in the result. S34 custom-family restrictions remain reference checks.

## Deliberate boundaries

Qualification does not assert publication minima, cross-fact contradictions,
selected toy-type agreement, explicit-NA permission, E membership, care review
readiness or value-evidence completeness. Shape-valid contradictions remain
available for later publication validation. The real dispatcher retains negative
N versus unknown U and S46 optional-equipment O; qualification invents no
equipment-only discriminator and waives no other publication checks.

Do not apply this fresh qualification to S42 baseline eligibility: that boundary
uses structural/context-reference eligibility, not unrelated fresh facts failures.
No conservation, HTTP, transaction or publication integration is introduced.
S35/S45 define the current scoped continuation; S48 authorizes this complete
three-file unit up to 450 lines only. Later units retain the 400-line ceiling.
