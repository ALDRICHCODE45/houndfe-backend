# Document V2 primitive wire boundary

`parseDocumentShapeV2(unknown)` returns a detached `DocumentShapeV2` by composing
existing value and sellable-facts parsers. This dormant T3d S2 helper checks only
the required seven-key wire shape, never full document admission.

## Contract

- Require schemaVersion 2, nullable string commercialTitle/description/familyCode,
  string-array mediaRefs, ValueV2-array values and SellableFactsShapeV2-array facts.
- Inspect descriptors without executing getters; accept plain/null-prototype
  records and dense plain arrays only. Return a fully detached tree.
- Reuse existing value/facts parsers unchanged. Parent rejection is
  `TypeError('Expected a document shape V2')`; leaf/reflection failures propagate.
- Preserve strings, order, duplicates, unknown references, reversed ranges and
  family-null relational conflicts. No defaults, conversion or normalization.

## Proof limits

This is shape-only, pre-receipt work, not historical recognition, full admission,
publication, receipts or HTTP activation. Later relational/fresh gates remain
responsible for rejecting semantic conflicts when applicable.
