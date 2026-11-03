# Purchase-order drafts HTTP contract — O3b T4

`PurchaseOrdersModule` is registered in `AppModule`; its scoped parser mounts in `main.ts` after CORS and before Nest initializes default parsers. This is source-level wiring, **not runtime/API-ready or PostgreSQL proof**. T5 owns a newly disposable database and FE runtime verification. No database was touched by this slice.

## Routes and authority (S2, S11)

All routes use JWT authentication → trusted tenant CLS → PermissionsGuard. No actor, tenant or grants are accepted from request bodies/query. Queries and commands independently recheck persisted active tenant/user, membership and grant edges on every invocation; cached JWT abilities and super-admin claims do not replace that check. Existing CASL `manage:all` implication remains.

| Route | Required permissions | Response |
| --- | --- | --- |
| `GET /procurement/purchase-orders` | read PO | 200 `Page<PurchaseOrderSummary>` |
| `POST /procurement/purchase-orders` | create PO + read supplier + read Product | 201 `PurchaseOrder` |
| `GET /procurement/purchase-orders/:orderId` | read PO | 200 `PurchaseOrder` |
| `PUT /procurement/purchase-orders/:orderId/draft` | read + update PO + read supplier + read Product | 200 `PurchaseOrder` |
| `DELETE /procurement/purchase-orders/:orderId` | read + delete PO | 204, **zero response bytes**, no JSON null |

PO means `ProcurementPurchaseOrder`, supplier means `ProcurementSupplier`. GET needs no catalog/supplier grants. POST does not require read PO. DELETE needs no reference grants. No default grants, confirm/cancel/history routes, stock/reservation/money/CxP/outbox integration, or product-selector changes are introduced (S14).

## Admission and errors (S2, S12)

Every routed success or error carries `Cache-Control: no-store`, including guard denials and early body-parser failures. Early errors preserve CORS headers. Parser failures occur before guards, matching Nest's normal transport ordering. Unsupported paths/verbs retain existing default behavior; this is not a global error-policy change.

- GET has no body (including unparsed media/chunked streams). Detail and mutation queries must be empty.
- POST/PUT/DELETE require `Content-Type: application/json` (charset allowed), exactly one case-insensitive raw `Idempotency-Key` header, 1–200 characters, and the T2 closed body parser. The controller uses `rawHeaders`, never a joined header lookup. Exact key content, including commas and observed whitespace, is forwarded. Node/intermediaries may strip transport whitespace; use a transport-stable opaque key.
- POST body is `OrderInput`; PUT is `{expectedVersion, order: OrderInput}` (full replacement, including lines); DELETE is exactly `{expectedVersion}`. No DTO coercion, silent trimming, extra fields, implicit cost/tax defaults or request-controlled response snapshots.
- Primitive, malformed, oversized and invalidly encoded JSON/path input becomes `400 MALFORMED`, never a new 413 vocabulary or a raw parser snippet. The scoped parser uses Express's existing default 100 KiB JSON limit. DELETE rejects duplicate raw member names, including escaped-equivalent spellings. Like supplier POST/PATCH, PO POST/PUT do not add nested duplicate-member detection; decoded closed parsing cannot recover duplicate raw members.
- The PO-only parser matches exact collection GET/HEAD/POST, detail GET/HEAD/DELETE and `/:orderId/draft` PUT, case-insensitively with optional trailing slash. Supplier parser code is unchanged; both parsers are exercised together with supplier and unrelated-route regression requests.

The closed envelope is **exactly** `{statusCode, error}`, with no message, values or driver details:

| Status | Error |
| --- | --- |
| 400 | MALFORMED |
| 401 | UNAUTHORIZED |
| 403 | FORBIDDEN |
| 404 | NOT_FOUND |
| 409 | ORDER_VERSION_CONFLICT, SUPPLIER_ARCHIVED, IDEMPOTENCY_KEY_CONFLICT, IDEMPOTENCY_KEY_IN_FLIGHT |
| 500 | INTERNAL_ERROR |

Mutation acknowledgements are forwarded unchanged from [the command protocol](procurement-po-drafts-commands.md). Same tenant/actor/operation/target/key/body replays the original status/body after current authority. No hidden retries, CAS refresh, or new receipt protocol. DELETE uses `response.end()` rather than serializing its internal null body.

## Detail and diagnostics (S4, S8)

`PurchaseOrderQueries.getDraft(id)` normalizes the UUID, checks current authority, then reads only a tenant-qualified DRAFT. Missing/foreign is 404 after authority. It reconstructs the entire S4 DTO from stored header and ordered line columns, preserving null versus a present partial informed-cost object, exact decimal strings, original note/location content and saved version/timestamps. Actor and storage-only fields are not exposed.

Current same-tenant reference facts feed the **same** `buildPurchaseOrderDiagnostics` used by commands: stable path/code ordering, incomplete drafts allowed, exact unrounded subtotals, no order total. Current valid labels refresh in the response only; invalidated retained lines keep saved names/unit, missing suppliers keep their last snapshot, archived suppliers show current archive status. Current tenant name supplies the response location snapshot. Nothing is persisted by GET: no version/timestamp changes, audits, receipts, evidence replay or baseline rewrite.

