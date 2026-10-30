# Dormant vocabulary GET header admission

`parseEditorialVocabularyHeaders(rawHeaders: readonly string[]): void` is a pure,
unwired admission-only helper for vocabulary GET. It consumes framework-parsed
alternating name/value pairs, preserving duplicates; do not pass a collapsed header
object. Names match exactly after lowercase; values are never normalized.

## Admission rules

Headerless requests pass. Any occurrence of `Editorial-Contract-Version`,
`Editorial-Vocabulary-Revision`, `Editorial-Adoption`,
`Editorial-Care-Confirmation` or `Idempotency-Key` throws
`EditorialVocabularyHeaderError`: code/message `MALFORMED`, statusCode `400`.
This includes version `1` or `2`, malformed, empty, list and duplicate values.
There is no version negotiation, 406 response or ignored legacy semantic header.
Unrelated framework-parsed headers are ignored without HTTP syntax validation.

## Boundaries and deferred wiring

Inputs and stored data are not mutated. Non-array, odd-length or non-string pair
inputs throw `TypeError`: internal programmer misuse, not client admission errors.
The error properties are metadata, not an HTTP response. The response helper sends
constant informational version `2` and no revision on errors.
No controller, filter, DI, CORS, authentication or authority wiring is implemented;
no endpoint behavior or activation is claimed. Document/write admission is outside
this unit. See [target contract §2](catalog-editorial-single-contract.md#2-http-surface-and-authority).
