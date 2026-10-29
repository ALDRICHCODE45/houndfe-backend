# Dormant vocabulary GET header admission

`parseEditorialVocabularyHeaders(rawHeaders: readonly string[]): 1 | 2` is a pure,
unwired helper for vocabulary GET only. It consumes Node-style framework-parsed
alternating name/value pairs, preserving duplicates; do not pass a collapsed header
object. Names match exactly after lowercase; values are never trimmed or normalized.

## Admission rules

| Input                                                                   | Outcome                                                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Version absent or one exact `Editorial-Contract-Version: 1`             | Return `1`                                                                                                                             |
| One exact `Editorial-Contract-Version: 2`                               | Return `2` unless a prohibited header occurs                                                                                           |
| Any other version value, list or duplicate (even identical/case-varied) | Throw `EditorialVocabularyHeaderError`: code/message `UNSUPPORTED_EDITORIAL_CONTRACT`, statusCode `406`, normalizedVersion `undefined` |
| V2 with any revision/adoption/care-confirmation/idempotency header      | Throw the same class: code/message `MALFORMED`, statusCode `400`, normalizedVersion `2`                                                |

The prohibited names are `Editorial-Vocabulary-Revision`, `Editorial-Adoption`,
`Editorial-Care-Confirmation` and `Idempotency-Key`. Any occurrence counts, including
empty, whitespace, list and duplicate values. V1 ignores these headers completely.
Unknown headers are ignored in both versions. Version negotiation finishes first:
an invalid version wins over prohibited headers regardless of pair order.

```ts
parseEditorialVocabularyHeaders([]); // 1
parseEditorialVocabularyHeaders(['editorial-contract-version', '2']); // 2
parseEditorialVocabularyHeaders(['Editorial-Contract-Version', ' 2']); // throws 406 metadata
```

## Boundaries and deferred wiring

Inputs and stored data are not mutated. Non-array, odd-length or non-string pair
inputs throw `TypeError`: internal programmer misuse, not client 406 negotiation.
This is not a general HTTP syntax parser or a security/authentication guard.

The error properties are metadata, not an HTTP response. A future adapter must keep
`{statusCode,error}`, send normalized version only when known, and send no revision
header on errors. No controller, filter, DI, CORS, authentication or authority wiring
is implemented; no endpoint behavior or activation is claimed. Atomic V2 activation
still waits for T3d/T3f compatibility. Document and write admission are out of scope.
See [contract §3](catalog-editorial-production-vocabulary-contract-proposal.md#3-exact-proposed-headers-and-admission-order).
