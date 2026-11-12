# Chatbot request inbox — the read routes (groups, counts, detail, history, assignable users)

**Status:** implemented on `feat/human-intervention` (human-intervention unit 4, slices 4a and 4b), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §3.8, §3.10, §6.3, §12.3, §12.4, §12.6, §12.11, R12.

Shapes in this document come from the controller, the DTOs, the service and the PostgreSQL integration spec `chatbot-request-reads.integration.spec.ts` (`src/chatbot-requests/**`). Nothing was sent to the dev API. Commands (claim, release, reassign, cancel, resolve) are in handoffs 11 and 12; this document is only the reads.

**Not in this slice** (fields keep their final shape, with the value in the second column for now):

| Contract item | Today |
| --- | --- |
| `liveSession` | always `null` (live conversations are unit 11) |
| `unreadCustomerMessages` | always `0` (conversation mirror is unit 9) |
| `slaPaused`, `slaResumesAt` | derived on every read (unit 7c): `slaPaused` is `true` when the tenant's calendar is closed **now** (outside the opening hours or a closed date) **and** the request is open; `slaResumesAt` is then the next opening (ISO), else `null`. Closed requests are never paused. It is computed per response, so it changes without the row changing: do not use it to order or to detect updates |
| `claimDeadlineAt`, `resolveDeadlineAt`, `overdueAt` | `claimDeadlineAt`/`resolveDeadlineAt` filled when the subtype has a deadline; `overdueAt` is set by the SLA sweep (every 30 s) at the **deadline instant** of the first overdue and never cleared (`displayStatus` `EXPIRED`). The sweep does not change `version` (it is not a command), so a row can gain `overdueAt` without a new `version` until the realtime event of unit 8 |
| `scheduledFor`, `requiresTemplateAtStart`, `needsReschedule` | `null`/`false` (scheduling is unit 14) |
| `templateCostText` in the detail | not sent (it only comes with `SEND_TEMPLATE`, unit 11) |
| `GET /chatbot-requests/:id/conversation`, media | unit 9 |
| `reply`, `messages`, `template`, `finish`, `reschedule` | not built yet (`merge` and `link-customer` are in handoff 11, `assignable-users` in section 13 below) |
| `q` (free-text search) on `history` | not supported: it answers `400` like any unknown parameter (`groups` supports it, section 4) |
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
| `GET /chatbot-requests/assignable-users` | `update:ChatbotRequestAssignment` (section 13) |
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
  "version": 4,
  "cancelReason": null, "staffCancelReason": null, "mergedInto": null,
  "slaLevel": "ESCALATION",
  "allowedActions": ["RELEASE", "CANCEL"],
  "deniedActions": [{ "action": "REASSIGN", "code": "INSUFFICIENT_PERMISSIONS" }]
}
```

- `kind`: `DECISION | CLARIFICATION | CONVERSATION`. `subtype`: `RESTOCK | EXPIRATION | DELIVERY_ZONE | TRANSFER_RECEIPT | TALK_TO_HUMAN | COMPLAINT | UNKNOWN_QUESTION | DISCOUNT`. `status`: `NEW | IN_PROGRESS | RESOLVED | CANCELLED`. `displayStatus` is `EXPIRED` for an open request with `overdueAt`, else the status.
- `closedAt` and `resolvedBy {id, displayName}` (additive to the contract row) are set on closed rows; `resolvedBy` is `null` for a cancelled one. `summary` is bot text: show it as text, never as HTML.
- `version` is the value to send as `expectedVersion` in the commands.
- Dates are ISO UTC strings.
- **S8 fields (all additive, v1.3).** Every row of every list now also has `cancelReason`, `staffCancelReason`, `mergedInto`, `slaLevel`, `allowedActions` and `deniedActions`; the detail has the same six (its own `allowedActions` / `deniedActions` can also contain `MERGE` and `LINK_CUSTOMER`). Existing fields and routes did not change. Section 14 has the types and examples.

## 4. `GET /chatbot-requests/groups`

Query (all optional; unknown parameters are `400`):

| Parameter | Values | Default |
| --- | --- | --- |
| `status` | `open`, `resolved`, `cancelled`, `scheduled` | `open` |
| `subtype` | any `subtype` | all |
| `assignee` | `me`, `unassigned` (alias `none`), or a user id (UUID) | all |
| `overdue` | `true` / `false` | not filtered |
| `windowClosingSoon` | `true` / `false` (WhatsApp window closes within the next 2 hours) | not filtered |
| `q` | free text, at most 100 characters: a folio, a customer name, or phone digits (see below) | no search |
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

- **`q` (search).** One box, three modes, picked from what was typed. It combines with `status` and the filters, and keeps the same ordering and cursor.
  - **Folio** — `S-000123`, any case and any zero padding (`s-123` works). It is exact: `S-0001` finds only folio 1, never a prefix. Works for every role.
  - **Customer name** — case and accent insensitive (`maria` finds `María`, `nandu` finds `Ñandú`); each word must be contained in `firstName lastName`, in any order, at most 4 words (`perez maria`). A prefix is just a short word. Only requests **linked to a customer** can match by name (an unlinked request has no name). `%` and `_` are literal.
  - **Phone digits** — digits with optional spaces, dashes, parentheses or `+` (`55 1234-5678`, `1234`), matched as a *contains* over the customer's full number. **Only for callers with `read:CustomerPhone`.** Without it a digits-only `q` finds **nothing at all** (`{"items": [], "nextCursor": null}`, exactly like a miss), so the box cannot be used to find out whether a number is a customer. Text that mixes letters and digits (`maria 0001`) is a name search and never matches a phone.
  - An empty or blank `q` is ignored. A `q` over 100 characters is `400`. The matching group shows only the requests that match (like any filter); `openCount` stays the customer's open total.
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
{ "new": 7, "inProgress": 4, "mine": 2, "overdue": 1, "windowClosingSoon": 3, "scheduled": 0, "needsReschedule": 0,
  "resolved7d": 12, "cancelled7d": 5, "openGroups": 9 }
```

