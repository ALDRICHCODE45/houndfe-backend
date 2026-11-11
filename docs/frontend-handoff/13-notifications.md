# Notifications API (in-app list, unread badge, preferences)

**Status:** implemented on `feat/human-intervention` (human-intervention unit 6, slice 6a), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §5.1, §5.2, §6.3, §8 (D5, D14). Model and pipeline: `docs/notifications-model.md`.

Shapes in this document come from the controller, DTOs, service and their specs (`src/notifications/**`). Nothing was sent to the dev API.

**Not in this slice:**
- Real time. `notification.created` and `notification.read` over SSE arrive with unit 8; until then **poll** `GET /notifications/unread-count` (for example every 30 s and on tab focus).
- Notices for claim reminders, escalation and overdue requests (unit 7). The types and the list already handle them; they just do not appear yet.
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
| `REQUEST_CANCELLED` | The assignee, if the request had one | The **customer** cancelled |

A staff cancellation does not notify. A notice appears within about a second of the change, not in the same response.

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
      "readAt": null
    }
  ],
  "nextCursor": "MjAyNi0xMS0xMVQxMDowMzo0MS41MDBafDZmMWQ…"
}
```

- `nextCursor` is opaque; send it back unchanged. `null` means the last page. A malformed cursor is `400 VALIDATION_ERROR`.
- `title` and `body` are Spanish text built by the server from the type, the subtype and the folio. They never contain the customer's name, phone or message.
- To open the request, go to `/chatbot/solicitudes/:requestId`. `requestId` is `null` only for types that are not about a request (none today).

### `GET /notifications/unread-count`

```json
{ "count": 3 }
```

### `POST /notifications/:id/read`

No body. Idempotent: reading again returns the first `readAt`.

```json
{ "id": "6f1d3a2e-…", "readAt": "2026-11-11T10:05:00.000Z" }
```

`404` for an id that does not exist **or belongs to someone else or another sucursal** (the same answer on purpose). `400` if `:id` is not a UUID.

### `POST /notifications/read-all`

No body. Marks only the caller's unread notices in the current sucursal.

```json
{ "updated": 4 }
```

### `GET /notifications/preferences`

```json
{ "emailEnabled": true, "soundEnabled": true }
```

Both default to `true` (D14: sound is on by default). Preferences belong to the **person**: they are the same in every sucursal and on every device.

### `PUT /notifications/preferences`

Send at least one flag; the other keeps its stored value. Returns the full object. An empty body is a plain `400`; unknown fields are `400`.

```json
{ "soundEnabled": false }
```

```json
{ "emailEnabled": true, "soundEnabled": false }
```

The contract text in §5.2 mentions `GET/PATCH /me/notification-preferences`. This slice shipped `GET/PUT /notifications/preferences` as requested for the backend task; the shape is the same.

## 4. Email, so support questions have an answer

Email is sent only to people with `emailEnabled` and only for the types that have one:

- A new request waits in a batch: everything that arrives in the same 2-minute clock window leaves as **one** email per person, with a link per request. Live conversations and complaints leave alone and immediately.
- Reassignments leave immediately. Customer cancels have no email.
- Subject `[HoundFe] Nueva solicitud: <tipo> (<sucursal>) · S-000123`. The body has the type, sucursal, folio and a link to `/chatbot/solicitudes/:id`. It never has the customer's name or phone.
- Turning email off does not remove in-app notices.

## 5. Errors

| Status | When |
| --- | --- |
| `400` | Bad `limit`, `unread` or `:id`; an empty or unknown preference body; a malformed `cursor` (`VALIDATION_ERROR`) |
| `401` | No JWT, or the user is inactive |
| `403` | No membership in the sucursal of the token |
| `404` | The notification does not exist for this person in this sucursal |
