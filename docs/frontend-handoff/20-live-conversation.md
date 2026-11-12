# Chatbot request inbox — live conversation (unit 11)

**Status:** implemented on `feat/human-intervention-u11` (human-intervention unit 11: sessions, text messages, the S16 changes, staff photos and PDFs, the paid template and the live-session notices), **not merged, not pushed, not deployed**. Load-tested at production size: `docs/perf/unit-11-live-conversation.md` (inbox with the `liveSession` fields p95 about 20-28 ms per page). Contract: `docs/proposals/human-intervention-backend-proposal.md` §4, §12.4, §12.8, §12.10, §12.15. Bot side: `docs/chatbot-handoff/chatbot-requests-bot-contract.md`, section "Live conversation (unit 11)".

A `TALK_TO_HUMAN` or `COMPLAINT` request goes live when someone **claims** it ("Atender"). The bot goes silent, and from then on the attendee talks to the customer through `POST …/messages`; the bot relays. Nothing here works until the chatbot ships its handler: **until then a claim reverts by itself after the start timeout** (request back to `NEW`). The timeout is a per-sucursal setting, `startTimeoutSeconds`, default **120 s** (30 to 600; see handoff 16); it is fixed on the session at the claim.

## 1. State machine you will see

`liveSession.state`: `null` (not a conversation, or it never had a session) → `STARTING` → `ACTIVE` → `ENDING` → `ENDED`. `WAITING` is what an **open** request shows after a session ended without finishing it (the start-timeout revert).

| Moment                                                                                                                  | What happens                                                                           | Row change                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `claim` of a live request                                                                                               | `200 {request}` as always, plus a session `STARTING`. The composer shows "Conectando…" | `liveSession {state: STARTING, handoffEpoch: N}`; SSE `request.claimed` **and** `session.starting` |
| The bot confirms it is silent                                                                                           | Composer opens                                                                         | `session.active` (`version` + 1)                                                                   |
| No confirmation in the **start timeout** (120 s by default)                                                             | The claim reverts: request back to `NEW`, no assignee                                  | `request.released` + `session.ended` (`liveSession.state: WAITING`)                                |
| `finish`                                                                                                                | Request `RESOLVED`, session `ENDING`, the bot says goodbye                             | `session.ending`                                                                                   |
| The bot confirms it is back (or **10 min** pass)                                                                        | Session `ENDED`                                                                        | `session.ended`                                                                                    |
| Customer silent **2 h** (counted from the time the customer _wrote_ the last message, not from when the bot relayed it) | The backend finishes by itself (automatic note)                                        | `session.ending`                                                                                   |

**Versions.** `session.active`, `session.ending` and `session.ended` raise `request.version` (§12.8: replace the row only if the version is higher). So after `claim` returns version `v`, the row will usually be `v+1` once `session.active` arrives: **send the latest version from the row/SSE in `finish`**, not the one from the claim response (a stale one is `409 VERSION_CONFLICT` with `current`). Messages do **not** change the version.

## 2. Row and detail: `liveSession`

```json
"liveSession": { "state": "ACTIVE", "handoffEpoch": 3,
                 "lastStaffActivityAt": "2026-11-13T16:02:11.000Z",
                 "lastCustomerMessageAt": "2026-11-13T16:01:40.000Z" }
```

`null` unless the request is a conversation that had a session. The attendee is `assignee.displayName` (not repeated here). `lastStaffActivityAt` is the last message of the attendee in this session (at the claim: the claim time). Compute "inactive for N min" with your clock corrected by the heartbeat's `serverTime` (§12.10). No automatic action follows staff inactivity.

`allowedActions` adds `SEND_MESSAGE` (assignee of an `ACTIVE` session), `FINISH` (the assignee; or a holder of `update:ChatbotRequestAssignment`, who **forces** it) and `FINISH_IDLE` (together with `FINISH` once the customer has been silent for 30 min: enable "Finalizar" with no extra confirmation). `RELEASE` is **not** offered while a session is live (see §6, "Release").