### Read consistency and lock choice

Reads own a `ReadCommitted` transaction, reject ambient transactions, and follow supplier-query lifecycle shared → Tenant SHARE → current user/grant-edge SHARE ordering. **No order, supplier, product or variant row locks** are taken. The command-oriented `readPurchaseOrderReferences` is deliberately not called because it takes supplier/Product UPDATE locks, exceeding the supplier query precedent. Instead the query layer batches the same selected fields and fact/label rules in at most three tenant-qualified reference SELECTs.

A single header SELECT correlates tenant-qualified ordered `jsonb_agg` lines, so a concurrent full replacement cannot pair one header version with another version's lines. Reference facts are live observations from subsequent bounded SELECTs, not a globally frozen catalog snapshot; a concurrent catalog change may appear on this request or the next. GET remains nonmutating. No stronger snapshot or write serialization is promised.

## List and cursor (S13)

`GET /procurement/purchase-orders?supplierId=…&search=…&limit=…&cursor=…` accepts only these optional parameters. Supplier IDs use the same UUID parser; unknown/repeated/structured scalar parameters fail closed. Limit defaults to 25 and accepts canonical decimal strings 1–100, not coercion, signs, leading zeros or blanks.

Per L7 («Búsqueda en el servidor por proveedor y nota (recomendado)»), search matches the **current supplier displayName OR draft note**, combined with supplierId using AND. A tenant-qualified LEFT JOIN on supplier tenantId + id preserves supplierless drafts, which can match only by note. Saved supplier display snapshots are never searched. Matching is literal case-insensitive contains via parameterized PostgreSQL ILIKE, escaping `%`, `_` and `\`; database collation determines Unicode case behavior.

Search follows supplier admission exactly: reject NUL/lone surrogates before trimming, trim edges only, blank/whitespace means absent, and reject an effective term over 200 Unicode codepoints with `400 MALFORMED`. Case and interior whitespace remain unchanged; no Unicode normalization or array/repeated-value coercion. Only the effective search is normalized, never stored supplier names or notes.

The result is `{items, nextCursor}` with exact summaries:

`{id, version, status, supplierDisplaySnapshot, lineCount, issueCount, note, locationDetail, createdAt, updatedAt}`.

`issueCount` is the full detail diagnostic count, including current catalog/supplier drift, not a persisted stale count. The returned page's supplier/product/variant IDs are deduplicated and resolved in bounded queries (no per-order N+1). Lookahead rows are not reference-resolved. Header/line projection plus up to three reference queries is constant in page size; no COUNT or totals query is issued.

Tenant-qualified DRAFT rows, optionally filtered by supplierId, are ordered by `(createdAt,id)` descending, fetch `limit+1`, and continue strictly before the last returned tuple. Only an observed lookahead row produces `nextCursor`. HMAC-SHA256 cursors use existing `JWT_SECRET` via the feature module factory and bind tenant, purchase-order resource, supplier filter and exact trimmed search (or absence). Case/interior-whitespace changes or adding/removing search invalidate the cursor; surrounding whitespace alone does not. Extending the binding invalidates previously issued pre-search cursors; restart listing explicitly. Changing limit is permitted; signature/version/encoding/position/scope mismatches are `400 MALFORMED`. Cursors are opaque continuations, not grants, encryption or snapshot pagination. Secret rotation invalidates them.

## Evidence and remaining gate

Test-first offline evidence: query tests failed against public stubs; HTTP tests observed raw malformed-body messages and incorrectly successful duplicate-member DELETE (204) before the scoped parser; composition failed before root registration. Initial T4 offline validation passed 21 suites / 575 tests. The S13 search extension first observed five intended failures across parser, cursor, query and HTTP suites (search rejected; cursor mismatch accepted), then passed 133 focused tests. Final offline validation: `node node_modules/jest/bin/jest.js --config jest.config.js --runInBand --testPathPatterns src/procurement` passed **21 suites / 590 tests**, including guard-combination, no-store/CORS, exact 204, errors, pagination, current diagnostics, batching and supplier/unrelated parser regression cases. No standalone lint/build/formatter or integration command was authorized/run. The parent reported clean eslint/tsc for initial T4 commit `3de0782`; this search-only extension claims offline Jest and whitespace validation, not a new standalone type/lint result.

`po-queries.integration.spec.ts` is authored **but not executed**. It covers tied timestamp pagination, supplier filters, current-name versus saved-snapshot search, note-only/supplierless matching, literal wildcard escaping, supplierId AND search, search-bound pagination, foreign detail, drift, persisted authority revocation, preserved header/lines/audits/receipts and zero sampled product/sales/payment/outbox effects. Only parent-owned T5 execution against a newly disposable target can prove SQL behavior and actual runtime readiness. See [storage](procurement-po-drafts-storage.md) and [commands](procurement-po-drafts-commands.md).
