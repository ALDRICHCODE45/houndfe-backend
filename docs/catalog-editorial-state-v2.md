# Fresh editorial state V2 composition

`createEditorialStateV2(vocabularyRevision, input)` returns the closed §5
`StateV2` wrapper: `contractVersion: 2`, the unchanged vocabulary revision and
`EditorialStateV2`. `RawStoredEditorialStateV2` accepts raw draft/published JSON,
not legacy-only documents. Counters and nullable slots are preserved explicitly.
A present slot containing document `null` has a legacy document view; it is not
an absent slot.

## Preconditions and preservation

The caller supplies already-decoded finite, acyclic JSON data trees, an admitted
vocabulary revision and well-formed persisted counters and archived-option
warnings. This is typed composition, not an unknown-input parser or a storage
validity check. It adds no caps, revision admission or fresh domain checks.

Each present document uses the existing historical mode classifier independently.
Legacy, production-v2 and unsupported data are recursively copied without
serialization, normalization or conversion. Strings, negative zero, array order
and unknown keys (including own `__proto__`) survive in detached trees. Production
data is not parsed again or reconstructed. Historical relational conflicts do
not become fresh-policy failures. Nonempty warnings are copied field by field in
order; absent or empty warnings are omitted, never recomputed.

## Boundary

This dormant helper composes **fresh responses only**, not receipt replay.
Replay must preserve recorded modes and warnings rather than classify again.
No metadata, authority, persistence, HTTP, adoption, receipt lookup, status or
attestation behavior is implemented. Existing helpers remain unchanged.
