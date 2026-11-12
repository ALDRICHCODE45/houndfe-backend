# Conversation mirror: read the chat of a request, play its files, receive new messages live

**Status:** implemented on `feat/human-intervention` (human-intervention unit 9), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §3.6, §3.8, §6.1 to §6.3, §12.5, §12.8, R12, and the v1.6 note in §17. The bot side (what writes the mirror) is `docs/chatbot-handoff/chatbot-requests-bot-contract.md`. Model and performance: `docs/chatbot-requests-model.md` ("Conversation mirror"), `docs/perf/conversation-load-results.md`.

Shapes in this document come from the controllers, the views and the PostgreSQL integration specs `src/conversations/*.integration.spec.ts` and `src/realtime/realtime-conversation.integration.spec.ts`. Nothing was sent to the dev API.

**What this unit is.** A copy, kept 12 months, of what the customer and the bot said in the WhatsApp chat, so the person who attends a request sees the context. It is **read only**: staff cannot write, edit or delete messages here. Sending a message as staff, the live session, `session.*` events and the "attend without `read:ChatbotConversation`" session view arrive with unit 11.

**Not in this unit** (fields keep their final shape, with the value in the second column for now):

| Contract item | Today |
| --- | --- |
| Staff messages (`author: STAFF`, `clientMessageId`, `staff {id, displayName}`) | The shape is final and the read already renders it, but **no staff message exists yet** (unit 11). |
| `author: SYSTEM`, `type: SYSTEM` and `TEMPLATE` from staff | Same: unit 11. (`TEMPLATE` sent by the bot does exist.) |
| `media.hasThumb` and `?variant=thumb` | Always `false` and `404 THUMB_UNAVAILABLE`: the backend has no image library to generate thumbnails. Show the original (10 MB at most). |
| `media.durationSec` | Always `null` (the backend does not parse audio). Read the duration in the browser from the `blob:`. |
| `unreadCustomerMessages` on the inbox row and detail | **Live (owner decision S12).** Customer messages of the chat after the last time **any** staff member opened the conversation; reset to `0` for everyone on open. Opening = `GET …/conversation` by a reader with `read:ChatbotConversation` (the page you get is what marks it: the **latest** page clears the count; `?before=` pages never do; an `?after=` page clears only up to the newest message it returned). An assignee without that permission who receives the empty page does **not** clear it. The marker is stored on the conversation, so it survives restarts and is shared by every request of that chat. |
| Someone who attends a request **without** `read:ChatbotConversation` | Sees their session only. There are no sessions yet, so the answer is an empty page (section 2). |
| `deliveryStatus` of a **staff** message (`QUEUED`, `DEFERRED`) | Unit 11. The bot's own messages are `SENT`, `DELIVERED`, `READ` or `FAILED` today. |

## 1. Who can do what

| Route | CASL required |
| --- | --- |
| `GET /chatbot-requests/:id/conversation` | `read:ChatbotRequest`, plus `read:ChatbotConversation` (see section 2 for the exception) |
| `GET /chatbot-media/:id` | `read:ChatbotRequest` **and** `read:ChatbotConversation` |

Same guard chain as the rest of the inbox: `JWT → tenant → active user → CASL`. All answers are `Cache-Control: no-store` (the media proxy: `private, no-store`). Initial grants (task log L2): Manager and Cashier have `read:ChatbotConversation`; a role with only `read`/`update:ChatbotRequest` does not.

## 2. `GET /chatbot-requests/:id/conversation`

Query (all optional, no other parameter is accepted):

| Parameter | Rule |
| --- | --- |
| `limit` | 1 to 100, default 50 |
| `before=<seq>` | The page of messages **older** than `seq` (`seq` ≥ 2). For "load earlier". |
| `after=<seq>` | The messages **newer** than `seq` (≥ 0), oldest first. For polling (every 3 to 5 s) until the stream is on. |
| (none) | The **latest** page. |

`before` and `after` together, a malformed or out-of-range value, an unknown parameter, or a `limit` over 100 is `400 VALIDATION_ERROR`.

