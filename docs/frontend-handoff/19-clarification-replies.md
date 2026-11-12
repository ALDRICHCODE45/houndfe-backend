# Chatbot request inbox — answering a clarification: `POST /chatbot-requests/:id/reply`

**Status:** implemented on `feat/human-intervention` (human-intervention unit 10), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §2.2, §3.8, §3.10, §4.5, §6.2, §6.4, §12.6, §12.12 and the v1.8 note (§19). Same command rules as handoff 11 (headers, `expectedVersion`, error envelope, retry recipe): read it first.

A **clarification** (`kind = CLARIFICATION`, subtype `UNKNOWN_QUESTION`: a customer question the bot could not answer) is answered with `reply`. The reply **closes the request** and the bot relays the text to the customer on WhatsApp. `resolve` is only for decisions (`422 ACTION_NOT_ALLOWED` on a clarification) and conversations are closed with `finish` (unit 11).

## 1. The command

`POST /chatbot-requests/:id/reply`

| | |
| --- | --- |
| Permission | `read:ChatbotRequest` + `update:ChatbotRequest` |
| Who | The **assignee**, or **anyone with the permission when the request is `NEW`**: replying to a `NEW` clarification **claims it for you and resolves it in one step** (owner decision S13, like `resolve` does for decisions; no separate `claim` needed). A request held by **someone else** can only be answered by its holder: `403 NOT_ASSIGNEE`, with no override (not even `update:ChatbotRequestAssignment`) |
| Headers | `Idempotency-Key: <uuid>` (required), JWT |
| Body | `{ "expectedVersion": 2, "text": "Sí, es apto desde las 8 semanas." }`, nothing else (unknown fields are `400`) |

`text` rules (contract §6.4: ≤ 1500):

- 1 to **1500 characters** after cleaning (emoji count as one character, like WhatsApp). Empty or blank is `400 VALIDATION_ERROR`.
- Leading and trailing whitespace is trimmed; control characters and bidi override marks are removed; line breaks and tabs stay.
- It is **plain text**: `<b>x</b>` is stored and delivered as those characters. Render it as text, never as HTML.
- The error never echoes the text.

Response: `200 {request}`, the same small view as the other commands:

```json
{ "request": { "id": "2b7c…", "folio": "S-000123", "kind": "CLARIFICATION", "subtype": "UNKNOWN_QUESTION",
  "status": "RESOLVED", "displayStatus": "RESOLVED", "version": 3,
  "assignee": { "id": "8d6f…", "displayName": "Ana" }, "claimedAt": "…", "overdueAt": null, "closedAt": "2026-11-12T16:00:00.000Z" } }
```

`status` becomes `RESOLVED` and `version` + 1 in one transaction (on a `NEW` request `assignee` is you in the response, and the audit has **one** event, `REPLIED` from `NEW` to `RESOLVED`: no separate `CLAIMED`, exactly like `resolve`), together with the audit event and the delivery for the bot (so there is never a resolved clarification without its delivery, or the other way round). A replay of the same key and body answers the same stored body; the same key with another `text` is `409 IDEMPOTENCY_CONFLICT`.

### Errors (order of checks)

`404 NOT_FOUND` → `409 REQUEST_CLOSED` → `422 ACTION_NOT_ALLOWED` (a decision or a conversation) → `403 NOT_ASSIGNEE` (held by someone else; `current.claimedBy` names the holder) → `409 VERSION_CONFLICT` (with `current`). Plus `400 VALIDATION_ERROR` (key, version or text), `401`, `403 INSUFFICIENT_PERMISSIONS`, `403 FORBIDDEN`, `409 IDEMPOTENCY_CONFLICT`. Switch on `code`.

**Two people replying to the same `NEW` request at once:** one wins; the other gets `409 REQUEST_CLOSED` (or `409 VERSION_CONFLICT` if they were fast enough to see a version bump). If someone `claim`s it first, a reply from another person is `403 NOT_ASSIGNEE` with `current.claimedBy`.

**The 24 h window never blocks a reply.** Unlike a live message (unit 11, `409 WINDOW_CLOSED`), a reply is accepted at any time: if the customer's window is closed, the bot holds the delivery and sends it when the customer writes again. The request is `RESOLVED` already; only the delivery waits (section 3).

## 2. `REPLY` in `allowedActions` / `deniedActions`

Rows (groups, by-customer list, history, other open rows, merge candidates) and the detail include `REPLY` in `allowedActions`, between `RESOLVE`'s slot and `MERGE`/`CANCEL` (order: `CLAIM, RELEASE, REASSIGN, RESOLVE, REPLY, MERGE, LINK_CUSTOMER, CANCEL`):

