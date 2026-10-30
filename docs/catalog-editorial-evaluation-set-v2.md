# Editorial evaluation set

`buildEditorialEvaluationSetV2(family, values, eligibleSubjects, qualifiedFactsBySubject)`
returns fresh `{ code, variantId, result }` entries for target §7 evaluation.
It schedules and evaluates bindings; it does not admit publication.

## Preconditions

Metadata must be admitted and stable: unique bindings/case codes, valid references,
S44 ownership restrictions, static case consistency and acyclic dependencies.
Values must be parsed and reference-admitted with unique identities. Facts are
already qualified known projections indexed by exact subject, not raw captures.
The caller supplies E from the real offered-sellable union; this helper queries
neither prices nor catalog settings and does not validate E membership.

## Scheduling

- Seed `always` bindings even without assignments. Seed `when_asserted` only for
  known or NA assertions; false/empty known values count. Missing/unknown do not.
- Product bindings use null once, including when E is empty (S50). Sellable
  bindings use only supplied E identities; null is not fabricated for them.
- Follow only the uniquely selected option case's dependencies recursively.
  Product dependencies use null; sellable dependencies retain the current subject.
  Deduplicate by binding code and subject, including repeated E identities.
- Resolve option case identity with the shared selector. Fact rules use only the
  exact subject's qualified facts (missing row means unknown inputs); pending
  routes return null. Neither route falls back to option matching.
- Keep unresolved results and null selections as entries, never silent omissions.
  Consumers must apply local readiness and all independent publication gates.

Inputs are unchanged; entries/results are detached. Errors propagate unchanged.
Output follows first encounter in family/E traversal then selected dependencies;
callers must not interpret that order as admission or error precedence.
Fresh NA permission, evidence/presence checks, numeric policies, facts consistency,
family minima, care attestations, conservation and transaction/HTTP integration
remain separate. Inactive captured rows still require their reference checks.
