# Decode historical graph integrity, not compatibility

`decodeHistoricalVocabularyGraph(unknown)` is dormant and returns its own `HistoricalVocabularyGraph`, never `VocabularyReadSnapshot`. It does not call or supply a conversion to the V1 projector.

## Established boundary

- Required family/definition arrays; exact string identities and labels, including blanks, without normalization or sorting.
- Independent ID/code uniqueness, versions 1/2, six known definition tags, and all bindings including V2 families.
- Local binding ID/code uniqueness, exact parent and actual-definition ID/code references, persisted owners and integer order.
- Selected own data properties only: accessors are rejected without invocation; irrelevant columns are ignored, not admission gates.
- Detached selected JSON data, preserving null versus absence and reader order. Guard/introspection failures propagate without catch-and-replacement.

## Deliberately untrusted

Policy/numericPolicy remain unknown, including null, pending, resolved and unfamiliar JSON. Nothing defaults to pending or proves S18 compatibility. Units/options must be arrays because the raw query always supplies them, but selected leaf fields remain unknown; malformed JSON-valued leaves are not certified safe. Unknown future columns, metadata, exposure, searchability, groups and aliases are not returned. Raw policy payloads themselves remain intact.

The next compatibility composition must classify eligible V1 definitions, validate their selected leaves and parent identities, translate unitCode and archivedAt, and establish every projector precondition. Omitted-only or unbound advanced definitions are not subjected to strict V2 leaf/policy admission here.

T3c S2 supplies only this structural prerequisite; S18 classification and S19 full-production validation remain separate. An unknown input cannot prove snapshot completeness, database coherence or write stability: callers owe provenance. No activation, adoption or publication authority is granted.
