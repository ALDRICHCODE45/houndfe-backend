# Supplier wire foundation (O3a A2, first subunit)

Pure exported functions in `src/procurement/suppliers/supplier-contract.ts` only.
**No supplier route/API availability, authority, database execution or replay guarantee is asserted by this unit.** Future controllers must call these parsers before using their results; no shared editorial/human-decisions helpers were changed.

## Bodies and responses

- `SupplierInput`: exactly required `displayName`, `termsText`, `status`.
  Name is nonblank and at most 200 Unicode codepoints; terms are null or text of at most 4000 codepoints (empty text allowed). Status is exactly `ACTIVE` or `ARCHIVED`.
- `SupplierUpdate`: exactly `expectedVersion` (number, positive safe integer) and `changes` (nonempty subset of input fields). Omission preserves; null clears only terms. Archive/reactivate are explicit status patches. No automatic retries or CAS refresh.
- Stored name/terms are never trimmed, whitespace-collapsed or Unicode-normalized. Technical PostgreSQL UTF-8 policy rejects U+0000 and unpaired UTF-16 surrogates rather than silently replacing them. Other controls are not stripped; valid supplementary codepoints count once.
- Records must have ordinary/null prototypes and own enumerable data properties. Unknown fields, symbols, hidden fields, accessors, explicit undefined and wrong types fail closed. Outputs are detached. Duplicate JSON members cannot be detected after JSON decoding; this parser makes no such guarantee.
- `Supplier`: input plus server UUID `id`, positive `version`, UTC ISO 8601 string `createdAt`/`updatedAt`. `SupplierPage`: `{ items: Supplier[], nextCursor: string | null }`, no totals. These are response types, not runtime response serializers.
- `parseSupplierId`: existing human-decisions policy, trim/lowercase UUID v1–v8 with variant 8/9/a/b; reject nil/invalid. UUID generation remains server-owned.

## List query

`parseSupplierListQuery` accepts only required `status=ACTIVE|ARCHIVED|ALL`, optional `search`, `limit`, `cursor`. Unknown keys and repeated scalar arrays/objects are rejected; callers must pass uncoerced framework query values, not collapse duplicates first.

Search trims edges only; blank means no filter. The effective term is at most 200 Unicode codepoints; NUL and lone surrogates are rejected before trimming. Case and interior whitespace are preserved. The future reader must implement **literal case-insensitive name contains**, including escaping SQL LIKE `%`, `_` and `\` as needed; this pure parser does not execute search.

Limit defaults to 25 only when omitted. Supplied limits must be decimal strings `1`–`100`, without sign, leading zeros, whitespace, exponents or coercion. Cursor must be a nonempty string and is otherwise passed through opaquely. Later reader work must decode/validate tenant/resource/search/status binding, descending `(createdAt,id)` pagination and invalid cursor errors; this function cannot authorize a cursor.

## Idempotency key and canonical hash

`parseSupplierIdempotencyKey(rawHeaders)` requires exactly one case-insensitive `Idempotency-Key` name/value pair, 1–200 characters, for future POST/PATCH callers. Duplicate pairs are rejected even if identical. Do not use a joined headers lookup. Commas are valid content, not a duplicate delimiter.

Policy evidence: `src/catalog-editorial/http/idempotency-key.ts` preserves decoded whitespace with no UUID grammar. Supplier parsing additionally uses Node's `node:http.validateHeaderValue`: HTAB, space, visible ASCII and Latin-1 U+0080–U+00FF are accepted; other C0, DEL, CR/LF and characters above U+00FF are rejected. No trimming, case folding or UUID restriction. These are decoded Node header values, not original socket bytes; transport intermediaries may remove surrounding whitespace before admission. FE should use a transport-stable opaque key and reuse the exact same value/body only for deliberate recovery, never automatic retries.

`hashSupplierBody('create'|'update', unknown)` first parses the appropriate closed body, then hashes UTF-8 `JSON.stringify` bytes with SHA-256 (lowercase 64 hex digits). Fixed schema field order: input/patch `displayName`, `termsText`, `status`; update `expectedVersion`, `changes`. Omitted patch keys stay absent. This is independent of incoming object key order and preserves exact string content, omission versus null, and CAS. No Unicode normalization. Idempotency keys are not part of the body hash and are not normalized. The future receipt namespace must separately bind tenant, actor, operation, target and key; a body hash alone provides no authority or replay protocol.

## Errors and later HTTP obligations

`SupplierContractError` and `supplierErrorEnvelope` provide exactly `{ statusCode, error }`, never raw values/driver errors. Parser failures become `400 MALFORMED`; unexpected errors map to `500 INTERNAL_ERROR`.

| Status | Error                                                                          |
| ------ | ------------------------------------------------------------------------------ |
| 400    | MALFORMED                                                                      |
| 401    | UNAUTHORIZED                                                                   |
| 403    | FORBIDDEN                                                                      |
| 404    | NOT_FOUND                                                                      |
| 409    | SUPPLIER_VERSION_CONFLICT, IDEMPOTENCY_KEY_CONFLICT, IDEMPOTENCY_KEY_IN_FLIGHT |
| 500    | INTERNAL_ERROR                                                                 |

No purchase-order eligibility errors. Future HTTP integration owns authentication/current authority, no-store on success/errors, status codes (create 201; update/detail/list 200), and sanitized filter mapping. There are no controller/service/permission edits, timing protocol, stock, money or CxP effects in this foundation.
