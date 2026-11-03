# Supplier HTTP contract (O3a A2–A3, D1 deletion)

`SuppliersModule` registers the five supplier routes in the normal `AppModule`.
This is source-level integration, **not a runtime/API-ready claim**: disposable SQL proof, isolated runtime and FE E2E remain parent-owned gates. The closed parsers live in `src/procurement/suppliers/supplier-contract.ts`; no shared editorial/human-decisions helpers were changed.

## Routes and authority

| Route | Persisted permission | Success |
| --- | --- | --- |
| `GET /procurement/suppliers?status=…` | `read:ProcurementSupplier` | `200 SupplierPage` |
| `POST /procurement/suppliers` | `create:ProcurementSupplier` only | original `201 Supplier` |
| `GET /procurement/suppliers/:supplierId` | `read:ProcurementSupplier` | `200 Supplier` |
| `PATCH /procurement/suppliers/:supplierId` | `read:ProcurementSupplier` + `update:ProcurementSupplier` | original `200 Supplier` |
| `DELETE /procurement/suppliers/:supplierId` | `read:ProcurementSupplier` + `delete:ProcurementSupplier` | original `204`, empty wire body |

No history, purchase-order or stock routes. Archive/reactivate use PATCH. No default human-role grants. Ordinary JWT → tenant CLS → PermissionsGuard conventions apply; actor/tenant never come from caller body/query. Current persisted active tenant/user, membership and grants are additionally checked on each query/command, under the feature-owned lifecycle → Tenant SHARE → user/grant-edge SHARE lock order. JWT claims, super-admin claims and cached abilities do not replace that check. Existing `manage:all` CASL implication is preserved. Details return tenant-qualified 404 only after authority; archived detail remains readable.

Queries perform bounded SELECTs only: no version changes, receipt/audit creation, stock, payment, CxP or outbox effects. Commands retain the previously implemented atomic CAS/audit/receipt protocol and original-response replay after current authority. No backend resubmit or hidden retry. HTTP 401 refresh/recovery is external FE behavior; preserve the same exact key/body for deliberate recovery, never automatically refresh CAS.

## Bodies and responses

- `SupplierInput`: exactly required `displayName`, `termsText`, `status`.
  Name is nonblank and at most 200 Unicode codepoints; terms are null or text of at most 4000 codepoints (empty text allowed). Status is exactly `ACTIVE` or `ARCHIVED`.
- `SupplierUpdate`: exactly `expectedVersion` (number, positive safe integer) and `changes` (nonempty subset of input fields). Omission preserves; null clears only terms. Archive/reactivate are explicit status patches. No automatic retries or CAS refresh.
- `SupplierDelete`: exactly `{expectedVersion}` (number, positive safe integer). DELETE requires `Content-Type: application/json` (charset parameter allowed), no query fields, and the same exact single raw Idempotency-Key policy as POST/PATCH. Unknown fields and repeated raw JSON members (including escaped equivalent names) are rejected, not collapsed. ACTIVE and ARCHIVED are both deletable. The response is `204` with zero body bytes, not JSON `null`, and `Cache-Control: no-store`.
- Stored name/terms are never trimmed, whitespace-collapsed or Unicode-normalized. Technical PostgreSQL UTF-8 policy rejects U+0000 and unpaired UTF-16 surrogates rather than silently replacing them. Other controls are not stripped; valid supplementary codepoints count once.
- Records must have ordinary/null prototypes and own enumerable data properties. Unknown fields, symbols, hidden fields, accessors, explicit undefined and wrong types fail closed. Outputs are detached. Duplicate JSON members cannot be detected after JSON decoding; POST/PATCH keep that existing limitation. DELETE additionally rejects repeated members in its feature-scoped raw JSON parser before decoding.
- `Supplier`: input plus server UUID `id`, positive `version`, UTC ISO 8601 string `createdAt`/`updatedAt`. `SupplierPage`: `{ items: Supplier[], nextCursor: string | null }`, no totals. These are response types, not runtime response serializers.
- `parseSupplierId`: existing human-decisions policy, trim/lowercase UUID v1–v8 with variant 8/9/a/b; reject nil/invalid. UUID generation remains server-owned.

## List query

`parseSupplierListQuery` accepts only required `status=ACTIVE|ARCHIVED|ALL`, optional `search`, `limit`, `cursor`. Unknown keys and repeated scalar arrays/objects are rejected; callers must pass uncoerced framework query values, not collapse duplicates first.

