# Chatbot ↔ backend: human requests (slice 5a)

What the chatbot session consumes. Contract source: `docs/proposals/human-intervention-backend-proposal.md` §3.1–§3.5, §3.9, §6.4, §10.1 R2. Implemented in this slice: **create**, **merge**, **customer cancel**, the **route budgets**. Not yet: the feed and delivery ACKs (slice 5b), `cancel-batch`, `reschedule`, scheduling slots, the conversation mirror, media, `GET /conversations/:ref/state` (see "Not in this slice").

## Common rules

| Rule | Detail |
| --- | --- |
| Auth | `Authorization: Bearer svc_…`. `X-Branch-Id`, when sent, must equal the credential's tenant (else `403 FORBIDDEN`). The tenant, source and credential never go in a body. |
| Scopes | `requests:create`, `requests:read`, `requests:cancel`, `feed:read`, `feed:ack`, `conversation:write`, `media:write`. They are free text on `ServiceCredential.scopes`; add the ones a credential needs. A missing scope is `403 INSUFFICIENT_SCOPE`. This slice's routes use `requests:create` and `requests:cancel`. |
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
- Wrapped subtypes add `legacy`: what the old route answers (`POST /chatbot-api/human-decisions`), because the bot still polls those rows by id until the feed carries the answers. A `DELIVERY_ZONE` requester that an already-approved zone answers immediately has no request: `id` and `folio` are `null`, `status` is `RESOLVED`, and `legacy` holds the answer.
- A wrapped replay whose envelope differs from the first one (other `customer`, `summary`, …) is `409 IDEMPOTENCY_CONFLICT`.

### Errors

| Status / code | When | Extra fields |
| --- | --- | --- |
| `400 VALIDATION_ERROR` | bad body, bad key, key ≠ `sourceRequestId` | — |
| `401`, `403 INSUFFICIENT_SCOPE`, `403 FORBIDDEN` | credential, scope, branch | — |
| `404 NOT_FOUND` | a wrapped `detail` refers to a missing product (as the old route) | — |
| `409 IDEMPOTENCY_CONFLICT` | same key, other body | — |
| `409 CUSTOMER_OPEN_LIMIT` | the customer already has 20 open requests, all subtypes together | `limit: 20`, `open: 20` |
| `429 CUSTOMER_RATE_LIMITED` | 10 requests created for this customer in the last hour (counted in the database; merges do not count) | `limit: 10`; `Retry-After` header |
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
- For a wrapped decision (`RESTOCK`, `EXPIRATION`, `DELIVERY_ZONE`) only the request closes; the legacy row stays `PENDING` and the old routes still work on it (see `docs/chatbot-requests-model.md`, "Customer cancel"). **After a successful cancel the bot must drop its own pending record of the legacy row for that decision and ignore any later outcome of `GET /chatbot-api/human-decisions/:id` for it.** Staff may still resolve the legacy row afterwards (a stock decision, or a zone resolved for other customers), and that poll then answers `RESOLVED`; the customer withdrew, so the bot sends nothing. Example: the customer asks for stock of croquetas, the bot creates the request (`legacy.id = "hd-1"`), the customer says "ya no", the bot cancels (`200`) and deletes its `hd-1` tracking; ten minutes later staff answers `hd-1` and the poll returns `RESOLVED`; the bot ignores it and does not call `application-outcome` for it.
- A cancelled request leaves the inbox group and sends no message to the customer.

## Route budgets (R2)

Counters live in PostgreSQL (`service_rate_buckets`), so every replica shares them: one counter per (credential, class), a window of 60 s that opens at its first request.

| Class | Used by | Default per minute | Override |
| --- | --- | --- | --- |
| `default` | the other chatbot-api routes that existed before this contract (catalog, customers, checkout, shipping quotes, receipts…) | the credential's `rateLimit` (60) | `rateLimits.default`, else `rateLimit` |
| `humanDecisions` | the stock, expiration and delivery-zone routes: `POST /chatbot-api/human-decisions`, `GET /chatbot-api/human-decisions/:id`, `POST …/:id/application-outcome` | the credential's `rateLimit` (60) | `rateLimits.humanDecisions`, else `rateLimit` |
| `write` | `POST /chatbot-api/requests`, `…/:id/cancel` | 300 | `rateLimits.write` |
| `read` | reserved for the read routes (slice 5b+) | 300 | `rateLimits.read` |
| `feed` | reserved for the feed long-poll (slice 5b); never spends `write` or `read` | 120 | `rateLimits.feed` |

`humanDecisions` and `default` have the same budget but **separate counters**: spending one never uses the other (owner decision M1), so stock and expiration traffic cannot starve the catalog and checkout routes, nor the reverse.

`ServiceCredential.rateLimits` is optional JSON mapping a class name to a per-minute budget, e.g. `{"write": 600, "humanDecisions": 120}`. Any class can be overridden, `default` and `humanDecisions` included; a missing, non-numeric or non-positive value (valid: integers 1..9,999,999) falls back to the class default above. The defaults are sized for 60 inbound messages per minute per branch with headroom (proposal §6.4, §11.1) and are measured in the pilot.

The window is measured by the database clock, not by the backend replica's, so replicas with skewed clocks cannot shorten each other's windows; `Retry-After` is the time left in the window, rounded up to whole seconds.

Behavior note: the old in-memory limiter was a sliding window per process; the shared one is a fixed window anchored at the first request, so a burst across a window edge can reach up to twice the budget. The count and the limit per minute are unchanged.
