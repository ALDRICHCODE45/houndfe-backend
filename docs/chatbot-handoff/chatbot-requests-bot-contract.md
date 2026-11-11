# Chatbot ↔ backend: human requests (slices 5a, 5b and 5c)

What the chatbot session consumes. Contract source: `docs/proposals/human-intervention-backend-proposal.md` §3.1–§3.5, §3.9, §4.5, §6.4, §10.1 R2/R7, §12.14. Implemented: **create**, **merge**, **customer cancel**, the **route budgets** (5a) and the **feed**, the **delivery outcome** and **pending deliveries** (5b, below), and the **recovery route** with the new outcome `DEFERRED_HUMAN_SESSION` (5c, below). Not yet: `cancel-batch`, `reschedule`, scheduling slots, the conversation mirror, media, `GET /conversations/:ref/state`, and the feed types of later units (`request.cancel_ack`, `conversation.*`, `template.requested`).

## Common rules

| Rule | Detail |
| --- | --- |
| Auth | `Authorization: Bearer svc_…`. `X-Branch-Id`, when sent, must equal the credential's tenant (else `403 FORBIDDEN`). The tenant, source and credential never go in a body. |
| Scopes | `requests:create`, `requests:read`, `requests:cancel`, `feed:read`, `feed:ack`, `conversation:write`, `media:write`. They are free text on `ServiceCredential.scopes`; add the ones a credential needs. A missing scope is `403 INSUFFICIENT_SCOPE`. The create and cancel routes use `requests:create` and `requests:cancel`; the recovery route uses `requests:read`; the feed and pending deliveries use `feed:read`; the delivery outcome uses `feed:ack`. |
| Idempotency | Every write sends `X-Idempotency-Key: <uuid>`. Create: it must equal the body's `sourceRequestId` (compared literally, else `400`). Cancel: any UUID. Same key and same canonical hash → the same answer; same key and another body → `409 IDEMPOTENCY_CONFLICT`. Create keys are one namespace across all subtypes: a `sourceRequestId` already used for a `RESTOCK` and sent again as a `COMPLAINT` (or the other way round) is a conflict, never a second request. |
| Errors | `{ "statusCode": 409, "code": "…", "message": "…" }` plus the extra fields listed per error. All responses, errors included, carry `Cache-Control: no-store`. |
| Rate limit | `429 RATE_LIMITED` with `Retry-After` (seconds). See "Route budgets". |

## `POST /chatbot-api/requests`

Scope `requests:create`, class `write`. Body = the common envelope plus `detail`:

```json
{
  "sourceRequestId": "5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10",
  "subtype": "UNKNOWN_QUESTION",
  "customer": { "phoneCountryCode": "52", "phone": "5512345678", "displayName": "Juan" },
  "conversationRef": "wa:5215512345678",
  "lastCustomerMessageAt": "2026-11-09T16:02:11.000Z",
  "summary": "¿El shampoo X sirve para cachorros de 2 meses?",
  "needs": "El cliente pregunta si el producto es apto para cachorros.",
  "context": { "cartRef": "cart-1", "productIds": ["7f3e…"], "quantity": 2 },
  "dedupKey": "UNKNOWN_QUESTION:product:7f3e",
  "triggerWaMessageId": "wamid.HBg…",
  "detail": {}
}
```

Unknown keys are `400`. Field rules:

| Field | Rule |
| --- | --- |
| `sourceRequestId` | UUID. |
| `subtype` | `UNKNOWN_QUESTION`, `TALK_TO_HUMAN`, `COMPLAINT` (created directly) or `RESTOCK`, `EXPIRATION`, `DELIVERY_ZONE` (legacy intake). `TRANSFER_RECEIPT` and `DISCOUNT` → `422 SUBTYPE_DISABLED` (receipts keep entering through `POST /chatbot-api/sales/:id/receipts`). |
| `customer` | `{phoneCountryCode, phone, displayName?}`. The backend computes `customerKey` with `canonicalPhone` (R1): Mexico's `521` + 10 digits and `52` + 10 digits are the same person. `displayName` is validated and **not stored**. A number with no canonical form is `400`. Required for the three direct subtypes; optional for the wrapped ones. |
| `conversationRef`, `lastCustomerMessageAt` | Required for the direct subtypes (≤ 200 chars; ISO-8601 with `Z` or an offset). The 24 h window closes at `lastCustomerMessageAt + 24 h`. `lastCustomerMessageAt` must be at most 5 minutes in the future and at most 30 days old, else `400 VALIDATION_ERROR` (also when the request merges). |
| `summary` | 1..140 chars, no control characters. Required for the direct subtypes; wrapped ones default to a short Spanish label. |
| `needs` | ≤ 1000 chars, plain text. |
| `context` | Only these keys: `cartRef`, `saleId`, `orderId` (id strings ≤ 100), `productIds`, `variantIds` (≤ 20 ids), `quantity` (integer 0..100000). Never prices. |
| `dedupKey` | `[A-Za-z0-9:_.-]{1,200}`; needs `customer`. |
| `triggerWaMessageId` | The WhatsApp id of the message that triggered it; stored in the audit event only. |
| `scheduledFor` | **`422 SCHEDULING_DISABLED`** when present and not null. Scheduled conversations are unit 14 (§4.9). |
| `detail` | `{}` (or absent) for the direct subtypes. For `RESTOCK`, `EXPIRATION` and `DELIVERY_ZONE` it is **exactly today's body** of `POST /chatbot-api/human-decisions` (including its own `sourceRequestId`, which must equal the envelope's, and `type`, which must equal `subtype`), validated by the same parsers. For `DELIVERY_ZONE`, a `customer` in the envelope must be the same number as the detail's. |