The first seven are over open requests of the current sucursal. `new` and `inProgress` are by status; `mine` is the caller's `IN_PROGRESS` requests; `windowClosingSoon` uses the same 2-hour window as the filter. `new`/`inProgress` include scheduled requests.

**S8 counts (v1.3, additive).** `resolved7d` and `cancelled7d` are the requests with `status = RESOLVED` / `CANCELLED` and `closedAt >= now − 7 days` (wall clock, the instant of the request, **the same window as the `resolved` and `cancelled` tabs of `groups`**, so each number equals the number of requests that tab lists). `openGroups` is the number of customers with at least one open request, i.e. the number of groups of the `open` tab with no filter (the tab filters do not change it). Same permission as the other counts (`read:ChatbotRequest`) and the same answer for every role: counts carry no phone and no per-person data except `mine`, so R12 does not apply. Another sucursal's requests are never counted. They come from the same index-backed statement (history index for the two closed counts, group table for `openGroups`), see `docs/perf/chatbot-inbox-load-results.md`.

## 7. `GET /chatbot-requests/history`

Closed requests (`RESOLVED` or `CANCELLED`) with `closedAt` **older than 7 days**, newest first (`closedAt` descending, then `id`), flat, no groups. Rows have the S8 fields: `allowedActions` and `deniedActions` are always `[]` (a closed request takes no command) and `slaLevel` is `null`; the close cause (section 14.2) is filled.

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
    "ambiguous": false,
    "candidates": [],
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
  "allowedActions": ["CLAIM", "RESOLVE", "LINK_CUSTOMER"]
}
```

- `needs` and `context` are bot-untrusted text/JSON: show as text.
- `customer.id = null` and `displayName = null` when no customer is linked; `recentOrders` is then `[]`, `priceList` `null`, `isTrusted` `false`. `recentOrders` are the last five confirmed or canceled sales of the customer, newest first (drafts are not shown).
- **`customer.candidates[]`** (R1, for `LINK_CUSTOMER`): only while the request is open and has **no** customer. The tenant's customers whose canonical phone is this request's phone (`521…` and `52…` count as the same number; the match is exact in SQL, so a busy sucursal never hides one behind a page), at most 10, oldest first: `{id, displayName, phone, isTrusted, customerSince, lastOrderAt}`. `phone` follows the same mask as everywhere (full only with `read:CustomerPhone`). **`customer.ambiguous`** is `true` when the bot found several customers with that phone and left the request unlinked: the user picks one and sends it to `POST …/link-customer` (handoff 11). It can also hold one customer that was created after the request. It is `[]` once linked, for a closed request and for a legacy request with no phone.
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
- **`allowedActions`** is computed by the server from the state machine, the caller's permissions and whether the caller is the assignee. Offer a button only if its action is in the list; the command can still answer `409` if the request changed meanwhile. Today it can contain `CLAIM`, `RELEASE`, `REASSIGN`, `RESOLVE`, `MERGE`, `LINK_CUSTOMER`, `CANCEL` (in this order):

  | Action | Offered when |
  | --- | --- |
  | `CLAIM` | `update:ChatbotRequest`, request `NEW` |
  | `RELEASE` | `update:ChatbotRequest`, request `IN_PROGRESS`, and it is yours or you also have `update:ChatbotRequestAssignment`; not for a live conversation |
  | `REASSIGN` | `update:ChatbotRequestAssignment`, request `IN_PROGRESS` |
  | `RESOLVE` | `update:ChatbotRequest` **and** the legacy permission of the subtype (`update:HumanDecision` for stock and expiry, `validate:DeliveryZone`, `update:ReceiptEvidence`), `kind = DECISION`, open and not held by someone else; for `DELIVERY_ZONE` also only when it has a validation (without one the resolve route answers `404`) |
  | `MERGE` | `update:ChatbotRequest`, request open, subtype `UNKNOWN_QUESTION`, `TALK_TO_HUMAN` or `COMPLAINT` with no started session, **and** at least one merge candidate (section 10). If it is held by someone else you also need `update:ChatbotRequestAssignment` (the same rule as `CANCEL`) |
  | `LINK_CUSTOMER` | `update:ChatbotRequest`, request open, no customer linked yet, a phone identity (not a legacy `unknown:` request) **and at least one candidate customer** (`customer.candidates` is not empty). Held by someone else does not hide it |
  | `CANCEL` | `update:ChatbotRequest`, open, not a `DECISION`, and (if held by someone else) you have `update:ChatbotRequestAssignment` |

  **`deniedActions`** (S8) is computed by the same evaluation: section 14.4.

  `RESCHEDULE`, `REPLY`, `SEND_MESSAGE`, `SEND_TEMPLATE`, `FINISH` and `FINISH_IDLE` are **never** in the list yet: their routes do not exist. A read-only user always gets `[]`. Examples: a Manager on a new restock request whose phone has no customer gets `["CLAIM","RESOLVE"]`, and `["CLAIM","RESOLVE","LINK_CUSTOMER"]` when a customer with that phone exists; the Cashier who claimed an `UNKNOWN_QUESTION` gets `["RELEASE","CANCEL"]`, plus `MERGE` when that customer has another open question in the same conversation. A Cashier looking at a colleague's request gets neither `MERGE` nor `CANCEL` (a Manager gets both).

## 9. `GET /chatbot-requests/:id/audit`

`?cursor=&limit=` (limit 1–50, default 50) → `{items, nextCursor}`, same event shape as `audit[]`, newest first.

## 10. `GET /chatbot-requests/:id/merge-candidates`

`{ "items": [ /* rows */ ] }`: up to 20 open requests of the same customer, the same subtype and the **same conversation** (`conversationRef`, non-null: a merge across conversations is refused), nearest deadline first, only for `UNKNOWN_QUESTION`, `TALK_TO_HUMAN` and `COMPLAINT` (never for decisions). Empty when the request is closed or not mergeable: hide "Unir con…". The command is `POST /chatbot-requests/:id/merge` (handoff 11); each row's `id` and `version` are the `intoRequestId` and `intoExpectedVersion` it needs.

## 11. Errors

Same envelope as handoff 11: `{statusCode, code, message}`.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Unknown or malformed parameter, missing `customerKey` in the customer list, a `limit` outside 1–50, a malformed or foreign `cursor`/`customerKey` (also a cursor with a date that is not a real instant or an id that is not a UUID), `from`/`to` outside the years 1900–9999, `from`/`to` not together or reversed, `:id` that is not a UUID |
| `400` | `RANGE_TOO_LARGE` | `from`/`to` span more than 92 days |
| `401` | `UNAUTHORIZED` | No JWT, or the user is inactive |
| `403` | `FORBIDDEN` | No membership in the sucursal |
| `403` | `INSUFFICIENT_PERMISSIONS` | Missing `read:ChatbotRequest` (or `update:ChatbotRequest` on merge candidates, or `update:ChatbotRequestAssignment` on `assignable-users`) |
| `404` | `NOT_FOUND` | The request does not exist or belongs to another sucursal |

## 13. `GET /chatbot-requests/assignable-users`

The picker for `reassign`. Needs only `update:ChatbotRequestAssignment`.

```json
{ "items": [ { "id": "8d6f…", "displayName": "Ana López" } ] }
```

- Only `{id, displayName}`: **no email, no phone.** `displayName` is the user's name (the email's local part if the name is empty). Sorted by `displayName`.
- Who is in the list is exactly who `POST …/reassign` accepts, because both use one rule: an **active** user with a membership in this sucursal whose roles grant `read` **and** `update` on `ChatbotRequest`. `manage` counts. The two grants may come from different roles of the same person (read from one, update from another). Inactive users, members of other sucursales and users with only `read` or only `update` are not listed, and `reassign` answers `422 USER_NOT_ASSIGNABLE` for them.
- The list does not exclude the caller or the current assignee (`reassign` to the current assignee answers `422 ACTION_NOT_ALLOWED`; filter it in the UI). Tenant-wide, one page (the people who attend requests are few).

## 14. S8 additions (v1.3): what the rows and the detail now carry

Owner decisions of 2026-11-11 (inbox gaps). Everything here is **additive**: no existing field, route or status code changed. The same six fields are on every row (`groups`, `?customerKey=`, `history`, `otherOpenRequests`, `merge-candidates`) and on the detail.

| Field | Type | Null / empty |
| --- | --- | --- |
| `allowedActions` | `AllowedAction[]` | `[]` for a closed request or a caller with no right |
| `deniedActions` | `{action, code}[]` | `[]` when nothing applies |
| `cancelReason` | `"CUSTOMER_WITHDREW" \| "SUPERSEDED" \| "AUTO_RESOLVED" \| "STAFF"` | `null` for open and for resolved requests |
| `staffCancelReason` | `"DUPLICATE" \| "NOT_ACTIONABLE" \| "CUSTOMER_UNREACHABLE" \| "OTHER"` | `null` unless `cancelReason = "STAFF"` |
| `mergedInto` | `{id: string, folio: "S-000123"}` | `null` unless `cancelReason = "SUPERSEDED"` by a staff merge |
| `slaLevel` | `"OK" \| "HALF" \| "ESCALATION" \| "OVERDUE"` | `null` for a closed request, when the active clock has no deadline (and no `overdueAt`), or when the tenant's calendar cannot be read (and no `overdueAt`) |

### 14.1 Actions on every row (`allowedActions`)

The server computes it from **the row's own state and the caller's abilities**, with no extra query per row, using the same rules as the detail (one function, the state machine): section 8 lists when each action is offered. Differences from the detail, on purpose:

- **`MERGE` and `LINK_CUSTOMER` are never in a row.** They need facts only the detail loads (another request that could take this one, a customer with that phone). Open the detail to offer them.
- `RESOLVE` on a `DELIVERY_ZONE` row is offered only if that zone request has a validation, exactly like the detail's `zoneImpact` rule (without one the resolve route answers `404`). A row never guesses: when in doubt it is not offered.
- **A row action can still fail at command time.** The list may be a minute old (another person claimed it, the request closed): the command answers `409` with `current` as always. Treat `allowedActions` as "show the button", not as a promise.

```json
// a Cashier looking at a colleague's open question
{ "allowedActions": [], "deniedActions": [
  { "action": "CLAIM",    "code": "REQUEST_CLAIMED_BY_OTHER" },
  { "action": "RELEASE",  "code": "NOT_ASSIGNEE" },
  { "action": "REASSIGN", "code": "INSUFFICIENT_PERMISSIONS" },
  { "action": "CANCEL",   "code": "NOT_ASSIGNEE" } ] }
