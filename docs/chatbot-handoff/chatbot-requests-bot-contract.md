# Chatbot ↔ backend: human requests (slices 5a, 5b, 5c; conversation mirror and media: unit 9; clarification replies: unit 10)

What the chatbot session consumes. Contract source: `docs/proposals/human-intervention-backend-proposal.md` §3.1–§3.5, §3.9, §4.5, §6.4, §10.1 R2/R7, §12.14. Implemented: **create**, **merge**, **customer cancel**, the **route budgets** (5a) and the **feed**, the **delivery outcome** and **pending deliveries** (5b, below), and the **recovery route** with the new outcome `DEFERRED_HUMAN_SESSION` (5c, below). The **conversation mirror** (`messages:batch`, `statuses:batch`) and **media** (`POST /chatbot-api/media`) are implemented (unit 9, section "Conversation mirror and media" below; this is what the outbox's `MESSAGE_MIRROR` rows send). **Clarification replies** (a staff answer to an `UNKNOWN_QUESTION`, delivered through the feed, deferred while the 24 h window is closed, and mirrored as the staff member's message) are unit 10, section "Clarification replies (unit 10)" below. **Live conversations** (`conversation.started`, `conversation.staff_message`, `conversation.reassigned`, `conversation.ended`, `template.requested`, `session-ack`, `GET …/state`, the bulk `GET …/conversations/state?mode=HUMAN`, staff media through `GET /chatbot-api/media/:id`) are unit 11, section "Live conversation (unit 11)" at the end. Not yet: `cancel-batch`, `reschedule`, scheduling slots, and the feed types of later units (`request.cancel_ack`, `conversation.scheduled_reminder`, `conversation.rescheduled`).

## Common rules

| Rule        | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | `Authorization: Bearer svc_…`. `X-Branch-Id`, when sent, must equal the credential's tenant (else `403 FORBIDDEN`). The tenant, source and credential never go in a body.                                                                                                                                                                                                                                                                                                                                      |
| Scopes      | `requests:create`, `requests:read`, `requests:cancel`, `feed:read`, `feed:ack`, `conversation:write`, `media:write`, `media:read` (unit 11: downloads a staff file). They are free text on `ServiceCredential.scopes`; add the ones a credential needs. A missing scope is `403 INSUFFICIENT_SCOPE`. The create and cancel routes use `requests:create` and `requests:cancel`; the recovery route uses `requests:read`; the feed and pending deliveries use `feed:read`; the delivery outcome uses `feed:ack`. |
| Idempotency | Every write sends `X-Idempotency-Key: <uuid>`. Create: it must equal the body's `sourceRequestId` (compared literally, else `400`). Cancel: any UUID. Same key and same canonical hash → the same answer; same key and another body → `409 IDEMPOTENCY_CONFLICT`. Create keys are one namespace across all subtypes: a `sourceRequestId` already used for a `RESTOCK` and sent again as a `COMPLAINT` (or the other way round) is a conflict, never a second request.                                          |
| Errors      | `{ "statusCode": 409, "code": "…", "message": "…" }` plus the extra fields listed per error. All responses, errors included, carry `Cache-Control: no-store`.                                                                                                                                                                                                                                                                                                                                                  |
| Rate limit  | `429 RATE_LIMITED` with `Retry-After` (seconds). See "Route budgets".                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## `POST /chatbot-api/requests`

Scope `requests:create`, class `write`. Body = the common envelope plus `detail`:

```json
{
  "sourceRequestId": "5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10",
  "subtype": "UNKNOWN_QUESTION",
  "customer": {
    "phoneCountryCode": "52",
    "phone": "5512345678",
    "displayName": "Juan"
  },
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

| Field                                      | Rule                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceRequestId`                          | UUID.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `subtype`                                  | `UNKNOWN_QUESTION`, `TALK_TO_HUMAN`, `COMPLAINT` (created directly) or `RESTOCK`, `EXPIRATION`, `DELIVERY_ZONE` (legacy intake). `TRANSFER_RECEIPT` and `DISCOUNT` → `422 SUBTYPE_DISABLED` (receipts keep entering through `POST /chatbot-api/sales/:id/receipts`).                                                                                                                                      |
| `customer`                                 | `{phoneCountryCode, phone, displayName?}`. The backend computes `customerKey` with `canonicalPhone` (R1): Mexico's `521` + 10 digits and `52` + 10 digits are the same person. `displayName` is validated and **not stored**. A number with no canonical form is `400`. Required for the three direct subtypes; optional for the wrapped ones.                                                            |
| `conversationRef`, `lastCustomerMessageAt` | Required for the direct subtypes (≤ 200 chars; ISO-8601 with `Z` or an offset). The 24 h window closes at `lastCustomerMessageAt + 24 h`. `lastCustomerMessageAt` must be at most 5 minutes in the future and at most 30 days old, else `400 VALIDATION_ERROR` (also when the request merges).                                                                                                            |
| `summary`                                  | 1..140 chars, no control characters. Required for the direct subtypes; wrapped ones default to a short Spanish label.                                                                                                                                                                                                                                                                                     |
| `needs`                                    | ≤ 1000 chars, plain text.                                                                                                                                                                                                                                                                                                                                                                                 |
| `context`                                  | Only these keys: `cartRef`, `saleId`, `orderId` (id strings ≤ 100), `productIds`, `variantIds` (≤ 20 ids), `quantity` (integer 0..100000). Never prices.                                                                                                                                                                                                                                                  |
| `dedupKey`                                 | `[A-Za-z0-9:_.-]{1,200}`; needs `customer`.                                                                                                                                                                                                                                                                                                                                                               |
| `triggerWaMessageId`                       | The WhatsApp id of the message that triggered it; stored in the audit event only.                                                                                                                                                                                                                                                                                                                         |
| `scheduledFor`                             | Unit 14: an ISO-8601 instant that is the `startsAt` of a bookable block, `TALK_TO_HUMAN`/`COMPLAINT` only; see "Scheduled conversations (unit 14)" below. `422 SCHEDULING_DISABLED` when the branch's scheduling is off.                                                                                                                                                                                  |
| `detail`                                   | `{}` (or absent) for the direct subtypes. For `RESTOCK`, `EXPIRATION` and `DELIVERY_ZONE` it is **exactly today's body** of `POST /chatbot-api/human-decisions` (including its own `sourceRequestId`, which must equal the envelope's, and `type`, which must equal `subtype`), validated by the same parsers. For `DELIVERY_ZONE`, a `customer` in the envelope must be the same number as the detail's. |

### Answer

`201` when created; `200` for a replay or a merge.

```json
{
  "id": "…",
  "folio": "S-000123",
  "status": "NEW",
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

| Status / code                                    | When                                                                                                  | Extra fields                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `400 VALIDATION_ERROR`                           | bad body, bad key, key ≠ `sourceRequestId` (cancel: also an `:id` that is not a UUID)                 | —                                                                                  |
| `401`, `403 INSUFFICIENT_SCOPE`, `403 FORBIDDEN` | credential, scope, branch                                                                             | —                                                                                  |
| `404 NOT_FOUND`                                  | a wrapped `detail` refers to a missing product (as the old route)                                     | —                                                                                  |
| `409 IDEMPOTENCY_CONFLICT`                       | same key, other body                                                                                  | —                                                                                  |
| `409 CUSTOMER_OPEN_LIMIT`                        | the customer already has 20 open requests, all subtypes together                                      | `limit: 20`, `open: 20`                                                            |
| `429 CUSTOMER_RATE_LIMITED`                      | 10 requests created for this customer in the last hour (counted in the database; merges do not count) | `limit: 10`; `Retry-After` header: seconds until the count is back under the limit |
| `422 SUBTYPE_DISABLED`                           | `TRANSFER_RECEIPT`, `DISCOUNT`                                                                        | —                                                                                  |
| `422 SCHEDULING_DISABLED`                        | `scheduledFor` sent                                                                                   | —                                                                                  |
| `409 VERSION_CONFLICT`                           | the open request kept opening and closing across three attempts (practically never); retry            | —                                                                                  |
| `429 RATE_LIMITED`                               | the credential's `write` budget                                                                       | `Retry-After` header                                                               |

`CUSTOMER_RATE_LIMITED` is not in the proposal's error list; it is a different code from `RATE_LIMITED` on purpose: retrying a credential-limited call later is right, retrying a per-customer one is not.

## `POST /chatbot-api/requests/:id/cancel`

Scope `requests:cancel`, class `write`. Body `{ "reason": "CUSTOMER_WITHDREW" | "AUTO_RESOLVED", "triggerWaMessageId": "wamid.…" }`, `X-Idempotency-Key` required.

`200`:

```json
{
  "id": "…",
  "status": "CANCELLED",
  "reason": "CUSTOMER_WITHDREW",
  "cancelledAt": "2026-11-10T16:20:00.000Z"
}
```

| Status / code                                      | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404 NOT_FOUND`                                    | unknown id, or an id of another branch                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `409 ALREADY_RESOLVED`                             | the request is `RESOLVED`; the body carries `resolution` (what staff decided, e.g. `{"action":"PROVIDE_RESTOCK_ESTIMATE","restockDays":7,"via":"LEGACY_ROUTE"}` for a stock decision) so the bot delivers it instead of saying "cancelled". For a clarification answered by staff (unit 10) it is `{"action":"REPLY","replyId":"…","text":"…"}`: deliver `text` (the reply may not have reached the customer yet, e.g. a deferred delivery) instead of saying "cancelled" |
| `409 REQUEST_CLOSED`                               | already `CANCELLED` (with another key)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `409 CANCEL_NOT_ALLOWED`                           | a live conversation (`STARTING`/`ACTIVE`/`ENDING`); the customer's words go to the attendant (§4). Live sessions arrive with unit 11, so no request is live yet                                                                                                                                                                                                                                                                                                           |
| `409 IDEMPOTENCY_CONFLICT`, `400 VALIDATION_ERROR` | as above                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Notes:

- Works on `NEW` and `IN_PROGRESS` requests, every kind, including a conversation that has not started (`WAITING`).
- For a wrapped decision (`RESTOCK`, `EXPIRATION`, `DELIVERY_ZONE`) only the request closes; the legacy row stays `PENDING` and the old routes still work on it (see `docs/chatbot-requests-model.md`, "Customer cancel of a wrapped decision"). **After a successful cancel the bot must drop its own pending record of the legacy row for that decision and ignore any later outcome of `GET /chatbot-api/human-decisions/:id` for it.** Staff may still resolve the legacy row afterwards (a stock decision, or a zone resolved for other customers), and that poll then answers `RESOLVED`; the customer withdrew, so the bot sends nothing. Example: the customer asks for stock of croquetas, the bot creates the request (`legacy.id = "hd-1"`), the customer says "ya no", the bot cancels (`200`) and deletes its `hd-1` tracking; ten minutes later staff answers `hd-1` and the poll returns `RESOLVED`; the bot ignores it and does not call `application-outcome` for it.
- A cancelled request leaves the inbox group and sends no message to the customer.

## Route budgets (R2)

Counters live in PostgreSQL (`service_rate_buckets`), so every replica shares them: one counter per (credential, class), a window of 60 s that opens at its first request.

| Class            | Used by                                                                                                                                                                                                                          | Default per minute                | Override                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| `default`        | the other chatbot-api routes that existed before this contract (catalog, customers, checkout, shipping quotes, receipts…)                                                                                                        | the credential's `rateLimit` (60) | `rateLimits.default`, else `rateLimit`        |
| `humanDecisions` | the stock, expiration and delivery-zone routes: `POST /chatbot-api/human-decisions`, `GET /chatbot-api/human-decisions/:id`, `POST …/:id/application-outcome`                                                                    | the credential's `rateLimit` (60) | `rateLimits.humanDecisions`, else `rateLimit` |
| `write`          | `POST /chatbot-api/requests`, `…/:id/cancel`, `POST /chatbot-api/deliveries/:id/outcome`, `POST /chatbot-api/conversations/:ref/messages:batch`, `POST /chatbot-api/messages/statuses:batch`, `POST /chatbot-api/media` (unit 9) | 300                               | `rateLimits.write`                            |
| `read`           | `GET /chatbot-api/requests/pending-deliveries`, `GET /chatbot-api/requests` (recovery)                                                                                                                                           | 300                               | `rateLimits.read`                             |
| `feed`           | `GET /chatbot-api/feed` (the long-poll); never spends `write` or `read`                                                                                                                                                          | 120                               | `rateLimits.feed`                             |

`humanDecisions` and `default` have the same budget but **separate counters**: spending one never uses the other (owner decision M1), so stock and expiration traffic cannot starve the catalog and checkout routes, nor the reverse.

`ServiceCredential.rateLimits` is optional JSON mapping a class name to a per-minute budget, e.g. `{"write": 600, "humanDecisions": 120}`. Any class can be overridden, `default` and `humanDecisions` included; a missing, non-numeric or non-positive value (valid: integers 1..9,999,999) falls back to the class default above. The defaults are sized for 60 inbound messages per minute per branch with headroom (proposal §6.4, §11.1) and are measured in the pilot.

The window is measured by the database clock, not by the backend replica's, so replicas with skewed clocks cannot shorten each other's windows; `Retry-After` is the time left in the window, rounded up to whole seconds.

Behavior note: the old in-memory limiter was a sliding window per process; the shared one is a fixed window anchored at the first request, so a burst across a window edge can reach up to twice the budget. The count and the limit per minute are unchanged.

## The feed (slice 5b)

How the backend hands answers to the bot: **pull only**, one consumer, at-least-once. Everything the bot used to poll per request (`GET /chatbot-api/human-decisions/:id`) now also arrives here. **Both paths exist until unit 13** (the old routes and their polls are unchanged; S4), and they describe the same state: a staff answer that goes through the new `resolve` command _and_ one that goes through the old staff routes produce the same feed item. The bot can consume the feed and keep polling until it trusts it; it must not send the customer the same answer twice (see "No double delivery").

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
      "payload": {
        "kind": "DECISION",
        "subtype": "RESTOCK",
        "action": "PROVIDE_RESTOCK_ESTIMATE",
        "legacyId": "5d0c…",
        "text": "El producto «Croquetas 20 kg» estará disponible en aproximadamente 7 días.",
        "prefix": null,
        "productName": "Croquetas 20 kg",
        "restockDays": 7
      },
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

| `type`                   | When                                                                                                                                                | `payload`                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `request.answered`       | Staff resolved a wrapped decision (stock, expiration, delivery zone, transfer receipt), from the new `resolve` command or from the old staff routes | `{kind: "DECISION", subtype, action, legacyId, text, prefix, …fields}` below                                                 |
| `request.answered`       | Staff answered a clarification (`UNKNOWN_QUESTION`) with `reply` (unit 10)                                                                          | `{kind: "CLARIFICATION", subtype, action: "REPLY", replyId, text, prefix, staffText}`: see "Clarification replies (unit 10)" |
| `request.cancelled`      | Staff cancelled a request (§12.14); no message of its own                                                                                           | `{requestId, reason, cancelledBy: "STAFF", customerNote?}`                                                                   |
| `request.merged`         | Staff merged this request into another open one of the same customer, subtype **and conversation** (§3.5, §12.11). Informational                    | `{requestId, intoRequestId, conversationRef}`                                                                                |
| `request.overdue_notice` | The request went past the deadline of its active clock (§5.4, unit 7c). **Once per request, ever**                                                  | `{requestId, folio, kind, subtype, clock, overdueAt, assigned}`, see "`request.overdue_notice`" below                        |