### Answer

`201` when created; `200` for a replay or a merge.

```json
{
  "id": "…", "folio": "S-000123", "status": "NEW",
  "outcome": "CREATED",
  "mergedIntoId": null,
  "businessHours": null
}
```

- `outcome`: `CREATED`, `REPLAYED` (same key and hash again: the request that key created) or `MERGED`.
- `MERGED`: an open request of the same customer with the same `dedupKey` already exists. `id` and `mergedIntoId` are that request, `status` its current status (`NEW` or `IN_PROGRESS`). The repeated question is appended to its audit timeline (`MERGED` event) and a newer `lastCustomerMessageAt` reopens its 24 h window. The merge is stored by key: retrying it answers the same even after the request closed. A merge works at any open count (the open limit does not apply to it).
- `status` of `CREATED`/`REPLAYED` is the status at creation (`NEW`), not the current one.
- `businessHours` is `null` until unit 7 (the business calendar). Do not treat `null` as "closed".
- Wrapped subtypes add `legacy`: what the old route answers (`POST /chatbot-api/human-decisions`), because the bot still polls those rows by id until the feed carries the answers. A `DELIVERY_ZONE` requester that an already-approved zone answers immediately has no request: `id` and `folio` are `null`, `status` is `RESOLVED`, and `legacy` holds the answer. Its key is still idempotent: the same body replays (`200`, `outcome: REPLAYED`), another body is `409 IDEMPOTENCY_CONFLICT`.
- A wrapped replay whose envelope differs from the first one (other `customer`, `summary`, …) is `409 IDEMPOTENCY_CONFLICT`.

### Errors

| Status / code | When | Extra fields |
| --- | --- | --- |
| `400 VALIDATION_ERROR` | bad body, bad key, key ≠ `sourceRequestId` (cancel: also an `:id` that is not a UUID) | — |
| `401`, `403 INSUFFICIENT_SCOPE`, `403 FORBIDDEN` | credential, scope, branch | — |
| `404 NOT_FOUND` | a wrapped `detail` refers to a missing product (as the old route) | — |
| `409 IDEMPOTENCY_CONFLICT` | same key, other body | — |
| `409 CUSTOMER_OPEN_LIMIT` | the customer already has 20 open requests, all subtypes together | `limit: 20`, `open: 20` |
| `429 CUSTOMER_RATE_LIMITED` | 10 requests created for this customer in the last hour (counted in the database; merges do not count) | `limit: 10`; `Retry-After` header: seconds until the count is back under the limit |
| `422 SUBTYPE_DISABLED` | `TRANSFER_RECEIPT`, `DISCOUNT` | — |
| `422 SCHEDULING_DISABLED` | `scheduledFor` sent | — |
| `409 VERSION_CONFLICT` | the open request kept opening and closing across three attempts (practically never); retry | — |
| `429 RATE_LIMITED` | the credential's `write` budget | `Retry-After` header |

`CUSTOMER_RATE_LIMITED` is not in the proposal's error list; it is a different code from `RATE_LIMITED` on purpose: retrying a credential-limited call later is right, retrying a per-customer one is not.

## `POST /chatbot-api/requests/:id/cancel`

Scope `requests:cancel`, class `write`. Body `{ "reason": "CUSTOMER_WITHDREW" | "AUTO_RESOLVED", "triggerWaMessageId": "wamid.…" }`, `X-Idempotency-Key` required.

`200`:

```json
{ "id": "…", "status": "CANCELLED", "reason": "CUSTOMER_WITHDREW", "cancelledAt": "2026-11-10T16:20:00.000Z" }
```

| Status / code | When |
| --- | --- |
| `404 NOT_FOUND` | unknown id, or an id of another branch |
| `409 ALREADY_RESOLVED` | the request is `RESOLVED`; the body carries `resolution` (what staff decided, e.g. `{"action":"PROVIDE_RESTOCK_ESTIMATE","restockDays":7,"via":"LEGACY_ROUTE"}` for a stock decision) so the bot delivers it instead of saying "cancelled". Clarification replies (`resolution` with text) arrive with unit 10; until then only decisions have a `resolution` |
| `409 REQUEST_CLOSED` | already `CANCELLED` (with another key) |
| `409 CANCEL_NOT_ALLOWED` | a live conversation (`STARTING`/`ACTIVE`/`ENDING`); the customer's words go to the attendant (§4). Live sessions arrive with unit 11, so no request is live yet |
| `409 IDEMPOTENCY_CONFLICT`, `400 VALIDATION_ERROR` | as above |

Notes:

- Works on `NEW` and `IN_PROGRESS` requests, every kind, including a conversation that has not started (`WAITING`).
- For a wrapped decision (`RESTOCK`, `EXPIRATION`, `DELIVERY_ZONE`) only the request closes; the legacy row stays `PENDING` and the old routes still work on it (see `docs/chatbot-requests-model.md`, "Customer cancel of a wrapped decision"). **After a successful cancel the bot must drop its own pending record of the legacy row for that decision and ignore any later outcome of `GET /chatbot-api/human-decisions/:id` for it.** Staff may still resolve the legacy row afterwards (a stock decision, or a zone resolved for other customers), and that poll then answers `RESOLVED`; the customer withdrew, so the bot sends nothing. Example: the customer asks for stock of croquetas, the bot creates the request (`legacy.id = "hd-1"`), the customer says "ya no", the bot cancels (`200`) and deletes its `hd-1` tracking; ten minutes later staff answers `hd-1` and the poll returns `RESOLVED`; the bot ignores it and does not call `application-outcome` for it.
- A cancelled request leaves the inbox group and sends no message to the customer.

