# Chatbot request inbox — the read routes (groups, counts, detail, history)

**Status:** implemented on `feat/human-intervention` (human-intervention unit 4, slice 4a), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §3.8, §3.10, §6.3, §12.3, §12.4, §12.6, §12.11, R12.

Shapes in this document come from the controller, the DTOs, the service and the PostgreSQL integration spec `chatbot-request-reads.integration.spec.ts` (`src/chatbot-requests/**`). Nothing was sent to the dev API. Commands (claim, release, reassign, cancel, resolve) are in handoffs 11 and 12; this document is only the reads.

**Not in this slice** (fields keep their final shape, with the value in the second column for now):

| Contract item | Today |
| --- | --- |
| `liveSession` | always `null` (live conversations are unit 11) |
| `unreadCustomerMessages` | always `0` (conversation mirror is unit 9) |
| `slaPaused`, `slaResumesAt` | `false`, `null` (working-hours calendar is unit 7) |
| `claimDeadlineAt`, `resolveDeadlineAt`, `overdueAt` | filled only when a deadline exists; the sweep that sets them is unit 7, so most rows have `null` today |
| `scheduledFor`, `requiresTemplateAtStart`, `needsReschedule` | `null`/`false` (scheduling is unit 14) |
| `templateCostText` in the detail | not sent (it only comes with `SEND_TEMPLATE`, unit 11) |
| `GET /chatbot-requests/:id/conversation`, media | unit 9 |
| `assignable-users`, `reply`, `messages`, `template`, `finish`, `reschedule`, `merge`, `link-customer` | not built yet |
| `q` (free-text search) on `groups` and `history` | not supported: it answers `400` like any unknown parameter |
| The `200 {request}` of the commands (handoffs 11 and 12) | still the small shape (no phone, no `customerKey`); the full row arrives with the SSE unit |

## 1. Who can do what

Same guards as the commands: `JWT → tenant → active user → CASL`, so the caller also needs a membership in the sucursal. All responses are `Cache-Control: no-store`.

| Route | CASL required |
| --- | --- |
| `GET /chatbot-requests/groups` | `read:ChatbotRequest` |
| `GET /chatbot-requests?customerKey=` | `read:ChatbotRequest` |
| `GET /chatbot-requests/counts` | `read:ChatbotRequest` |
| `GET /chatbot-requests/history` | `read:ChatbotRequest` |
| `GET /chatbot-requests/:id` | `read:ChatbotRequest` |
| `GET /chatbot-requests/:id/audit` | `read:ChatbotRequest` |
| `GET /chatbot-requests/:id/merge-candidates` | `read:ChatbotRequest` + `update:ChatbotRequest` |
| `GET /chatbot-requests/:id/zone-impact` | `read:ChatbotRequest` (handoff 12) |

A request of another sucursal answers `404`, the same as a missing one.

## 2. The phone and `customerKey` (R12)

**The backend decides what a phone looks like; never mask or unmask in the frontend.**

- `customer.phone` (groups and detail) is `"55 **** 5678"` (area code and last four digits) unless the caller has `read:CustomerPhone`, in which case it is the full E.164 number with a plus: `"+525512345678"`. It is `null` when the request has no phone (old rows). A very short national number shows only its last two digits (`"**** 56"`).
- **`customerKey` is opaque.** The contract example (§12.4) shows `"525512345678"`, but that is the phone, so it would leak the full number to a Cashier. The API returns a token (`"k1.…"`) instead, **for every caller** (also those with `read:CustomerPhone`), so the frontend groups and caches by it whatever the role. It is deterministic (the same customer always has the same token in a sucursal), bound to the sucursal, and only valid for the sucursal that issued it. Send it back unchanged in `?customerKey=`. Never parse it, and never build one.
- **Contract deviation (v1.2, recorded in proposal §3.8 and §12.4).** The contract examples show the raw key; the API never sends it, because of D11/R12. Tell your SSE and cache code too: every row and every `previousCustomerKey` (unit 8) uses the same token, so a row from `groups`, from `?customerKey=` and from an event with the same customer share one `customerKey`.
- Cursors do not contain the phone or the raw key either (they carry the same token).
- A `customerKey` or cursor that is not a token of the current sucursal (altered, from another sucursal, or issued before a server secret rotation) answers `400 VALIDATION_ERROR`. After a `400` on a stored key, **reload the list** and use the new tokens; do not retry with the same value. **Rotating the server secret (`JWT_SECRET`) invalidates every token**, which shows up as that `400` (a reload fixes it; nothing leaks).
- Where the full number appears with the permission: `customer.phone` of the group and of the detail. Nowhere else.

## 3. The row

The same row is used by `groups`, `?customerKey=`, `history`, `otherOpenRequests` and `merge-candidates`:

