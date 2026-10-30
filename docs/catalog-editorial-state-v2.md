# Fresh editorial state V2 composition

`createEditorialStateV2(vocabularyRevision, input)` returns the closed S35 §8
`StateResponse`: `contractVersion: 2`, the unchanged vocabulary revision and
`EditorialStateV2`. Present draft/published slots contain direct `DocumentShapeV2`
documents, never `{mode, document}` wrappers. Counters and nullable slots are
preserved explicitly; a null document is invalid, not an absent slot.

## Preconditions and preservation

The caller supplies already-decoded finite, acyclic JSON data trees, an admitted
vocabulary revision and well-formed persisted counters and archived-option
warnings. This is typed composition, not an unknown-input parser or a storage
validity check. It adds no caps, revision admission or fresh domain checks.

Each present document must pass the existing current-contract structural/static-axis
recognizer. Legacy, future, malformed and wrapped documents reject the whole
composition with `TypeError('Expected an editorial document V2')`; nothing is
converted, wrapped, omitted or downgraded. Unexpected failures propagate unchanged.
Recognized documents are recursively copied, not reconstructed from parsed output.
Strings, negative zero and array order survive in detached trees; shared children
are copied independently. Historical relational conflicts do not become fresh-policy
failures. Nonempty warnings are copied field by field in order; absent or empty
warnings are omitted, never recomputed.

## Boundary

This dormant helper composes **fresh responses only**, not receipt replay.
Replay must preserve recorded warnings rather than rebuild them.
No metadata, authority, persistence, HTTP, adoption, receipt lookup, status or
attestation behavior is implemented. No stored state is migrated or activated.