| Caller | Request | `REPLY` is |
| --- | --- | --- |
| has `update:ChatbotRequest` | open clarification **you hold** | allowed |
| has `update:ChatbotRequest` | `NEW` clarification | allowed (the reply claims it for you; the row's `CLAIM` stays offered too) |
| has `update:ChatbotRequest` | open clarification held by someone else (also for a manager) | denied `NOT_ASSIGNEE` |
| no `update:ChatbotRequest` | any open clarification | denied `INSUFFICIENT_PERMISSIONS` |
| anyone | a decision, a conversation, a closed request | in neither list |

The codes are the ones the command answers. A `NEW` clarification row carries no `REPLY` denial any more (S13); `NOT_ASSIGNEE` only appears on rows held by someone else.

## 3. What the customer gets, and what you can show

The detail gets an additive key **`reply`** (`null` until a clarification is answered, and always `null` for other kinds):

```json
"reply": { "id": "7d1f0c52-…", "text": "Sí, es apto desde las 8 semanas.",
           "repliedBy": { "id": "8d6f…", "displayName": "Ana" }, "repliedAt": "2026-11-12T16:00:00.000Z" }
```

`reply.text` is kept as long as the request (it is not deleted with the 12-month conversation purge; contract §3.6). The audit never holds the text (section 5).

`deliveries[]` of the detail shows the delivery of the answer (`type: "request.answered"`):

| `outcome` | What it means for the screen |
| --- | --- |
| `PENDING` | The bot has not reported yet |
| `PROVIDER_ACCEPTED` | WhatsApp accepted the message |
| `DEFERRED_WINDOW_CLOSED` | The customer's 24 h window was closed: the answer is **saved and will be sent when the customer writes again**. Show "Pendiente: se enviará cuando el cliente escriba" |
| `DEFERRED_HUMAN_SESSION` | The conversation is in a human session: held until it ends |
| `DELIVERY_UNKNOWN` | The bot cannot tell whether it was sent (`needsReconciliation: true`, "entrega dudosa") |
| `STALE` | Nothing was sent (the bot decided not to) |

`providerStatus` (sent/delivered/read/failed) stays `null` there; the message status arrives on the mirrored message (below).

## 4. In the conversation

When the bot has sent the answer it reports it to the conversation mirror (bot handoff, `staffReplyId`). Then `GET /chatbot-requests/:id/conversation` shows it as a normal staff message of that conversation:

```json
{ "id": "7d1f0c52-…", "seq": 12, "direction": "OUT", "author": "STAFF", "staff": { "id": "8d6f…", "displayName": "Ana" },
  "type": "TEXT", "text": "Le comparto la respuesta del equipo: Sí, es apto desde las 8 semanas.",
  "clientMessageId": "7d1f0c52-…", "deliveryStatus": "SENT", … }
```

- `id` and `clientMessageId` are the **reply's id** (`reply.id`; the `messageId` of the `REPLIED` audit event), so you can match the message to the reply. `text` is what the bot actually sent (the bot may word the team prefix in the customer's tú/usted).
- **It appears only after the bot sent it.** A deferred answer is not in the conversation until it is really delivered. Before that, `reply.text` and the delivery state are the source.
- A clarification **without** a `conversationRef` has no conversation of its own: `GET /chatbot-requests/:id/conversation` stays empty for it even after the bot sent the answer (the message is stored in the chat the bot sent it to, and shows in that chat's other requests). Keep showing `reply.text` and the delivery state for it.
- Live updates: the `conversation.message` event of that message goes to the request that was answered too (even though it is closed now), and `message.status` follows (`SENT → DELIVERED → READ`).

## 5. Audit and realtime

- Audit: `REPLIED` (`USER`), `data: { "messageId": "<reply id>" }`, `fromStatus: IN_PROGRESS`, `toStatus: RESOLVED`. **No text.** Later, `DELIVERY_OUTCOME` events (`SERVICE`) record each delivery attempt (`DEFERRED_WINDOW_CLOSED`, then `PROVIDER_ACCEPTED`, ...).
- Realtime (`GET /realtime/stream`): the reply is announced as **`request.resolved`**, exactly as a resolve (`payload.cause` is `REPLIED` in the log; the event the browser gets is the same `request.resolved` with the full row). Apply it like any other (version greater or equal). Delivery outcomes are not announced.
- No notification is created for a reply or for a deferred delivery (the contract defines none). The assignee is the one who replied; nobody else is told.

## 6. Not in this unit

`messages`, `template` (and `templateCostText`, `requiresTemplateAtStart`), `finish`, `reschedule`: units 11 and 14.