```

### 14.2 Why a request closed (`cancelReason`, `staffCancelReason`, `mergedInto`)

| `status` | `cancelReason` | `staffCancelReason` | `mergedInto` | Meaning |
| --- | --- | --- | --- | --- |
| `NEW` / `IN_PROGRESS` | `null` | `null` | `null` | open |
| `RESOLVED` | `null` | `null` | `null` | resolved (see `resolvedBy`) |
| `CANCELLED` | `CUSTOMER_WITHDREW` | `null` | `null` | the customer withdrew it |
| `CANCELLED` | `AUTO_RESOLVED` | `null` | `null` | the chatbot closed it on its own (no staff needed) |
| `CANCELLED` | `STAFF` | one of the four | `null` | staff cancelled it |
| `CANCELLED` | `SUPERSEDED` | `null` | `{id, folio}` | staff merged it into another request (`POST …/merge`) |

- `mergedInto` comes from the source's own `MERGED` audit event; its `id` opens the surviving request. It is `null` (never an error) if a `SUPERSEDED` row has no readable event.
- **Internal notes never appear on a row or in these fields.** The `note` and `customerNote` of a cancel live only in the audit `data` of that event (as before).
- Defensive: `cancelReason` is nullable on a `CANCELLED` row too (nothing writes that today); if it is `null` show "Cancelada" with no cause.

### 14.3 Counts

`resolved7d`, `cancelled7d`, `openGroups`: section 6.

### 14.4 Why an action is missing (`deniedActions`)

For the actions the caller **would see but cannot do right now**. Each entry is only `{action, code}`; the codes are exactly what the command would answer, so the tooltip never disagrees with the server:

| `code` | When | Command that answers it |
| --- | --- | --- |
| `INSUFFICIENT_PERMISSIONS` | The caller lacks the permission of that action (`update:ChatbotRequest`, `update:ChatbotRequestAssignment` for `REASSIGN`, the subtype's legacy permission for `RESOLVE`). **A permission gate always wins over any state code**, like the route guard. | `403 INSUFFICIENT_PERMISSIONS` |
| `REQUEST_CLAIMED_BY_OTHER` | `CLAIM` or `RESOLVE` of a request someone else holds | `409 REQUEST_CLAIMED_BY_OTHER` |
| `NOT_ASSIGNEE` | `RELEASE`, `CANCEL` or (detail) `MERGE` of someone else's request without `update:ChatbotRequestAssignment` | `403 NOT_ASSIGNEE` |
| `CANCEL_NOT_ALLOWED` | `CANCEL` of a decision (decisions are resolved, never cancelled; use `RESOLVE`'s negative option), or while a live session is running | `422/409 CANCEL_NOT_ALLOWED` |

Rules, so you can rely on the list being small and quiet:

- **Bounded:** one entry per action at most (7 actions), never the same action in both lists, same order as `allowedActions`.
- **Only actions that apply to the state.** `RELEASE`/`REASSIGN` of an unclaimed request, `RESOLVE` of a clarification, your own request's `CLAIM` and every action of a closed request are in neither list (nothing to explain).
- **No information beyond what you already see.** Only a code: no holder name (the row already shows `assignee`), no permission name, nothing about other people.
- Rows never carry `MERGE` / `LINK_CUSTOMER` entries (see 14.1); the detail does.
- A read-only user gets `allowedActions: []` and `INSUFFICIENT_PERMISSIONS` for the applicable actions: show the buttons disabled with "no tienes permiso" if the design wants it.

### 14.5 Traffic light (`slaLevel`)

Computed on every read **in business time** (the clock pauses outside the opening hours and on closed dates of the sucursal), from the request's **active clock** (the time to claim while the request is `NEW`, the time to resolve once claimed) with the **same instants the SLA sweep uses for its notices** (50 %, 80 %, 100 %):

| `slaLevel` | When | Colour |
| --- | --- | --- |
| `OK` | less than 50 % of the active window used | green |
| `HALF` | 50 % or more, less than 80 % | amber |
| `ESCALATION` | 80 % or more, not yet at the deadline | red |
| `OVERDUE` | at or after the deadline, **or the request has `overdueAt` set** (it was overdue once) | red **and the «Vencida» chip** |

- The boundary is inclusive, like the sweep's: exactly at 50 % the level is `HALF`. A release restarts the claim window, so the level falls back to `OK` for the next person (unless the request already has `overdueAt`, see below).
- **`claimDeadlineAt` / `resolveDeadlineAt` already include the paused time** (they are absolute instants computed in business time). Show them as they are; do **not** add the pause yourself. While `slaPaused` is `true` show `slaResumesAt` ("se reanuda a las 09:00") and keep the level you were given: it does not advance while paused.
- `null` for a closed request, for an open request whose active clock has no deadline (a live conversation after it was taken: resolves live) **and no `overdueAt`**, and when the sucursal's settings cannot be read (the server logs it once per response and still answers: `slaPaused` is then `false`). Show no light for `null`.
- **`overdueAt` wins.** An open request with `overdueAt` set is always `OVERDUE`, so `slaLevel` agrees with `displayStatus: "EXPIRED"` and with the overdue notice its assignee already received. The mark is never cleared: a request that went overdue while waiting to be taken and is then claimed (or released) stays `OVERDUE` even if its new window (the later resolve deadline, a fresh claim window) has plenty of time left. Without `overdueAt` the level follows the **active** clock as described above. This also holds when the sucursal's settings cannot be read (it needs no calendar).
- Like `slaPaused` it is computed per response, so it changes without the row changing: **do not** use it to order, to detect updates or as a cache key. For ordering keep `mostUrgentAt` and the deadlines.
- The sweep records its notices up to 30 seconds after an instant; `slaLevel` is exact at read time. It never disagrees with a recorded milestone (it can only be ahead of it for a few seconds); the `overdueAt` rule above is the one place it deliberately goes beyond the active clock.

### 14.6 Audit event types (official list)

`audit[].type` is one of the following. `data` is small, never customer text, and keeps these shapes (fields marked `?` are optional). `actor.kind` is `USER` for staff, `SERVICE` for the chatbot and `SYSTEM` for the platform.

| `type` | Actor | `data` |
| --- | --- | --- |
| `CREATED` | `SERVICE` (bot) or `SYSTEM` (backfill/wrapped legacy flows) | `{subtype, sourceRequestId?, triggerWaMessageId?, wrapped?, backfilled?}` |
| `MERGED` | `USER` (staff merge) | source side: `{role: "SOURCE", intoRequestId, intoFolio}`; target side: `{role: "TARGET", sourceRequestId, sourceFolio}`. `intoFolio` / `sourceFolio` are numbers (format as `S-000123`) |
| `CLAIMED` | `USER` | `{}` |
| `RELEASED` | `USER` | `{previousAssignee: {id, displayName}}` |
| `AUTO_RELEASED` | `SYSTEM` | not emitted yet (live conversations, unit 11) |
| `REASSIGNED` | `USER` | `{fromUser: {id, displayName}, toUser: {id, displayName}, note?}` |
| `RESOLVED` | `USER` | `{action, …}`: `action` is the resolve option, `"SIBLING_RESOLVED"` with `viaRequestId` when a shared zone validation closed it, or `{action, via: "LEGACY_ROUTE"}` when the old staff screen resolved it |
| `REPLIED` | `USER` | not emitted yet (conversation, unit 9/11) |
| `TEMPLATE_SENT` | `USER` | not emitted yet (unit 11) |
| `FINISHED` | `USER` | not emitted yet (unit 11) |
| `CANCELLED` | `USER` (staff) or `SERVICE` (customer withdrew) | staff: `{reason, note?, customerNote?}` with `reason` one of the four staff reasons; customer: `{reason: "CUSTOMER_WITHDREW" \| "AUTO_RESOLVED"}`. `note` is internal and `customerNote` is what the bot relays; both are written by staff and shown only here |
| `RESCHEDULED` | `USER` | not emitted yet (scheduling, unit 14) |
| `CUSTOMER_LINKED` | `USER` | `{customerId}` |
| `SLA_MILESTONE` | `SYSTEM` | `{milestone: "HALF" \| "ESCALATION" \| "OVERDUE", clock: "CLAIM" \| "RESOLVE", cycle, dueAt, notice, noticeNotBefore?, customerNotice?}`: `cycle` is the clock's start in ms as a string, `dueAt` the instant the milestone was due, `notice` the notice sent (or `null`), `noticeNotBefore` when staff notices were held until the next opening, `customerNotice` (`SENT` \| `SKIPPED_STALE`) on the first overdue only |
| `DELIVERY_OUTCOME` | `SERVICE` | `{deliveryId, feedType, outcome, attemptId, evidenceHash, ackReceivedAt, needsReconciliation}`: what the bot reported about a queued answer (`outcome` as in `deliveries[]`) |

The order of the table is the order of the contract. A type listed as "not emitted yet" is reserved: handle an unknown `type` by showing a generic line, so a later unit adds events without a release of the frontend.

### 14.7 Examples

A cancelled-by-merge row inside `groups?status=cancelled`:

```json
{ "id": "…", "folio": "S-000041", "status": "CANCELLED", "displayStatus": "CANCELLED",
  "cancelReason": "SUPERSEDED", "staffCancelReason": null,
  "mergedInto": { "id": "9d1c…", "folio": "S-000044" },
  "slaLevel": null, "allowedActions": [], "deniedActions": [] }