```json
{
  "id": "…", "folio": "S-000123", "customerKey": "k1.…",
  "kind": "DECISION", "subtype": "RESTOCK",
  "status": "IN_PROGRESS", "displayStatus": "EXPIRED", "summary": "…",
  "assignee": { "id": "…", "displayName": "Ana" },
  "createdAt": "2026-11-09T17:00:00.000Z",
  "claimDeadlineAt": null, "resolveDeadlineAt": "2026-11-10T15:00:00.000Z", "overdueAt": "2026-11-10T15:00:00.000Z",
  "slaPaused": false, "slaResumesAt": null,
  "whatsappWindowClosesAt": null, "unreadCustomerMessages": 0,
  "scheduledFor": null, "requiresTemplateAtStart": false, "needsReschedule": false,
  "liveSession": null,
  "closedAt": null, "resolvedBy": null,
  "version": 4
}
```

- `kind`: `DECISION | CLARIFICATION | CONVERSATION`. `subtype`: `RESTOCK | EXPIRATION | DELIVERY_ZONE | TRANSFER_RECEIPT | TALK_TO_HUMAN | COMPLAINT | UNKNOWN_QUESTION | DISCOUNT`. `status`: `NEW | IN_PROGRESS | RESOLVED | CANCELLED`. `displayStatus` is `EXPIRED` for an open request with `overdueAt`, else the status.
- `closedAt` and `resolvedBy {id, displayName}` (additive to the contract row) are set on closed rows; `resolvedBy` is `null` for a cancelled one. `summary` is bot text: show it as text, never as HTML.
- `version` is the value to send as `expectedVersion` in the commands.
- Dates are ISO UTC strings.

## 4. `GET /chatbot-requests/groups`

Query (all optional; unknown parameters are `400`):

| Parameter | Values | Default |
| --- | --- | --- |
| `status` | `open`, `resolved`, `cancelled`, `scheduled` | `open` |
| `subtype` | any `subtype` | all |
| `assignee` | `me`, `unassigned` (alias `none`), or a user id (UUID) | all |
| `overdue` | `true` / `false` | not filtered |
| `windowClosingSoon` | `true` / `false` (WhatsApp window closes within the next 2 hours) | not filtered |
| `cursor` | the `nextCursor` of the previous page | first page |
| `limit` | 1–50 | 25 |

```json
{
  "items": [
    {
      "customerKey": "k1.…",
      "customer": { "id": "…", "displayName": "Juan Pérez", "phone": "55 **** 5678", "isTrusted": false },
      "mostUrgentAt": "2026-11-09T17:00:00.000Z",
      "openCount": 3,
      "requests": [ /* up to 10 rows (section 3) */ ],
      "moreRequests": 0
    }
  ],
  "nextCursor": "…"
}
```

- **Order of the groups:** `mostUrgentAt` ascending (overdue first, because their deadline is in the past), groups with no deadline last, then by customer. The order is stable for the cursor, so pages never repeat a group.
- **Inside a group:** the nearest deadline first (`NULL` last), then `createdAt`, then `id`. Up to 10 rows; `moreRequests` is how many matching rows are left. Page the rest with `GET /chatbot-requests?customerKey=` (section 5).
- With a filter (`subtype`, `assignee`, `overdue`, `windowClosingSoon`, or the `scheduled` tab), a group appears only if it has a matching open request, and `requests` and `moreRequests` count only the matching ones. `openCount` is always the customer's open total.
- `customer.id` and `displayName` are `null` for a customer that is not linked to a `Customer` (the phone is the only identity); show the masked phone.
- **`status=resolved` and `status=cancelled`** show only requests closed in the **last 7 days** (D17). These groups are ordered by the latest closing, have `openCount: 0`, `mostUrgentAt: null` and an extra `lastClosedAt`, and their rows are ordered by `closedAt` descending. Filters apply to them too (`assignee` is the person who held it).
- `status=scheduled` lists open conversations with a `scheduledFor` (none exist until unit 14).
- Window rule, exactly: a closed request belongs to the inbox while `closedAt >= now − 7 days` and to the history from `closedAt < now − 7 days`. The two lists never overlap and never skip a request.

## 5. `GET /chatbot-requests?customerKey=`

`customerKey` (the token from a group) is **required**: without it, `400 VALIDATION_ERROR`. Optional `status` (same values and 7-day rule as `groups`, default `open`), `cursor`, `limit` (1–50, default 25).

```json
{ "items": [ /* rows (section 3) */ ], "nextCursor": "…" }
```

Order is the same as inside a group (open: nearest deadline, then `createdAt`, `id`; closed tabs: `closedAt` descending). Use it for "Ver las N restantes".

## 6. `GET /chatbot-requests/counts`

```json
{ "new": 7, "inProgress": 4, "mine": 2, "overdue": 1, "windowClosingSoon": 3, "scheduled": 0, "needsReschedule": 0 }
```