## Route budgets (R2)

Counters live in PostgreSQL (`service_rate_buckets`), so every replica shares them: one counter per (credential, class), a window of 60 s that opens at its first request.

| Class | Used by | Default per minute | Override |
| --- | --- | --- | --- |
| `default` | the other chatbot-api routes that existed before this contract (catalog, customers, checkout, shipping quotes, receipts…) | the credential's `rateLimit` (60) | `rateLimits.default`, else `rateLimit` |
| `humanDecisions` | the stock, expiration and delivery-zone routes: `POST /chatbot-api/human-decisions`, `GET /chatbot-api/human-decisions/:id`, `POST …/:id/application-outcome` | the credential's `rateLimit` (60) | `rateLimits.humanDecisions`, else `rateLimit` |
| `write` | `POST /chatbot-api/requests`, `…/:id/cancel`, `POST /chatbot-api/deliveries/:id/outcome` | 300 | `rateLimits.write` |
| `read` | `GET /chatbot-api/requests/pending-deliveries`, `GET /chatbot-api/requests` (recovery) | 300 | `rateLimits.read` |
| `feed` | `GET /chatbot-api/feed` (the long-poll); never spends `write` or `read` | 120 | `rateLimits.feed` |

`humanDecisions` and `default` have the same budget but **separate counters**: spending one never uses the other (owner decision M1), so stock and expiration traffic cannot starve the catalog and checkout routes, nor the reverse.

`ServiceCredential.rateLimits` is optional JSON mapping a class name to a per-minute budget, e.g. `{"write": 600, "humanDecisions": 120}`. Any class can be overridden, `default` and `humanDecisions` included; a missing, non-numeric or non-positive value (valid: integers 1..9,999,999) falls back to the class default above. The defaults are sized for 60 inbound messages per minute per branch with headroom (proposal §6.4, §11.1) and are measured in the pilot.

The window is measured by the database clock, not by the backend replica's, so replicas with skewed clocks cannot shorten each other's windows; `Retry-After` is the time left in the window, rounded up to whole seconds.

Behavior note: the old in-memory limiter was a sliding window per process; the shared one is a fixed window anchored at the first request, so a burst across a window edge can reach up to twice the budget. The count and the limit per minute are unchanged.

## The feed (slice 5b)

How the backend hands answers to the bot: **pull only**, one consumer, at-least-once. Everything the bot used to poll per request (`GET /chatbot-api/human-decisions/:id`) now also arrives here. **Both paths exist until unit 13** (the old routes and their polls are unchanged; S4), and they describe the same state: a staff answer that goes through the new `resolve` command *and* one that goes through the old staff routes produce the same feed item. The bot can consume the feed and keep polling until it trusts it; it must not send the customer the same answer twice (see "No double delivery").

### `GET /chatbot-api/feed?after=<cursor>&limit=50&waitSeconds=25`

Scope `feed:read`, class `feed`. `after` is the `nextCursor` of the previous answer (omit it to start from the oldest retained item); `limit` 1..50 (default 50); `waitSeconds` 0..25 (default 25; `0` answers at once). Out-of-range values are `400 VALIDATION_ERROR`, not clamped.

```json
{
  "items": [
    {
      "cursor": "000000001842",
      "deliveryId": "b1c0…",
      "type": "request.answered",
      "requestId": "9a7e…",
      "conversationRef": "wa:5215512345678",
      "payload": { "kind": "DECISION", "subtype": "RESTOCK", "action": "PROVIDE_RESTOCK_ESTIMATE", "legacyId": "5d0c…", "text": "El producto «Croquetas 20 kg» estará disponible en aproximadamente 7 días.", "prefix": null, "productName": "Croquetas 20 kg", "restockDays": 7 },
      "notBefore": null,
      "expiresAt": null
    }
  ],
  "nextCursor": "000000001842"
}
```

- **Cursor rules.** Items arrive in ascending cursor order and **cursor order is commit order**: you never see cursor 6 before a cursor 5 that is still to come. Store `nextCursor` **after** you handled the page, and send it as `after`. An empty page returns the `after` you sent, so you can keep it. The cursor is per tenant (the branch of the credential) and is opaque: do not do arithmetic on it. A cursor is never a delivery receipt: reading does not acknowledge anything.
- **Long-poll.** With no item after `after`, the request waits up to `waitSeconds` and answers `{items: [], nextCursor: <after>}` at the deadline, or as soon as an item commits (well under a second). Reconnect immediately. It spends the `feed` budget **once, when it opens**. At most **2 waiting long-polls per credential** (per replica); a third gets `429 RATE_LIMITED` with `Retry-After: 1`. A request that is answered at once never counts as waiting. Hang up whenever you like; the slot is freed.
- **`410 CURSOR_EXPIRED`.** The feed keeps **30 days**. A cursor older than what was purged answers `410`; recover with `GET /chatbot-api/requests?status=open&updatedSince=`: see "Recovery after `410 CURSOR_EXPIRED`" (slice 5c, below) for the exact procedure.
- **Retry.** The same `after` returns the same items again (plus newer ones), so a crash between "read" and "handled" only repeats work. De-duplicate by `deliveryId` (store it as a unique key **before** calling Meta).

### Item types in this slice