```json
{
  "items": [
    { "id": "…", "seq": 17, "direction": "IN", "author": "CUSTOMER",
      "staff": null, "type": "TEXT", "text": "Hola, ¿tienen croquetas?",
      "media": null, "deliveryStatus": null, "clientMessageId": null,
      "providerTimestamp": "2026-11-09T16:02:11.000Z",
      "createdAt": "2026-11-09T16:02:11.420Z" },
    { "id": "…", "seq": 18, "direction": "OUT", "author": "BOT",
      "staff": null, "type": "IMAGE", "text": "Así se ve",
      "media": { "id": "…", "mimeType": "image/jpeg", "sizeBytes": 182344,
                 "durationSec": null, "hasThumb": false, "purged": false },
      "deliveryStatus": "DELIVERED", "clientMessageId": null,
      "providerTimestamp": "2026-11-09T16:02:14.000Z",
      "createdAt": "2026-11-09T16:02:14.350Z" }
  ],
  "hasMoreBefore": true
}
```

- **Order is `seq`, always ascending in `items`**, whichever parameter you used. `seq` is assigned by the backend when the message arrives (1, 2, 3… with no gaps within a chat). **Never order by `providerTimestamp` or `createdAt`**: the first is Meta's clock, the second ours; two messages of one batch can share `createdAt`.
- `hasMoreBefore` is `true` when a message with a lower `seq` exists than the first item (also after an `after` read). An empty `items` always comes with `false`.
- `direction`: `IN` (the customer) or `OUT` (the bot, and later staff). `author`: `CUSTOMER`, `BOT`, `STAFF`, `SYSTEM`. `staff` is non-null only for `STAFF`.
- `type`: `TEXT`, `IMAGE`, `STICKER`, `DOCUMENT` (a PDF), `AUDIO`, `TEMPLATE`, `SYSTEM`, `UNSUPPORTED`. `UNSUPPORTED` is a message the system does not store: its `text` is one of the fixed strings **"Video recibido"**, **"Ubicación recibida"** or **"Mensaje no compatible recibido"**, never the customer's words, and it has no file.
- **`text` is plain text.** Show it as text, never as HTML (the customer typed it): it is stored as sent, minus control characters and bidi overrides. For `IMAGE` and `DOCUMENT` it is the caption; it can be `null` (audio, stickers, captionless media).
- `deliveryStatus` exists only on `OUT` messages (`null` on `IN` and on timeline marks). Values: `QUEUED | DEFERRED | SENT | DELIVERED | READ | FAILED | UNKNOWN`. It only moves forward; the changes come on the stream (section 4).
- `media.purged: true` means the 12-month retention deleted the file (the message row may still exist for a moment): `GET /chatbot-media/:id` answers `410`. A message whose file row is already gone also reads `purged: true` with `mimeType` and `sizeBytes` `null`.
- `providerTimestamp` can be `null` (not for bot or customer messages today).