All counts are over open requests of the current sucursal. `new` and `inProgress` are by status; `mine` is the caller's `IN_PROGRESS` requests; `windowClosingSoon` uses the same 2-hour window as the filter. `new`/`inProgress` include scheduled requests.

## 7. `GET /chatbot-requests/history`

Closed requests (`RESOLVED` or `CANCELLED`) with `closedAt` **older than 7 days**, newest first (`closedAt` descending, then `id`), flat, no groups, no actions.

| Parameter | Values |
| --- | --- |
| `subtype` | any `subtype` |
| `resolvedBy` | user id (UUID) of who resolved it |
| `customerKey` | a token from a group or row |
| `from`, `to` | ISO dates or instants; `closedAt >= from` and `closedAt < to`. **They go together** (one without the other is `400 VALIDATION_ERROR`, as is `to <= from`). Their span is at most **92 days**, otherwise `400 RANGE_TOO_LARGE` |
| `cursor`, `limit` | as above (limit 1–50, default 25) |

```json
{ "items": [ /* rows (section 3) */ ], "nextCursor": "…" }
```

Open the detail with `GET /chatbot-requests/:id`.

## 8. `GET /chatbot-requests/:id`

The row (section 3) plus:

```json
{
  "needs": null,
  "context": null,
  "customer": {
    "id": "…", "displayName": "Juan Pérez", "phone": "55 **** 5678",
    "customerSince": "2025-03-02T10:00:00.000Z", "isTrusted": true,
    "priceList": { "id": "…", "name": "Mayoreo" },
    "recentOrders": [
      { "saleId": "…", "folio": "V-1", "createdAt": "…", "totalCents": 12300, "status": "CONFIRMED", "paymentStatus": "PAID" }
    ]
  },
  "otherOpenRequests": [ /* up to 20 rows of the same customer, open, not this one */ ],
  "decision": { "subtype": "RESTOCK", "snapshot": { "…": "…" }, "resolution": null },
  "zoneImpact": { "validationId": "…", "requests": 4, "customers": 3, "setVersion": 7 },
  "deliveries": [
    { "deliveryId": "…", "type": "request.answered", "createdAt": "…", "outcome": "PENDING",
      "attemptedAt": null, "providerStatus": null, "needsReconciliation": false }
  ],
  "audit": [
    { "id": "…", "type": "CLAIMED", "createdAt": "…",
      "actor": { "kind": "USER", "id": "…", "displayName": "Ana" },
      "fromStatus": "NEW", "toStatus": "IN_PROGRESS", "version": 2, "data": {} }
  ],
  "auditNextCursor": null,
  "allowedActions": ["CLAIM", "RESOLVE"]
}
```

- `needs` and `context` are bot-untrusted text/JSON: show as text.
- `customer.id = null` and `displayName = null` when no customer is linked; `recentOrders` is then `[]`, `priceList` `null`, `isTrusted` `false`. `recentOrders` are the last five confirmed or canceled sales of the customer, newest first (drafts are not shown).
- **`decision`** is `null` for `CLARIFICATION` and `CONVERSATION`. For decisions it is discriminated by `subtype`:

  | `subtype` | Shape |
  | --- | --- |
  | `RESTOCK` | `{subtype, snapshot {branchName, productId, productName, variantId, sku, requestedQuantity, observedStockAtRequest, stockObservedAt}, resolution}` |
  | `EXPIRATION` | `{subtype, snapshot {branchId, branchName, productId, productName, unit, variantId, variantName, variantOption, variantValue}, resolution}` |
  | `DELIVERY_ZONE` | `{subtype, validationId, zipCode, state, municipality, neighborhood, requesterCount, lastCustomerMessageAt, resolution}`; `requesterCount` counts every requester of the validation (also resolved and cancelled ones; `validationId` is `null` and the count 1 when the request has no validation); `lastCustomerMessageAt` is this request's own |
  | `TRANSFER_RECEIPT` | `{subtype, receiptId, saleId, saleFolio, declaredAmountCents, declaredAmountProvided, declaredDate, declaredReference, saleTotalCents, salePaidCents, saleDebtCents, file {mimeType, sizeBytes, previewStatus, originalUrl, previewUrl} \| null, extracted, mismatch, resolution}`; the file URLs are the existing `/sales/:id/receipts/:rid/file` and `/preview` routes (`null` once purged) |

  `resolution` is `null` while open; after a resolve it is the chosen option with its parameters, plus `resolvedBy {id, displayName}` and `resolvedAt` (for example `{action: "PROVIDE_RESTOCK_ESTIMATE", restockDays: 7, resolvedBy, resolvedAt}`). It is also `null` on a request closed by a customer or staff cancel. The customer's phone and conversation reference of the wrapped tables are never in it.