| `type` | When | `payload` |
| --- | --- | --- |
| `request.answered` | Staff resolved a wrapped decision (stock, expiration, delivery zone, transfer receipt), from the new `resolve` command or from the old staff routes | `{kind: "DECISION", subtype, action, legacyId, text, prefix, …fields}` below |
| `request.cancelled` | Staff cancelled a request (§12.14); no message of its own | `{requestId, reason, cancelledBy: "STAFF", customerNote?}` |
| `request.merged` | Staff merged this request into another open one of the same customer, subtype **and conversation** (§3.5, §12.11). Informational | `{requestId, intoRequestId, conversationRef}` |
| `request.overdue_notice` | The request went past the deadline of its active clock (§5.4, unit 7c). **Once per request, ever** | `{requestId, folio, kind, subtype, clock, overdueAt, assigned}`, see "`request.overdue_notice`" below |

`conversationRef` is the request's (`null` when the request has none, e.g. a stock request created without one). `legacyId` is the id the bot already tracks from the create answer (`legacy.id`: the human decision, the zone requester or the receipt).

**The bot composes the message; `text` is only a fallback.** Owner decision: the bot writes the wording with each customer's tú/usted register, **from the structured fields** of the payload. The backend `text`/`prefix` are an **usted fallback** for a bot that cannot compose (written in usted throughout, with the one exception noted below). `prefix` is `"Le comparto la respuesta del equipo:"` only when `text` is what staff wrote for the customer, else `null`.

Structured fields (always present unless marked): `kind`, `subtype`, `action`, `legacyId`, and per subtype:

| `subtype` | `action` | Fields |
| --- | --- | --- |
| `RESTOCK` | `PROVIDE_RESTOCK_ESTIMATE` / `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` | `productName`; `restockDays` only for the first |
| `EXPIRATION` | `PROVIDE_EXPIRATION_TEXT` / `REPORT_EXPIRATION_UNAVAILABLE` | `productName`; `expirationText` and `staffText` (the same staff-written string) only for the first |
| `DELIVERY_ZONE` | `APPROVE_DELIVERY_ZONE` / `REJECT_DELIVERY_ZONE` | `zipCode`, `zoneType` (`FREE`, `SURCHARGE`, `CARRIER_ONLY`, `DENIED`); `surchargeCents` and `etaDays` only when they apply |
| `TRANSFER_RECEIPT` | `CONFIRM_RECEIPT` / `REJECT_RECEIPT` | a rejection carries `customerReason`, `reasonSource` and, only for `STAFF`, `staffText` |

```json
{ "kind": "DECISION", "subtype": "RESTOCK", "action": "REPORT_RESTOCK_ESTIMATE_UNAVAILABLE", "legacyId": "…", "text": "Por ahora no tenemos una fecha estimada de reposición para «Croquetas 20 kg».", "prefix": null, "productName": "Croquetas 20 kg" }
{ "kind": "DECISION", "subtype": "EXPIRATION", "action": "PROVIDE_EXPIRATION_TEXT", "legacyId": "…", "text": "Caduca en marzo 2027", "prefix": "Le comparto la respuesta del equipo:", "productName": "Leche", "expirationText": "Caduca en marzo 2027", "staffText": "Caduca en marzo 2027" }
{ "kind": "DECISION", "subtype": "DELIVERY_ZONE", "action": "APPROVE_DELIVERY_ZONE", "legacyId": "…", "text": "Sí entregamos en su código postal (64000) con un cargo de envío de $1,250.00 MXN. Tiempo estimado: 3 días.", "prefix": null, "zipCode": "64000", "zoneType": "SURCHARGE", "surchargeCents": 125000, "etaDays": 3 }
{ "kind": "DECISION", "subtype": "TRANSFER_RECEIPT", "action": "REJECT_RECEIPT", "legacyId": "…", "text": "El monto no coincide, envíenos otro comprobante.", "prefix": "Le comparto la respuesta del equipo:", "customerReason": "El monto no coincide, envíenos otro comprobante.", "reasonSource": "STAFF", "staffText": "El monto no coincide, envíenos otro comprobante." }
```

