# Fresh V2 numeric payload domain

`assertFreshNumericPayloadV2(payload, policy, operation)` is a dormant domain
assertion for fresh save/publish candidates (T3d S2/S33, contract §7).

## Preconditions and behavior

- Payload already passed finite wire parsing; policy already passed metadata
  validation. Actual bound definition type and exact unit membership, and the
  operation, have already been admitted by the caller.
- Every range must have `min <= max`; equality and either sign of zero are valid.
- Pending policy permits this domain step on save, but publish throws plain
  `Error('MALFORMED')`. Pending is not reviewed unbounded metadata.
- Resolved policy applies its integer flag and each non-null inclusive/exclusive
  bound to the scalar or both range endpoints. Null means no bound.
- Success returns void. Rejection is exactly plain `Error('MALFORMED')`.
  Neither payload nor policy is mutated, rounded, normalized or converted.

Policy admission and candidate domain admission are distinct: this helper does
not parse payloads or validate policy consistency. It adds no safe-integer cap,
magnitude-name heuristics, unit conversion or membership checks.

## Integration boundary

Outer complete fresh validation must invoke this for every known numeric
assertion using its actual bound definition. This helper does not traverse
metadata/documents or validate evidence, NA, current revision, authority, D14,
HTTP, storage, history or receipt replay. No runtime integration is activated.
