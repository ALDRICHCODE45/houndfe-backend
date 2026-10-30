# Selected-binding readiness V2

`assertSelectedBindingReadinessV2(selected, value)` checks local publication
readiness for one already-selected binding/subject (S35/S45, target §7).

## Preconditions

- The caller supplies a stable, admitted `RuleResultV2` or null for unresolved
  selection; the caller chooses the evaluation set and subject.
- Any assignment is parsed and reference-admitted, matching that binding/subject.
  This helper does not resolve identities, owners, payload types or membership.
- Numeric domain/order/unit and S33 numeric-policy checks remain independent.
  Local number/range presence is not numeric validity or publication permission.

## Local rules

Null selection or unresolved applicability/documentary status throws the existing
`Error('MALFORMED')`. Documentary `not_applicable` is resolved readiness metadata,
not legal compliance, an evidence waiver or assignment NA permission.

Required means applicable and known, with nonempty single/text/multi payloads.
Only text uses ECMAScript trim as an emptiness predicate; inputs are not trimmed.
Boolean false, zero and admitted signed/equal ranges satisfy local presence.
Optional absent/unknown is allowed when resolved; known false/empty is an assertion.
Known contradicts selected NA. Explicit NA requires NA applicability and allowNA;
it never needs fabricated known-value evidence. Every supplied known-value evidence
must pass `isFreshEvidenceV2`; null is allowed only when evidenceRequired is false.
Facts cannot substitute for per-value evidence. Inputs and unexpected errors retain
identity; no normalization, mutation, clock or recency policy is introduced.

S46 accessory optional-equipment O can pass this gate with its own valid evidence,
even with unknown electrical relevance. This proves no E coverage, family minima,
care/equipment-only determination, product scheduling, conservation, transaction,
HTTP, replay or complete publication admission. No runtime registration is added.
