# Historical V1 composition

The dormant `projectHistoricalVocabularyV1(unknown)` validates the complete historical graph before shared binding selection and explicitly constructs legacy fields. It does not call the trusted-snapshot projector.

## Trust boundary

Retained bindings require present null or exact pending policy; emitted numbers require present null or exact pending numeric policy. Retained ranges or resolved numbers fail the whole call. Omitted-only payloads are not semantically admitted. Originally unbound resolved numbers are classified by persisted primitive shape and excluded without unit admission, not parsed by strict V2 rules.

Emitted units and options require exact parent/type relations, required primitives and local code uniqueness; emitted unit IDs are globally unique. Archive state derives from raw null versus string, including the empty string. Copies preserve blank strings, nulls and reader order.

## Limits

This is not full-production admission, adoption, publication safety or V2 activation. Unknown input cannot prove that the original observation was complete or coherent; provenance remains the caller's obligation. Existing readers, SQL, graph decoder, shared selection and trusted projector stay unchanged.

The historical copier intentionally repeats explicit legacy fields: unlike the trusted-snapshot projector, it admits unknown leaf data. Only complete-graph binding selection is shared. It neither sorts nor fabricates publication checks, semantics versions or family metadata. Any retained contradiction or invalid emitted leaf rejects the whole call, never a partial/pruned response.