- **`zoneImpact`** exists only on `DELIVERY_ZONE` that has a validation (same value as `GET …/zone-impact`, including `validationId`; send its `setVersion` as `expectedZoneSetVersion` when resolving). `requests` and `customers` count only the **open** requesters (what resolving would settle), while `decision.requesterCount` counts **every** requester of the validation, whatever its state, like the old zone screen.
- **`deliveries[]`** are the answers queued for the bot, newest first (at most 50): `outcome` is `PENDING` until the bot reports, then `PROVIDER_ACCEPTED | DELIVERY_UNKNOWN | DEFERRED_WINDOW_CLOSED | DEFERRED_HUMAN_SESSION | STALE`. `needsReconciliation` is true for `DELIVERY_UNKNOWN` (the "entrega dudosa"). `providerStatus` is `null` until the statuses unit.
- **`audit[]`** is the 20 most recent events, newest first. `actor.kind` is `USER | SERVICE | SYSTEM` (for `SYSTEM`, `id` and `displayName` are `null`). `data` is small and never customer text (except the `customerNote` that staff wrote on a cancel). More: `GET …/audit?cursor=` with `auditNextCursor`.
- **`allowedActions`** is computed by the server from the state machine, the caller's permissions and whether the caller is the assignee. Offer a button only if its action is in the list; the command can still answer `409` if the request changed meanwhile. Today it can contain `CLAIM`, `RELEASE`, `REASSIGN`, `RESOLVE`, `CANCEL`:

  | Action | Offered when |
  | --- | --- |
  | `CLAIM` | `update:ChatbotRequest`, request `NEW` |
  | `RELEASE` | `update:ChatbotRequest`, request `IN_PROGRESS`, and it is yours or you also have `update:ChatbotRequestAssignment`; not for a live conversation |
  | `REASSIGN` | `update:ChatbotRequestAssignment`, request `IN_PROGRESS` |
  | `RESOLVE` | `update:ChatbotRequest` **and** the legacy permission of the subtype (`update:HumanDecision` for stock and expiry, `validate:DeliveryZone`, `update:ReceiptEvidence`), `kind = DECISION`, open and not held by someone else; for `DELIVERY_ZONE` also only when it has a validation (without one the resolve route answers `404`) |
  | `CANCEL` | `update:ChatbotRequest`, open, not a `DECISION`, and (if held by someone else) you have `update:ChatbotRequestAssignment` |

  `RESCHEDULE`, `REPLY`, `SEND_MESSAGE`, `SEND_TEMPLATE`, `FINISH`, `FINISH_IDLE`, `MERGE` and `LINK_CUSTOMER` are **never** in the list yet: their routes do not exist. A read-only user always gets `[]`. Examples: a Manager on a new restock request gets `["CLAIM","RESOLVE"]`; a Cashier gets `["CLAIM"]`; the Cashier who claimed an `UNKNOWN_QUESTION` gets `["RELEASE","CANCEL"]`.

## 9. `GET /chatbot-requests/:id/audit`

`?cursor=&limit=` (limit 1–50, default 50) → `{items, nextCursor}`, same event shape as `audit[]`, newest first.

## 10. `GET /chatbot-requests/:id/merge-candidates`

`{ "items": [ /* rows */ ] }`: up to 20 open requests of the same customer and the same subtype, nearest deadline first, only for `UNKNOWN_QUESTION`, `TALK_TO_HUMAN` and `COMPLAINT` (never for decisions). Empty when the request is closed or not mergeable: hide "Unir con…". The merge command is not built yet.

## 11. Errors

Same envelope as handoff 11: `{statusCode, code, message}`.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Unknown or malformed parameter, missing `customerKey` in the customer list, a `limit` outside 1–50, a malformed or foreign `cursor`/`customerKey` (also a cursor with a date that is not a real instant or an id that is not a UUID), `from`/`to` outside the years 1900–9999, `from`/`to` not together or reversed, `:id` that is not a UUID |
| `400` | `RANGE_TOO_LARGE` | `from`/`to` span more than 92 days |
| `401` | `UNAUTHORIZED` | No JWT, or the user is inactive |
| `403` | `FORBIDDEN` | No membership in the sucursal |
| `403` | `INSUFFICIENT_PERMISSIONS` | Missing `read:ChatbotRequest` (or `update:ChatbotRequest` on merge candidates) |
| `404` | `NOT_FOUND` | The request does not exist or belongs to another sucursal |

## 12. Performance (for the record)

Measured with 5,000 open requests over ~2,000 customers plus 20,000 closed and two noise sucursales: a page of 25 groups p95 **6.9 ms** (target < 200 ms), every page of a full walk p95 9.4 ms, counts 2 ms, detail 4.2 ms, history 1.7 ms. See `docs/perf/chatbot-inbox-load-results.md`.
