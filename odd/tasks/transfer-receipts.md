# Transfer receipts uploaded by the chatbot, stored privately
Branch `feat/transfer-receipts` (worktree `.tmp/receipts`). The chatbot uploads the receipt bytes; the backend stores them privately in DigitalOcean Spaces; a human always validates in the system.
Current state (explore, 2026-11-05): `POST /chatbot-api/sales/:saleId/receipts` takes `mediaUrl` only, no idempotency, never reads the sale; `ReceiptEvidence.declaredAmountCents` NOT NULL; `src/files` uploads public-read to Spaces; `src/private-media` is S3-compatible private but product-bound and unwired; no magic-byte check anywhere; no receipt poll route; review queue exposes `mediaUrl`.

## Specs
- S1 Upload: multipart `POST /chatbot-api/sales/:saleId/receipts` with `file` + fields, replacing `mediaUrl`. "Se aceptan PDF además de JPEG/PNG. Límites: validación por magic bytes, 10 MB máximo". The chatbot rejects encrypted PDFs itself; the backend still never trusts the declared MIME.
- S2 Storage: "guardarlo privado" in DigitalOcean Spaces (never public-read); the staff sees it only through the system with permission checks.
- S3 PDF preview: "que en la UI de revisión se vea la PRIMERA PÁGINA como imagen de vista previa (rasterizada en el backend), para que el staff no abra el PDF original".
- S4 Idempotency: "X-Idempotency-Key = id del media de WhatsApp. Así un reintento no duplica"; a replay returns the same receiptId.
- S5 Fields: "declaredAmountCents pasa a ser opcional"; separate block `extracted` {amountCents, date, reference, bank, confidence} from the chatbot's vision (prefill only, never decides); the backend computes the mismatch against the sale debt, "que es la fuente de verdad".
- S6 Sale rules: "Sí" to several receipts per sale and partial payments; upload errors SALE_NOT_FOUND 404, SALE_ALREADY_PAID 409, SALE_NOT_PAYABLE 409 (canceled or not confirmed); upload scope `sales:write`.
- S7 Staff email RECEIPT_REVIEW_REQUESTED to users with permission, through the existing notification config + outbox + Inngest path. "El chatbot no notifica a ops."
- S8 Bot outcome: "Consulta simple": `GET /chatbot-api/receipts/:receiptId` → {status PENDING|CONFIRMED|REJECTED, customerReason?, sale:{debtCents, paymentStatus}} with a new scope (e.g. `sales:read`). Rejection carries a customer-safe `customerReason`, separate from the internal reason.
- S9 Retention: "5 años" then automatic deletion of the stored files (and previews).
- S10 Review UI data: the review queue shows the image (or PDF preview), the declared and the extracted data, and the mismatch. FE strict decoders: existing review response shapes may only change after the FE agrees.

## Tasks
| ID | Task | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Private storage + multipart upload + magic bytes + PDF first-page preview + idempotency + optional declared/extracted + sale rules + mismatch | S1 S2 S3 S4 S5 S6 | worker | |
| T2 | Review side: private file/preview read route, queue additions, customerReason on reject, RECEIPT_REVIEW_REQUESTED email, bot GET with scope, retention job, FE handoff | S7 S8 S9 S10 | worker after T1 | |

## Log
- L1 (owner via chatbot agent, 2026-11-05): the backend stores receipt images in DigitalOcean (Spaces); the chatbot downloads the WhatsApp media and hands it over; always a human validates; the chatbot's vision only prefills and flags discrepancies, never decides. Proposal points 1–7 (multipart, X-Idempotency-Key = WhatsApp media id, optional declaredAmountCents + extracted, backend mismatch vs debt, RECEIPT_REVIEW_REQUESTED email, polling GET, sale rules, retention).
- L2 (owner via chatbot): PDF accepted besides JPEG/PNG, magic bytes, 10 MB; private storage; backend rasterizes the first PDF page as preview; bot no longer asks the amount or CONFIRMAR/CANCELAR; rejection needs a customer-readable customerReason.
- L3 (user answers): several receipts and partial payments "Sí (recomendado)"; bot outcome "Consulta simple (recomendado)"; retention "5 años (recomendado)"; start implementation "Sí, arrancá (recomendado)".
