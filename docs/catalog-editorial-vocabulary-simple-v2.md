# Dormant V2 text/boolean definition validator

`validateSimpleDefinitionV2(input: unknown): SimpleDefinitionV2` admits only the
text/boolean metadata branches of [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4).
It returns a detached object with exactly `id`, `code`, `label`, and `type`.

## Admission guarantees

- All four keys are required; `type` is exactly `text` or `boolean`.
- Identities are nonblank strings. Whitespace and Unicode scalars are preserved;
  there is no trimming, coercion, normalization, sorting, or default insertion.
- The existing canonical JSON guard runs before submitted property reads. Accessors
  are rejected without invocation, as are non-data descriptors, custom prototypes,
  symbols, cycles, malformed JSON trees, and lone UTF-16 surrogates.
- Invalid input throws `TypeError('Expected a simple definition V2')`.
  Accepted frozen inputs and rejected data records remain unchanged.

## Scope and review boundary

This is the S2,S4–S8 metadata subset only: no values, choices, numeric policies,
family/binding rules, aliases, exposure, evidence, care review, or publication
eligibility are admitted or activated. T3c remains incomplete. There are no runtime
consumers, HTTP negotiation, persistence, provisioning, or legacy-reader changes.
The rollback boundary is this module, its public-API tests, and this document;
the shared canonical guard and numeric leaf remain unchanged.
