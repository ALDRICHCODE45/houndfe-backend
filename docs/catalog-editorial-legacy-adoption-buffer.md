# Unsaved legacy adoption buffer

`createLegacyAdoptionBuffer(input: unknown): DocumentShapeV2` is a pure,
explicit opt-in helper for preparing an **unsaved local buffer** (contract §5).
The server MUST NOT call it automatically during reads, initialize or writes.
It does not alter stored history or activate V2.

The existing `isRecognizableLegacyDocument` gate runs first. Rejection throws
`TypeError('Expected a recognizable legacy document')`; unexpected reflection
failures propagate unchanged, even same-message TypeErrors and non-Error values.
Legacy-mode `{}` is not adoptable; versioned V2 and unsupported inputs fail too.

The new mutable, detached buffer preserves title, description, media, family,
value order, code, owner, variant and all five legacy payload branches exactly.
It wraps values as known with null evidence and adds schemaVersion 2 and empty
facts. Number units, including null, fractions and negative zero survive unchanged.
Media and multi arrays are independent of the input and every other call.
No trimming, sorting, normalization, alias translation, owner conversion, unit
repair, range inference, evidence or known-facts invention occurs.

Historical unknown/deleted references and strings outside fresh limits remain.
The buffer is **not freshly valid or save-authorized**. Manual remediation and
current validation remain necessary before a separately authorized fresh save.
This helper adds no storage, initialize/read/controller integration, adoption
headers, CAS, authentication, publication or permission behavior.
