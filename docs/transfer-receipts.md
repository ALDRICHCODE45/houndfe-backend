# Transfer receipts (chatbot upload)

The chatbot downloads the customer's WhatsApp media and uploads the bytes. The
backend validates them, stores them **privately** in DigitalOcean Spaces and
creates a `PENDING` receipt. A human always reviews it. The chatbot's vision
output (`extracted`) only prefills data and flags discrepancies; it never
decides a payment.

## Endpoint

`POST /chatbot-api/sales/:saleId/receipts`

- Auth: service credential (`Authorization: Bearer svc_…`), scope `sales:write`.
- Content type: `multipart/form-data`.
- `:saleId` must be a UUID.

### Headers

| Header | Required | Notes |
| --- | --- | --- |
| `X-Idempotency-Key` | yes (multipart) | WhatsApp media id. Trimmed, 1–200 chars. Scoped per tenant + sale. |

### Multipart parts

| Part | Type | Rules |
| --- | --- | --- |
| `file` | file, required | JPEG, PNG or PDF, at most 10 MB. The type comes from the magic bytes only; the declared MIME and filename are ignored. |
| `declaredAmountCents` | text, optional | Integer ≥ 1 (digits only). |
| `declaredDate` | text, optional | ISO-8601 date or timestamp. |
| `declaredReference` | text, optional | 1–120 chars after trimming. |
| `extracted` | text, optional | JSON object string, max 4 KB: `{ amountCents?: int ≥ 1, date?: ISO-8601, reference?: 1–120 chars, bank?: 1–80 chars, confidence?: number 0..1 }`. Unknown keys, `null` values and wrong types are rejected. |

Blank text parts count as absent. Unknown or repeated parts are rejected.

Magic bytes: JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, PDF `%PDF-`
(at offset 0).

### Example

```bash
curl -X POST "$API/chatbot-api/sales/$SALE_ID/receipts" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "X-Idempotency-Key: wamid.HBgMNTIxNTUxMjM0NTY3OBUCABIYFjNFQjA" \
  -F "file=@comprobante.pdf" \
  -F "declaredAmountCents=519800" \
  -F 'extracted={"amountCents":519800,"date":"2026-11-05","reference":"TRF-99887","bank":"BBVA","confidence":0.91}'
```

`201 Created`:

```json
{
  "receiptId": "6f1c…",
  "status": "PENDING",
  "mimeType": "application/pdf",
  "sizeBytes": 183422,
  "sha256": "9b74c9897bac770ffc029102a200c5de…",
  "previewStatus": "READY"
}
```

`receiptId` and `status` are the contract. `mimeType`, `sizeBytes`, `sha256` and
`previewStatus` (`READY` | `UNAVAILABLE`) are additive. `status` in this
response is always `PENDING`; the review outcome is read elsewhere (T2).

### Idempotency

- Same key + same bytes (sha256): returns the **same body** with `201` and does
  not upload again. This also works after the sale was paid, so a late retry
  still gets its receipt.
- Same key + different bytes: `409 IDEMPOTENCY_KEY_REUSED`.
- Concurrent requests with one key settle into a single receipt.
- The same key on another sale is a different receipt.

### Sale rules (checked before storing)

| Sale | Result |
| --- | --- |
| missing or another tenant's | `404 SALE_NOT_FOUND` |
| canceled or not confirmed (draft) | `409 SALE_NOT_PAYABLE` |
| paid (`paymentStatus = PAID` or `debtCents <= 0`) | `409 SALE_ALREADY_PAID` |

Several receipts per sale are allowed (partial payments). The staff confirms
the actual amount at review time, as before.

### Errors

