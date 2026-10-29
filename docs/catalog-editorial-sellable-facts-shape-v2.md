# Sellable facts V2 wire row

`parseSellableFactsShapeV2(unknown)` returns a detached `SellableFactsShapeV2`.
This dormant T3d S2 primitive implements the row shape in [facts §1](catalog-editorial-production-vocabulary-facts-contract.md#1-one-private-document-shape-w01), not complete document admission.

## Closed shape

All four keys are required: `variantId: string | null`, `presentation: string`,
`declarations: DeclarationShapeV2[]`, and `careReview: CareReviewCaptureV2 | null`.
Records must have plain or null prototypes and exact enumerable data properties.
Declarations must be a dense plain array without extra, hidden, symbol or accessor properties.
Existing declaration and care parsers validate and detach nested values unchanged; no submitted getter executes.
Null care stays null, with no defaults. Deliberate parent rejection is
`TypeError('Expected a sellable facts shape V2')`; leaf and reflection failures propagate unchanged, without catches.

## Proof boundary

The [pre-receipt boundary](catalog-editorial-production-vocabulary-contract-proposal.md#3-exact-proposed-headers-and-admission-order) deliberately preserves blank/lone-surrogate strings, unknown variant/code references, malformed date strings, empty/duplicate declarations and their order, and structurally valid contradictory care dossiers.
No fresh bounds, uniqueness, ownership, family applicability, evidence freshness, reference resolution or publication gate runs here.
This neither recognizes historical documents nor approves care, attests, authorizes, queries metadata, fetches evidence or activates HTTP/V2.
Public-function tests exercise real leaves, frozen detachment, output mutation isolation, descriptor rejection and thrown-value identity; they do not prove full admission or runtime integration.