- **`reasonSource` (receipt rejection).** `STAFF`: a person typed the reason for the customer; relay `staffText` as written (the fallback `prefix` marks it as the team's). `DEFAULT`: staff rejected without a customer reason, and the old route stored its default text; that is **not** staff wording, so there is no `staffText` and `prefix` is `null`: compose your own "we could not validate your receipt, please send it again" in the customer's register. A staff reason that happens to equal the default text is reported as `DEFAULT`.
- **Fallback texts** (the full list, verbatim; `«…»` is `productName`, `N` the days, `$X` an es-MX amount such as `$1,250.00 MXN`, `Z` the postal code):
  - `RESTOCK` with estimate: `El producto «…» estará disponible en aproximadamente N días.` (`1 día` for one day); without: `Por ahora no tenemos una fecha estimada de reposición para «…».`
  - `EXPIRATION` with text: the staff text itself (with the team prefix); without: `Por ahora no tenemos la fecha de caducidad de «…».`
  - `FREE`: `Sí entregamos en su código postal (Z), sin costo de envío.` · `SURCHARGE`: `Sí entregamos en su código postal (Z) con un cargo de envío de $X.` (with no amount, or an amount of 0: `… con un cargo de envío adicional.`, never `$0.00`) · `CARRIER_ONLY`: `En su código postal (Z) el envío es solo por paquetería.` plus ` El cargo de envío es de $X.` when a surcharge is set · `DENIED`: `Por ahora no entregamos en su código postal (Z).` Every approval ends with ` Tiempo estimado: N días.` when `etaDays` is set.
  - `CONFIRM_RECEIPT`: `Le confirmamos la recepción de su comprobante de pago. ¡Gracias!`
  - `REJECT_RECEIPT` with a staff reason: that reason; by default: `No pudimos validar tu comprobante. Por favor envíanos uno nuevo o contáctanos.` (the old route's own default, kept **verbatim**, so it is in **tú**: the one fallback that is not usted).
- The structured fields are what the old poll returns, so you can map them yourself and ignore `text`. The fallback texts live in one place, `src/chatbot-requests/domain/chatbot-feed.ts`.
- **A zone answer is one item per customer** (R9): resolving one request settles every customer waiting on that postal code, and each gets its own item, with its own `conversationRef` and `deliveryId`.
- A customer who cancelled the request (`POST /requests/:id/cancel`) gets **no** item when staff later resolves the old row (the customer withdrew); drop your pending record, as the cancel section says.
- **`request.cancelled` (§12.14).** `reason` is `DUPLICATE`, `NOT_ACTIONABLE`, `CUSTOMER_UNREACHABLE` or `OTHER`. Forget the pending state of that request. `DUPLICATE`: send nothing, ACK `STALE`. The other reasons: send a short notice (`customerNote`, when present and the 24 h window is open, goes as written with the team prefix instead of the generic notice) and ACK `PROVIDER_ACCEPTED` with the `providerMessageId`; with the window closed send nothing and ACK `STALE`. **Never `DEFERRED_WINDOW_CLOSED` for this type**: it is refused with `422 OUTCOME_NOT_ALLOWED`.

- **`request.merged` (§3.5, §12.11; agreed with the chatbot).** `requestId` is the request that was merged away (now `CANCELLED`, reason `SUPERSEDED`); `intoRequestId` is the one that stays open. Both have the **same** `conversationRef` (the backend refuses a merge across conversations, or when either has none, with `409 MERGE_NOT_ALLOWED`), so this item is addressed to one conversation: the item's own `conversationRef` equals the payload's. There is **nothing to send to the customer**. Treat `requestId` as an alias of `intoRequestId`: whatever you were waiting on for the first one, wait on the second. **Only the target is answered later**: when it is resolved you get one `request.answered` for `intoRequestId`, and **none** for `requestId` (no fan-out; this replaces §3.5's "salen entregas para las dos"). The only outcome you may report is **`STALE`**; `PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN`, `DEFERRED_WINDOW_CLOSED` and `DEFERRED_HUMAN_SESSION` are refused with `422 OUTCOME_NOT_ALLOWED`. It is enqueued in the same transaction as the merge, so it exists if and only if the merge committed (a rejected merge leaves no item).

### `POST /chatbot-api/deliveries/:deliveryId/outcome`

Scope `feed:ack`, class `write`. Send it **after** the local effect (the message was accepted by Meta, or you decided not to send). One call per attempt:

```json
{ "attemptId": "0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10", "outcome": "PROVIDER_ACCEPTED", "providerMessageId": "wamid.HBg…", "attemptedAt": "2026-11-10T16:20:00.000Z" }
```

| `outcome` | Meaning | Body |
| --- | --- | --- |
| `PROVIDER_ACCEPTED` | Meta accepted the message | `providerMessageId` required, `attemptedAt` required |
| `DELIVERY_UNKNOWN` | You cannot tell whether it was sent; **do not retry** (the delivery is marked "to reconcile" for staff) | `attemptedAt` required, `providerMessageId` optional |
| `DEFERRED_WINDOW_CLOSED` | The 24 h window is closed; the delivery stays **pending** (see below). Not allowed for `request.cancelled` | `attemptedAt` required |
| `DEFERRED_HUMAN_SESSION` | The conversation is in `HUMAN` mode, so you hold the delivery; it stays **pending** exactly like the window deferral (see below). Not allowed for `request.cancelled` | `attemptedAt` required, no `providerMessageId` |
| `STALE` | Nothing was sent and nothing needs to be (duplicate, customer cancelled, window closed for a cancel notice) | only `attemptId` (`attemptedAt` optional, no `providerMessageId`) |

Exactly those keys; an unknown key, a missing required key, a key an outcome forbids, `FAILED` or any other outcome is `400 VALIDATION_ERROR`. `attemptId` is a lowercase UUID, `attemptedAt` is canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, `providerMessageId` is 1..512 characters, trimmed, no control characters.

`200`: `{"deliveryId", "outcome", "attemptId", "ackReceivedAt"}` (`ackReceivedAt` is `null` for both deferrals, `DEFERRED_WINDOW_CLOSED` and `DEFERRED_HUMAN_SESSION`). One terminal outcome per delivery, the same semantics as the human-decision application outcome:

| Status / code | When |
| --- | --- |
| `200` | First outcome, or an exact replay: the **same `attemptId` and the same evidence** (the backend hashes `attemptId`, `outcome`, `attemptedAt` and `providerMessageId`). A replay of **any attempt this delivery already applied** answers `200` with that attempt's own stored state, even after a later attempt (for example an old `DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION` replayed after the delivery was accepted): it changes nothing |
| `409 IDEMPOTENCY_CONFLICT` | An `attemptId` this delivery already applied, sent with other evidence |
| `409 OUTCOME_ALREADY_RECORDED` | A **new** `attemptId` after a terminal outcome (`PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN` or `STALE`; a deferral is not terminal) |
| `422 OUTCOME_NOT_ALLOWED` | `DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION` for a `request.cancelled` or `request.overdue_notice` delivery; **any outcome except `STALE` for a `request.merged` delivery** |
| `404 NOT_FOUND` (`message: "Delivery not found"`) | Unknown delivery, or one of another branch |
| `400 VALIDATION_ERROR` | Body or `deliveryId` malformed |
| `403 INSUFFICIENT_SCOPE`, `401`, `429 RATE_LIMITED` | Credential, scope, budget |

Retry a lost ACK with the **same body**: it answers `200`. A new send attempt after a deferral (either) uses a **new `attemptId`**. Every first outcome adds a `DELIVERY_OUTCOME` event to the request's audit (`needsReconciliation: true` for `DELIVERY_UNKNOWN`).

### `GET /chatbot-api/requests/pending-deliveries?conversationRef=` (or `?requestId=`)

Scope `feed:read`, class `read`. The deliveries whose last outcome was a deferral (`DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION`) and that have no terminal outcome yet (up to 50, ascending cursor), in the same item shape as the feed plus **`deferredReason`**: `{ "items": [ … ] }`.

```json
{ "items": [ { "cursor": "000000001842", "deliveryId": "b1c0…", "type": "request.answered", "requestId": "9a7e…", "conversationRef": "wa:5215512345678", "payload": { "kind": "DECISION", "…": "…" }, "notBefore": null, "expiresAt": null, "deferredReason": "HUMAN_SESSION" } ] }
```

`deferredReason` says which deferral applies, so you know when to ask again:

| `deferredReason` | Replay it when |
| --- | --- |
| `WINDOW_CLOSED` | The customer writes again (the 24 h window is open). Deliver and ACK with a new `attemptId`. |
| `HUMAN_SESSION` | The human session ended (`conversation.ended`, unit 11) or the conversation's next bot-mode turn. Deliver and ACK with a new `attemptId`. |

Both are served by the same route, by `conversationRef` and by `requestId`. This avoids walking the feed again.

Send **exactly one** filter (both or neither is `400`):

- `conversationRef` (1..200 characters): the deliveries of that conversation.
- `requestId` (a request UUID, the `id` of the create answer): the deliveries of that request. **Use this for a request that has no `conversationRef`** (a stock or expiration request created without one, or one created by the old routes): its items carry `conversationRef: null` and could never be found by conversation. Chosen over deriving a `wa:` reference because those requests have no customer phone to derive it from.

### No double delivery

- The bot stores `deliveryId` as a unique key **before** calling Meta. If it cannot tell whether a send happened, it reports `DELIVERY_UNKNOWN` and does not retry.
- An answer can reach you twice while both paths exist (the feed and the legacy poll of the same decision). Track the answer by the request's `legacyId`: whichever arrives first is delivered, and the other is ACKed `STALE` (feed) or ignored (poll).
- Run **one consumer** per branch (an advisory lock on your side): two consumers would both see every item.

### v1 clarifications of the contract (§3.3 and §12.14)

The proposal leaves these open; this is what the backend does, and the bot should rely on it:

1. **`attemptedAt` is optional only for `STALE`.** §3.3 lists it for every outcome. `STALE` is a definite "nothing was sent", so there is no attempt time to report; every other outcome requires it.
2. **`providerMessageId` is rejected (`400`) for `DEFERRED_WINDOW_CLOSED`, `DEFERRED_HUMAN_SESSION` and `STALE`.** No message was accepted in those cases. It is required for `PROVIDER_ACCEPTED` and optional for `DELIVERY_UNKNOWN` (audit only).
3. **`422 OUTCOME_NOT_ALLOWED`: `DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION` for a `request.cancelled` delivery.** §12.14 says the bot never defers a cancellation notice (a closure notice days later only annoys the customer); the reason for waiting does not change that, so the backend enforces it for both deferrals and such an item cannot sit pending forever. Answer `STALE` instead.
4. **`DEFERRED_HUMAN_SESSION` is a non-terminal outcome, exactly like `DEFERRED_WINDOW_CLOSED` (slice 5c).** `ackedAt` stays empty, `GET …/pending-deliveries` serves the delivery (with `deferredReason: "HUMAN_SESSION"`), and a later attempt with a new `attemptId` may end it with any outcome, or defer again for either reason. The deferral is recorded in the request's audit (`DELIVERY_OUTCOME`, `outcome: "DEFERRED_HUMAN_SESSION"`). The backend does not look at the conversation's mode: reporting it is the bot's call.

5. **`request.merged` takes only `STALE`** (a v1.2 type, §3.5): it carries information, not a message, so there is nothing to accept, defer or reconcile. Any other outcome is `422 OUTCOME_NOT_ALLOWED` and the item stays pending until a `STALE` ACK. A replay of the same `STALE` attempt answers `200`, like any outcome.

Also: `FAILED` is not an outcome; the 404 of the outcome route says `Delivery not found`; the backend sends the long-poll answers `Cache-Control: no-store`.

### Recovery after `410 CURSOR_EXPIRED` (slice 5c)

`GET /chatbot-api/requests?status=open&updatedSince=<ISO>&cursor=&limit=50`

Scope `requests:read`, class `read`, tenant from the credential (`X-Branch-Id`, when sent, must equal it). Use it when the feed answers `410 CURSOR_EXPIRED` (or whenever you lose your cursor): it hands back the requests you must know about and the feed position to resume from.

| Param | Rule |
| --- | --- |
| `status` | Required, exactly `open`. |
| `updatedSince` | Optional, canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Adds the requests **closed at or after** this instant (`RESOLVED` or `CANCELLED`), so you can drop them. The backend reaches **5 s earlier** than the value you send, because `updatedAt` and `closedAt` are stamped by whichever backend replica writes, with its own clock: a request closed by a replica whose clock runs slightly behind is still returned. You may therefore see a closed request you already handled; dedupe by `id`. Open requests are returned **all**, however old, with or without it. Send an instant **earlier** than your last sync (the last instant your pending state was complete), never later. |
| `cursor` | The `nextPage` of the previous page; omit for the first page. Opaque. |
| `limit` | 1..50, default 50. |

Anything else (a missing or other `status`, an unknown key, a non-canonical `updatedSince`, `limit` 0 or 51, a malformed `cursor`) is `400 VALIDATION_ERROR`, never clamped or ignored. Pages are ordered by `(updatedAt, id)` ascending and keyset-paginated: a request updated while you walk may be seen once more at the end; none is skipped. Cost per page does not depend on how many requests the branch has closed.

```json
{
  "items": [
    {
      "id": "9a7e…", "folio": "S-000123", "kind": "DECISION", "subtype": "RESTOCK",
      "status": "RESOLVED",
      "conversationRef": "wa:5215512345678",
      "legacyId": "5d0c…",
      "whatsappWindowClosesAt": "2026-11-11T16:20:00.000Z",
      "cancelReason": null,
      "createdAt": "2026-11-10T10:00:00.000Z", "updatedAt": "2026-11-10T16:00:00.000Z", "closedAt": "2026-11-10T16:00:00.000Z",
      "pendingDeliveries": [
        { "cursor": "000000001842", "deliveryId": "b1c0…", "type": "request.answered", "requestId": "9a7e…", "conversationRef": "wa:5215512345678", "payload": { "kind": "DECISION", "…": "…" }, "notBefore": null, "expiresAt": null, "deferredReason": null }
      ],
      "undeliveredTruncated": false,
      "undeliveredResumeAfter": null
    }
  ],
  "nextCursor": "000000001900",
  "nextPage": "eyJ1Ijoi…"
}
```

- It is the bot's view: ids, folio, kind, subtype, status, `conversationRef` (the bot's own key, `wa:<wa_id>`: **it contains the customer's phone number**, so keep it out of logs and analytics like any phone),  `legacyId` (the id you track from the create answer, for wrapped subtypes), the window, `cancelReason` and times. **No customer name, assignee or staff data, and no free text.**
- **`pendingDeliveries`**: the request's latest **5** feed items with no terminal outcome, oldest first, in the feed item shape plus `deferredReason` (`null` when no attempt was reported yet, else `WINDOW_CLOSED` or `HUMAN_SESSION`). Use `deliveryId` to deliver and ACK (or ACK `STALE`) the answers you never delivered. A closed request keeps showing its answer until it is acknowledged.
- **`undeliveredTruncated` / `undeliveredResumeAfter`.** `pendingDeliveries` lists at most 5 items per request. When the request has more undelivered items than that, `undeliveredTruncated` is `true` and `undeliveredResumeAfter` is the feed `after` that serves its **oldest** undelivered item again (its cursor minus one); otherwise they are `false` and `null`. If any request in the walk is truncated, resume the feed from the **smallest** of those `undeliveredResumeAfter` values and the walk's `nextCursor` (all are fixed-width, zero-padded cursors, so compare them as strings; do no arithmetic), and dedupe by `deliveryId`: the feed then re-serves the older items. Do **not** use `pending-deliveries` for this: it serves deferred items only, not the ones that were never attempted.
- **`nextCursor`** is the tenant's feed position when the **first page** was served (never below the retention watermark; `000000000000` for an empty feed). **Every page of one walk answers the same value** (the page cursor carries it).
- **`nextPage`** is the `cursor` of the next page, `null` on the last one.

Procedure:

1. The feed answers `410 CURSOR_EXPIRED`. Stop using that cursor.
2. Call the route with `status=open` and `updatedSince` = the last instant your state was complete. Omit it if you do not know: every open request is returned anyway, so a pending record of yours for a request the walk did not list as open is a closed one (you just do not get its final status or its unacknowledged answer).
3. Walk every page with `cursor=<nextPage>` until `nextPage` is `null`. Keep the `nextCursor` of the first page.
4. For each item, make your records match it: `NEW` or `IN_PROGRESS` → you must hold a pending record (create or refresh it from `conversationRef`, `legacyId`, the window); `RESOLVED` or `CANCELLED` → drop the pending record (and the same for any record the walk did not list as open). Then handle its `pendingDeliveries` as feed items (same type rules, dedupe by `deliveryId`, ACK each).
5. Only after every page was processed and saved, store as your feed position `nextCursor` (or, if a request came back truncated, the smaller `undeliveredResumeAfter`, see above) and resume `GET /chatbot-api/feed?after=<that>`. Everything that committed after the walk started is after that position; what the walk already showed may arrive again in the feed, which is safe (dedupe by `deliveryId`, ACKs are idempotent). `nextCursor` is accepted by the feed (it is never below the purge watermark), so it cannot answer `410` again right away.

### Shutdown and restarts

On a deploy or restart the backend wakes its waiting long-polls, which answer `{items: [], nextCursor: <after>}` at once. Reconnect and keep your cursor: nothing is lost, and the next poll reads from it.

### Deploy checklist for 5b

- The credential needs `feed:read` and `feed:ack` (`ServiceCredential.scopes`).
- The backend needs a direct PostgreSQL connection for `LISTEN` (no transaction-pooling proxy in front of `DATABASE_URL`); each replica opens one extra connection.
- Migration `20261110050000_chatbot_feed` (additive; see `docs/chatbot-requests-model.md`, "Deploy safety").

### `request.overdue_notice` (unit 7c, contract §5.4)

**What it is.** The backend's SLA sweep (every 30 s, on every replica, `FOR UPDATE SKIP LOCKED`) found an open request past the deadline of its active clock: the **claim** clock while it is `NEW` (nobody took it in time) or the **resolve** clock once someone holds it or when the subtype has no claim time. The bot tells the customer **once** that the team is taking longer than expected. Staff are notified separately; this item is only for the customer.

**When.** In the same transaction that marks the request overdue (`overdueAt`), at the first overdue of the request. The clocks count business minutes (they pause outside the opening hours and on closed dates), so the item appears at the real deadline, which for a transfer receipt is the close of the business day. A request that is later released, re-claimed or overdue again on its other clock produces **no second item**. Exactly one `request.overdue_notice` exists per request: a unique index `(tenantId, requestId)` for this type rejects a second one, and the sweep also only emits it while `overdueAt` was empty, which lives on the request (it survives the 30-day feed purge). A request closed before the sweep reaches its deadline never gets one. **Only if it expired less than 24 h ago (owner decision, 2026-11-11).** When the sweep first marks the request overdue and the deadline is **24 hours or more** behind (wall-clock, a late sweep, downtime or the backlog below), the backend does **not** create this item: telling the customer a day later is noise. `overdueAt` is still set and staff are still notified; the request's `SLA_MILESTONE` audit event records `customerNotice: "SKIPPED_STALE"` (`"SENT"` when the item was created). The boundary is exact: 23 h 59 m 59 s sends, 24 h 00 m 00 s skips. So an old open request that is already overdue when this ships produces **no** customer item, only the ones that expire from then on. This is decided once, at the first overdue; it is never re-evaluated later. A backlog (the sweep was down) is caught up in batches of 100 per 30 s.

**Customer vs staff timing.** The customer item is created at the real deadline instant (the sweep's next tick), even outside business hours: the bot decides whether to send. Staff notices are different: they are held until the tenant's next opening (see `docs/notifications-model.md`).

**Payload.**

```json
{
  "requestId": "…",
  "folio": "S-000123",
  "kind": "DECISION | CLARIFICATION | CONVERSATION",
  "subtype": "RESTOCK | EXPIRATION | DELIVERY_ZONE | TRANSFER_RECEIPT | TALK_TO_HUMAN | COMPLAINT | UNKNOWN_QUESTION | DISCOUNT",
  "clock": "CLAIM | RESOLVE",
  "overdueAt": "2026-11-10T16:30:00.000Z",
  "assigned": false
}
```

The item's own `conversationRef` is the request's (`null` when it has none: then you can only tell the customer through the `legacyId` you track for a wrapped request, or skip). `overdueAt` is the deadline that expired, not the instant of the sweep. `assigned` says only whether someone holds the request (no names, no staff text). You compose the message yourself (tú/usted); suggested meaning: "seguimos revisando su solicitud, está tardando más de lo esperado". It does not promise a time.

**ACK** (`POST /chatbot-api/deliveries/:deliveryId/outcome`, same body as the others). Allowed: `PROVIDER_ACCEPTED` (you sent it), `DELIVERY_UNKNOWN` (you tried and cannot tell), `STALE` (you did not send it: the request is already answered or cancelled on your side, the 24 h window is closed, or the customer is in a human session). **`DEFERRED_WINDOW_CLOSED` and `DEFERRED_HUMAN_SESSION` are refused with `422 OUTCOME_NOT_ALLOWED`**, like `request.cancelled`: a late "seguimos revisando" only annoys, so report `STALE` instead of deferring. Idempotency is the common rule: the same `attemptId` with the same evidence replays `200`; another attempt after a terminal outcome is `409 OUTCOME_ALREADY_RECORDED`.

**Idempotency on your side.** The item has a stable `deliveryId`; process it by `deliveryId`/`requestId`. Seeing it twice (at-least-once) must not send twice: after your ACK it is not served again, and before it you may re-read it.

**Not covered yet.** The conversation clocks of §4.6 (5, 15, 30 min and 2 h) arrive with unit 11. Until then a conversation request (`TALK_TO_HUMAN`, `COMPLAINT`) follows the same claim/resolve clocks as any other, and a request with a live human session does not exist yet: when unit 11 lands the bot stays silent in a session, so report `STALE` for an overdue notice that reaches you while `HUMAN`.

### Deploy checklist for 7c

- Migration `20261111070000_chatbot_sla_sweep`: two partial UNIQUE indexes (`chatbot_feed_items_overdue_notice_uq`, `chatbot_request_events_sla_milestone_uq`), no column change. Nothing writes rows of those kinds before this unit, so they build over zero matching rows and cannot fail on duplicates; deploy at low traffic (SHARE lock for the build, `lock_timeout` 5 s).
- **Burst when it ships.** Open requests that were already past their deadline (RESTOCK/EXPIRATION/ZONE rows wrapped by the backfill, for example) are marked overdue by the first sweeps. Those whose deadline is 24 h or more old get **no** customer item (rule above); only recently expired ones do. Staff do get one notice per request (held to the next opening). The sweep drains 100 rows per 30 s (about 200 a minute). Check `oldestOpenAt` of the backfill dry run first.

### Deploy checklist for 5c

- The credential needs `requests:read` for the recovery route (and keeps `feed:read` / `feed:ack`).
- Migration `20261110060000_chatbot_feed_recovery` (no table or column change: it widens the outcome CHECKs for `DEFERRED_HUMAN_SESSION`, replaces the pending-deliveries partial index and adds two partial indexes on `chatbot_requests`; see `docs/chatbot-requests-model.md`, "Deploy safety"). Deploy the backend before the bot reports `DEFERRED_HUMAN_SESSION`: an older backend answers `400` for the unknown outcome.