`conversationRef` is the request's (`null` when the request has none, e.g. a stock request created without one). `legacyId` is the id the bot already tracks from the create answer (`legacy.id`: the human decision, the zone requester or the receipt).

**The bot composes the message; `text` is only a fallback.** Owner decision: the bot writes the wording with each customer's tú/usted register, **from the structured fields** of the payload. The backend `text`/`prefix` are an **usted fallback** for a bot that cannot compose (written in usted throughout, with the one exception noted below). `prefix` is `"Le comparto la respuesta del equipo:"` only when `text` is what staff wrote for the customer, else `null`.

Structured fields (always present unless marked): `kind`, `subtype`, `action`, `legacyId`, and per subtype:

| `subtype`          | `action`                                                           | Fields                                                                                                                     |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `RESTOCK`          | `PROVIDE_RESTOCK_ESTIMATE` / `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` | `productName`; `restockDays` only for the first                                                                            |
| `EXPIRATION`       | `PROVIDE_EXPIRATION_TEXT` / `REPORT_EXPIRATION_UNAVAILABLE`        | `productName`; `expirationText` and `staffText` (the same staff-written string) only for the first                         |
| `DELIVERY_ZONE`    | `APPROVE_DELIVERY_ZONE` / `REJECT_DELIVERY_ZONE`                   | `zipCode`, `zoneType` (`FREE`, `SURCHARGE`, `CARRIER_ONLY`, `DENIED`); `surchargeCents` and `etaDays` only when they apply |
| `TRANSFER_RECEIPT` | `CONFIRM_RECEIPT` / `REJECT_RECEIPT`                               | a rejection carries `customerReason`, `reasonSource` and, only for `STAFF`, `staffText`                                    |

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
{
  "attemptId": "0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10",
  "outcome": "PROVIDER_ACCEPTED",
  "providerMessageId": "wamid.HBg…",
  "attemptedAt": "2026-11-10T16:20:00.000Z"
}
```

| `outcome`                | Meaning                                                                                                                                                               | Body                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PROVIDER_ACCEPTED`      | Meta accepted the message                                                                                                                                             | `providerMessageId` required, `attemptedAt` required              |
| `DELIVERY_UNKNOWN`       | You cannot tell whether it was sent; **do not retry** (the delivery is marked "to reconcile" for staff)                                                               | `attemptedAt` required, `providerMessageId` optional              |
| `DEFERRED_WINDOW_CLOSED` | The 24 h window is closed; the delivery stays **pending** (see below). Not allowed for `request.cancelled`                                                            | `attemptedAt` required                                            |
| `DEFERRED_HUMAN_SESSION` | The conversation is in `HUMAN` mode, so you hold the delivery; it stays **pending** exactly like the window deferral (see below). Not allowed for `request.cancelled` | `attemptedAt` required, no `providerMessageId`                    |
| `STALE`                  | Nothing was sent and nothing needs to be (duplicate, customer cancelled, window closed for a cancel notice)                                                           | only `attemptId` (`attemptedAt` optional, no `providerMessageId`) |

Exactly those keys; an unknown key, a missing required key, a key an outcome forbids, `FAILED` or any other outcome is `400 VALIDATION_ERROR`. `attemptId` is a lowercase UUID, `attemptedAt` is canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, `providerMessageId` is 1..512 characters, trimmed, no control characters.

`200`: `{"deliveryId", "outcome", "attemptId", "ackReceivedAt"}` (`ackReceivedAt` is `null` for both deferrals, `DEFERRED_WINDOW_CLOSED` and `DEFERRED_HUMAN_SESSION`). One terminal outcome per delivery, the same semantics as the human-decision application outcome:

| Status / code                                       | When                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`                                               | First outcome, or an exact replay: the **same `attemptId` and the same evidence** (the backend hashes `attemptId`, `outcome`, `attemptedAt` and `providerMessageId`). A replay of **any attempt this delivery already applied** answers `200` with that attempt's own stored state, even after a later attempt (for example an old `DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION` replayed after the delivery was accepted): it changes nothing |
| `409 IDEMPOTENCY_CONFLICT`                          | An `attemptId` this delivery already applied, sent with other evidence                                                                                                                                                                                                                                                                                                                                                                                |
| `409 OUTCOME_ALREADY_RECORDED`                      | A **new** `attemptId` after a terminal outcome (`PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN` or `STALE`; a deferral is not terminal)                                                                                                                                                                                                                                                                                                                       |
| `422 OUTCOME_NOT_ALLOWED`                           | `DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION` for a `request.cancelled` or `request.overdue_notice` delivery; **any outcome except `STALE` for a `request.merged` delivery**                                                                                                                                                                                                                                                                   |
| `404 NOT_FOUND` (`message: "Delivery not found"`)   | Unknown delivery, or one of another branch                                                                                                                                                                                                                                                                                                                                                                                                            |
| `400 VALIDATION_ERROR`                              | Body or `deliveryId` malformed                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `403 INSUFFICIENT_SCOPE`, `401`, `429 RATE_LIMITED` | Credential, scope, budget                                                                                                                                                                                                                                                                                                                                                                                                                             |

Retry a lost ACK with the **same body**: it answers `200`. A new send attempt after a deferral (either) uses a **new `attemptId`**. Every first outcome adds a `DELIVERY_OUTCOME` event to the request's audit (`needsReconciliation: true` for `DELIVERY_UNKNOWN`).

### `GET /chatbot-api/requests/pending-deliveries?conversationRef=` (or `?requestId=`)

Scope `feed:read`, class `read`. The deliveries whose last outcome was a deferral (`DEFERRED_WINDOW_CLOSED` or `DEFERRED_HUMAN_SESSION`) and that have no terminal outcome yet (up to 50, ascending cursor), in the same item shape as the feed plus **`deferredReason`**: `{ "items": [ … ] }`.

```json
{
  "items": [
    {
      "cursor": "000000001842",
      "deliveryId": "b1c0…",
      "type": "request.answered",
      "requestId": "9a7e…",
      "conversationRef": "wa:5215512345678",
      "payload": { "kind": "DECISION", "…": "…" },
      "notBefore": null,
      "expiresAt": null,
      "deferredReason": "HUMAN_SESSION"
    }
  ]
}
```

`deferredReason` says which deferral applies, so you know when to ask again:

| `deferredReason` | Replay it when                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `WINDOW_CLOSED`  | The customer writes again (the 24 h window is open). Deliver and ACK with a new `attemptId`.                                              |
| `HUMAN_SESSION`  | The human session ended (`conversation.ended`, unit 11) or the conversation's next bot-mode turn. Deliver and ACK with a new `attemptId`. |

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

| Param          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | Required, exactly `open`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `updatedSince` | Optional, canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Adds the requests **closed at or after** this instant (`RESOLVED` or `CANCELLED`), so you can drop them. The backend reaches **5 s earlier** than the value you send, because `updatedAt` and `closedAt` are stamped by whichever backend replica writes, with its own clock: a request closed by a replica whose clock runs slightly behind is still returned. You may therefore see a closed request you already handled; dedupe by `id`. Open requests are returned **all**, however old, with or without it. Send an instant **earlier** than your last sync (the last instant your pending state was complete), never later. |
| `cursor`       | The `nextPage` of the previous page; omit for the first page. Opaque.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `limit`        | 1..50, default 50.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Anything else (a missing or other `status`, an unknown key, a non-canonical `updatedSince`, `limit` 0 or 51, a malformed `cursor`) is `400 VALIDATION_ERROR`, never clamped or ignored. Pages are ordered by `(updatedAt, id)` ascending and keyset-paginated: a request updated while you walk may be seen once more at the end; none is skipped. Cost per page does not depend on how many requests the branch has closed.

```json
{
  "items": [
    {
      "id": "9a7e…",
      "folio": "S-000123",
      "kind": "DECISION",
      "subtype": "RESTOCK",
      "status": "RESOLVED",
      "conversationRef": "wa:5215512345678",
      "legacyId": "5d0c…",
      "whatsappWindowClosesAt": "2026-11-11T16:20:00.000Z",
      "cancelReason": null,
      "createdAt": "2026-11-10T10:00:00.000Z",
      "updatedAt": "2026-11-10T16:00:00.000Z",
      "closedAt": "2026-11-10T16:00:00.000Z",
      "pendingDeliveries": [
        {
          "cursor": "000000001842",
          "deliveryId": "b1c0…",
          "type": "request.answered",
          "requestId": "9a7e…",
          "conversationRef": "wa:5215512345678",
          "payload": { "kind": "DECISION", "…": "…" },
          "notBefore": null,
          "expiresAt": null,
          "deferredReason": null
        }
      ],
      "undeliveredTruncated": false,
      "undeliveredResumeAfter": null
    }
  ],
  "nextCursor": "000000001900",
  "nextPage": "eyJ1Ijoi…"
}
```

- It is the bot's view: ids, folio, kind, subtype, status, `conversationRef` (the bot's own key, `wa:<wa_id>`: **it contains the customer's phone number**, so keep it out of logs and analytics like any phone), `legacyId` (the id you track from the create answer, for wrapped subtypes), the window, `cancelReason` and times. **No customer name, assignee or staff data, and no free text.**
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

**When.** In the same transaction that marks the request overdue (`overdueAt`), at the first overdue of the request. The clocks count business minutes (they pause outside the opening hours and on closed dates), so the item appears at the real deadline, which for a transfer receipt is the close of the business day. A request that is later released, re-claimed or overdue again on its other clock produces **no second item**. Exactly one `request.overdue_notice` exists per request: a unique index `(tenantId, requestId)` for this type rejects a second one, and the sweep also only emits it while `overdueAt` was empty, which lives on the request (it survives the 30-day feed purge). A request closed before the sweep reaches its deadline never gets one. **Only if it expired less than 24 h ago (owner decision, 2026-11-11).** When the sweep first marks the request overdue and the deadline is **24 hours or more** behind (wall-clock, a late sweep, downtime or the backlog below), the backend does **not** create this item: telling the customer a day later is noise. `overdueAt` is still set and staff are still notified; the request's `SLA_MILESTONE` audit event records `customerNotice: "SKIPPED_STALE"` (`"SENT"` when the item was created). The boundary is exact: 23 h 59 m 59 s sends, 24 h 00 m 00 s skips. So an old open request that is already overdue when this ships produces **no** customer item, only the ones that expire from then on. This is decided once, at the first overdue; it is never re-evaluated later. A backlog (the sweep was down) is caught up at up to 10 batches of 100 rows per phase per 30 s tick, per replica (see the burst note below).

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
- **Burst when it ships.** Open requests that were already past their deadline (RESTOCK/EXPIRATION/ZONE rows wrapped by the backfill, for example) are marked overdue by the first sweeps. Those whose deadline is 24 h or more old get **no** customer item (rule above); only recently expired ones do. Staff do get one notice per request (held to the next opening). The sweep drains up to 10 batches × 100 rows = 1 000 rows per phase per 30 s tick, **per replica** (the `due` phase handles the overdue rows; the `stale` phase has its own budget; replicas add up because their batches are disjoint). That is up to about 2 000 rows a minute per replica, so a backlog of N overdue rows clears in roughly N / 1 000 ticks (N / 2 000 minutes) with one replica, and the bot sees at most as many `request.overdue_notice` items as that: **only** the rows whose deadline is less than 24 h old produce one (rule above), the older ones are marked overdue and notified to staff but never reach the feed. Items are also bounded by one per request. Check `oldestOpenAt` of the backfill dry run first.

### Deploy checklist for 5c

- The credential needs `requests:read` for the recovery route (and keeps `feed:read` / `feed:ack`).
- Migration `20261110060000_chatbot_feed_recovery` (no table or column change: it widens the outcome CHECKs for `DEFERRED_HUMAN_SESSION`, replaces the pending-deliveries partial index and adds two partial indexes on `chatbot_requests`; see `docs/chatbot-requests-model.md`, "Deploy safety"). Deploy the backend before the bot reports `DEFERRED_HUMAN_SESSION`: an older backend answers `400` for the unknown outcome.

## Conversation mirror and media (unit 9)

Contract: proposal §3.6, §3.9, §4.1, §6.1, §6.2, §11.2 and the v1.6 note in §17. The mirror is the 12-month copy of what the customer and the bot said, so staff see the context of a request. **Your outbox's `MESSAGE_MIRROR` rows (and the status rows) call these routes**, in this order of work: upload the file (if any) → mirror the message → report statuses later. The mirror starts with new messages from activation (no backfill, §3.7) and covers **every** message in both directions, bot-mode turns included (§11.2).

Common rules: `Authorization: Bearer svc_…`, scopes `conversation:write` (batch and statuses) and `media:write` (upload), budget class `write` (section "Route budgets"), every answer `Cache-Control: no-store`, errors `{statusCode, code, message}`. The tenant comes from the credential: a tenant, `seq`, author or status in a body is `400`. **`conversationRef` contains the customer's phone (`wa:<wa_id>`): keep it out of logs and analytics.** None of these routes needs `X-Idempotency-Key` (sending one is ignored): idempotency is by `waMessageId` and by `(providerMessageId, status)`, so retrying the very same call is always safe. The only exception is the upload (below).

### `POST /chatbot-api/conversations/:conversationRef/messages:batch`

Scope `conversation:write`. `:conversationRef` is the chat's reference (`wa:5215512345678`, URL-encode the colon if your client does not; 1 to 200 characters of `A-Z a-z 0-9 : _ . @ + -`; anything else `400`). The literal `:batch` is part of the path. Body:

```json
{
  "messages": [
    {
      "waMessageId": "wamid.HBgM…==",
      "direction": "IN",
      "type": "TEXT",
      "text": "Hola, ¿tienen croquetas?",
      "providerTimestamp": "2026-11-12T16:02:11.000Z",
      "observedAt": "2026-11-12T16:02:12.103Z"
    },
    {
      "waMessageId": "wamid.HBgN…==",
      "direction": "OUT",
      "type": "TEXT",
      "text": "Claro que sí, ¿de qué marca?",
      "providerTimestamp": "2026-11-12T16:02:15.000Z",
      "observedAt": "2026-11-12T16:02:15.440Z"
    },
    {
      "waMessageId": "wamid.HBgO…==",
      "direction": "IN",
      "type": "IMAGE",
      "mediaId": "0b3f1c1e-…",
      "text": "mi foto",
      "providerTimestamp": "2026-11-12T16:03:00.000Z",
      "observedAt": "2026-11-12T16:03:01.020Z"
    }
  ]
}
```

Rules (any violation is one `400 VALIDATION_ERROR`, nothing is stored, the input is never echoed):

| Field               | Rule                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`          | 1 to **50** items (`413 BATCH_TOO_LARGE`, `{limit: 50}`, over 50). The array order is the order the backend stores them in (it assigns `seq` in arrival order; **your clocks are only for display**), so send a chat's rows in your outbox `seq` order.                                                                                                  |
| `waMessageId`       | The WhatsApp message id: `A-Z a-z 0-9 . _ = + / : -`, 1 to 255 characters, unique inside the batch. **Inbound:** the wamid Meta sent. **Outbound:** the wamid Meta returned when you sent it (mirror the message once you have it; a message that was never accepted by Meta has no wamid and is not mirrored).                                          |
| `direction`         | `IN` (the customer wrote) or `OUT` (you wrote).                                                                                                                                                                                                                                                                                                          |
| `author`            | Optional. If sent it must match: `IN` → `CUSTOMER`, `OUT` → `BOT`. **`STAFF` and `SYSTEM` are refused (`400`)**: staff messages are written by the backend (unit 11), never relayed by the bot (§4.1). The one way a staff member's words get into the mirror is `staffReplyId` (next row, unit 10): the backend decides the author from its own record. |
| `staffReplyId`      | Optional (unit 10). The `replyId` of the `request.answered` item you just delivered; only on an `OUT` `TEXT` message. See "Clarification replies (unit 10)". Anything else (an `IN` message, a non-text type, a malformed id, `null`, the same id twice in a batch) is `400`                                                                             |
| `type`              | `TEXT`, `IMAGE`, `STICKER`, `DOCUMENT` (a PDF), `AUDIO`, `TEMPLATE` (only `OUT`), `UNSUPPORTED`. `SYSTEM` is refused.                                                                                                                                                                                                                                    |
| `text`              | A string of at most **4 096 characters** (counted as characters, emoji included). Control characters and bidi overrides are removed; markup is kept as text. `TEXT` needs a non-blank text. Media types may carry a caption or none. **`UNSUPPORTED` must NOT carry `text`** (`400` if it does).                                                         |
| `mediaId`           | Required (a uuid from the upload) for `IMAGE`, `STICKER`, `DOCUMENT`, `AUDIO`; forbidden for the rest.                                                                                                                                                                                                                                                   |
| `kind`              | Only for `UNSUPPORTED`: `VIDEO`, `LOCATION` or (default) `OTHER`. The backend stores the fixed text "Video recibido", "Ubicación recibida" or "Mensaje no compatible recibido" and **never the customer's words or any file**. This is the way to mirror a video or a location (v1 stores neither, §3.6).                                                |
| `providerTimestamp` | Meta's timestamp, ISO-8601 with `Z` or an offset, **required**. Not before 2020, at most 5 minutes in the future. For `OUT`, use the time Meta accepted the send.                                                                                                                                                                                        |
| `observedAt`        | Your clock when you saw the message, same format and bounds, **required**.                                                                                                                                                                                                                                                                               |
| anything else       | `400` (`tenantId`, `seq`, `staffUserId`, `deliveryStatus`, `purgeAfter`… are not yours to set).                                                                                                                                                                                                                                                          |

