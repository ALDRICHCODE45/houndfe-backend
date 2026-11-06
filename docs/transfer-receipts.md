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
response is always `PENDING`; poll the outcome with
`GET /chatbot-api/receipts/:receiptId` (below).

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

## Review outcome poll

`GET /chatbot-api/receipts/:receiptId`

- Auth: service credential, scope **`sales:read`**. Scopes match exactly, so
  `sales:write` alone answers `403`; add `sales:read` to the chatbot
  credential.
- `:receiptId` must be a UUID (`400` otherwise).
- Tenant-scoped: a missing receipt or another tenant's answers
  `404 RECEIPT_NOT_FOUND` (`{ statusCode, error, message, timestamp }`).
- Audited as `receipts.status`.

`200`:

```json
{
  "status": "REJECTED",
  "customerReason": "No pudimos validar la referencia de tu transferencia.",
  "sale": { "debtCents": 10000, "paymentStatus": "CREDIT" }
}
```

| Key | Notes |
| --- | --- |
| `status` | `PENDING` \| `CONFIRMED` \| `REJECTED` |
| `customerReason` | Only when `REJECTED`. Customer-safe text written by staff (or a generic Spanish default when the reviewer gave none). Relay it as-is. |
| `sale.debtCents` | Live sale debt (the source of truth for what is still owed). |
| `sale.paymentStatus` | `PAID` \| `PARTIAL` \| `CREDIT` \| `null` |

It never exposes the internal rejection reason, the reviewer, storage keys,
`extracted`, `mismatch` or any file route. Poll with a backoff (the review is
human); a `CONFIRMED` receipt with `debtCents > 0` means a partial payment.

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
- If the database insert fails after the objects were stored, they are
  deleted (best effort; a failed delete is logged and the original error is
  returned). A lost concurrent race then answers like a replay of the winner;
  any other failure is returned unchanged.

## Preview

- JPEG/PNG: the image is its own preview (`previewKey = storageKey`); there is
  no downscale, to avoid a native image dependency.
- PDF: page 1 is rasterized in the backend with PDFium (WASM, `@hyzyla/pdfium`)
  and encoded as PNG (`pngjs`). The longest side is 1600 px. It is stored
  privately next to the original as `<…>.preview.png`.
- Isolation: the render runs in a short-lived **child process**
  (`child_process.fork` of `src/receipts/infrastructure/pdf-preview.child.ts`),
  never inside the API process. A hostile PDF (decompression bomb, PDFium
  crash, endless render) can only take down the child; the API keeps serving.
  The child gets no API environment (only `NODE_ENV`), so it never sees
  secrets.
- Limits (defaults in `pdfium-preview-rasterizer.ts`):
  - 15 s hard timeout, then `SIGKILL`.
  - `--max-old-space-size=256` for the child's V8 heap. PDFium's WASM memory
    lives outside that heap, so a Linux `/proc` RSS watchdog (polled every
    100 ms) `SIGKILL`s the child above 512 MB resident. On other platforms only
    the timeout and the process boundary apply.
  - Concurrency 1 for the whole API process. Up to 3 uploads wait in order;
    a 4th waiting upload gets `UNAVAILABLE` at once. The worst-case wait is
    (1 + 3) × 15 s = 60 s.
  - The input is already capped at 10 MB.
- Child path: `nest build`/`tsc -p tsconfig.build.json` compiles the child to
  `dist/receipts/infrastructure/pdf-preview.child.js` next to the rasterizer,
  which forks that `.js` when it exists. Under ts-jest only the `.ts` source
  exists, so it is forked with `--require ts-node/register/transpile-only` (a
  devDependency, never used in production). The child resolves
  `@hyzyla/pdfium`/`pngjs` from the app's `node_modules` (`/app/node_modules`
  in the image).
- Any child crash, OOM, kill, timeout, full queue or preview-upload failure
  keeps the original, sets `previewStatus = UNAVAILABLE` and
  `previewKey = null`, and logs a warning with the cause (exit code or signal
  and the tail of the child's stderr).

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

Migration `20261106050000_receipt_review_retention` (T2, additive) adds
`customerReason` and `purgedAt`, widens the CHECK to accept purged rows and
indexes `createdAt`. `20261106050100_receipt_review_requested_action` adds the
`RECEIPT_REVIEW_REQUESTED` notification action (single `ALTER TYPE`).

Migration `20261106070000_receipt_retention_purge_attempts` (T3, additive)
adds `purgeAttempts` (default 0) and `lastPurgeErrorAt`.

## Staff review (T2)

Staff contracts are in
[frontend-handoff/08-transfer-receipts-review.md](frontend-handoff/08-transfer-receipts-review.md):

- `GET /sales/:id/receipts/:receiptId/file` and `/preview` stream the private
  objects through the backend (JWT + tenant + `read ReceiptEvidence`,
  `Cache-Control: private, no-store`, inline, `nosniff`).
- The review queue keeps every v1 key; private uploads still show
  `mediaUrl: ""` and `declaredAmountCents: 0`, and the new
  `declaredAmountProvided`, `file`, `extracted`, `mismatch`, `createdAt` keys
  carry the truth. `GET /sales/receipts/pending` is the tenant-wide worklist.
- Reject takes an optional `customerReason` (1–300 chars) next to the internal
  `reason`.

## Staff email

`RECEIPT_REVIEW_REQUESTED` (off until a tenant enables it). A NEW receipt
(multipart or legacy JSON; never an idempotent replay or a lost concurrent
race) writes a `receipt.review_requested` outbox row in the same transaction.
A dedicated poller/dispatcher (excluded from the generic poller) sends the
Inngest event `receipts/review.requested`; the function
`receipt-review-requested-email` re-checks the config and emails the
configured recipients who can review receipts (`ReceiptEvidence`
update/manage or `manage all`). The file is never attached.

## Retention

Stored files are kept **5 years** from upload. The Inngest cron
`receipt-retention-purge` (daily 03:00 America/Mexico_City) deletes the
original and the preview in bounded batches, then sets `purgedAt` and clears
`storageKey`/`previewKey`; the row, amounts and outcome stay. It refuses keys
outside `receipts/<tenantId>/`, keeps the keys when a delete fails (retried on
the next run) and is idempotent. Legacy `mediaUrl` rows have nothing stored and
are untouched.

A failed row (delete error or key outside its prefix) gets `purgeAttempts + 1`
and `lastPurgeErrorAt` = the run time. The following batches of the same run
skip it, and later runs scan rows by `purgeAttempts` first, so rows that keep
failing can never block newer due rows. The run time is read once, inside the
`read-clock` step, so every batch and every Inngest replay uses the same
cutoff. A run stops on a short batch or after 50 batches.

## Environment

| Variable | Required | Use |
| --- | --- | --- |
| `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY` | yes | shared Spaces client (same as `src/files`) |
| `SPACES_BUCKET` | yes | default bucket |
| `RECEIPTS_SPACES_BUCKET` | no | separate private bucket for receipts; defaults to `SPACES_BUCKET` |
