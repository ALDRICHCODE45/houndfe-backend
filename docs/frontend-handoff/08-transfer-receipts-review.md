# Transfer receipts review (private files, preview, worklist, customer reason)

**Status: Backend implemented on `feat/transfer-receipts`, not merged.** Every change to the existing review endpoints is **additive**: no key was renamed, removed or retyped, so the current strict decoders keep working. The FE can opt in to each new key whenever it is ready.

The examples are built from the shapes pinned by the backend tests (unit + PostgreSQL integration). They were not captured against the dev DB.

## 1. What changed for staff

- The chatbot now uploads the receipt **file** (JPEG, PNG or PDF). The file is stored privately; there is no public URL. For these receipts `mediaUrl` is `""`, and the image comes from the new `file` routes.
- PDFs come with a **preview**: the first page rasterized to PNG. Show the preview; open the original PDF only on demand.
- The chatbot no longer asks the customer for the amount, so `declaredAmountCents` may be missing. The chatbot's vision reads the receipt into `extracted` (a prefill hint only), and the backend computes a `mismatch` against the sale debt. A human always decides.
- There is a new **tenant-wide worklist** of pending receipts, so staff no longer have to open each sale to find them.
- Rejecting now takes a **customer-safe reason**. The chatbot relays it to the customer. The internal reason stays internal.
- New optional email: «Comprobante por revisar» (`RECEIPT_REVIEW_REQUESTED`), off until enabled (section 8).

## 2. Permissions

| Action | Permission | Without it |
| --- | --- | --- |
| Per-sale queue, worklist, file and preview | `ReceiptEvidence:read` | `403` |
| Confirm / reject | `ReceiptEvidence:update` | `403` |

Unchanged from today. Auth is JWT + tenant context, as for every staff route.

## 3. `GET /sales/:id/receipts` — per-sale queue (additive keys)

Response `200`: an array, unchanged order (oldest first), unchanged v1 keys, plus the new keys at the end of each item.

```json
[
  {
    "id": "6f1c2c8e-4d3b-4a8e-9a51-0b7f1f6f2d10",
    "saleId": "2b8e0c51-7a43-4b0e-8f6e-1d9c3f0a5e21",
    "mediaUrl": "",
    "declaredAmountCents": 0,
    "declaredDate": null,
    "declaredReference": null,
    "status": "PENDING",
    "salePaymentStatus": "CREDIT",
    "salePaidCents": 0,
    "saleDebtCents": 10000,
    "saleTotalCents": 10000,

    "declaredAmountProvided": false,
    "file": {
      "mimeType": "application/pdf",
      "sizeBytes": 2048,
      "previewStatus": "READY",
      "originalUrl": "/sales/2b8e0c51-7a43-4b0e-8f6e-1d9c3f0a5e21/receipts/6f1c2c8e-4d3b-4a8e-9a51-0b7f1f6f2d10/file",
      "previewUrl": "/sales/2b8e0c51-7a43-4b0e-8f6e-1d9c3f0a5e21/receipts/6f1c2c8e-4d3b-4a8e-9a51-0b7f1f6f2d10/preview"
    },
    "extracted": { "amountCents": 10000, "bank": "BBVA", "confidence": 0.9 },
    "mismatch": { "debtCents": 10000, "extractedDiffCents": 0, "flagged": false },
    "createdAt": "2026-11-05T09:00:00.000Z"
  }
]
```

### v1 keys: same meaning, two compatibility values

| Key | New-upload value | Read instead |
| --- | --- | --- |
| `mediaUrl` | `""` (no public URL) | `file.originalUrl` / `file.previewUrl` |
| `declaredAmountCents` | `0` when nothing was declared (real amounts are ≥ 1) | `declaredAmountProvided` |

Legacy receipts (attached by URL before this change) keep their real `mediaUrl`, and their `file` is `null`.

### New keys

