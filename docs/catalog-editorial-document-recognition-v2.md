# Historical V2 document recognition

`isRecognizableDocumentV2(unknown): input is DocumentShapeV2` returns a boolean,
never a decoded clone. The original input is unchanged; the existing shape parser
may detach its internal result. Empty V2 is recognizable; `{}` and the legacy
empty document are not. This predicate does not classify their modes.

The real `parseDocumentShapeV2` enforces closed shapes, primitive types, finite
numbers and existing static tags. Only `EditorialDocumentShapeError` becomes
`false`; unexpected errors, ordinary same-message TypeErrors and non-Errors
propagate unchanged. Descriptor/getter safety comes from that parser.

After parsing, known dimension/fit/capacity/equipment declarations require the
exact 8/3/2/5 static literals from [facts §1](catalog-editorial-production-vocabulary-facts-contract.md).
Wrong namespaces, aliases and case variants return `false`. Unknown declarations,
empty subsets and duplicates are allowed. Toy types and optional nonpertinence
codes remain strings; no current family/definition/option/unit/variant membership
or family-specific axis restrictions are imposed.

Per [approved historical policy §5](catalog-editorial-production-vocabulary-contract-proposal.md),
duplicates, family-null values/facts, product-owned non-null variants, reversed
ranges and dangling care references remain readable conflicts. Blank strings,
lone surrogates, malformed dates and over-fresh-limit strings/counts are preserved.
No fresh evidence predicate, canonical serializer, current metadata, normalization,
repair, storage write, adoption, receipt, permission or activation is involved.
Fresh save/publication and future transport composition remain separate gates.