Search trims edges only; blank means no filter. The effective term is at most 200 Unicode codepoints; NUL and lone surrogates are rejected before trimming. Case and interior whitespace are preserved. The reader implements **literal case-insensitive name contains** using parameterized PostgreSQL ILIKE with explicit escape handling for `%`, `_` and `\`. Unicode case behavior follows the database collation; no Unicode normalization is performed.

Limit defaults to 25 only when omitted. Supplied limits must be decimal strings `1`–`100`, without sign, leading zeros, whitespace, exponents or coercion. Cursor must be a nonempty string and is otherwise passed through opaquely. The reader validates tenant/resource/effective-search/status binding, then applies descending `(createdAt,id)` keyset pagination. It fetches at most `limit+1`, returns at most `limit` items and uses the last returned position for `nextCursor` only when another row was observed; no COUNT or inferred totals. Changing limit is permitted. Pages are not a snapshot: concurrent edits can change filter membership. No synthetic pagination fields are returned.

Cursors use a versioned, canonical base64url payload and domain-separated HMAC-SHA256 using the existing `JWT_SECRET` configuration, with no new secret. They bind the exact trimmed search (including case), tenant, supplier resource and status; they are neither credentials nor encrypted data. Invalid encoding, signature, timestamp/UUID, version or scope is `400 MALFORMED`. Secret rotation invalidates outstanding cursors; restart listing explicitly. Clients must treat the value as opaque.

## Idempotency key and canonical hash

`parseSupplierIdempotencyKey(rawHeaders)` requires exactly one case-insensitive `Idempotency-Key` name/value pair, 1–200 characters, for POST/PATCH/DELETE callers. Duplicate pairs are rejected even if identical. Do not use a joined headers lookup. Commas are valid content, not a duplicate delimiter.

Policy evidence: `src/catalog-editorial/http/idempotency-key.ts` preserves decoded whitespace with no UUID grammar. Supplier parsing additionally uses Node's `node:http.validateHeaderValue`: HTAB, space, visible ASCII and Latin-1 U+0080–U+00FF are accepted; other C0, DEL, CR/LF and characters above U+00FF are rejected. No trimming, case folding or UUID restriction. These are decoded Node header values, not original socket bytes; transport intermediaries may remove surrounding whitespace before admission. FE should use a transport-stable opaque key and reuse the exact same value/body only for deliberate recovery, never automatic retries.

`hashSupplierBody('create'|'update'|'delete', unknown)` first parses the appropriate closed body, then hashes UTF-8 `JSON.stringify` bytes with SHA-256 (lowercase 64 hex digits). Fixed schema field order: input/patch `displayName`, `termsText`, `status`; update `expectedVersion`, `changes`; delete `expectedVersion`. Omitted patch keys stay absent. This is independent of incoming object key order and preserves exact string content, omission versus null, and CAS. No Unicode normalization. Idempotency keys are not part of the body hash and are not normalized. The command receipt namespace separately binds tenant, actor, operation, target and key; a body hash alone provides no authority or replay protocol.

## Errors and transport admission

`SupplierContractError` and `supplierErrorEnvelope` provide exactly `{ statusCode, error }`, never raw values/driver errors. Parser failures become `400 MALFORMED`; unexpected errors map to `500 INTERNAL_ERROR`.

| Status | Error                                                                          |
| ------ | ------------------------------------------------------------------------------ |
| 400    | MALFORMED                                                                      |
| 401    | UNAUTHORIZED                                                                   |
| 403    | FORBIDDEN                                                                      |
| 404    | NOT_FOUND                                                                      |
| 409    | SUPPLIER_VERSION_CONFLICT, IDEMPOTENCY_KEY_CONFLICT, IDEMPOTENCY_KEY_IN_FLIGHT |
| 500    | INTERNAL_ERROR                                                                 |

`409 SUPPLIER_HAS_PURCHASE_ORDERS` is reserved for O3b, not emitted/enforced in O3a: no purchase-order table or reference-count query exists. O3b must add a tenant-qualified restrictive FK from purchase orders to live suppliers, and deliberate eligibility/error mapping; this change does not claim reference coverage. Supplier responses use `Cache-Control: no-store`, including guard denials, malformed admission and unexpected failures. The feature filter maps guard errors to this closed vocabulary and never emits messages, driver details or rejected values.

GET accepts no body; detail and mutation queries must be empty. POST/PATCH/DELETE admit uncoerced closed bodies and a single raw Idempotency-Key before calling commands. Primitive JSON, malformed syntax/encoding, oversized bodies and invalid encoded path parameters return `400 MALFORMED`, not a new 413 vocabulary. The supplier-only parser is installed after CORS and before Nest initialization; early failures retain CORS headers. It matches the actual Express case-insensitive/optional-trailing-slash collection GET/POST and detail GET/PATCH/DELETE paths (including automatic HEAD-for-GET semantics), not nearby siblings/history/other verbs. Other routes keep their existing parsers. Parser failures precede guards, as in Nest's default transport; successfully decoded requests still pass all guards. No broad DTO coercion or global parser/filter/CORS policy change.

## Permanent deletion and recovery

Fresh DELETE locks the tenant-qualified operational row and checks expectedVersion and the PostgreSQL INTEGER ceiling (2147483647), then conditionally removes that row only. A deletion at the ceiling is `409 SUPPLIER_VERSION_CONFLICT` because its audit version would overflow. Earlier audits/receipts and scalar supplier IDs survive. The deletion audit stores actor, operation, audit timestamp, prior fields/timestamps and deletion version `previous+1`; see the storage snapshot definition. No stock/money/CxP/outbox effects or automatic retries.

Same tenant/actor/operation/target/key + same body replays `204` after current persisted read+delete authority, even when the supplier is gone; different body is `409 IDEMPOTENCY_KEY_CONFLICT`. A new key on missing/foreign supplier is `404 NOT_FOUND` after authority. CREATE/UPDATE historical responses still replay unchanged after deletion under their own current permissions. A retained receipt is not a live-resource read or permission grant. No default delete role grants are added.

See [verification evidence and remaining gates](procurement-suppliers-api-verification.md).
