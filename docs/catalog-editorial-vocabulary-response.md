# Dormant vocabulary response descriptions

`createEditorialVocabularyHttpResponse(source, rawHeaders)` composes header admission and the existing read composition. It returns `{statusCode,headers,body}` without invoking HTTP. The caller must already have completed current authentication and authority checks.

## Response contract

- Every call creates its own headers with `Cache-Control: no-store` and informational `Editorial-Contract-Version: 2` before parsing, including internal-input failures.
- Headerless requests explicitly call `readEditorialVocabulary(source, 2)` once and await it. Success preserves the full canonical envelope by identity and sends its exact revision.
- Any occurrence of the five prohibited request headers selects `400 MALFORMED` before reading; internal raw-pair input failures select `500 INTERNAL_ERROR`. No negotiation or 406 remains.
- Only the typed application unrepresentable error selects `500 EDITORIAL_VOCABULARY_UNREPRESENTABLE`; other read failures select `500 INTERNAL_ERROR`, including source-thrown header/representation errors.
- Error bodies contain exactly `{statusCode,error}`. No error revision, document, exception message or cause is exposed. This outward translation intentionally differs from application-layer identity propagation.

## Proof limits

Tests cover S35/S37 dormant composition, exact descriptors, success identity, admission ordering, secrecy, frozen inputs and interleaved call-local headers. They do not prove registered HTTP, CORS or activation. Existing controllers, filters and authentication remain unchanged; storage and full-production admission are outside this unit. The application-layer V1 branch remains unused by this helper pending separate retirement; this is not full V1 cleanup. See [target contract §2](catalog-editorial-single-contract.md#2-http-surface-and-authority).