| Key | Type | Meaning |
| --- | --- | --- |
| `declaredAmountProvided` | boolean | `false` when the chatbot declared no amount (then `declaredAmountCents` is `0`). |
| `file` | object \| `null` | Private file metadata; `null` for legacy URL receipts. |
| `file.mimeType` | `"image/jpeg"` \| `"image/png"` \| `"application/pdf"` | From the file's magic bytes. |
| `file.sizeBytes` | integer \| `null` | Original size. |
| `file.previewStatus` | `"READY"` \| `"UNAVAILABLE"` | `UNAVAILABLE` when a PDF could not be rasterized; show a «Ver PDF» fallback. |
| `file.originalUrl` | string \| `null` | Relative route to the original. `null` once deleted by retention. |
| `file.previewUrl` | string \| `null` | Relative route to the preview. `null` when `previewStatus` is `UNAVAILABLE` or after retention. For images it serves the image itself. |
| `extracted` | object \| `null` | Chatbot vision prefill: `{ amountCents?, date?, reference?, bank?, confidence? }` (every key optional; `confidence` 0..1). A hint, never a decision. |
| `mismatch` | object \| `null` | `{ debtCents, declaredDiffCents?, extractedDiffCents?, flagged }`, computed at upload against the sale debt **at that moment**. Diff = amount − debt (negative = partial, positive = overpaid). A diff is present only when that amount exists. `null` for receipts older than this change. |
| `createdAt` | ISO date | Upload time. |

UI suggestion: prefill the confirm amount with `extracted.amountCents`, else the declared amount (when `declaredAmountProvided`), else the debt. Show a warning when `mismatch.flagged`. The confirm body is unchanged: the reviewer still types the real amount.

## 4. `GET /sales/receipts/pending` — tenant-wide worklist (new)

Every pending receipt of a confirmed sale in the current sucursal, **oldest first**, with cursor pagination `Page<T> = { items, nextCursor }`.

| Param | Type | Default | Rule |
| --- | --- | --- | --- |
| `limit` | integer | `25` | `1..100` (`400` otherwise) |
| `cursor` | string | — | The opaque `nextCursor` of the previous page. A malformed one answers `400 INVALID_RECEIPT_CURSOR`. |

Note: the order is **oldest first** (FIFO review), unlike the newest-first default of other lists. `nextCursor: null` marks the last page.

Each item is exactly the per-sale item above **plus**:

| Key | Type |
| --- | --- |
| `saleFolio` | string \| `null` |
| `customerName` | string \| `null` (first + last name) |

```json
{
  "items": [
    {
      "id": "6f1c…",
      "saleId": "2b8e…",
      "mediaUrl": "",
      "declaredAmountCents": 0,
      "status": "PENDING",
      "saleDebtCents": 10000,
      "declaredAmountProvided": false,
      "file": { "mimeType": "image/png", "sizeBytes": 183422, "previewStatus": "READY", "originalUrl": "/sales/2b8e…/receipts/6f1c…/file", "previewUrl": "/sales/2b8e…/receipts/6f1c…/preview" },
      "extracted": null,
      "mismatch": { "debtCents": 10000, "declaredDiffCents": -6000, "flagged": true },
      "createdAt": "2026-11-05T10:00:00.000Z",
      "saleFolio": "V-0042",
      "customerName": "Ana López"
    }
  ],
  "nextCursor": "WyIyMDI2LTExLTA1VDEwOjAwOjAwLjAwMFoiLCI2ZjFj4oCmIl0"
}
```

(The example item is shortened; real items carry every key of section 3.)

After confirming or rejecting, refetch: the receipt leaves the list.

## 5. File and preview routes (new)

```http
GET /sales/:id/receipts/:receiptId/file
GET /sales/:id/receipts/:receiptId/preview
Authorization: Bearer <token>
```

