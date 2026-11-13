# Notifications API (in-app list, unread badge, preferences)

**Status:** implemented on `feat/human-intervention` (human-intervention unit 6, slice 6a), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §5.1, §5.2, §6.3, §8 (D5, D14). Model and pipeline: `docs/notifications-model.md`.

Shapes in this document come from the controller, DTOs, service and their specs (`src/notifications/**`). Nothing was sent to the dev API.

**Not in this slice:**
- Real time: **built in unit 8** (`notification.created` and `notification.read` over `GET /realtime/stream`, payloads and reconnect rules in `17-realtime-sse.md`). Behind Traefik/Swarm it is **not proven yet** (owner test pending), so keep **polling** `GET /notifications/unread-count` (for example every 30 s and on tab focus) until the owner confirms, and refetch it on connect and on `resync`.
- Notices for claim reminders, escalation and overdue requests: built in unit 7c (see §2 and the `reason` field).
- Notices for the live conversation (units 8 and 11).
- Retention of old notices (90 days) and a "failed notices" admin screen.

## 1. Rules

- Every route uses `JWT → tenant context → active user`. There is **no CASL permission**: each person only ever sees their own notices in the current sucursal. The user and tenant come from the JWT, never from the query or body.
- All responses carry `Cache-Control: no-store`.
- In-app notices **cannot be turned off**. Only email and sound are preferences.
- A notification belongs to one person in one sucursal. Switching sucursal switches the list.

## 2. What produces notices today

| `type` | Who gets it | When |
| --- | --- | --- |
| `REQUEST_CREATED` | Active members with `read` + `update:ChatbotRequest` | A request is created (bot, or a legacy restock/expiration/zone/receipt flow) |
| `REQUEST_REASSIGNED` | The new assignee only | A request is reassigned (not when you reassign to yourself) |
| `REQUEST_CANCELLED` | The assignee, if the request had one | The request **closed under you without your action** (see below) |
| `REQUEST_CLAIM_REMINDER` | Same people as `REQUEST_CREATED` | A `NEW` request reached 50 % of its claim time without being taken |
| `REQUEST_ESCALATION` | Members with `read:ChatbotEscalation`, **plus the assignee** if someone holds the request | 80 % of the active clock («Solicitud por vencer») |
| `REQUEST_OVERDUE` | Same as `REQUEST_ESCALATION` | The deadline passed («Solicitud vencida») |

`REQUEST_CANCELLED` covers every close that was not the assignee's own, and the `title` says which (§5.1: «el cliente canceló o se resolvió solo»):

| Cause | `title` |
| --- | --- |
| The customer cancelled | `El cliente canceló la solicitud` |
| Someone else resolved it (a legacy review route) | `Otra persona resolvió la solicitud` |
| Someone else cancelled it | `Otra persona canceló la solicitud` |
| It was resolved together with others of the same postal code | `Se resolvió junto con otras de su zona` |
| Someone merged it into another request of the same customer | `Otra persona la unió con otra solicitud del cliente` |

Each of those is also a structured `cause` on the item (see §3): `CUSTOMER`, `RESOLVED_BY_OTHER`, `CANCELLED_BY_OTHER`, `SIBLING_RESOLVED`, `MERGED`. `MERGED` is the **source** request of a merge (`POST /chatbot-requests/:id/merge`): it is closed as cancelled (`SUPERSEDED`), the open one is the target, and the person who merged is not told. A row written before causes existed has `cause: null` and its `title` reads as the customer's cancel.

**Held notices.** The SLA notices (`REQUEST_CLAIM_REMINDER`, `REQUEST_ESCALATION`, `REQUEST_OVERDUE`) are held until the sucursal's **next opening** when the milestone falls while it is closed. For a held notice **`createdAt` is the release time** (when the notice appeared), not the moment the deadline was reached. The milestone time is the `dueAt` of the request's audit event `SLA_MILESTONE` (see `14-chatbot-request-inbox.md`). A held notice for a request that closed meanwhile is dropped and never appears.

The person who closed the request is never told, and nobody is told about a request that nobody had taken. There is no email for any of these. A notice appears within about a second of the change, not in the same response.

## 3. Routes

### `GET /notifications?cursor=&limit=20&unread=true`

Newest first. `limit` is 1 to 50 (default 20); `unread=true` returns only unread. Unknown query fields are rejected with `400`.

```json
{
  "items": [
    {
      "id": "6f1d3a2e-0b7c-4e55-9a31-2c7d8e9f0a1b",
      "type": "REQUEST_CREATED",
      "title": "Nueva solicitud",
      "body": "Pregunta sin respuesta · S-000123",
      "requestId": "2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c",
      "createdAt": "2026-11-11T10:03:41.500Z",
      "readAt": null,
      "folio": "S-000123",
      "subtype": "UNKNOWN_QUESTION",
      "cause": null,
      "reason": null,
      "requestOpen": true
    },
    {
      "id": "0c8e5b1a-3d44-4f0e-b2a9-7e6d5c4b3a21",
      "type": "REQUEST_CANCELLED",
      "title": "Otra persona la unió con otra solicitud del cliente",
      "body": "Pregunta sin respuesta · S-000118",
      "requestId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
      "createdAt": "2026-11-11T09:58:02.000Z",
      "readAt": null,
      "folio": "S-000118",
      "subtype": "UNKNOWN_QUESTION",
      "cause": "MERGED",
      "reason": null,
      "requestOpen": false
    },
    {
      "id": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      "type": "REQUEST_OVERDUE",
      "title": "Solicitud vencida",
      "body": "Queja · S-000110",
      "requestId": "7c6b5a49-3827-4165-9f0e-1d2c3b4a5968",
      "createdAt": "2026-11-11T15:00:00.000Z",
      "readAt": null,
      "folio": "S-000110",
      "subtype": "COMPLAINT",
      "cause": null,
      "reason": "ASSIGNEE",
      "requestOpen": true
    }
  ],
  "nextCursor": "MjAyNi0xMS0xMVQxMDowMzo0MS41MDBafDZmMWQ…"
}
```