```

An open row, three quarters through its window:

```json
{ "id": "…", "folio": "S-000050", "status": "NEW", "claimDeadlineAt": "2026-11-12T16:30:00.000Z",
  "slaPaused": false, "slaResumesAt": null, "slaLevel": "HALF",
  "cancelReason": null, "staffCancelReason": null, "mergedInto": null,
  "allowedActions": ["CLAIM", "CANCEL"], "deniedActions": [] }
```

## 12. Performance (for the record)

Measured with 5,000 open requests over ~2,000 customers plus 20,000 closed and two noise sucursales: a page of 25 groups p95 **6.9 ms** (target < 200 ms), every page of a full walk p95 9.4 ms, counts 2 ms, detail 4.2 ms, history 1.7 ms. See `docs/perf/chatbot-inbox-load-results.md`.

**`q` (slice 4b)**, same data plus 20,000 customers per sucursal (accented Spanish names), p95: folio **1.6 ms**, phone **4–6 ms**, a digits-only `q` without `read:CustomerPhone` **0 ms** (nothing is searched), customer name **89–123 ms** (a short prefix such as `mar` with ~3,700 matching customers is the slowest; a miss 80 ms). The name search has no index: PostgreSQL cannot index a *contains* match without the `pg_trgm` extension, which this database does not use, so it folds accents and case in SQL over the sucursal's customers (~4 µs per customer). Cost grows with the number of customers of one sucursal; measure again past ~100,000 customers.