- Use the relative routes from `file.originalUrl` / `file.previewUrl`, prefixed with the API base URL.
- The routes require the `Authorization` header, so a bare `<img src>` does not work. Fetch the bytes, wrap them in a `Blob`, and show them through `URL.createObjectURL(blob)`. Revoke the object URL when the view closes.
- The bytes stream through the backend. Spaces is never exposed and nothing is ever cached.

Success `200` headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `image/jpeg`, `image/png` or `application/pdf` (preview: always `image/png`) |
| `Content-Disposition` | `inline; filename="comprobante-<receiptId>.<ext>"` (preview: `comprobante-<receiptId>-vista-previa.png`) |
| `Cache-Control` | `private, no-store` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Length` | file size |

Errors (`{ statusCode, error, message, timestamp }`, `Cache-Control: no-store`):

| Status | `error` | When |
| --- | --- | --- |
| `404` | `RECEIPT_NOT_FOUND` | unknown receipt, another sale's receipt, or another sucursal's |
| `404` | `RECEIPT_FILE_NOT_AVAILABLE` | legacy URL receipt (use its `mediaUrl`), preview `UNAVAILABLE`, or the object is missing |
| `410` | `RECEIPT_FILE_PURGED` | deleted by the 5-year retention |
| `502` | `RECEIPT_STORAGE_FAILED` | storage temporarily failed; retry |
| `403` | `INSUFFICIENT_PERMISSIONS` | no `ReceiptEvidence:read` |
| `400` | — | `:id` or `:receiptId` is not a UUID |

## 6. Reject: new `customerReason`

```http
POST /sales/:id/receipts/:receiptId/reject
Content-Type: application/json

{
  "reason": "Referencia duplicada con otra venta",
  "customerReason": "No pudimos validar la referencia de tu transferencia."
}
```

| Field | Rule |
| --- | --- |
| `reason` | required, non-empty (unchanged). **Internal only**: never sent to the customer. |
| `customerReason` | optional, trimmed, 1–300 chars. The chatbot relays it to the customer as-is, so write it for the customer. |

- The current FE body (`{ reason }`) keeps working. Without `customerReason` the backend stores a generic customer text: «No pudimos validar tu comprobante. Por favor envíanos uno nuevo o contáctanos.»
- New screens should always ask for both: «Motivo interno» and «Mensaje para el cliente».
- A blank (`"   "`) or 301+ char `customerReason` answers `400`.
- Response unchanged (`200`, empty body). Confirm is unchanged.

## 7. Retention (5 years)

Stored files (original and preview) are deleted automatically 5 years after upload. The receipt row, amounts and outcome are kept. After the purge, `file` stays in the queue items with `originalUrl: null` and `previewUrl: null`, and the file routes answer `410 RECEIPT_FILE_PURGED`. Show «Archivo eliminado por política de retención».

## 8. Staff email `RECEIPT_REVIEW_REQUESTED` (notification settings)

- A new action key, `RECEIPT_REVIEW_REQUESTED`, is accepted by the existing `PUT /notification-config` (`enabledActions`). Suggested label: «Comprobante de transferencia por revisar».
- It is **off for every sucursal** until an admin enables it. No rows are seeded.
- Sent once per **new** receipt the chatbot uploads; a chatbot retry of the same file sends nothing.
- Recipients: the configured notification recipients, narrowed to active members whose role can **review** receipts (`ReceiptEvidence:update`, `ReceiptEvidence:manage` or full admin). A configured recipient without that permission gets no email; consider telling the admin in the settings screen.
- Content (Spanish): sale folio, customer name, declared amount, amount read from the receipt, the sale balance, and a «No coincide con el saldo» warning when `mismatch.flagged`. The file is never attached; the CTA opens the app.

## 9. Not included

- There is no endpoint to list confirmed/rejected receipts history; the queues show `PENDING` only.
- `customerReason` is not exposed in the staff queue (it is only set when rejecting, and rejected receipts leave the queue).