**Which messages:** the whole chat of the customer with the bot, including messages from before this request existed (it is context). The request is linked to its chat by its conversation reference, which **never** appears in this response (it contains the customer's phone). If the request has no conversation reference, or its chat was never mirrored, the answer is `{ "items": [], "hasMoreBefore": false }`.

**Permission rule.** With `read:ChatbotConversation` you get the page. Without it: if you are the **assignee of this request and it is `IN_PROGRESS`** you get `{ "items": [], "hasMoreBefore": false }` (your session's messages: none exist until unit 11); anyone else gets `403 INSUFFICIENT_PERMISSIONS` and you should not show the block. A request of another sucursal, or an unknown id, is `404 NOT_FOUND` (the same body). A malformed id is `400`.

**R12.** The phone is not in this response at all, and no route of this unit returns a phone. The customer card (masked phone, name) comes from the request detail (handoff 14), through `toStaffPhone`. The customer's own free text can contain a number; it is shown as written.

## 3. `GET /chatbot-media/:id`: images, stickers, PDFs and voice notes

There are **no signed or public URLs**. The backend streams the file after checking, **on every request**, that the user is active and has `read:ChatbotRequest` and `read:ChatbotConversation` (a signed URL would outlive a revoked permission). Because the token is in `Authorization`, you cannot use the route in `<img src>` or `<audio src>`: fetch it, make a `blob:` with `URL.createObjectURL`, and release it with `URL.revokeObjectURL` when the component unmounts. Audio is downloaded whole before playing (10 MB at most).

| Status | When |
| --- | --- |
| `200` | The bytes, with the **real** `Content-Type` (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `audio/ogg`, `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/amr`), `Content-Length`, `Content-Disposition: inline` (a PDF: `inline; filename="documento.pdf"`, never a name the customer chose), `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. |
| `400 VALIDATION_ERROR` | The id is not a UUID, or `variant` is not `original` / `thumb`. |
| `403 INSUFFICIENT_PERMISSIONS` | Missing `read:ChatbotConversation`. |
| `404 MEDIA_NOT_FOUND` | Unknown id, another sucursal's file (same body), or the stored object is missing. |
| `404 THUMB_UNAVAILABLE` | `?variant=thumb` (no thumbnails yet): ask for the original. |
| `410 MEDIA_PURGED` | The retention deleted it. Show "Archivo eliminado". |
| `503 MEDIA_STORAGE_FAILED` | The storage could not be read. Retry later; `Retry-After` is not sent. |

Errors use the usual `{statusCode, code, message}` envelope.

## 4. Realtime: `conversation.message` and `message.status`

On the stream of handoff 17 (`GET /realtime/stream`, same connection, same `Last-Event-ID` replay). Both carry an `id:` (they move the cursor) and go **only to users with `read:ChatbotConversation`** (everyone else on the stream simply does not receive them).

```text
event: conversation.message
data: {"requestId":"…","message":{ /* a message exactly as in section 2 */ }}

event: message.status
data: {"requestId":"…","messageId":"…","seq":18,"deliveryStatus":"DELIVERED"}
```

- One event **per open request of that chat** (`NEW` or `IN_PROGRESS`), so a customer with two open requests produces two events with different `requestId`s and the same message. A chat with no open request produces none: you will read the messages when the request is opened. Closed requests receive nothing.
- **Append or replace by `seq`:** if you already hold a message with that `seq`, replace it, otherwise insert it in `seq` order. A gap (you hold 17 and receive 19) means you missed 18: call `GET …/conversation?after=17`.
- **The message is the state at delivery time, not when it was logged.** After a reconnect you may receive `conversation.message` for a message whose `deliveryStatus` is already `READ`, and several `message.status` events for one message can all show the latest status. Apply what you receive; do not replay transitions. `message.status` is sent only when a status really moved forward (a repeated or older Meta status sends nothing).
- Nothing carries the chat reference, the customer key or a phone. The event does **not** increase `request.version` and does not carry the unread count: the count moves with its own **`request.updated`** (below).
- **Keeping `unreadCustomerMessages` fresh.** For every open request of the chat the backend also logs one `request.updated` (same stream, handoff 17, the full row with the **current** `unreadCustomerMessages`) (a) once per batch that contains at least one **customer** message (bot-only batches send none) and (b) when someone **opens** the conversation and the marker moves (so every other screen clears its badge; opening again with nothing newer sends nothing). They go to everyone with `read:ChatbotRequest` (the row is theirs even without `read:ChatbotConversation`), and the row's `version` does **not** change, so apply it with the equal-version rule of handoff 17. If the stream is down, the count is simply read again by any list or detail fetch (it is part of the row).
- If the file of a message was purged before delivery, or the message was, no event is sent.
- Reminder from handoff 17: while the Traefik/Swarm test (R6) is pending, keep polling `?after=<seq>` as the source of truth and treat the stream as an accelerator.

## 5. Suggested client logic

1. Open the request: `GET /chatbot-requests/:id/conversation` (latest page). Keep the highest `seq`.
2. Scroll up: `?before=<lowest seq>`; stop when `hasMoreBefore` is `false`.
3. Live: apply `conversation.message` / `message.status` for the open `requestId`; when the stream is not available poll `?after=<highest seq>` every 3 to 5 s.
4. Files: fetch `GET /chatbot-media/:id` on demand (when the bubble is visible or the user presses play), cache the `blob:` for the open conversation only, revoke on close.
5. Never write, edit or delete: there is no route. A correction is a new message (unit 11).

## 6. Errors and codes (summary)

| Status / code | Route | Meaning |
| --- | --- | --- |
| `400 VALIDATION_ERROR` | conversation, media | Bad id or query. |
| `401` | both | No / expired token or inactive user: refresh, else log out. |
| `403 INSUFFICIENT_PERMISSIONS` | both | See sections 1 to 3. |
| `404 NOT_FOUND` | conversation | Unknown request or another sucursal's. |
| `404 MEDIA_NOT_FOUND` / `THUMB_UNAVAILABLE` | media | Section 3. |
| `410 MEDIA_PURGED` | media | Deleted by retention. |
| `503 MEDIA_STORAGE_FAILED` | media | Retry later. |

## 7. Retention (what users should expect)

Messages and files are deleted **12 months after they were received** (a purge runs hourly). The request, its resolution and its audit are kept forever. After the purge a request's conversation is simply shorter or empty; an old file is `410 MEDIA_PURGED`.