## 3. Send a message: `POST /chatbot-requests/:id/messages`

`read` + `update:ChatbotRequest`, and you must be the assignee. Headers: JWT and **`Idempotency-Key` equal to `clientMessageId`** (else `400`). Body (exact; unknown keys are `400`):

```json
{
  "clientMessageId": "6f1d…-uuid",
  "expectedEpoch": 3,
  "text": "Hola, soy Ana."
}
```

(Photos and PDFs: section 3b.) `text`: plain text, 1 to 4096 characters, line breaks allowed, trimmed; control characters are `400`. It goes to the customer **as written**: no prefix, no rewriting. `200`:

```json
{
  "message": {
    "id": "…",
    "seq": 17,
    "direction": "OUT",
    "author": "STAFF",
    "type": "TEXT",
    "text": "Hola, soy Ana.",
    "deliveryStatus": "QUEUED",
    "clientMessageId": "6f1d…",
    "staff": { "id": "…", "displayName": "Ana" },
    "createdAt": "…"
  }
}
```

The message is stored in the same transaction as the item the bot reads, so it exists if and only if it will be delivered. Order is **`seq`** (never the clock). A repeat of the same `clientMessageId` and text answers `200` with the stored message; the same id with another text (or another request) is `409 IDEMPOTENCY_CONFLICT`.