Answer `200`:

```json
{
  "accepted": [{ "waMessageId": "wamid.HBgM…==", "messageId": "…", "seq": 1 }],
  "duplicates": ["wamid.HBgN…=="]
}
```

- `accepted`: stored by this call, with the `seq` the backend gave them (consecutive within the batch). `duplicates`: ids that were **already mirrored** (a retry, or an overlap): ignored, not an error, and the stored message is **never changed** by a replay (messages are immutable). **Both mean "the row is done": ACK the outbox row.** A replay of a whole batch answers `accepted: []`.
- A bot message (`OUT`) is stored as `SENT`; statuses move it forward (below). A customer message has no delivery status.
- All-or-nothing: if the call fails, none of the batch is stored and no `seq` is burned.

| Status / code                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                    | What the outbox does                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `200`                                            | Done (see above).                                                                                                                                                                                                                                                                                                                                                          | ACK the row(s).                                                       |
| `400 VALIDATION_ERROR`                           | The body is wrong. It will not get better by retrying.                                                                                                                                                                                                                                                                                                                     | Park the row as failed and alert; do not retry in a loop.             |
| `401`, `403 INSUFFICIENT_SCOPE`, `403 FORBIDDEN` | Credential, scope (`conversation:write`) or `X-Branch-Id`.                                                                                                                                                                                                                                                                                                                 | Stop and alert; retrying is pointless until the credential is fixed.  |
| `409 MESSAGE_ID_CONFLICT`                        | A `waMessageId` of this batch is already stored in **another** chat (a reused wamid: a bug), including when two chats post the same id at the same moment (never a 500). Nothing was stored.                                                                                                                                                                               | Park and alert.                                                       |
| `413 BATCH_TOO_LARGE`                            | Over 50 messages.                                                                                                                                                                                                                                                                                                                                                          | Split and resend.                                                     |
| `422 REPLY_NOT_FOUND`                            | A `staffReplyId` is not the reply id of a **answered clarification of this branch** whose chat is this one (unknown id, a reply of a request that belongs to ANOTHER chat, another branch's, a request that is still open). A clarification that has **no** `conversationRef` matches the chat you send it to (see "Mirror attribution"). Nothing of the batch was stored. | Park and alert (a bug: the id must come from the item you delivered). |
| `422 MEDIA_NOT_FOUND`                            | A `mediaId` does not exist for this branch, its file was already purged, or it is past its retention time / being purged right now (only possible for a file about 12 months old: a file is kept until the newest message that shows it is due).                                                                                                                           | Upload the file again (new key if the old media is gone) and resend.  |
| `422 MEDIA_TYPE_MISMATCH`                        | The file kind does not match the type (`IMAGE`/`STICKER` need an image, `DOCUMENT` a PDF, `AUDIO` audio).                                                                                                                                                                                                                                                                  | Park and alert (a bug in the mapping).                                |
| `429 RATE_LIMITED`                               | The `write` budget; `Retry-After` in seconds.                                                                                                                                                                                                                                                                                                                              | Wait `Retry-After`, then retry.                                       |
| `5xx`, timeout, network                          | Transient.                                                                                                                                                                                                                                                                                                                                                                 | Retry with backoff, **same body**: it is idempotent.                  |

**Body size.** The route-scoped parser (`installConversationBatchBodyParser`, mounted in `main.ts`) accepts a JSON body of **at most 3 MiB (3 145 728 bytes)** on this route only (every other bot route keeps the framework default of 100 KB). A full batch (50 messages × 4 096 characters) is about 200 KB when non-ASCII is sent as raw UTF-8, but a JSON encoder that escapes it as `\uXXXX` writes 6 bytes per character and 12 per emoji (a surrogate pair): the worst case, 50 × 4 096 emoji, is **about 2.5 MB**, which fits. So **a full batch never needs splitting by size**: split by count (50) only. If a body is still over the bound the answer is `413 {statusCode, code: "BODY_TOO_LARGE", message}`; a body that is not valid JSON is `400 {statusCode, code: "VALIDATION_ERROR", message}`. Both use the envelope above, carry fixed texts and never echo any part of your body.

### `POST /chatbot-api/messages/statuses:batch`

Scope `conversation:write`. Meta's delivery statuses for messages **you sent and mirrored**. Body:

```json
{
  "statuses": [
    {
      "providerMessageId": "wamid.HBgN…==",
      "status": "DELIVERED",
      "occurredAt": "2026-11-12T16:02:19.000Z",
      "errorCode": "131047"
    }
  ]
}
```

- 1 to **100** items (`413 BATCH_TOO_LARGE` over 100). `providerMessageId` is the `waMessageId` you mirrored. `status`: `SENT`, `DELIVERED`, `READ` or `FAILED` (Meta's `sent`/`delivered`/`read`/`failed`). `QUEUED`, `DEFERRED` and `UNKNOWN` belong to the backend (`400`). `occurredAt` required (same bounds as `providerTimestamp`). `errorCode` optional, at most 64 characters; it is accepted and **not stored**.
- A status only moves a message **forward**: `SENT → DELIVERED → READ`, and `FAILED` only before delivery. Out of order or repeated statuses are fine (a late `DELIVERED` after `READ` is ignored); several statuses for one message in one call are applied in the order you send them. A customer's message never gets a status.

Answer `200`: `{ "applied": 1, "ignored": 1, "unknown": ["wamid…"] }`. `applied`: statuses that moved a message. `ignored`: known messages whose status was already equal or ahead (or not yours to move). **`unknown`**: ids that match no mirrored message **yet** (the status raced ahead of the mirror row). ACK the status row; if you want them to land, retry the unknown ones after the message's mirror row is acknowledged, and **give up after 24 hours** (do not retry forever). Errors as for `messages:batch` (`400`, `401/403`, `413`, `429`, `5xx`).

### `POST /chatbot-api/media`: upload BEFORE mirroring the message

Scope `media:write`, budget class `write`. `multipart/form-data` with:

| Part                       | Rule                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `file`                     | **Required**, one part, 1 byte to **10 MiB** (10 485 760 bytes).                                                                    |
| `sha256`                   | Optional lowercase hex of the file's bytes; if sent it must match (`400` otherwise).                                                |
| Header `X-Idempotency-Key` | **Required**: a lowercase UUID. Derive it from the WhatsApp media id (for example UUIDv5 of it) so a retry after a crash reuses it. |

The type is decided **by the file's bytes**, not by what you declare. Accepted: `image/jpeg`, `image/png`, `image/webp` (stickers are webp), `application/pdf`, and audio `audio/ogg` (voice notes), `audio/mpeg`, `audio/mp4` (`.m4a` only), `audio/aac`, `audio/amr`. **Not accepted (`415 MEDIA_TYPE_NOT_ALLOWED`):** video (including `.mp4` video), location, GIF, SVG, HTML, archives, executables. For a video or a location do **not** upload: mirror an `UNSUPPORTED` message instead.

Answer `201` (stored) or `200` (the same key and the same bytes again):

```json
{
  "mediaId": "0b3f1c1e-…",
  "mimeType": "image/jpeg",
  "sizeBytes": 182344,
  "sha256": "…"
}
```

The file is stored privately (never public, never a URL back to you); staff read it through the authenticated proxy. Use `mediaId` in the message you mirror next. A media nobody mirrors is deleted with everything else 12 months after the upload.

| Status / code                | Meaning                                                                                                      | What the outbox does                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `201` / `200`                | Stored / replay.                                                                                             | Continue to the message.                                                                           |
| `400 VALIDATION_ERROR`       | No key, key not a lowercase UUID, empty or missing `file`, `sha256` mismatch or malformed, an unknown field. | Park and alert (a bug) except a `sha256` mismatch, which means the bytes changed: re-download.     |
| `409 IDEMPOTENCY_CONFLICT`   | The key was already used with other bytes.                                                                   | Use a new key only if the bytes really are different.                                              |
| `413 MEDIA_TOO_LARGE`        | Over 10 MiB.                                                                                                 | Do not retry. Mirror an `UNSUPPORTED` message (`OTHER`) and, for audio, ask the customer to write. |
| `415 MEDIA_TYPE_NOT_ALLOWED` | See above.                                                                                                   | Do not retry; mirror `UNSUPPORTED`.                                                                |
| `401`, `403`, `429`          | As above (`media:write`; `Retry-After`).                                                                     | As above.                                                                                          |
| `503 MEDIA_STORAGE_FAILED`   | The storage was down; nothing was recorded. `Retry-After: 5`.                                                | Retry with the **same key**.                                                                       |

**Audio** (decision D13): upload and mirror every voice note (with or without a person attending); when nobody attends, you also ask the customer to write it. Staff play it from the inbox.

### What the outbox must do (summary)

For each inbound or outbound WhatsApp message of a chat, in the chat's outbox order:

1. If it has a file you can store (image, sticker, PDF, audio ≤ 10 MiB): download it from Meta, `POST /chatbot-api/media` with a stable `X-Idempotency-Key`, keep `mediaId`. Video / location / other: no upload, `type: UNSUPPORTED` with `kind`.
2. Build the message (table above) and `POST …/messages:batch` (up to 50 rows of one chat; the whole body at most 3 MiB, which a full batch always fits). ACK the rows on `200`.
3. When Meta reports a status for a message you sent, `POST …/statuses:batch` (up to 100). ACK on `200`; retry `unknown` ids for at most 24 h.
4. Never mirror staff messages (the backend owns them), never send tenant, `seq`, author `STAFF`/`SYSTEM` or a status the backend owns.

### Not covered by unit 9

- `GET /chatbot-api/conversations/:ref/state` and `POST …/session-ack` are unit 11 (section "Live conversation (unit 11)"). `messages:batch` takes **no `epoch`** (§11.2).
- A customer message does not yet update the 24 h window of an open request: the request keeps the `lastCustomerMessageAt` you sent when you created it (or merged into it). Updating the window from the mirror needs the request's version and audit semantics and arrives with unit 11.
- Echoing a **live** staff message (unit 11) back to the mirror: unit 11 stores the wamid from the delivery outcome you already report. The **clarification reply** of unit 10 is different: you mirror it yourself with `staffReplyId` (below).

### Deploy checklist for unit 9

1. Migration `20261112020000_conversation_mirror` (three new tables, triggers, one partial index on `chatbot_requests`; brief locks, deploy at low traffic; recovery note in the file).
2. The credential has `conversation:write` and `media:write`; the `write` budget (`rateLimits.write`, default 300 a minute) covers messages, statuses and uploads together.
3. Spaces: the same `SPACES_*` configuration as receipts (`RECEIPTS_SPACES_BUCKET` or `SPACES_BUCKET`); objects live under `conversation-media/<tenantId>/`.
4. `main.ts` mounts `installConversationBatchBodyParser(app)` (from `src/conversations/presentation/conversation-body-parser.ts`) next to the other `install*BodyParser` calls, before `app.listen` (done: it is mounted, with a 3 MiB limit for that route only).
5. The retention purge runs hourly on every replica (no setup).

## Clarification replies (unit 10)

Contract: proposal §2.2, §3.3, §3.8, §4.5, §6.2, §12.14 and the v1.8 note (§19). A staff member answers a customer's question (a `CLARIFICATION` request, subtype `UNKNOWN_QUESTION`) from the inbox with `POST /chatbot-requests/:id/reply {expectedVersion, text}` (FE handoff `19-clarification-replies.md`). That **closes the request** (`RESOLVED`) and, in the same transaction, adds one `request.answered` item to your feed. Nothing else changes for you: same cursor, same `deliveryId`, same ACK route.

### The feed item

```json
{
  "cursor": "000000001900",
  "deliveryId": "c3a1…",
  "type": "request.answered",
  "requestId": "2b7c…",
  "conversationRef": "wa:5215512345678",
  "payload": {
    "kind": "CLARIFICATION",
    "subtype": "UNKNOWN_QUESTION",
    "action": "REPLY",
    "replyId": "7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09",
    "text": "Sí, es apto desde las 8 semanas.",
    "prefix": "Le comparto la respuesta del equipo:",
    "staffText": "Sí, es apto desde las 8 semanas."
  },
  "notBefore": null,
  "expiresAt": null
}
```

- **You compose the wording** with the customer's tú/usted (owner decision, L38): relay **`staffText` as written** after your own team prefix. `text` (= `staffText`) and `prefix` (`"Le comparto la respuesta del equipo:"`, usted) are only the fallback if you cannot compose. Do not rewrite or summarise `staffText` and do not pass it through the model (§4.4: staff text goes out as is). It is plain text of up to 1500 characters, line breaks included.
- There is **no `legacyId`**: a clarification has no wrapped row. Track it by the item's `requestId` (the `id` your create call returned). Forget the pending question when this item arrives.
- `replyId` is the id of the message you are about to send. Keep it: you send it back as `staffReplyId` when you mirror the message (below).
- **At most one per request, ever** (a unique index backs it). The request is already `RESOLVED` when you see it, so a customer's `POST /requests/:id/cancel` answers `409 ALREADY_RESOLVED` with `resolution {action: "REPLY", replyId, text}`: deliver that text if you have not (same `deliveryId` rules: do not send twice).
- `conversationRef` is the request's (`null` if the question was created without one: use `pending-deliveries?requestId=`).

### ACK

Same route and body as every `request.answered` (`POST /chatbot-api/deliveries/:deliveryId/outcome`); **all five outcomes are allowed**:

| You did                                                                      | Report                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Sent it, Meta accepted                                                       | `PROVIDER_ACCEPTED` + `providerMessageId`                          |
| Cannot tell whether it went out                                              | `DELIVERY_UNKNOWN` (do not retry)                                  |
| **The 24 h window is closed** (Meta rejects, or you know)                    | `DEFERRED_WINDOW_CLOSED`: non-terminal, the delivery stays pending |
| The conversation is in a human session                                       | `DEFERRED_HUMAN_SESSION`: non-terminal                             |
| The customer already got this answer another way, or you decided not to send | `STALE`                                                            |

Unlike `request.cancelled` and `request.overdue_notice`, a reply **may be deferred**: the answer is worth sending days later, because the customer asked for it. A deferral is audited (`DELIVERY_OUTCOME`) and shown to staff as "pending: it will be sent when the customer writes again".

### Deferred: what happens next

1. `DEFERRED_WINDOW_CLOSED` leaves the item pending (`ackedAt` empty). It is served by `GET /chatbot-api/requests/pending-deliveries?conversationRef=…` (or `?requestId=…`) with `deferredReason: "WINDOW_CLOSED"`, and by the recovery route (`pendingDeliveries` of the **closed** request, `status=open&updatedSince=`).
2. **The backend does nothing on its own when the customer writes again.** You do: when the customer's message opens the window, call `pending-deliveries` for that conversation and send what is there (this is the §4.5 flow, no feed walk).
3. Send it and ACK with a **new `attemptId`**: `PROVIDER_ACCEPTED` ends it (`ackedAt` set, no longer served anywhere). A later attempt after a terminal outcome is `409 OUTCOME_ALREADY_RECORDED`. A deferral can repeat (a new `attemptId` each time) for either reason.
4. `DEFERRED_HUMAN_SESSION` is replayed the same way when the session ends (`conversation.ended`, unit 11) or on the next bot-mode turn.
5. The backend does **not** correct the request's 24 h window from your `DEFERRED_WINDOW_CLOSED` (§4.5 last bullet): the request is already closed, so the estimate no longer drives anything. Meta stays the source of truth; you decide when the window is open.

There is no expiry for a pending reply other than the 30-day retention of the feed (`410 CURSOR_EXPIRED` / recovery as usual). The text is also kept on the request (`resolution`), so it can always be recovered from `ALREADY_RESOLVED`.

### Mirror attribution: `staffReplyId`

The conversation mirror shows a message as the staff member's (`author: STAFF`, with their name) only when **you mirror the message you sent for this reply** and say which reply it was:

```json
{
  "waMessageId": "wamid.HBgN…",
  "direction": "OUT",
  "type": "TEXT",
  "text": "Le comparto la respuesta del equipo: Sí, es apto desde las 8 semanas.",
  "staffReplyId": "7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09",
  "providerTimestamp": "…",
  "observedAt": "…"
}
```

- Send it in the normal `messages:batch` of that chat, in outbox order, **after** Meta accepted it (you need the wamid). `text` is what you actually sent (your composed prefix plus `staffText`), but **it is not stored**: for a message sent with `staffReplyId` the backend takes the text from its own record (`resolution.text`, exactly what the staff member submitted, without your prefix or any other framing). You may still send your text (it is not validated against the record and a different text is not an error); the conversation shows the staff member's words only. Every other mirrored message (no `staffReplyId`) keeps your text as is.
- The backend looks `staffReplyId` up in its own record: the request must be an answered clarification **of this branch**, and if it has a `conversationRef` that must be **this chat**. A clarification created **without** a `conversationRef` (you never told us its chat) is accepted in the chat you mirror the message to: the reply id is unique, so it can be mirrored **once**; mirroring the same `staffReplyId` again in another chat is `409 MESSAGE_ID_CONFLICT` (nothing stored), never a second message. The staff user, the author `STAFF`, the text and the id come from that record, never from your body (`author: "STAFF"` and `staffUserId` stay `400`). Unknown, foreign or other-chat id (a request that names a different chat): `422 REPLY_NOT_FOUND`, nothing stored for the whole batch. The staff UI shows a message of a request with no `conversationRef` only in the chat's other requests (that request itself has no conversation to read).
- The stored message has `id = clientMessageId = replyId` and starts as `SENT` (statuses move it forward as for every `OUT` message). `accepted[].messageId` in the answer is the `replyId`.
- A replay is a `duplicate` (same `waMessageId`). The same reply under **another** wamid is `409 MESSAGE_ID_CONFLICT` (one message per reply).
- A message **without** `staffReplyId` is stored as yours (`BOT`), even if it carries the staff's words. Do not mirror a deferred reply until it was really sent: until then it is not in the conversation.
- The reply's own request is already closed, so the live `conversation.message` event is also sent for it (staff keep seeing their message arrive).

### Deploy checklist for unit 10

- Migration `20261112050000_clarification_replies`: one function body (realtime trigger announces `REPLIED` as `request.resolved`) and two partial UNIQUE indexes (`chatbot_requests_reply_id_uq`, `chatbot_feed_items_clarification_answer_uq`); no table or column changes, builds over zero matching rows. Apply the migration before the new code (the code needs the unique indexes only as a guard; the new realtime mapping needs the new function).
- Deploy the backend before the bot starts handling `kind: "CLARIFICATION"` items. Until your handler lands you can ACK unknown payload kinds `STALE` (as for unknown types): the staff UI then shows the delivery as `STALE`, and the customer is **not** answered, so ship the handler before staff start replying on dev.
- `staffReplyId` needs no scope beyond `conversation:write`.

## Live conversation (unit 11)

Contract: proposal §4 (4.1 to 4.8), §3.3, §3.9, §10.1 R2/R7, §11.1, §12.15 and the v1.9 note (§20). A staff member takes a `TALK_TO_HUMAN` or `COMPLAINT` request (the **claim** command, the same "Atender" button as today) and from then on talks to the customer **through you**: the backend decides who attends, whether you are silent and in what order messages go out; you relay. **This section is the design contract for the bot side.** It is final: the product questions Q1 to Q6 were all answered by the owner (table "Product questions" at the end). The status table at the end says which parts the backend has already shipped.

Everything here is **at-least-once and idempotent in both directions** and **nothing sent is edited or deleted** (a correction is a new message). The backend wins every disagreement.

### The model in one picture

```text
claim (staff)      you read conversation.started{epoch N}     you ACK + session-ack STARTED        staff writes
 WAITING ───────►  STARTING  ─────────────────────────────►  ACTIVE  ──────────────────────────►  conversation.staff_message items
    ▲                │ no session-ack STARTED in 120 s (setting) │ finish / 2 h idle / forced finish
    │                ▼                                           ▼
    └── conversation.ended{N, START_TIMEOUT}              ENDING ── you ACK + session-ack ENDED ──► ENDED (you are back in BOT mode)
                                                             └── no session-ack ENDED in 10 min: the backend marks it ENDED itself
```

\* The start timeout is a per-tenant setting (`startTimeoutSeconds`, default **120 s**, 30 to 600) that the backend snapshots on the session at the claim: a settings change never moves the deadline of a session that already started. Everywhere this section says "60 s" read "the start timeout (default 120 s)".

- **`handoffEpoch`** is an integer per conversation. **Every claim raises it** (N → N+1), also a new attempt after a revert, a release or an end; an epoch is never reused. Ending and reverting keep the epoch of the session they end. You reject orders of an old epoch.
- **`mode`**: `BOT` or `HUMAN`. The backend sets `HUMAN` the moment the claim commits (session `STARTING`) and `BOT` when the session reaches `ENDED`. **You are silent from the moment you read `conversation.started`**, not from the moment you send `session-ack`.
- **`seq`**: the per-conversation message counter the backend assigns (`UPDATE … nextSeq + 1 … RETURNING` in the message's own transaction): strictly increasing, shared by every message of the chat in both directions. Staff messages are delivered to you **in `seq` order** (see below).
- Keep, per conversation, in your own durable state: `handoff = {mode, epoch, requestId}` written with a compare-and-set, and check it in the dispatcher **before** the LLM (as you agreed in §11).

### Silence protocol (the rules, in order of importance)

1. **`conversation.started` for epoch N.** If `N` is greater than your stored epoch: in ONE durable write set `handoff = {mode: HUMAN, epoch: N, requestId}`; **then** call `session-ack STARTED` (do not wait for Meta: §11.1); **only after the ack answered `200`** send the greeting (see the item below) and report the **delivery outcome** of the item (S16 1b: the order is durable `HUMAN`, then the ack, then the greeting; a `409` ack means no greeting, see the ack answers). A later `resumeNotice` (rule 7) is only sent for a greeting that actually went out. If `N` is not greater than your epoch, the item is stale: do nothing local, report outcome `STALE`, do **not** send `session-ack`.
2. **While `mode = HUMAN` you say nothing on your own.** No LLM call, no menu, no "I did not understand", no audio-transcription prompt (staff hear the audio), no `request.overdue_notice`, no `request.answered`/`request.cancelled` of other requests of this chat (report `DEFERRED_HUMAN_SESSION` for the ones that may wait, `STALE` for the ones that may not, as the feed section says). Your **only** outbound messages are the ones in `conversation.*` and `template.requested` items, and the single safety notice of rule 8.
3. **Customer → staff.** Every message the customer writes in `HUMAN` mode is mirrored as always (`POST …/messages:batch`, direction `IN`, **no `epoch` in the batch**, §11.2). The backend moves the 24 h window, shows it to the attendee, notifies them and starts the "unanswered" clock. You do nothing else with it. Media: upload first, mirror after (unit 9).
4. **Staff → customer.** Each `conversation.staff_message` item is one message: send **the text as written**, no prefix, no rewriting, no LLM (§4.4 point 5), then report the outcome. **Reject an item whose `handoffEpoch` is not your current `HUMAN` epoch** (outcome `STALE`). De-duplicate by `deliveryId` **and** `messageId` (store both before calling Meta).
5. **Order.** Send the staff messages of a conversation in **`seq` order**. The feed already hands them to you in that order (a message takes the conversation lock until it commits, so cursor order equals `seq` order within a conversation), so a gap only appears after a retry or a crash. If you hold item `seq = 18` and `17` has not arrived, keep `18` until `17` is handled, **at most 30 s**; after that, send what you hold in `seq` order and continue (the backend never invents a gap: a missing number is a delivery you have not read yet, and you will still send it when it arrives). This ordering rule is **advisory** (S16 12): the backend does not check it, and a message that arrives late is still sent.
6. **`conversation.ended` for epoch N.** If your `HUMAN` epoch is N (or lower: a missed `started`): in ONE durable write set `handoff.mode = BOT` (keep the epoch); **then** send the farewell if `payload.farewell` is true **and** the window is open; report the outcome; **then** call `session-ack ENDED`; then replay what you deferred (`GET …/requests/pending-deliveries?conversationRef=`, `deferredReason: HUMAN_SESSION`) and resume bot mode. If your `HUMAN` epoch is higher than N (a newer claim already started), the item is stale: outcome `STALE`, do not change anything and do not send `session-ack`.
7. **`reason: START_TIMEOUT` is a revert, not an end.** The backend did not see `session-ack STARTED` within the start timeout (default 120 s, per-tenant setting) and gave the conversation back to you (§12.15). Apply rule 6 with `farewell: false`: set `mode = BOT` in epoch N, send nothing, outcome `STALE`, **no** `session-ack`. This makes a bot that has not shipped its handler yet **safe**: a claim reverts after the start timeout and the customer keeps talking to the bot. `resumeNotice: true` is the S15 Q1 answer: if you already told the customer you were handing over, send a short "seguimos por aquí" in their register; otherwise nothing.
8. **Safety notice (§4.7).** If the feed has failed for more than **10 minutes** while you are in `HUMAN` mode, send the customer **once**, **only if the 24 h window is open** (a closed window means no free-form message at all, S16 12), "Tenemos una falla técnica, en cuanto se resuelva le respondemos" (your wording, the customer's tú/usted) and stay silent. Never speak on your own again while the epoch is `HUMAN`. One notice per epoch; restarting does not repeat it.
9. **Reconcile.** At start-up and **every 5 minutes while you are silent**, call `GET /chatbot-api/conversations/:ref/state` and apply the answer: **the backend always wins**. `mode: BOT` while you think `HUMAN` means you missed a `conversation.ended`; do rule 6 without a farewell (`farewell: false`, you cannot know whether it was sent). `handoffEpoch` higher than yours with `mode: HUMAN` means you missed a `conversation.started`: mute at once (rule 1, no greeting) and `session-ack STARTED`.
10. **Unknown item types.** A bot without this handler that reads `conversation.started` and ACKs it `STALE` is safe (the claim reverts after the start timeout). Do **not** ACK `conversation.staff_message` or `template.requested` `STALE` for a conversation you actually muted: staff would see "No enviado" for text they believed delivered.

### Feed items

All five use the common envelope (`cursor`, `deliveryId`, `type`, `requestId`, `conversationRef`, `payload`, `notBefore: null`, `expiresAt: null`), the same cursor, the same long-poll and the same `POST /chatbot-api/deliveries/:deliveryId/outcome`. They are enqueued in the **same transaction** as the state change, so an item exists if and only if the change committed.

| `type`                       | When                                                                                        | `payload`                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation.started`       | The claim of a live request committed (session `STARTING`, epoch N)                         | `{requestId, handoffEpoch, staffFirstName, whatsappWindowClosesAt}`                                                                                                                                                                                                |
| `conversation.staff_message` | The attendee sent a message (`POST /chatbot-requests/:id/messages`)                         | `{requestId, handoffEpoch, seq, messageId, type: "TEXT", text}` or, for a staff photo or PDF (S15 Q5), `{requestId, handoffEpoch, seq, messageId, type: "IMAGE" \| "DOCUMENT", mediaId, mimeType, filename, caption}` (`caption` may be `null`; see "Staff media") |
| `template.requested`         | The attendee pressed "Enviar plantilla" (never automatic, §4.5)                             | `{requestId, handoffEpoch, seq, messageId, templateName, languageCode}`                                                                                                                                                                                            |
| `conversation.reassigned`    | An attendee **reassigned** a STARTING/ACTIVE session to another person (same epoch, S15 Q2) | `{requestId, handoffEpoch, staffFirstName}`                                                                                                                                                                                                                        |
| `conversation.ended`         | Finish by the attendee or a reassigner, 2 h idle, or the start-timeout revert               | `{requestId, handoffEpoch, reason, farewell, resumeNotice}`                                                                                                                                                                                                        |

- `conversation.reassigned` (S15 Q2): tell the customer "Ahora te atiende <nombre>" (their register; `staffFirstName: null` → "una persona del equipo"). Same rules as the others: ignore it if `handoffEpoch` is not your current `HUMAN` epoch (outcome `STALE`), do **not** send `session-ack`, and the epoch is **unchanged**. Outcomes: `PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN`, `STALE` only (a message sent days later only annoys: `DEFERRED_*` is `422 OUTCOME_NOT_ALLOWED`). A reassignment of a session that is not STARTING/ACTIVE sends nothing. Staff get the usual `request.reassigned` realtime event; the session state does not change, so there is no `session.*` event.
- `staffFirstName` is the first word of the attendee's name; **`null` when the account has no name** (do not invent one: say "una persona del equipo"). It is the only staff datum you ever get; you compose the greeting ("Le atiende Ana…") with the customer's register.
- `whatsappWindowClosesAt` is informational (the backend's estimate, ISO UTC, or `null`); **Meta is the source of truth** and you apply the real rule when you send. A closed window does **not** stop you from muting and ACKing the session: it only means there is no greeting to send (outcome `STALE`).
- `messageId` is the id of the message row the backend stored (`QUEUED`). `text` is plain text, 1 to 4096 characters, line breaks included. **Staff messages carry no prefix and the model never touches them.** `seq` is the message's conversation `seq`.
- `templateName` is the approved template of the tenant's settings (the attendee does not choose it). **S15 Q4 / S16 8:** `template.requested` will also carry `languageCode` from the tenant setting `templateLanguageCode` (default `es_MX`, shape `xx` or `xx_YY`) and **no variables** in v1. The item is **IMPLEMENTED** (T11d): the payload above carries `languageCode` (the tenant's `templateLanguageCode`, default `es_MX`) and no variables. `seq` and `messageId` identify the `TEMPLATE` message the backend stored (`QUEUED`, author `STAFF`); report the wamid only in the outcome and **do not mirror it**. A template Meta refused or later failed may be requested again by the attendee: you then receive a **new** `template.requested` with a new `messageId`/`deliveryId` for the same window (treat it as a new item; de-duplicate by `deliveryId` and `messageId`).
- `reason` of `conversation.ended`: `FINISHED` (the attendee finished), `FORCED` (a reassigner finished it), `IDLE_TIMEOUT` (the customer was silent for 2 h, §4.6), `START_TIMEOUT` (the revert of rule 7). `farewell` is `true` for the first three and `false` for `START_TIMEOUT`. `resumeNotice` is `true` only for `START_TIMEOUT`: if you already told the customer you were handing over (you sent the greeting), send a short "seguimos por aquí" in their register (open question Q1); otherwise send nothing. The farewell wording is yours ("vuelve a hablar con el bot", in the customer's register).
- The `request.answered` items of a clarification **are not** a live message: they keep their own rules and are `DEFERRED_HUMAN_SESSION` while `HUMAN`.

### ACK outcomes per type

`POST /chatbot-api/deliveries/:deliveryId/outcome` as in the feed section (same body, same `attemptId` rules, one terminal outcome per delivery, `409` for a second different one). **Which outcomes each type accepts** (anything else is `422 OUTCOME_NOT_ALLOWED`, the item stays pending):

| Type                              | `PROVIDER_ACCEPTED` | `DELIVERY_UNKNOWN` | `DEFERRED_WINDOW_CLOSED`                   | `DEFERRED_HUMAN_SESSION` | `STALE`                                                   |
| --------------------------------- | ------------------- | ------------------ | ------------------------------------------ | ------------------------ | --------------------------------------------------------- |
| `conversation.started` (greeting) | greeting sent       | cannot tell        | **no**                                     | **no**                   | no greeting (window closed, old epoch, you chose not to)  |
| `conversation.reassigned`         | notice sent         | cannot tell        | **no**                                     | **no**                   | no notice (window closed, old epoch)                      |
| `conversation.staff_message`      | sent                | cannot tell        | **yes** (non terminal)                     | **no**                   | old epoch, session over, not sent                         |
| `template.requested`              | template sent       | cannot tell        | **no**                                     | **no**                   | Meta refused it synchronously (nothing sent), old epoch   |
| `conversation.ended` (farewell)   | farewell sent       | cannot tell        | **no** (a farewell days later only annoys) | **no**                   | no farewell (`farewell: false`, window closed, old epoch) |

What the backend does with the outcome of a staff message or template (the attendee sees it live, `message.status`):

| You report                                | Message `deliveryStatus` | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_ACCEPTED` + `providerMessageId` | `SENT`                   | **The backend stores the wamid as the message's `waMessageId`**, so the `statuses:batch` you send later (delivered, read, failed) finds it. **Do not mirror this message yourself** (rule below).                                                                                                                                                                                                                                                        |
| `DELIVERY_UNKNOWN`                        | `UNKNOWN`                | "Entrega dudosa"; no automatic retry (the attendee decides and a resend is a **new** message).                                                                                                                                                                                                                                                                                                                                                           |
| `DEFERRED_WINDOW_CLOSED`                  | `DEFERRED`               | Non terminal **while that epoch's session is `ACTIVE`** (S16 3; see "Deferred staff messages" below): `pending-deliveries` serves it with `deferredReason: WINDOW_CLOSED`; resend it, **in `seq` order**, when the customer writes again and ACK with a **new `attemptId`**. Also **corrects the backend's window**: the 24 h window of this conversation is treated as closed from `attemptedAt` until the customer's next message (§4.5, last bullet). |
| `STALE`                                   | `FAILED`                 | Not sent and not coming.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A status later than the outcome only moves forward (`SENT → DELIVERED → READ`); `FAILED` and `UNKNOWN` are final. The two exceptions are both the window rule below: `SENT → DEFERRED` (a `131047` status) and a resend replacing the dead wamid.

### Staff media (S15 Q5, S16 9): `GET /chatbot-api/media/:id`

A `conversation.staff_message` with `type: "IMAGE"` or `"DOCUMENT"` carries no bytes: download the file, then send it to the customer as a WhatsApp image or document (`caption` as the caption, `filename` as the document name; send nothing when `caption` is `null`). Everything else about the item is as for text: same outcomes, same `handoffEpoch` and de-duplication rules, same deferral while the window is closed.

- Scope **`media:read`**, budget class `read`. `Authorization: Bearer svc_…`; the tenant comes from the credential.
- `200` streams the original bytes. `Content-Type` is the real type (`image/jpeg`, `image/png`, `image/webp` or `application/pdf`, equal to `mimeType` of the item), `Content-Disposition: attachment; filename="<filename>"` (the sanitized name of the item: ASCII, no quotes or separators), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- `404 MEDIA_NOT_FOUND` for an unknown id, another tenant's id, a file purged by retention, and **any file that no staff message carries** (a customer's file, or one staff uploaded and never sent). The bot cannot read customer files back through this route. `403 INSUFFICIENT_SCOPE` without `media:read`; `429` with `Retry-After` as everywhere.
- **Validity:** the file is downloadable from the moment the item exists until the 12-month retention purge deletes it (`purgeAfter`). Retry freely; the same id always answers the same bytes. A purged file answers `404`: report the outcome `STALE` for that item.
- Limits are those of unit 9 uploads: at most 10 MB, images (JPEG, PNG, WebP) and PDF only. Staff cannot send audio.
- Scope deploy step: add `media:read` to the credential (same as `media:write` was added in unit 9).

### Deferred staff messages (S16 3 and S16 4) and recovery (S16 6)

- **`pending-deliveries` and the recovery route include the `conversation.*` items** (S16 6) with the same payload as the feed (`handoffEpoch`, `seq`, `messageId`, ...). The feed's cursor order is commit order, and within a conversation it is also `seq` order.

- **While the epoch is `ACTIVE`** a deferred `conversation.staff_message` is served by `GET …/requests/pending-deliveries` with `deferredReason: WINDOW_CLOSED`; resend it (in `seq` order, new `attemptId`) when the customer writes again. The resend's wamid **replaces** the old one on the message, so later `statuses:batch` find it.
- **When the session ends** (finish, forced finish, idle end) or the epoch changes, every still-deferred staff message of that epoch becomes **terminal `FAILED`** ("No enviado" for the attendee) and the item **leaves `pending-deliveries`**. A resend of it after that is `409 OUTCOME_ALREADY_RECORDED`: treat it as "not coming". A `DEFERRED_WINDOW_CLOSED` you report **after** the session left `ACTIVE` is accepted (`200`) and settled the same way at once. A deferral that you reported while staff were finishing and that committed just after the finish is settled the same way when the session reaches `ENDED` (your `session-ack ENDED` or the backend's timeout) or by the backend's sweep, so a message is never left deferred after its session. `pending-deliveries` never serves a deferred staff message of a session that is not `ACTIVE`.
- **Replaying that ACK (idempotent).** If your `DEFERRED_WINDOW_CLOSED` was accepted after the session left `ACTIVE`, the item was settled in the same transaction (internally `STALE`, message `FAILED`), but the answer you got is the deferral you reported: `200 {outcome: "DEFERRED_WINDOW_CLOSED", ackReceivedAt: null}`. The **same `attemptId` with the same evidence** replays exactly that body (`200`, same `outcome` and `ackReceivedAt`), however many times, and changes nothing. A **new** `attemptId` is `409 OUTCOME_ALREADY_RECORDED` (the item is terminal: not coming); the same `attemptId` with other evidence is `409 IDEMPOTENCY_CONFLICT`. In every case do not resend the message: the backend will not send it, and the attendee sees "No enviado".
- **`statuses:batch` `FAILED` with `errorCode: "131047"`** (Meta: re-engagement, the 24 h window is closed) **on a staff message** means the window closed _after_ you sent it: it is handled exactly like `DEFERRED_WINDOW_CLOSED`. The message goes `SENT → DEFERRED`, the item is pending again (`deferredReason: WINDOW_CLOSED`) while its epoch is `ACTIVE`, the chat's window is treated as closed from that status's `occurredAt`, and the attendee is told. If the epoch is no longer `ACTIVE` the message becomes `FAILED` instead. Any other `FAILED` (another code, or none), and `131047` on a bot message, is a plain `FAILED`. A replayed `131047` is ignored (`ignored`, not an error).

### Mirror attribution of staff messages

- **Never mirror a staff message or a template** (do not put it in your `MESSAGE_MIRROR` outbox): the backend owns them (§4.1) and already stored them as `author: STAFF` with the attendee's name when the attendee sent them. If you mirrored one anyway with its wamid it would be a `duplicate` once the backend stored the wamid from your outcome, and a second bot-authored copy if it arrives first. Report the wamid **only** in the outcome.
- The greeting and the farewell **are yours** (author `BOT`): mirror them like any other bot message. The backend adds the timeline marks ("Ana tomó la conversación", "Conversación finalizada") itself.
- `staffReplyId` (unit 10) stays only for clarification replies. It is **not** used for live messages.

### `POST /chatbot-api/conversations/:conversationRef/session-ack`

Scope `conversation:write`, class `control` (its own rate bucket, default 120/min, so a `write` 429 cannot trip the start-timeout revert). No `X-Idempotency-Key` needed: the natural key is `(epoch, state)`. `:conversationRef` as in `messages:batch`.

```json
{ "epoch": 3, "state": "STARTED", "providerMessageId": "wamid.HBg…" }
```

| Field               | Rule                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `epoch`             | integer ≥ 1; the epoch of the item you are acknowledging                                                                                                |
| `state`             | `STARTED` (you are muted for that epoch) or `ENDED` (you are back in bot mode for that epoch)                                                           |
| `providerMessageId` | optional, 1..512 characters: the wamid of the greeting/farewell **if you already have it** (audit only; you normally report it in the delivery outcome) |

Exactly those keys, else `400 VALIDATION_ERROR`. Answers:

| Status / code                                              | When                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200 {epoch, state, sessionState}`                         | `STARTED` on a `STARTING` session of that epoch (it becomes `ACTIVE`, the attendee's composer opens, `session.active` goes out), or the **same** call again (idempotent), or `ENDED` on an `ENDING` session of that epoch (it becomes `ENDED`), or the same call again. `sessionState` is the session's state after the call |
| `200` (idempotent)                                         | `ENDED` for a session that is already `ENDED` for that epoch **for any reason** (a 10-minute timeout, a start revert, a forced end): you may always send it                                                                                                                                                                  |
| `409 STALE_EPOCH` `{currentEpoch, mode, sessionState}`     | `STARTED` for an epoch that is no longer the current one **or** whose session is no longer `STARTING`/`ACTIVE` (a **late ack after the start-timeout revert**, §12.15: you already got `conversation.ended` for it and stay `BOT`), or any ack for an epoch higher than the backend's                                        |
| `409 SESSION_NOT_ENDING`                                   | `ENDED` for the current epoch while its session is `STARTING` or `ACTIVE`: **you cannot end a session on your own** (§4.1); the backend ends it                                                                                                                                                                              |
| `404 NOT_FOUND`                                            | the conversation is unknown to the backend                                                                                                                                                                                                                                                                                   |
| `403 INSUFFICIENT_SCOPE`, `401`, `429 RATE_LIMITED`, `400` | credential, scope, budget, malformed                                                                                                                                                                                                                                                                                         |

**`409 STALE_EPOCH` and `409 SESSION_NOT_ENDING` are a reconcile signal, never a retry** (S16 11): do not repeat the call. Read the body (`currentEpoch`, `mode`, `sessionState`) or call `GET …/state`, apply rule 9 and carry on; a retry of the same ack can only get the same answer.

### `GET /chatbot-api/conversations/:conversationRef/state`

Scope `requests:read`, class `read`. The reconciliation read of rule 9.

```json
{
  "mode": "HUMAN",
  "handoffEpoch": 3,
  "sessionState": "ACTIVE",
  "requestId": "9a7e…",
  "assigneeFirstName": "Ana"
}
```

`mode` `BOT | HUMAN`; `handoffEpoch` the conversation's current epoch (`0` before the first claim); `sessionState` `STARTING | ACTIVE | ENDING | null` (`null` when `mode` is `BOT`); `requestId` and `assigneeFirstName` are `null` when `mode` is `BOT` (or the account has no name). `404 NOT_FOUND` for a conversation the backend has never seen: treat it as `BOT`, epoch 0.

### `GET /chatbot-api/conversations/state?mode=HUMAN` (S16 7a)

Scope `requests:read`, class `read`. The bulk reconciliation read: after an outage, **one** call instead of one per chat. Query: `mode=HUMAN` (required; the only mode), `limit` 1 to 500 (default 100), `cursor` (opaque, from the previous answer). Anything else is `400 VALIDATION_ERROR`.

```json
{
  "items": [
    {
      "conversationRef": "wa:5255…",
      "mode": "HUMAN",
      "handoffEpoch": 3,
      "sessionState": "ACTIVE",
      "requestId": "9a7e…",
      "assigneeFirstName": "Ana"
    }
  ],
  "nextCursor": null
}
```

Each item is the single-conversation answer above plus `conversationRef`. The list holds every conversation whose backend `mode` is `HUMAN` (session `STARTING`, `ACTIVE` or `ENDING`), ordered by `conversationRef`; a conversation back in `BOT` is **not** listed, so a chat you think is `HUMAN` and that is missing here means you missed a `conversation.ended` (rule 9). `nextCursor` is `null` on the last page. The list is a live read, not a snapshot: a conversation that changes while you page may be missed or seen once, so reconcile again from the feed, not from this list alone.

### `messages:batch` answer (S16 7b, additive)

`POST /chatbot-api/conversations/:ref/messages:batch` now also answers the chat's handoff state as of the call: `{accepted, duplicates, mode, handoffEpoch}` (`mode` `BOT | HUMAN`, `handoffEpoch` `0` before the first claim). It is present even when the whole batch is duplicates. Use it as a free reconciliation hint (rule 9) after a missed `conversation.started`/`ended`.

### Bot messages that were in flight when the claim committed (S16 2)

A turn you had already started before you read `conversation.started` may finish after the claim. **Mirror it as usual** (`direction: OUT`): the backend accepts it (`200`, never a `4xx` because the chat is `HUMAN`), stores it as `author: BOT`, and the attendee reads it as a bot message inside the session (it takes its own `seq`; it is not a staff message and enqueues nothing). It does not change `mode`, the epoch or the session.

### Timeouts (all driven by the backend's sweep, never by an in-memory timer)

| Situation                                                                                                                                                                                                                                                                                                 | What the backend does                                                                          | What you see                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `STARTING` and no `session-ack STARTED` in the **start timeout** (default 120 s)                                                                                                                                                                                                                          | Reverts the claim (request back to `NEW`, `mode = BOT`, **epoch kept**) and tells the attendee | `conversation.ended {handoffEpoch: N, reason: START_TIMEOUT, farewell: false}` (rule 7)                      |
| `ENDING` and no `session-ack ENDED` in **10 min**                                                                                                                                                                                                                                                         | Marks the session `ENDED` (the request is already `RESOLVED`)                                  | Nothing new: you already have `conversation.ended`; if you never read it you will, and you apply it as usual |
| `ACTIVE` and the customer has not written for **2 h**, measured from the customer's newest message **`providerTimestamp`** (when it was written, S16 5; not when you mirrored it; a late-arriving older message never moves it back; no customer message since the session started counts from the start) | Moves to `ENDING` with an automatic note, resolves the request                                 | `conversation.ended {reason: IDLE_TIMEOUT, farewell: true}`                                                  |
| `ACTIVE`, the customer silent for **30 min**                                                                                                                                                                                                                                                              | Lets the attendee finish without confirmation (`FINISH_IDLE` in `allowedActions`)              | Nothing                                                                                                      |
| The attendee left                                                                                                                                                                                                                                                                                         | **Nothing automatic** (§12.10): a reassigner decides                                           | Nothing                                                                                                      |

These clocks do **not** pause outside business hours (a claim at night means someone is attending). Reassigning a STARTING or ACTIVE session to another person keeps the epoch and sends you `conversation.reassigned` (S15 Q2, above).

### What the backend checks on every staff write (so you do not have to)

The attendee must be the assignee, `mode = HUMAN`, the session `ACTIVE`, `expectedEpoch` the current epoch and the 24 h window open (else a template, below). A message that fails any check is **never** enqueued, so you never see a message from a person who no longer attends. `409 SESSION_NOT_ACTIVE`, `409 STALE_EPOCH`, `409 WINDOW_CLOSED {templateAllowed}` are the staff-side answers (FE handoff `20-live-conversation.md`).

### 24 h window and the template (`template.requested`)

- With the window closed the attendee cannot write; the only way to reach the customer is the **paid template**, sent by a button, **once per closed window** (a unique `(requestId, windowClosedAt)`). A template whose message ended `FAILED` (you reported `STALE`, or a later `statuses:batch` `FAILED`) may be requested again; while any template of the request sent since the customer's last message is queued, sent, delivered, read or `UNKNOWN` another may not (it costs money), even if Meta's `131047` verdict has since moved the instant the window closed. The backend refuses a request while the window is open (`409 WINDOW_OPEN`) or when the tenant has no `templateName` (`422 TEMPLATE_NOT_CONFIGURED`). No sweep or rule ever creates `template.requested`.
- On `template.requested`: send the approved template named `templateName` in `languageCode` (no variables) and report the outcome (table above). A template that Meta accepts is a message of the conversation (`type: TEMPLATE`, author `STAFF`, status by outcome). When the customer answers the template, the window opens again and staff can write.
- The backend's window for **staff sends** is `max(conversation.lastCustomerMessageAt, request.lastCustomerMessageAt) + 24 h`, and the mirror of a customer message keeps the chat's `lastCustomerMessageAt` current. The request row's own `whatsappWindowClosesAt` column is **not** moved by the mirror yet (status table: PLANNED; the inbox and detail window fields still follow the bot-reported request row). Meta's verdict (`DEFERRED_WINDOW_CLOSED` of a staff message, or a `131047` status) is stored on the chat (`windowClosedAt`, the verdict's `attemptedAt` / `occurredAt`, only moves forward) and closes the window from then until a customer message newer than it arrives; the request row is not touched.

### Complaints (`COMPLAINT`)

Identical protocol. Finishing a complaint carries a `complaintOutcome` classification for the staff's metrics; **it triggers nothing** (no refund, return or order change) and **you never see it**.

### Product questions (Q1 to Q6 were all resolved on 2026-11-12 with the owner's answers of S15; the table keeps the decisions)

| #   | Question                                                                                       | Decision (implemented)                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What does the customer see when the start reverts (`START_TIMEOUT`)?                           | **Answered (S15):** `farewell: false`; `resumeNotice: true` tells you to send a short "seguimos por aquí" **only if** you had already told the customer you were handing over, else nothing.                                                                                                                                                                                     |
| Q2  | When an active session is **reassigned** to another person (same epoch), is the customer told? | **Answered (S15):** yes, with the first name: `conversation.reassigned {handoffEpoch, staffFirstName}` ("Ahora te atiende <nombre>").                                                                                                                                                                                                                                            |
| Q3  | Releasing (not reassigning, not finishing) an `ACTIVE` session?                                | **Answered (S15):** "only finish (back to the bot)". Refused with `422 ACTION_NOT_ALLOWED`: a live conversation never goes back to `NEW` while you are muted; the way out is **finish** (the "return to bot" with a note), which a reassigner may force (`FORCED`). The proposal's §4.2 sentence "release ≡ return to bot with an automatic note" is implemented as that finish. |
| Q4  | Template language and variables                                                                | **Answered (S15/S16 8):** the language code is the tenant setting `templateLanguageCode` (default `es_MX`) carried by `template.requested`; no variables in v1. **IMPLEMENTED** (T11d).                                                                                                                                                                                          |
| Q5  | Staff photos and PDFs (D12) in a live session                                                  | **Answered (S15): yes**, in this unit, reusing unit 9 private media. **IMPLEMENTED** (see "Staff media"): `conversation.staff_message` is `TEXT`, `IMAGE` or `DOCUMENT`.                                                                                                                                                                                                         |
| Q6  | `complaintOutcome` mandatory for `COMPLAINT`                                                   | **Answered (S15): unit 12, IMPLEMENTED.** `finish` of a `COMPLAINT` is refused (`422 COMPLAINT_OUTCOME_REQUIRED`) without it, so the staff always classify; ignored for other subtypes. The bot does not see it and no feed item or payload changes. A 2 h idle end of a complaint has no classification.                                                                        |

### Status of this section (what the backend has shipped)

| Part                                                                                                                                | Status                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session model, claim starts a session, `conversation.started`, `session-ack`, `state`                                               | **IMPLEMENTED** (branch `feat/human-intervention-u11`, not merged, not deployed)                                                                                                                                        |
| Staff messages (text), `conversation.staff_message`, outcome → message status and stored wamid                                      | **IMPLEMENTED**                                                                                                                                                                                                         |
| Finish (assignee or forced), `conversation.ended`, start-timeout revert, 10 min `ENDING`, 2 h idle end                              | **IMPLEMENTED**                                                                                                                                                                                                         |
| Outcome rules per type (`OUTCOME_NOT_ALLOWED` table)                                                                                | **IMPLEMENTED**                                                                                                                                                                                                         |
| `DEFERRED_WINDOW_CLOSED` of a staff message corrects the chat's window                                                              | **IMPLEMENTED** (the chat's `windowClosedAt`, slice 2 migration; staff sends and `conversation.started` read it; a newer customer message reopens the window)                                                           |
| `template.requested` and the template command (`POST /chatbot-requests/:id/template`)                                               | **IMPLEMENTED** (T11d): once per closed window, retry after `STALE`/`FAILED`, `languageCode` in the payload; a closed window answers `409 WINDOW_CLOSED {templateAllowed}` with `true` when a template can be requested |
| A customer message moving the **request's own** `whatsappWindowClosesAt` column                                                     | **PLANNED** (staff sends already use the chat's window, which the mirror keeps)                                                                                                                                         |
| `FINISH_IDLE` (30 min), 5/15-minute "unanswered" notices, "customer wrote" notice                                                   | **IMPLEMENTED** (T11d; staff-side in-app notices written by the backend's session sweep, nothing for the bot; migration `20261113030000_live_conversation_notices`)                                                     |
| `conversation.reassigned` on reassigning a STARTING/ACTIVE session (S15 Q2)                                                         | **IMPLEMENTED**                                                                                                                                                                                                         |
| Per-tenant start timeout (`startTimeoutSeconds`, default 120 s) snapshotted at the claim (S16 1a)                                   | **IMPLEMENTED**                                                                                                                                                                                                         |
| In-flight BOT message mirrored after the claim (S16 2)                                                                              | **IMPLEMENTED** (accepted, readable as a bot message)                                                                                                                                                                   |
| Deferred staff messages terminal at session end; `pending-deliveries` only while ACTIVE (S16 3)                                     | **IMPLEMENTED**                                                                                                                                                                                                         |
| `statuses:batch` `FAILED 131047` on a staff message = window closed (S16 4)                                                         | **IMPLEMENTED** (needs the slice 2 migration: the trigger now allows `SENT → DEFERRED` for staff messages)                                                                                                              |
| Idle 2 h measured from the customer message `providerTimestamp` (S16 5)                                                             | **IMPLEMENTED**                                                                                                                                                                                                         |
| Bulk `GET /chatbot-api/conversations/state?mode=HUMAN` and `{mode, handoffEpoch}` on `messages:batch` (S16 7)                       | **IMPLEMENTED**                                                                                                                                                                                                         |
| `templateLanguageCode` setting (S16 8)                                                                                              | **IMPLEMENTED** (setting and the `languageCode` of `template.requested`)                                                                                                                                                |
| Staff photos and PDFs (S15 Q5, S16 9): staff upload, `IMAGE`/`DOCUMENT` staff messages, `GET /chatbot-api/media/:id` (`media:read`) | **IMPLEMENTED** (migration `20261113020000_live_conversation_media`)                                                                                                                                                    |

The dev/integration test that proves the whole loop with the real bot (unit 11's exit criterion) is still to be run with the chatbot team.

### Deploy checklist for unit 11

1. Apply, in order, the migrations `20261113000000_live_conversation` (new tables, one trigger function body, indexes), `20261113010000_live_conversation_slice2` (two settings columns with CHECKs, `startDeadlineAt`, two partial indexes, the trigger function again with the S16 4 transitions; idempotent), `20261113020000_live_conversation_media` (see step 2) and `20261113030000_live_conversation_notices` (two columns and a CHECK on `chatbot_live_sessions`; idempotent) **before** the new code; deploy at low traffic (brief locks, the migrations state them). The load test (`docs/perf/unit-11-live-conversation.md`) needed no further migration: there is no `20261113040000`.
2. The credential needs `feed:read`, `feed:ack`, `conversation:write`, `requests:read` and, for staff photos and PDFs, the **new scope `media:read`** (add it to the credential like `media:write`; free text on `ServiceCredential.scopes`, no code change). Also apply migration `20261113020000_live_conversation_media` (three nullable columns on `conversation_media` and a CHECK).
3. **Order of rollout:** ship the bot's handler for the five item types (`conversation.started`, `conversation.staff_message`, `conversation.reassigned`, `conversation.ended`, `template.requested`; rules 1 to 10) **before** staff start claiming live requests on that environment. Until then a claim reverts after the start timeout (rule 7; default 120 s), so nothing breaks, but no live conversation can happen.
4. Inngest does not need a re-sync (no new function). The timeouts run in the backend's own sweep (one more `@Interval`, gated in tests like the others).

## Scheduled conversations (unit 14)

Contract: proposal §4.9, §3.3, §3.9, §4.2, §4.5, §5.4, §10 row 14, §10.1 (R2, R11 and the "Agenda" target), §12.11 and the unit 11 section above (live session, 24 h window, template). Owner decisions that apply (D3, D7 to D10): out of hours "I want to talk to a person" is **scheduled**; 30-minute blocks; 3 times offered; at most 3 conversations per block and branch (configurable); windows free of charge first, a paid template only when no free block exists; holidays are closed dates. **This section is the contract for the bot side; the status table at the end says what the backend has shipped (everything below is implemented on the unit 14 branch, not merged, not deployed).** Every "Q" below was a product question the proposal left open; all 17 are resolved (list at the end): Q4, Q6, Q9 and Q10 by the owner (S19, 2026-11-12) and the rest by the recommended defaults, with the chatbot's review points (S20) applied on top.

### The model in one picture

```text
bot: out of hours / customer wants a person
 ├─ GET  /chatbot-api/scheduling/slots?conversationRef=…        → timeZone, whatsappWindowClosesAt, slots[]
 ├─ POST /chatbot-api/requests {subtype: TALK_TO_HUMAN|COMPLAINT, scheduledFor: <a startsAt>}   → request NEW, session WAITING, seat taken
 │        409 SLOT_UNAVAILABLE {slots[]}  → offer the new list
 ├─ (customer changes mind)  POST /chatbot-api/requests/:id/reschedule {scheduledFor}   → old seat freed, new one taken
 │                           POST /chatbot-api/requests/:id/cancel                       → seat freed
 │
backend, by time:
   scheduledFor − 10 min   feed: conversation.scheduled_reminder   (send only if the 24 h window is open)
   scheduledFor − 5 min    staff may claim ("Atender"); before that the claim is refused
   scheduledFor            the "solicitud nueva" notice goes to staff (not at booking)
   claim                   unit 11 as usual: conversation.started (epoch N), you mute, session-ack STARTED, greeting
staff changes the time → feed: conversation.rescheduled   (send only if the 24 h window is open)
```

**Nothing starts by itself at `scheduledFor`.** The conversation is a normal `TALK_TO_HUMAN`/`COMPLAINT` request in `NEW` with no session (`WAITING`); you keep answering the customer as a bot until a person claims it. The live session (unit 11) begins at the **claim**, exactly as for an unscheduled request: `conversation.started`, mute, `session-ack STARTED`, greeting, silence protocol, finish. Nothing in unit 11 changes.

### `GET /chatbot-api/scheduling/slots?conversationRef=&lastCustomerMessageAt=`

Scope `requests:read`, class `read`. `conversationRef` as everywhere (1..200 chars). `lastCustomerMessageAt` is optional (Q5): the instant of the customer's newest message as you know it (ISO-8601; at most 5 minutes in the future and 30 days old, else `400`). The backend uses the newest of that value and the chat's own `lastCustomerMessageAt` (kept current by the mirror); when it has neither (a chat it has never seen), it assumes the customer wrote **now**.

```json
{
  "timeZone": "America/Mexico_City",
  "whatsappWindowClosesAt": "2026-11-10T03:10:00.000Z",
  "businessHours": {
    "openNow": false,
    "nextOpenAt": "2026-11-10T15:00:00.000Z",
    "timeZone": "America/Mexico_City",
    "weeklyRanges": [
      { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] }
    ],
    "closedDates": ["2026-12-25"]
  },
  "slots": [
    {
      "startsAt": "2026-11-10T15:00:00.000Z",
      "withinWindow": true,
      "available": true
    },
    {
      "startsAt": "2026-11-10T15:30:00.000Z",
      "withinWindow": true,
      "available": true
    },
    {
      "startsAt": "2026-11-10T16:00:00.000Z",
      "withinWindow": true,
      "available": true
    }
  ]
}
```

- `timeZone` is the branch's IANA zone and always present. **There is no `label`**: build the text from `startsAt` and `timeZone` in the customer's register (§11.1). Never use a fixed UTC offset.
- `slots` has at most `slotsOffered` entries (default 3), earliest first, and only blocks with a free seat: **a full block is skipped, so `available` is always `true`** (the field exists for the contract's shape; do not rely on `false`).
- **Which blocks (Q2, Q3).** Blocks are `slotMinutes` long (default 30), laid out from each opening time of the branch's business hours (the chat's own hours, `GET /chatbot-settings`), inside the open ranges only, never on a closed date. A block is offered if `startsAt` is at least **10 minutes from now** and within **14 days**. The three offered are the next three free blocks ("the next opening and two more"), so on a quiet day they are consecutive.
- **Window first (D9).** `withinWindow = startsAt + 15 min < whatsappWindowClosesAt` (the greeting is free). If at least one free block is within the window, **only within-window blocks are listed** (maybe fewer than 3). If none is, the list holds the first free blocks with `withinWindow: false`: booking one costs a paid template at the start (`requiresTemplateAtStart`, below). Say so to the customer if you want, and ask them to answer when the person greets them.
- `whatsappWindowClosesAt` is `lastCustomerMessageAt + 24 h` as the backend computes it (informational; Meta decides at send time).
- `businessHours` (S20 4, 5): `openNow`; `nextOpenAt` (start of the open range that contains now, or of the next one within 14 days; `null` if none); `timeZone`; `weeklyRanges` (the seven days, Monday first, `HH:mm` ranges in the branch's zone: the chat's own hours) and `closedDates` (the branch's closed dates from today through the next 14 days, `YYYY-MM-DD`, sorted). A direct `POST /chatbot-api/requests` answers the same object **without** `weeklyRanges` and `closedDates` (Q16; the wrapped subtypes RESTOCK / EXPIRATION / DELIVERY_ZONE still answer `null`).
- **`SCHEDULING_DISABLED` is the cue to fall back** to the unit 11 out-of-hours create (an unscheduled `TALK_TO_HUMAN` / `COMPLAINT` with the usual out-of-hours message and `businessHours.nextOpenAt` from the create answer).
- Errors: `422 SCHEDULING_DISABLED` (the branch's `scheduling.enabled` is off, the default), `400 VALIDATION_ERROR`, `401`, `403 INSUFFICIENT_SCOPE`, `429 RATE_LIMITED`. An empty `slots` (nothing free for 14 days) is a `200` with `slots: []`: tell the customer nobody can be scheduled and fall back to the out-of-hours message with `businessHours.nextOpenAt`.
- Cost: one read of the tenant's settings (cached), one primary-key range read of the block counters and the chat row; measured at 2,700 booked requests and 484 full blocks in the tenant: **p95 10.97 ms** over HTTP against the §10.1 target of 100 ms (`docs/perf/unit-14-scheduled-conversations.md`). The create is synchronous: p95 18.76 ms, and the same-key replay of a 2xx p95 5.68 ms (S20 2).

### `POST /chatbot-api/requests` with `scheduledFor`

The same route and envelope as above (`sourceRequestId`, `customer`, `conversationRef`, `lastCustomerMessageAt`, `summary`, `needs`, …) plus `scheduledFor` (ISO-8601 instant). Rules:

- `subtype` must be `TALK_TO_HUMAN` or `COMPLAINT` (Q1); `scheduledFor` on another subtype is `400 VALIDATION_ERROR`. `scheduledFor: null` or absent is today's behaviour.
- `scheduledFor` must be **exactly the `startsAt` of a bookable block** (not necessarily one of the three you showed): on the branch's block grid, inside open hours, not a closed date, at least 10 minutes away and within 14 days, **and with a free seat**. The backend re-checks all of it **inside the transaction**, after locking the block's counter, so two bookings for the last seat can never both win. Otherwise **`409 SLOT_UNAVAILABLE`** with the fresh list in the body: `{ "statusCode": 409, "code": "SLOT_UNAVAILABLE", "slots": [ … same shape as the slots route … ], "timeZone": "…", "whatsappWindowClosesAt": "…" }`. Offer the new list; do not retry the same slot.
- At most one open scheduled request per customer and subtype (Q4); another is **`409 ALREADY_SCHEDULED`** `{requestId, scheduledFor}`: tell the customer they already have a time and offer to change it (`reschedule`). **Identity (S20 9):** the customer's canonical phone (`customerKey`: country code plus the national number with every non-digit removed), so `55 1234 5678` and `5512345678` are one customer. It is the phone, not a linked `customerId`: one open scheduled request per phone and subtype, whether or not the phone matches a customer record. One `TALK_TO_HUMAN` **and** one `COMPLAINT` may both be booked. The check runs before the seat is taken; a refused booking holds no seat.
- The answer is the usual one plus `scheduledFor`, `requiresTemplateAtStart`, `whatsappWindowClosesAt`, `businessHours`:

```json
{
  "id": "…",
  "folio": "S-000123",
  "status": "NEW",
  "outcome": "CREATED",
  "mergedIntoId": null,
  "businessHours": {
    "openNow": false,
    "nextOpenAt": "2026-11-10T15:00:00.000Z",
    "timeZone": "America/Mexico_City"
  },
  "scheduledFor": "2026-11-10T15:00:00.000Z",
  "scheduleVersion": 1,
  "requiresTemplateAtStart": false,
  "whatsappWindowClosesAt": "2026-11-10T21:02:11.000Z"
}
```

- `requiresTemplateAtStart` is `true` when `scheduledFor + 15 min >= whatsappWindowClosesAt` at booking time: the paid-template case. It is **recorded in the audit** (`CREATED` event, `data.requiresTemplate`) so the cost can be measured, and it is shown to staff on the row. Q7: it is the booking-time value and is not recomputed when the customer writes later (the composer at claim time uses the live window anyway).
- **Idempotency** as for every create: the key is `sourceRequestId`; a **2xx** replay answers the first answer (`outcome: "REPLAYED"`) even if the seat was released since. **4xx answers are never stored** (S20 1): after a `409 SLOT_UNAVAILABLE` or `ALREADY_SCHEDULED` the same `sourceRequestId` may book another slot (the whole transaction rolled back, no seat, no row). Same-key replay of a 2xx is an indexed lookup (measured p95 5.68 ms; the create itself 18.76 ms). A scheduled create never merges (a `dedupKey` is ignored for it).
- `scheduleVersion` (S20 6) is monotonic per request: `1` at booking, `+1` on every reschedule and on the cancel of a scheduled request; it is on the create, reschedule and cancel answers and on both feed items.
- **"Solicitud nueva" notice:** a scheduled booking does not notify staff at booking time; the schedule sweep writes the notice at `scheduledFor` (held to the next opening while the branch is closed, L69).
- **Times start at `scheduledFor`**, not at creation (§4.9.4): the claim deadline and the overdue clock are computed from it (business time), and the sweep never marks the request overdue before that hour.
- Errors added to the table above: `409 SLOT_UNAVAILABLE`, `409 ALREADY_SCHEDULED`, `422 SCHEDULING_DISABLED` (now only when the branch has scheduling off).

### `POST /chatbot-api/requests/:id/reschedule`

Scope `requests:create`, class `write`, `X-Idempotency-Key: <uuid>` required (any UUID). Body `{ "scheduledFor": "<ISO>", "lastCustomerMessageAt"?: "<ISO>", "triggerWaMessageId"?: "wamid.…" }`; exactly those keys.

`200`:

```json
{
  "id": "…",
  "status": "NEW",
  "outcome": "RESCHEDULED",
  "scheduledFor": "2026-11-11T15:30:00.000Z",
  "previousScheduledFor": "2026-11-10T15:00:00.000Z",
  "scheduleVersion": 2,
  "requiresTemplateAtStart": false,
  "whatsappWindowClosesAt": "2026-11-11T21:02:11.000Z"
}
```

- The old seat is released and the new one taken in **one transaction** (both counters locked in `startsAt` order, so two reschedules cannot deadlock). The claim, overdue and reminder clocks are recomputed from the new time; `needsReschedule` is cleared; the audit gets a `RESCHEDULED` event.
- Same `scheduledFor` as the current one: `200` with `outcome: "UNCHANGED"` and nothing changes (the seat is not counted twice, `scheduleVersion` stays).
- `triggerWaMessageId` is **audit only** (S20 10, stored on the `RESCHEDULED` event); idempotency is the `X-Idempotency-Key`: same key and body replays the first `200`, same key with another body is `409 IDEMPOTENCY_CONFLICT`. A 4xx is not stored, so the key may be reused after a `409 SLOT_UNAVAILABLE`.
- `lastCustomerMessageAt` (Q5) is optional here too: the window of `requiresTemplateAtStart` uses the newest of it, the request's and the chat's value.
- Allowed only while the session has **not started** (`WAITING`: a `NEW` request, also one whose time already passed, also one reverted after a start timeout). Same slot rules as booking, same `409 SLOT_UNAVAILABLE {slots}`.
- Other errors: `404 NOT_FOUND` (unknown id or another branch), `409 REQUEST_CLOSED` (already `RESOLVED` or `CANCELLED`), `409 NOT_SCHEDULED` (the request has no `scheduledFor`; this route is not a way to schedule an existing request), `409 RESCHEDULE_NOT_ALLOWED` (a live session has started: the words go to the attendee), `422 SCHEDULING_DISABLED`, `409 IDEMPOTENCY_CONFLICT`, `400`.
- It sends **no feed item**: you made the change, you already know. Tell the customer the new time yourself.
- No limit on the number of reschedules per request in v1 (Q17); the `write` budget applies.

### Cancel (`POST /chatbot-api/requests/:id/cancel`)

Unchanged route and body (`CUSTOMER_WITHDREW`). On a scheduled request it also **releases the seat** in the same transaction, stops its schedule and answers `scheduleVersion` (previous `+1`; absent for an unscheduled request). It works while the session has not started (`WAITING`); after a claim it is `409 CANCEL_NOT_ALLOWED` as before. A cancel by **staff** (`request.cancelled` with `reason`, `customerNote?` as §12.14 says) frees the seat too and reaches you as the usual `request.cancelled` item: nothing new to implement, but if you tell the customer "your appointment was cancelled" use the `customerNote` rule of the feed section.

### Feed items

Same envelope as every item (`cursor`, `deliveryId`, `type`, `requestId`, `conversationRef`, `payload`, `notBefore: null`, `expiresAt: null`), the same cursor, long-poll and `POST /chatbot-api/deliveries/:deliveryId/outcome`. Both are created in the **same transaction** as their cause (the sweep's, or the staff command's), so an item exists if and only if the change committed. Both are also served by `pending-deliveries` and the recovery route like any `conversation.*` item.

| `type`                            | When                                                                                                                               | `payload`                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `conversation.scheduled_reminder` | The backend's sweep, about **10 minutes before** `scheduledFor`, once per scheduled time, only for an open request still `WAITING` | `{requestId, scheduledFor, scheduleVersion, minutesBefore: 10, timeZone, whatsappWindowClosesAt, requiresTemplateAtStart}`    |
| `conversation.rescheduled`        | **Staff** changed the time (`POST /chatbot-requests/:id/reschedule`)                                                               | `{requestId, scheduledFor, previousScheduledFor, scheduleVersion, timeZone, whatsappWindowClosesAt, requiresTemplateAtStart}` |

- **Reminder (shipped; created by the schedule sweep, which runs every 15 s, so it can be a few seconds late).** The reminder is never sent when fewer than 3 minutes remain before `scheduledFor` (S20 7) and is suppressed while `needsReschedule` is set (S20 8). Send "En 10 minutos le atiende una persona del equipo" (your wording, the customer's register) **only if the 24 h window is open** (the payload's `whatsappWindowClosesAt` is the backend's estimate, Meta is the truth). With the window closed, send nothing and ACK `STALE`: a reminder is never worth a paid template, and no sweep ever creates `template.requested` (§4.5). If the customer's appointment was cancelled, rescheduled or claimed before you read the item, the backend does not create it; if it was created and then the situation changed (rescheduled, cancelled), ACK `STALE` after comparing `scheduledFor` with what you hold (the backend does not settle it for you). The backend never creates a reminder when the sweep ran after `scheduledFor`: a late reminder only confuses.
- **Rescheduled.** Tell the customer the new time ("Su conversación quedó para el <hora>") **only if the window is open**; otherwise ACK `STALE`. Q9: the backend does **not** defer it (`DEFERRED_WINDOW_CLOSED` is `422 OUTCOME_NOT_ALLOWED`): a time change delivered days later only confuses. Staff see the outcome in the request detail, and the staff command's answer says up front whether the customer can be told (`customerNotice.expected`).
- Items are for the request's **current** scheduled time: each carries `scheduledFor`; ignore an item whose `scheduledFor` is not the one you hold after your own latest `reschedule`.

### ACK outcomes

| Type                              | `PROVIDER_ACCEPTED` | `DELIVERY_UNKNOWN` | `DEFERRED_WINDOW_CLOSED` | `DEFERRED_HUMAN_SESSION`                                   | `STALE`                                                                      |
| --------------------------------- | ------------------- | ------------------ | ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `conversation.scheduled_reminder` | reminder sent       | cannot tell        | **no** (`422`)           | **no** (`422`: a reminder while a person talks is useless) | not sent (window closed, appointment changed or cancelled, you chose not to) |
| `conversation.rescheduled`        | notice sent         | cannot tell        | **no** (`422`)           | **no** (`422`)                                             | not sent (window closed, superseded)                                         |

Anything else is `422 OUTCOME_NOT_ALLOWED` and the item stays pending (the same rule as `request.cancelled`). While the chat is in `HUMAN` mode (a claim started early, five minutes before) you send neither: ACK `STALE`.

### How the window and the template work with unit 11

- **Booking.** `withinWindow` / `requiresTemplateAtStart` use `lastCustomerMessageAt + 24 h` and the 15 minute margin of the greeting (above). The booking stores the request's `lastCustomerMessageAt` and `whatsappWindowClosesAt` from the envelope as for any request.
- **At the claim** (from `scheduledFor − 5 min`; `409` `SCHEDULED_TOO_EARLY {claimableAt}` before) everything is unit 11: `conversation.started` carries `whatsappWindowClosesAt` (the live window: newest of the chat's and the request's last customer message, so a customer who kept writing while waiting reopened it); the greeting is yours and only goes if the window is open; if it is closed, ACK `STALE` for the greeting and do mute. The attendee's composer then offers **"Enviar plantilla"** instead of free text (409 `WINDOW_CLOSED {templateAllowed: true}` on a message), once per closed window; the template reaches you as `template.requested` and **the customer's answer reopens the window**. Ask the customer, in the booking message, to answer when the person greets them.
- Staff are the only ones who can spend a template. The reminder and the rescheduled notice never become one.
- **What the customer writes while waiting** goes to you as always (the request stays `WAITING`), is answered by the bot and is mirrored; a newer `lastCustomerMessageAt` through the mirror keeps the chat's window current.
- **No-show** is unit 11's §4.6 clocks counted from the greeting: no answer in 15 minutes the attendee may finish; after 2 hours the conversation goes back to you by itself (`conversation.ended`).
- **If nobody claims.** The request is overdue by the usual rules counted from `scheduledFor`; the staff notices work as for any request. The customer is not told anything by the system.

### Recovery: `scheduledRequest` on the state routes (S20 3)

`GET /chatbot-api/conversations/:conversationRef/state` and each item of `GET /chatbot-api/conversations/state?mode=HUMAN` carry `scheduledRequest`: `null`, or `{requestId, subtype, scheduledFor, needsReschedule, scheduleVersion}` of the chat's **nearest open scheduled request** (a chat may hold one `TALK_TO_HUMAN` and one `COMPLAINT`; the earlier time is shown). A chat the mirror has not seen yet but that has a booking answers `200 {mode: "BOT", handoffEpoch: 0, sessionState: null, requestId: null, assigneeFirstName: null, scheduledRequest}` instead of `404`. Use it after an outage to rebuild "this customer is waiting for <time>".

### Closed days and hours that change (`needsReschedule`)

Business hours and closed dates are the branch's chat settings (unit 7). When staff save a change (the settings `PUT`, or apply-to-all), the backend runs a pass **right after the settings commit** (not inside the settings transaction: that would invert the lock order every request command uses): open scheduled requests that are still `NEW` (nobody claimed them) and in the future, whose `scheduledFor` is now outside the open hours or on a closed date, get **`needsReschedule: true`** (`version` + 1, `request.updated` in realtime) and show in the inbox (`counts.needsReschedule`). The pass works in short batches of 200 rows, skips a row a command holds (`SKIP LOCKED`), and a failure never fails the settings write: the schedule sweep flags such a row anyway when its reminder falls due (10 minutes before the time). **Nothing moves by itself, nothing is sent to the customer and no feed item is created** (Q6, S19): a person decides and reschedules (`conversation.rescheduled` then goes to you). While the flag is set the reminder is suppressed (S20 8) and the "solicitud nueva" notice still goes out at `scheduledFor`. A request flagged and still unclaimed at `scheduledFor` stays a normal claimable request. A flagged request that you **reschedule yourself** (the customer asks) clears the flag; your `scheduledRequest.needsReschedule` on the state routes tells you it is set. Measured: a pass over 2,395 candidates in one tenant (1,779 flagged) took 402 ms in 12 batches (p95 37 ms per batch).

### Staff side (for your information; the FE has its own handoff `21-scheduled-conversations.md`)

- `POST /chatbot-requests/:id/reschedule {expectedVersion, scheduledFor}` with `Idempotency-Key` (`update:ChatbotRequest`): same slot rules, `RESCHEDULED` audit event `{from, to, requiresTemplate, scheduleVersion, byUser}`, `conversation.rescheduled` to you (always created, in the same transaction), `request.updated` in realtime. It answers `200 {request: {…, scheduledFor, previousScheduledFor, scheduleVersion, requiresTemplateAtStart, customerNotice}, customerNotice: {expected}}`; `customerNotice.expected` is `false` when the 24 h window is closed (the bot will ACK `STALE`, S19 Q9) so the screen warns the attendee before they confirm. `409 SLOT_UNAVAILABLE {slots}`, `409 REQUEST_CLOSED`, `409 NOT_SCHEDULED`, `409 RESCHEDULE_NOT_ALLOWED` (live), `409 VERSION_CONFLICT`.
- `GET /chatbot-requests/:id/scheduling/slots` (Q15) lists bookable blocks for the staff's picker.
- `CLAIM` before `scheduledFor − 5 min` is `409 SCHEDULED_TOO_EARLY {claimableAt}` and is listed in `deniedActions` with that code; `RESCHEDULE` is in `allowedActions` while the request is open, scheduled and the session has not started. Inbox rows and the detail carry `scheduledFor`, `scheduleVersion`, `needsReschedule`, `requiresTemplateAtStart`.
- A staff **merge** of a scheduled request into another is `422 MERGE_NOT_ALLOWED` (Q14); an unscheduled request merged **into** a scheduled one leaves the target's single seat as is. A staff **cancel** of a scheduled request frees the seat and bumps `scheduleVersion`.

### Product questions Q1 to Q17 (all resolved; the table keeps the decisions)

Q4, Q6, Q9 and Q10 were answered by the owner on 2026-11-12 (S19, verbatim «Una por cliente y tipo (Recomendado)», «Se marca para reagendar (Recomendado)», «No se avisa; la pantalla advierte (Recomendado)», «Sí, con su hora (Recomendado)»: all four are the recommended defaults). The others are product defaults the backend chose and implemented (no owner answer was needed; each is a constant or one predicate if the owner later prefers another). The chatbot's review (S20) refined Q6, Q8 and Q17 as noted. None changes the data model.

| #   | Question                                                                                                | Recommended default (implemented)                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Which subtypes can be scheduled? §4.9 says `TALK_TO_HUMAN` "(o `COMPLAINT`)".                           | Both. Any other subtype with `scheduledFor` is `400`. Seats are shared by both subtypes (one capacity per block and branch).                                                                                                                                                                                                          |
| Q2  | How far ahead, and how soon, can a time be booked?                                                      | At least 10 minutes from now (so the 10 minute reminder is not already late) and at most 14 days ahead. Constants, not settings.                                                                                                                                                                                                      |
| Q3  | Are the 3 offered times the next 3 free blocks or spread out? What if only some are within the window?  | The next 3 free blocks, in order (the literal "next opening and two more"). If any free block is within the free 24 h window, only within-window blocks are offered; otherwise the first 3 with `withinWindow: false`.                                                                                                                |
| Q4  | May one customer hold several scheduled conversations (and so several of the 3 seats)?                  | One open scheduled request per customer and subtype; a second is `409 ALREADY_SCHEDULED`. Prevents one person taking a whole block. **Owner S19.** S20 9 fixes the identity (the canonical phone, `customerKey`; one open request per phone and subtype).                                                                             |
| Q5  | The slots route only gets `conversationRef`, but the mirror may lag the customer's newest message.      | Optional `lastCustomerMessageAt` on the slots and reschedule routes (additive); the backend takes the newest of it and the chat's own value; neither known = the window is closed now (`withinWindow` false, no customer notice, `requiresTemplateAtStart` true).                                                                     |
| Q6  | What happens to a booked time when the owner later closes that day or shortens the hours?               | Flag `needsReschedule` (also for an hours change, not only closed dates), tell nobody automatically, staff reschedules. The proposal only names closed dates; hours are the same predicate. **Owner S19: yes.** S20 8 refines it: the reminder is suppressed while the flag is set.                                                   |
| Q7  | Is `requiresTemplateAtStart` live or frozen?                                                            | Frozen at booking/reschedule (it is the audit of "this booking will cost a template"); the composer at the claim uses the live window.                                                                                                                                                                                                |
| Q8  | Reminder when the window is already closed?                                                             | The item is still created (the backend only has an estimate; Meta decides); you ACK `STALE`. Never a template. S20 7 adds a lower bound: the backend never creates a reminder with fewer than 3 minutes left, nor after `scheduledFor`.                                                                                               |
| Q9  | Staff changes the time and the customer's window is closed. Defer the notice until the customer writes? | No: `STALE`, nobody is told. The staff command answers `customerNotice.expected` so the UI warns the attendee before they confirm. **Owner S19.**                                                                                                                                                                                     |
| Q10 | Do future scheduled requests show in "Nuevas" and the open counters before their time?                  | Yes, as today's design (the "Agendadas" tab is a filter over the open list and `counts.scheduled` counts them); the row shows `scheduledFor`. The "solicitud nueva" notice and the overdue clock wait for `scheduledFor`. Hiding them from `new` is a one-predicate change if the owner prefers. **Owner S19: yes, with their time.** |
| Q11 | The optional "Hoy hay N conversaciones agendadas" summary when the branch opens (§4.9.5)?               | Not in v1 (it is marked optional in the proposal).                                                                                                                                                                                                                                                                                    |
| Q12 | Reminder 10 min and claim 5 min before: fixed or settings?                                              | Fixed constants (the proposal states them as such); no new settings.                                                                                                                                                                                                                                                                  |
| Q13 | Seats when settings change afterwards (`maxScheduledPerSlot` lowered, `slotMinutes` changed)?           | Existing bookings keep their seat and time (nobody is evicted); new bookings see the new limit. Capacity is counted per exact `startsAt`: after a `slotMinutes` change, old and new grids can overlap in time.                                                                                                                        |
| Q14 | May staff merge a scheduled request into another one?                                                   | No (`422 MERGE_NOT_ALLOWED`): a merge would silently drop a booking and its seat.                                                                                                                                                                                                                                                     |
| Q15 | The FE needs a slot picker for staff reschedule; the proposal only lists the bot route.                 | `GET /chatbot-requests/:id/scheduling/slots` (`read:ChatbotRequest`), same function, up to 24 blocks.                                                                                                                                                                                                                                 |
| Q16 | `businessHours` in the create answer was `null` before unit 14.                                         | Filled from now on for every create (`openNow`, `nextOpenAt`) with the same calendar. Done (`businessHours` on every direct create; with the weekly ranges and closed dates only on the slots route, S20 4 and 5).                                                                                                                    |
| Q17 | Limit on reschedules per request?                                                                       | None in v1; the route budget and the 10 requests/hour customer limit apply. Revisit if abused. S20: the **bot** caps customer reschedules at 3 per conversation (bot side); the backend has no limit of its own.                                                                                                                      |

### Status of this section (what the backend has shipped)

Updated by step. Parts 2 to 4 (this branch `feat/human-intervention-u14`, not merged, not deployed) ship everything below except the item marked not implemented.

| Part                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This contract and the product questions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **WRITTEN** (step 1)                                                                                                                                                              |
| Pure scheduling domain, migration `20261114000000_scheduled_conversations`, atomic per-block seat counter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **IMPLEMENTED** (part 1)                                                                                                                                                          |
| Slots route (`businessHours` with weekly ranges and closed dates, `SCHEDULING_DISABLED`), booking with `scheduledFor` (seat in the insert's transaction, `SLOT_UNAVAILABLE`, `ALREADY_SCHEDULED`, 4xx not stored, `scheduleVersion`), bot reschedule, staff reschedule + staff slots, `conversation.rescheduled` and its ACK rules (`DEFERRED_*` are `422`), cancel (bot and staff) and staff merge keeping the seat count right, claim guard `SCHEDULED_TOO_EARLY`, `RESCHEDULE` / `scheduleVersion` on the staff inbox, `scheduledRequest` on both state routes, `businessHours` on every direct create | **IMPLEMENTED** (part 2)                                                                                                                                                          |
| Schedule sweep (`conversation.scheduled_reminder` 10 min before, none under 3 min, suppressed while `needsReschedule`, unique per `scheduleVersion`), the "solicitud nueva" notice and the start of the claim and overdue clocks at `scheduledFor` (held to the next opening, L69), the `needsReschedule` flag when settings change (settings `PUT` and apply-to-all, S19 Q6; nothing is sent to the customer), the bot reschedule receipt of kind `RESCHEDULE`                                                                                                                                           | **IMPLEMENTED** (part 3)                                                                                                                                                          |
| Recompute of `requiresTemplateAtStart` by the sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **NOT IMPLEMENTED, by design**: Q7 keeps the booking-time value (frozen); the composer at the claim uses the live window                                                          |
| Load test at production size (`docs/perf/unit-14-scheduled-conversations.md`): slots p95 10.97 ms (§10.1 target 100), booking create p95 18.76 ms, 2xx replay p95 5.68 ms, bot / staff reschedule p95 17.03 / 15.47 ms, cancel p95 12.2 / 13.5 ms (the last four against a derived 100 ms bar), inbox with the Agendadas tab p95 under 22 ms (target 200), a sweep tick with nothing due 0.30 ms (target 50). Two fixes it found: the flag pass wrote its realtime events one round trip per row (batch p95 133 ms, now 37 ms) and the sweep result counted every notice twice (log line only)            | **IMPLEMENTED** (part 4); no further migration (`20261114010000_scheduled_conversations_perf` was **not** created: the indexes of `20261114000000` already serve every statement) |
| Frontend handoff `docs/frontend-handoff/21-scheduled-conversations.md` (staff picker, reschedule with the `customerNotice` warning, `SCHEDULED_TOO_EARLY`, Agendadas tab) and the `needsReschedule` note in handoff 16                                                                                                                                                                                                                                                                                                                                                                                    | **WRITTEN** (part 4)                                                                                                                                                              |
| End-to-end proof with the real bot (reminder, rescheduled notice, `scheduledRequest` recovery, the 3-reschedule cap on the bot side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **TO RUN** with the chatbot team (condition to close unit 14)                                                                                                                     |

### Deploy checklist for unit 14

1. Apply migration `20261114000000_scheduled_conversations` **before** the new code. It is safe on a populated database: the new `chatbot_requests` columns (`scheduleVersion`, `scheduleStage` with a constant default, `scheduleDueAt` nullable) are metadata-only, the two partial indexes and the feed-item unique index start empty (no existing row has a `scheduledFor`), the bot receipt `kind` CHECK is widened, the realtime trigger function is replaced in place, and every wait is bounded by `lock_timeout = 5s`. It is idempotent (`IF NOT EXISTS` / `OR REPLACE`), so after a failure `prisma migrate resolve --rolled-back 20261114000000_scheduled_conversations` and a redeploy can run it again. Deploy at low traffic anyway: the `ALTER TABLE` takes a short exclusive lock on `chatbot_requests`. **Lock durations (unit 14 verify):** Prisma runs the file as ONE transaction, so the `ACCESS EXCLUSIVE` locks of the `ALTER TABLE` / `ADD CONSTRAINT` statements are held until commit; the `chatbot_requests` CHECK validates immediately (a scan of the table under that lock) and the three plain `CREATE INDEX` statements block writes to their table while they scan. How long depends on the size of `chatbot_requests` and `chatbot_feed_items`; at current production sizes it is short (the load test seeds 53,000 requests). Run it in the rollout's maintenance window.
2. **There is no `20261114010000`.** The load test needed no new index (`docs/perf/unit-14-scheduled-conversations.md`); if a deploy script lists `20261114010000_scheduled_conversations_perf`, remove it.
3. The credential needs `requests:read` (slots, state routes), `requests:create` (booking and the bot reschedule), `requests:cancel` (cancel), `feed:read` and `feed:ack` (the two feed items), as for units 5 and 11. No new scope.
4. **Nothing is scheduled until a branch turns it on:** `scheduling.enabled` is off by default (settings, handoff 16), and every scheduling route answers `422 SCHEDULING_DISABLED` until then, which is your cue to keep the unit 11 out-of-hours create. Enable it branch by branch **after** the bot ships its handlers.
5. **Order of rollout:** ship the bot's handling of `conversation.scheduled_reminder` and `conversation.rescheduled` (send only if the 24 h window is open, else ACK `STALE`; the ACK table above), the slots + `scheduledFor` booking flow, `409 SLOT_UNAVAILABLE` / `ALREADY_SCHEDULED`, and the use of `scheduledRequest` in recovery, **before** enabling scheduling on a branch. The backend side can be deployed first with scheduling off without changing any behaviour.
6. Inngest does not need a re-sync (no new function). The schedule sweep is the backend's own `@Interval` (every 15 s, `FOR UPDATE SKIP LOCKED`, no cursor in memory: replicas can run side by side), gated in tests like the other schedulers.
7. After deploy, check `GET /chatbot-requests/counts` (`scheduled`, `needsReschedule`) on a branch with scheduling on, and watch the log line `schedule sweep: N reminders, N notices, N flagged, …` (it prints only when something happened; the notice count is correct from this build on).
