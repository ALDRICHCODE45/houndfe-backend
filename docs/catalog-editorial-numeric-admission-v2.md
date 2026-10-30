# Fresh numeric admission V2

`assertFreshNumericAdmissionV2(values, family, definitions, operation)` checks
all supplied known numeric assertions for fresh save/publish (S33/S35/S42/S45).
It is dormant: no registered HTTP, persistence or transaction wiring is changed.

## Caller contract

Inputs are stable and already shape/reference-admitted. The selected family and
actual-ID-keyed definition map are coherent admitted metadata. Parsing has checked
finite numbers; references have checked ownership, subjects, uniqueness, exact
payload types and unit membership. Null-family/empty-document orchestration is
outside this selected-family helper. These checks are not repeated here.

## Traversal

Unknown, NA and known nonnumeric payloads are skipped. Every known number/range
resolves its exact binding code, then the binding's actual definition ID. The
existing `assertFreshNumericPayloadV2` receives the original payload, numeric
policy and operation unchanged. Its range-order, pending save/publish and resolved
domain rules remain authoritative; inputs and errors are preserved.
Missing bindings/definitions or nonnumeric definitions violate preconditions and
throw `TypeError('Expected admitted numeric inputs')`, not successful admission.

No E, activity, publicationCheck, applicability or evidence filter exempts supplied
numeric assertions. There is no conversion, rounding or fallback policy.
This is not completeness, NA/evidence admission or conservation eligibility.
Never use it for GET, initialization-copy, recorded replay or baseline eligibility:
S42 permits a reference-valid baseline despite unrelated fresh numeric failures.
Fresh candidate validation remains independent, even for unchanged assertions.
