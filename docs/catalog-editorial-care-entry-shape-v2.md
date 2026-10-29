# Parse private care entries without admitting a review

`parseCareRequirementShapeV2(unknown)` and `parseCareWarningShapeV2(unknown)`
return detached `CareRequirementV2` and `CareWarningV2` data. These dormant
helpers implement only the primitive pre-receipt boundary in
[wire §3](catalog-editorial-production-vocabulary-contract-proposal.md#3-exact-proposed-headers-and-admission-order)
and the entry shapes in [facts §3](catalog-editorial-production-vocabulary-facts-contract.md#3-prepared-care-review-and-publisher-confirmation-w02s8).

## Shape contract

- Requirements require exactly key, description, disposition, evidence and basis.
  Disposition accepts satisfied, not_applicable, unresolved and conflicting.
- Warnings require exactly key, requirementKeys, text, disclosure, evidence and
  handlingBasis. Disclosure accepts private_only, public_required and unresolved.
- Objects must have plain/null prototypes and own enumerable data properties.
  Arrays must be plain and dense with only exact indices and length. Accessors,
  hidden properties, decorations and symbols are rejected without calling getters.
- Evidence items use `parseEvidenceShapeV2` unchanged. Results contain fresh arrays
  and evidence objects, preserving strings, order, empty arrays and duplicates.
- Deliberate parent rejection is `TypeError('Expected a care entry shape V2')`.
  Evidence leaf errors and unexpected reflection failures propagate unchanged.

## Not care validity or publication permission

Blank/lone-surrogate strings, malformed date strings, duplicate evidence pairs and
arbitrary/duplicate requirement references remain representable. No count/string
limits, freshness, uniqueness, reference resolution, completeness, approval or legal
meaning is applied here. Fresh admission and publisher confirmation remain separate;
`public_required` and unresolved/conflicting states do not authorize publication.
There is no whole-care capture, document/HTTP integration, attestation, clock,
network or current-metadata lookup in this unit.
