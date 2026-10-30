# Evaluated binding readiness V2

`assertEditorialEvaluationReadinessV2(family, values, eligibleSubjects, qualifiedFactsBySubject)`
composes the evaluation-set builder with local binding readiness (S35/S45/S50).
It is dormant and does not authorize complete publication.

## Preconditions

The caller supplies stable, admitted family metadata, parsed/reference-admitted
unique values, actual eligible E subjects and matching qualified facts. The
function neither queries E nor qualifies raw facts or references. Null-family
orchestration remains outside this selected-family helper.

## Composition

The existing builder runs once with those inputs unchanged. For every resulting
entry, the consumer finds the assignment with exactly its code and variantId;
absence is passed as undefined. The original selected result and matching value
are passed to `assertSelectedBindingReadinessV2`, without translation or fallback.
All errors retain identity; inputs are not changed.

Existing scheduling remains authoritative: sellable completeness is limited to E,
product rules run once even with empty E, and selected-case dependencies are
included. Unresolved results, missing required values, contradictory known/NA
states and required evidence failures reject through the existing consumer.

Passing establishes only scheduled-binding readiness. All-supplied numeric
admission, independent known-fact consistency, toy/content agreement, care review
and confirmation, habitat's equipment-only exception, conservation, authority,
CAS and receipt/transaction gates remain separate. No HTTP or storage activation,
baseline validation, sibling borrowing or owner aggregation is introduced.
