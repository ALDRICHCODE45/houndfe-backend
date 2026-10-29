# Fresh facts V2 capture bounds

`assertFreshFactsCaptureV2(row: SellableFactsShapeV2): void` requires successful
`parseSellableFactsShapeV2` admission first. It is not an unknown-input parser.
Deliberate rejection is exactly plain `Error('MALFORMED')`; inputs are not mutated.

Presentation is 1–300 Unicode code points; every known declaration basis is
1–2000. Both must be nonblank under ECMAScript trim and contain no lone surrogate.
Submitted spaces, paired surrogates and nonblank C0/DEL prose are preserved.
Every known declaration, including false and empty subsets, requires the existing
`isFreshEvidenceV2` predicate. Locator/date parsing is not duplicated; locator
controls are rejected there. Unknown declarations retain their parsed closed shape.

At most 12 declarations with unique exact keys are accepted. With only twelve
wire keys, a thirteen-declaration parsed row necessarily also duplicates a key;
the test cannot isolate the count limit from uniqueness under this precondition.
Local arrays require exact uniqueness and caps: dimensions 8, toy types 15
(separately), fit 3, capacity 2, equipment 5, optional nonpertinence 68.
Empty sets are allowed; no sorting, deduplication, trimming or normalization occurs.

## Composition and proof limits

Fresh save and publish must apply this gate to **all supplied rows**, not only E.
It is dormant, not wired into HTTP/storage or activation. Passing is not complete
facts admission or publication approval. Care review internals are entirely
uninspected, including prepared reviews with invalid fresh capture fields.
Separate gates own row identity/total counts, family/key and axis binding, option
membership, toy/non-toy relationships, optional routes, NA, contradictions,
completeness, E/D14 and publisher confirmation. No historical recognizer is used
for fresh admission, and historical/replay data must not be revalidated here.
The complete candidate validator must separately compose `isFreshEvidenceV2`
directly for per-value evidence; row declarations cannot supply it implicitly.
