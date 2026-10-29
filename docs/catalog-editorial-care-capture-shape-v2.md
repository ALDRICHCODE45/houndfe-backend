# Parse private care capture wire shapes

`parseCareCaptureShapeV2(unknown)` returns a detached `CareReviewCaptureV2`.
This dormant pre-receipt parser implements T3d S2, not care approval.

## Accepted shape

- Unknown is exactly `{state:'unknown'}` with no defaults or extra fields.
- Prepared requires state, jurisdiction, intendedUse, determination, evidence,
  basis, requirements and warnings. Determination is `identified` or
  `none_applicable`; jurisdiction, intendedUse and basis are primitive strings.
- Evidence, requirement and warning arrays delegate to the existing leaf parsers.
  Order, duplicates, empty arrays and all submitted strings are preserved.

Records must be plain or null-prototype, with exact own enumerable data keys.
Arrays must be dense plain arrays without decorations, hidden or symbol keys.
Accessors are rejected without executing getters. Output objects and arrays are
new, including every nested leaf. Deliberate parent rejection throws
`TypeError('Expected a care capture shape V2')`; leaf failures and unexpected
reflection failures propagate unchanged, without catch/reclassification.

## Limits

Blank strings, lone surrogates, malformed date strings, unknown references,
conflicting/unresolved entries, public-required warnings and none-applicable
reviews containing entries remain representable here. Fresh bounds, uniqueness,
references, evidence policy, publisher confirmation and legal/publication gates
belong later. This adds no facts/root/HTTP integration, permission or attestation.

See [facts contract §3](catalog-editorial-production-vocabulary-facts-contract.md)
and [pre-receipt ordering §3](catalog-editorial-production-vocabulary-contract-proposal.md).
