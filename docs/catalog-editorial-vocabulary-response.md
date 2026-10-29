# Dormant vocabulary response descriptions

`createEditorialVocabularyHttpResponse(source, rawHeaders)` composes header admission and the existing read composition. It returns `{statusCode,headers,body}` without invoking HTTP. The caller must already have completed current authentication and authority checks.

## Response contract

- Every descriptor sends `Cache-Control: no-store`.
- Success preserves the read result by identity: V1 is unwrapped with version `1` and no revision; V2 sends version `2` and the exact envelope revision.
- Header admission failures prevent reads. Typed header errors select 400/406 and their known version; programmer input failures select generic 500 without a version.
- After negotiation, errors retain the known version. Only the typed application unrepresentable error on V2 selects S27's `EDITORIAL_VOCABULARY_UNREPRESENTABLE`; all other read failures select `INTERNAL_ERROR`, including source-thrown header errors and V1-injected V2 errors.
- Error bodies contain exactly `{statusCode,error}`. No error revision, document, exception message or cause is exposed. This outward translation intentionally differs from application-layer identity propagation.

## Proof limits

Tests cover S2/S23/S27/S29 dormant composition, exact descriptors, success identity, admission ordering, secrecy and call-local state. They do not prove registered HTTP, CORS or activation. Existing controllers, filters and authentication remain unchanged; storage, adoption and full-production admission are outside this unit.
