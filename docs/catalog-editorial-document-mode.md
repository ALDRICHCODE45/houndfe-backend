# Historical editorial document modes

`classifyEditorialDocumentMode(document: EditorialDocumentJson)` returns only
`legacy`, `production-v2` or `unsupported`. It is a dormant historical decoder
(contract §5, T3d S2), not save/publish admission or activation.

`EditorialDocumentJson` recursively represents null, booleans, numbers, strings,
arrays and string-keyed objects. Callers must supply already-decoded JSON with
finite numbers; TypeScript's `number` cannot express finiteness. Transport
validation belongs to the caller. Undefined, functions and cycles are outside
this API; it is not an unknown-input JSON-tree validator.

- No own `schemaVersion`: `legacy`, including `{}`, malformed unversioned objects,
  scalars, arrays and JSON null. Legacy adoptability is a separate gate; `{}` is
  legacy but not recognizable for adoption. Null state-slot absence is the caller's
  responsibility, not a fourth mode.
- Own numeric `schemaVersion` exactly `2` (including `2.0`) plus the existing
  `isRecognizableDocumentV2` gate: `production-v2`.
- Other explicit versions or malformed versioned shapes: `unsupported`.

Historical V2 conflicts, stale/unknown references and fresh-invalid strings stay
production V2 when structurally recognizable; invalid static axis codes do not.
No current metadata or fresh validation is consulted. The classifier does not
clone, mutate, reorder, prune, normalize or convert the supplied JSON.

Version inspection uses an own property descriptor rather than invoking a getter.
As defensive behavior beyond decoded JSON, accessor versions are unsupported and
inherited versions do not count. Unexpected reflection/recognizer failures
propagate unchanged; none are converted to a mode. Existing helpers, readers,
receipts and transport remain unchanged.