- `nextCursor` is opaque; send it back unchanged. `null` means the last page. A malformed cursor is `400 VALIDATION_ERROR`.
- **Structured fields (S10, additive).** Nothing above changed shape; each item also has:

  | Field | Type | Meaning |
  | --- | --- | --- |
  | `folio` | `string \| null` | Formatted like the inbox (`S-000123`). `null` only on a row that has none |
  | `subtype` | `string \| null` | The request subtype code (`UNKNOWN_QUESTION`, `RESTOCK`, `COMPLAINT`, …), **not** the Spanish label. `null` only on a row that has none |
  | `cause` | `'CUSTOMER' \| 'RESOLVED_BY_OTHER' \| 'CANCELLED_BY_OTHER' \| 'SIBLING_RESOLVED' \| 'MERGED' \| null` | Why a `REQUEST_CANCELLED` closed. `null` for every other type and for `REQUEST_CANCELLED` rows written before causes existed (their `title` is the customer wording) |
  | `reason` | `'ASSIGNEE' \| 'ESCALATION' \| null` | Only for `REQUEST_ESCALATION` and `REQUEST_OVERDUE`: the person got it **as the request's assignee** or **through `read:ChatbotEscalation`**. Decided when the notice is created and never recomputed (a later reassignment does not change an existing notice). Someone who is both assignee and escalation holder gets **one** notice, with `ASSIGNEE`. `null` for every other type and for escalation rows written before this field existed |
  | `requestOpen` | `boolean \| null` | The linked request is `NEW` or `IN_PROGRESS` **at the moment of the read** (a join in the same query, so it costs nothing per row; scoped to the sucursal). `null` when `requestId` is `null` or the request no longer exists. Re-fetch or listen to `request.*` events to refresh it; it is not stored |
  | `level` | `5 \| 15 \| null` | `CONVERSATION_UNANSWERED` only (unit 11): minutes the customer has waited. `null` for every other type. The `title` already includes it ("Cliente esperando respuesta (5 min)") |

  Use `requestOpen` to hide or grey the «abrir» action for a closed request. A notice whose `requestOpen` is `false` is still readable.
- `title` and `body` are Spanish text built by the server from the type, the subtype and the folio. They never contain the customer's name, phone or message.
- To open the request, go to `/chatbot/solicitudes/:requestId`. `requestId` is `null` only for types that are not about a request (none today).

### `GET /notifications/unread-count`

```json
{ "count": 3 }
```

### `POST /notifications/:id/read`

No body. Idempotent: reading again returns the first `readAt`. The first read also sends `notification.read` to the person's other tabs and devices over the stream (a repeat sends nothing).

```json
{ "id": "6f1d3a2e-…", "readAt": "2026-11-11T10:05:00.000Z" }
```

`404` for an id that does not exist **or belongs to someone else or another sucursal** (the same answer on purpose). `400` if `:id` is not a UUID.

### `POST /notifications/read-all`

No body. Marks only the caller's unread notices in the current sucursal. When it changed something it sends one `notification.read {ids: null, all: true}` to the person's other tabs and devices over the stream.

```json
{ "updated": 4 }
```

### `GET /me/notification-preferences`

```json
{ "emailEnabled": true, "soundEnabled": true }
```

Both default to `true` (D14: sound is on by default). Preferences belong to the **person**: they are the same in every sucursal and on every device. Same guards as the other routes (no CASL permission).

### `PATCH /me/notification-preferences`

Send at least one flag; the other keeps its stored value. Returns the full object. An empty body is a plain `400`; unknown fields are `400`.

```json
{ "soundEnabled": false }
```

```json
{ "emailEnabled": true, "soundEnabled": false }
```

There is no `/notifications/preferences` route.

### The same item over the stream

`notification.created` carries `{notification, unreadCount}` where `notification` has **exactly the same keys and values as a list item** (one mapping serves both; a test compares them). The only difference is timing: the stream builds the payload when it **delivers** the event, so `requestOpen` is the value at that moment; it is not pushed again when the request closes later. Update it from the `request.*` events (`17-realtime-sse.md`) or when the list is refetched.

## 4. By design

- **There is no mark-unread and no delete.** A notice can only be read (`POST /notifications/:id/read`, `POST /notifications/read-all`); old ones are removed by the 90-day retention. Do not build those actions.
- **Browser (desktop) notifications are a per-device permission of the browser**, asked and kept by the frontend. There is **no server field or preference** for it: `GET/PATCH /me/notification-preferences` only has `emailEnabled` and `soundEnabled`.

## 5. Email, so support questions have an answer

Email is sent only to people with `emailEnabled` and only for the types that have one:

- A new request waits in a batch: everything that arrives in the same 2-minute clock window leaves as **one** email per person, with a link per request. Live conversations and complaints leave alone and immediately.
- Reassignments leave immediately. Customer cancels have no email.
- Subject `[HoundFe] Nueva solicitud: <tipo> (<sucursal>) · S-000123`. The body has the type, sucursal, folio and a link to `/chatbot/solicitudes/:id`. It never has the customer's name or phone.
- Turning email off does not remove in-app notices.

## 6. Errors

| Status | When |
| --- | --- |
| `400` | Bad `limit`, `unread` or `:id`; an empty or unknown preference body; a malformed `cursor` (`VALIDATION_ERROR`) |
| `401` | No JWT, or the user is inactive |
| `403` | No membership in the sucursal of the token |
| `404` | The notification does not exist for this person in this sucursal |