Body: `{ statusCode, error: <CODE>, message, timestamp }`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_IDEMPOTENCY_KEY` | header missing, blank or longer than 200 |
| 400 | `RECEIPT_FILE_REQUIRED` | no `file` part, or it is empty |
| 400 | `INVALID_RECEIPT_FIELDS` | bad or unknown text part |
| 400 | `INVALID_RECEIPT_EXTRACTED` | `extracted` is not a valid object |
| 413 | `RECEIPT_FILE_TOO_LARGE` | file over 10 MB (multer aborts the stream at the limit) |
| 415 | `RECEIPT_FILE_TYPE_NOT_ALLOWED` | not JPEG/PNG/PDF by magic bytes |
| 404 | `SALE_NOT_FOUND` | see sale rules |
| 409 | `SALE_NOT_PAYABLE`, `SALE_ALREADY_PAID` | see sale rules |
| 409 | `IDEMPOTENCY_KEY_REUSED` | key reused with other bytes |
| 502 | `RECEIPT_STORAGE_FAILED` | Spaces upload failed; retry with the same key |
| 401 / 403 | — | missing credential / missing `sales:write` |

Multipart limits: 1 file, 8 text parts, 8 KB per text part. Other multer
violations answer `400`.

### Legacy JSON body (temporary)

`application/json` with `{ mediaUrl, declaredAmountCents?, declaredDate?, declaredReference? }`
still works until the chatbot confirms the multipart migration. It runs the
same sale rules, does not use idempotency (as before) and answers
`{ receiptId, status: "PENDING" }`. `declaredAmountCents` is now optional here
too. Remove this path once the chatbot has migrated.

## Storage

- Original and preview go to DigitalOcean Spaces with `ACL: private`. They
  are never `public-read` and there is no public URL. `src/files` (public
  catalog images) is unchanged; both modules share the `SPACES_*` client
  configuration through `createSpacesClient`.
- Keys are tenant-scoped and unguessable:
  `receipts/<tenantId>/<saleId>/<random-uuid>.<jpg|png|pdf>`. The random part
  is independent of `receiptId`, so knowing the receipt id does not reveal the
  key.
- `receipt_evidences` stores `storageKey`, `mimeType` (from magic bytes),
  `sizeBytes`, `sha256`, `previewKey`, `previewMimeType`, `previewStatus`,
  `idempotencyKey`, `extracted` and `mismatch`.
- If the database insert loses a concurrent race, the duplicate objects are
  deleted (best effort).

## Preview

- JPEG/PNG: the image is its own preview (`previewKey = storageKey`); there is
  no downscale, to avoid a native image dependency.
- PDF: page 1 is rasterized in the backend with PDFium (WASM, `@hyzyla/pdfium`)
  and encoded as PNG (`pngjs`). The longest side is 1600 px. It is stored
  privately next to the original as `<…>.preview.png`.
- Guards: the render runs in a short-lived worker thread with a 256 MB JS heap
  cap and a 15 s timeout. On timeout the worker is terminated, so a hostile PDF
  cannot block the event loop. The input is already capped at 10 MB.
- Any rasterization or preview-upload failure keeps the original, sets
  `previewStatus = UNAVAILABLE` and `previewKey = null`, and logs a warning.

## Mismatch

Computed at upload against the sale debt at that moment (the source of truth)
and stored as JSON:

```json
{ "debtCents": 10000, "declaredDiffCents": -6000, "extractedDiffCents": 0, "flagged": true }
```

Diffs are `amount - debt` (negative = partial, positive = overpaid). A diff is
present only when its amount was provided. `flagged` is true when any provided
amount differs from the debt. It is a review hint; it never confirms anything.

## Data model

Migration `20261106030000_receipt_private_upload` is additive.
`mediaUrl` and `declaredAmountCents` become nullable, and the storage,
preview, idempotency, `extracted` and `mismatch` columns are added. A CHECK
requires `mediaUrl` or `storageKey`. A unique index on
`(tenantId, saleId, idempotencyKey)` backs idempotency; legacy rows have a NULL
key and never collide. Rows created before this change keep working.

Review compatibility: until T2 adds the permission-checked file route, the
existing review responses keep their shape. A private upload appears with
`mediaUrl: ""` (no public URL) and `declaredAmountCents: 0` when nothing was
declared (real declared amounts are ≥ 1).

## Environment

| Variable | Required | Use |
| --- | --- | --- |
| `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY` | yes | shared Spaces client (same as `src/files`) |
| `SPACES_BUCKET` | yes | default bucket |
| `RECEIPTS_SPACES_BUCKET` | no | separate private bucket for receipts; defaults to `SPACES_BUCKET` |
