# Identify intentional document-shape rejection

`EditorialDocumentShapeError` tags deliberate closed-wire-shape rejection in the
V2 document, value, known-payload, evidence, sellable-facts, declaration, care
capture and both care-entry parsers. It extends `TypeError` without overriding
`name`: existing messages, `name === 'TypeError'` and `Error`/`TypeError` ancestry
remain unchanged. Constructor/prototype identity intentionally changes.

## Narrow future handling

A future boundary may distinguish intentional rejection with
`error instanceof EditorialDocumentShapeError`. Do not catch all `TypeError`s or
compare messages: unexpected reflection failures can be ordinary `TypeError`s
with the same message. Unexpected thrown values propagate unchanged, including
proxy traps and revoked-proxy engine errors. Nested deliberate failures retain
the originating parser's message and typed tag.

This is distinct from `EditorialVocabularyRepresentationError` and
`CanonicalEditorialJsonError`; neither vocabulary representation nor canonical
JSON rejection is a document-shape tag.

## Scope

Only deliberate `invalid()` throws are tagged. Accepted outputs, detachment and
shape rules are unchanged; `isFreshEvidenceV2` is untouched. This prerequisite
adds no catch boundary, historical-mode recognizer, fresh-admission rule,
transport mapping or activation. Passing a shape parser does not prove historical
recognizability, relational consistency or publication eligibility.
