# Care review publication readiness

`assertCarePublicationReadinessV2(review)` checks one parsed care review against
single-contract §7. Missing/null/unknown reviews fail with `Error('MALFORMED')`.
A successful check returns void without changing the review.

## Checks

The review must be prepared. The existing fresh capture validator first checks
jurisdiction/use/basis prose, entry limits and keys, evidence validity/uniqueness,
requirement bases, warning handling bases and local warning references.

Publication readiness additionally requires:

- At least one review evidence item; entry evidence cannot replace it.
- `identified`: at least one requirement. Every requirement must be satisfied or
  not applicable and carry its own evidence. Unresolved/conflicting entries fail.
- `none_applicable`: no requirements and no warnings. The review still needs its
  nonblank evidenced explanation; empty collections alone are not an exemption.
- Every warning must have evidence and `private_only` disclosure. Unresolved and
  `public_required` disclosures fail; no public regulatory-warning channel is
  approved for this slice.

## Boundary

The caller supplies parsed stable input; this helper does not parse raw JSON or
establish subject membership. Unexpected dependency errors propagate unchanged.
Private-only treatment is a recorded human declaration, not automatic legal
verification or declassification. Success is not publisher authorization, revision
confirmation, an attestation, or complete publication approval. E coverage,
presentation agreement, operational prescription controls and all other gates
remain caller/application responsibilities. No HTTP or transaction is activated.