| Error                                                           | When                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 NOT_ASSIGNEE`                                              | You do not hold the request                                                                                                                       |
| `409 SESSION_NOT_ACTIVE` `{sessionState}`                       | `STARTING` ("Conectando…"), `ENDING`, ended, or no session                                                                                        |
| `409 STALE_EPOCH` `{currentEpoch}`                              | `expectedEpoch` is not the current one (reload the row)                                                                                           |
| `409 WINDOW_CLOSED` `{templateAllowed, whatsappWindowClosesAt}` | The 24 h window is closed. Block the composer. **`templateAllowed: true`** means "Enviar plantilla" can be pressed now (a template name is configured and this closed window has no live template): see section 3c |
| `422 ACTION_NOT_ALLOWED`                                        | Not a conversation                                                                                                                                |
| `404`, `400`, `401`, `403 INSUFFICIENT_PERMISSIONS`             | As everywhere                                                                                                                                     |

**Delivery status** arrives by SSE `message.status {requestId, messageId, seq, deliveryStatus}`: `QUEUED` → `SENT` (the bot's Meta ACK) → `DELIVERED` → `READ`; `DEFERRED` (the bot found the window closed: show "No enviado, ventana cerrada"); `UNKNOWN` ("Entrega dudosa": a resend is a **new** message); `FAILED`. Show "Pendiente de envío" yourself after 30 s with no `SENT` (§4.7). The attendee's own message also arrives as `conversation.message` (reconcile with `clientMessageId`).

## 3b. Photos and PDFs (S15 Q5): upload, then send

Two calls. Only the assignee, only while the session is `ACTIVE`, same permissions as text (`read` + `update:ChatbotRequest`).

**1. Upload: `POST /chatbot-requests/:id/media`**, `multipart/form-data`, one part `file` (JPEG, PNG, WebP or PDF, **at most 10 MB**; the type is decided by the file's bytes, not by its name or declared type). Header `Idempotency-Key: <uuid>` (a retry with the same key and file answers the same media; the same key with another file is `409 IDEMPOTENCY_CONFLICT`). `201` (first time) or `200` (replay):

```json
{
  "mediaId": "…",
  "mimeType": "image/jpeg",
  "sizeBytes": 183422,
  "sha256": "…",
  "filename": "foto.jpg"
}
```

`filename` is the name the customer will see, cleaned by the backend (ASCII, no path, max 100; a missing or unusable name becomes `imagen.<ext>` or `documento.pdf`). Errors: `415 MEDIA_TYPE_NOT_ALLOWED` (audio, video, anything else), `413 MEDIA_TOO_LARGE`, `400` (no file, bad key), `403 NOT_ASSIGNEE`, `409 SESSION_NOT_ACTIVE`, `404`, `422 ACTION_NOT_ALLOWED`. An uploaded file belongs to this request and to you: nobody else can send it.

**2. Send: `POST /chatbot-requests/:id/messages`** with the same envelope as text (`clientMessageId` = `Idempotency-Key`, `expectedEpoch`) and, instead of `text`:

```json
{
  "clientMessageId": "…",
  "expectedEpoch": 3,
  "type": "IMAGE",
  "mediaId": "…",
  "caption": "Así quedó tu pedido"
}
```

`type` is `IMAGE` (the file must be an image) or `DOCUMENT` (a PDF); `caption` is optional (trimmed, printable, at most 1024); `text` is not allowed with media and `mediaId`/`caption` are not allowed with `TEXT` (all `400`). `type` defaults to `TEXT`, so the text call is unchanged. `200` has the shape of section 3 plus `media`:

```json
{
  "message": {
    "id": "…",
    "seq": 18,
    "type": "IMAGE",
    "text": "Así quedó tu pedido",
    "media": { "id": "…", "mimeType": "image/jpeg", "filename": "foto.jpg" },
    "deliveryStatus": "QUEUED",
    "…": "…"
  }
}
```

(`text` carries the caption, `""` when there is none.) The checks and errors are those of text (`403 NOT_ASSIGNEE`, `409 SESSION_NOT_ACTIVE`, `409 STALE_EPOCH`, `409 WINDOW_CLOSED`), plus `404 MEDIA_NOT_FOUND` (unknown id, another branch, another request or another person's upload), `422 MEDIA_PURGED` and `422 MEDIA_TYPE_MISMATCH` (an `IMAGE` pointing at a PDF or the reverse). Nothing is sent to the customer when the call fails. Delivery status, `DEFERRED` and `FAILED` work exactly as for text. You may send the same uploaded file again in a new message.

**Showing it.** In the conversation (`GET …/conversation`) and in `conversation.message`, the item has `type` `IMAGE`/`DOCUMENT`, `text` = caption and `media {id, mimeType, sizeBytes, purged, …}`. Open the bytes with `GET /chatbot-media/:id` (authenticated, `Authorization` header): the attendee may open the files of **their session's** messages without `read:ChatbotConversation` (others still need it).

## 3c. The paid template (T11d, §4.5): `POST /chatbot-requests/:id/template`

With the 24 h window closed the attendee cannot write; the only way to reach the customer is the **paid template**, sent **only when the attendee presses a button** (nothing automatic ever sends it). It costs money, so show `templateCostText` (settings) before the confirmation.

`POST /chatbot-requests/:id/template`, permissions `read` + `update:ChatbotRequest`, header `Idempotency-Key: <uuid>` (it identifies the template message: a retry with the same key answers the same message), body **exactly** `{ "expectedEpoch": <integer> }` (the template name and language come from the branch settings; no other key is accepted).

`200` answers like a text message, with `type: "TEMPLATE"` and the `templateName`:

```json
{ "message": { "id": "…", "seq": 21, "direction": "OUT", "author": "STAFF", "type": "TEMPLATE",
               "text": "", "templateName": "seguimiento_pedido", "deliveryStatus": "QUEUED",
               "clientMessageId": "<the Idempotency-Key>", "staff": { "id": "…", "displayName": "…" },
               "createdAt": "…" } }
```

The message joins the thread (`conversation.message` SSE, ordered by `seq`) and its `deliveryStatus` moves with `message.status` exactly as a text message does (`QUEUED` → `SENT` → `DELIVERED` → `READ`, `UNKNOWN`, `FAILED`). **A template is never `DEFERRED`** (the bot may not defer it). When the customer answers the template the window opens again (`WINDOW_CLOSED` stops) and the composer works.

| Error | When |
| --- | --- |
| `409 WINDOW_OPEN` `{whatsappWindowClosesAt}` | The window is still open: write a message instead |
| `422 TEMPLATE_NOT_CONFIGURED` | The branch has no `templateName` in its settings (send the admin to the settings screen) |
| `409 TEMPLATE_ALREADY_SENT` | This closed window already has a live template: queued, sent, delivered, read **or of unknown delivery** (it may have been sent, and it costs money). Once per closed window |
| `403 NOT_ASSIGNEE`, `409 SESSION_NOT_ACTIVE`, `409 STALE_EPOCH` `{currentEpoch}`, `422 ACTION_NOT_ALLOWED` | As for a message |
| `409 IDEMPOTENCY_CONFLICT` | The key already identifies something that is not your template message of this request |
| `404`, `400`, `401`, `403 INSUFFICIENT_PERMISSIONS` | As everywhere |

**Retry.** A template whose message ended `FAILED` can be requested again (a **new** `Idempotency-Key`): Meta refused it (the bot's `STALE`) or WhatsApp reported a failure after accepting it. The new request replaces the failed one for that window. `UNKNOWN` ("Entrega dudosa") does **not** allow a retry.

**Button state.** Enable "Enviar plantilla" when the last text send answered `WINDOW_CLOSED {templateAllowed: true}` (or from your own knowledge of the window and the settings). `templateAllowed` is evaluated at that moment: after a template is pending it is `false`, after a failed one it is `true` again.

## 4. Finish: `POST /chatbot-requests/:id/finish`

`read` + `update:ChatbotRequest`; `Idempotency-Key`; body `{ "expectedVersion": 5, "note": "Resuelto por teléfono", "complaintOutcome": "NO_ACTION" }`. `note` is internal, 1 to 1000 characters, required. `complaintOutcome` (`RETURN | REPLACEMENT | REFUND | NO_ACTION`) is the classification of a complaint, **stored only** for metrics: nothing is triggered (D19, no refund or order change). **Unit 12: it is mandatory when the request's `subtype` is `COMPLAINT`.** Show the four-option selector in the finish dialog when `subtype === 'COMPLAINT'` (`FINISH` stays in `allowedActions` as usual; there is no extra flag). For any other subtype the field is optional and **ignored** (not stored, not audited), so send it only for complaints. A forced finish (reassigner) needs it too.

`200 {request}` (status `RESOLVED`). Errors: `409 SESSION_NOT_ACTIVE` (not `ACTIVE`), `403 NOT_ASSIGNEE` (someone else holds it and you lack `update:ChatbotRequestAssignment`), `409 VERSION_CONFLICT`, `409 REQUEST_CLOSED`, `422 ACTION_NOT_ALLOWED` (not a conversation, or nobody holds it), `422 COMPLAINT_OUTCOME_REQUIRED` (a `COMPLAINT` without `complaintOutcome`, or `null`; body `{statusCode, code, message, current {version, status, claimedBy}, fieldErrors: [{"path": "complaintOutcome", "code": "REQUIRED"}]}`), `400 VALIDATION_ERROR` (a value outside the four, or an empty string). The state errors (version, holder, session, closed) answer **before** the missing outcome, and a refusal changes nothing: same version, no audit event, no feed item, session still `ACTIVE`.

**Reading it back.** `GET /chatbot-requests/:id` has `complaintOutcome` (`RETURN | REPLACEMENT | REFUND | NO_ACTION | null`): `null` while open, for non-complaints, and for a complaint the backend closed by itself (the 2 h idle end has nobody to classify it; it counts as "unclassified" in the metrics). The audit `FINISHED` event carries it in `data.complaintOutcome`. Inbox rows do not carry it (lists stay light); open the detail.

## 5. Reading the conversation

`GET /chatbot-requests/:id/conversation` (unit 9) now also serves the attendee **without** `read:ChatbotConversation`: they see only the messages of **their session** (from the first `seq` after the claim). With the permission, the whole chat as before. Opening the chat as an attendee does not move the unread marker.

## 5b. Messages that cannot be delivered (unit 11, slice 2)

- **Window closed after sending.** If WhatsApp reports the 24 h window closed after the bot sent a message (error 131047), the message goes from "Enviado" to **`DEFERRED`** (`message.status`) and the bot resends it when the customer writes again. The chat's window is treated as closed from then on, so the composer answers `409 WINDOW_CLOSED` until the customer writes.
- **Deferred messages never linger.** A message still `DEFERRED` when the session ends (finish, forced finish, 2 h idle) or the epoch changes becomes **`FAILED`** ("No enviado"; a `message.status` event announces it) and is not retried. A deferral the bot reports after the session ended is settled the same way.
- **A bot message that was in flight** when you claimed may appear in the session as a bot message (`author: BOT`): it is not an error, just the bot's last turn finishing.

## 6. Decisions and known limits

- **Release.** `release` of a live request is `422 ACTION_NOT_ALLOWED`: a live conversation never goes back to `NEW` while the bot is muted. The way out is `finish`; a reassigner can force it. (The proposal's §4.2 sentence "release ≡ return to bot" is implemented as that.)
- **Reassign** (STARTING or ACTIVE) keeps the epoch and the session and moves it to the new attendee: the previous attendee can no longer write (`403 NOT_ASSIGNEE`), the new one can. The bot tells the customer "Ahora te atiende <nombre>" (owner decision Q2, first name only). You get the usual `request.reassigned` SSE event; the session state does not change, so there is **no** `session.*` event for it.
- **Cancel** stays `WAITING`-only (`409 CANCEL_NOT_ALLOWED` while a session runs), as before.
- **Notices (T11d).** Three in-app notices, never by email, never held outside business hours (a live chat's clocks do not pause): `CONVERSATION_CUSTOMER_MESSAGE` ("El cliente escribió", the attendee, once per unanswered burst: not again until the attendee has replied), `CONVERSATION_UNANSWERED` level 5 ("Cliente esperando respuesta (5 min)", the attendee) and level 15 (same title with 15, whoever holds `update:ChatbotRequestAssignment`). `payload` carries `{folio, subtype}` and, for the unanswered one, `level: 5 | 15`; the `title`/`body` come ready from `GET /notifications`. They are written by the backend's 10-second session sweep, so allow up to ~10 s after the customer's message. Only the highest level due is sent (a delayed sweep sends the 15-minute one, not both). A reply from the attendee stops the clock; a newer customer message restarts it.
- **Known limit (window of the list row).** The 24 h window of the **inbox row and detail** (`whatsappWindowClosesAt`, `windowClosingSoon`) still uses the value the bot sent when it created the request: the conversation mirror does not move it, and neither does Meta's verdict (`DEFERRED` / 131047). Sending uses the chat's real window, so the composer is the source of truth (`409 WINDOW_CLOSED`). `templateCostText` is not in the detail: read it from `GET /chatbot-settings` (handoff 16) and show it in the confirmation of section 3c; the template language is the `templateLanguageCode` setting and needs no UI here.
- **Owner decisions applied (S15).** Q1 `START_TIMEOUT`: the bot sends a short "seguimos por aquí" only if it had already announced the handover (no UI). Q2 reassign: the customer is told with the first name. Q3: no release of a live session, the way out is `finish` (or reassign). Q4: template language and variables are chatbot/backend configuration, none in this UI. Q5: staff photos and PDFs (section 3b). Q6: `complaintOutcome` is stored only; mandatory in unit 12.
- **Revert notice.** When the start reverts (start timeout) you get `request.released` + `session.ended` (state `WAITING`); there is no persistent notification for it (the realtime events are the notice; §12.15 only requires the bot to be told, which the feed item `conversation.ended START_TIMEOUT` does).
