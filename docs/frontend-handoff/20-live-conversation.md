# Chatbot request inbox — live conversation (unit 11, first slice)

**Status:** implemented on `feat/human-intervention-u11` (human-intervention unit 11), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §4, §12.4, §12.8, §12.10, §12.15. Bot side: `docs/chatbot-handoff/chatbot-requests-bot-contract.md`, section "Live conversation (unit 11)".

A `TALK_TO_HUMAN` or `COMPLAINT` request goes live when someone **claims** it ("Atender"). The bot goes silent, and from then on the attendee talks to the customer through `POST …/messages`; the bot relays. Nothing here works until the chatbot ships its handler: **until then a claim reverts by itself after 60 s** (request back to `NEW`).

## 1. State machine you will see

`liveSession.state`: `null` (not a conversation, or it never had a session) → `STARTING` → `ACTIVE` → `ENDING` → `ENDED`. `WAITING` is what an **open** request shows after a session ended without finishing it (the 60 s revert).

| Moment                                           | What happens                                                                           | Row change                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `claim` of a live request                        | `200 {request}` as always, plus a session `STARTING`. The composer shows "Conectando…" | `liveSession {state: STARTING, handoffEpoch: N}`; SSE `request.claimed` **and** `session.starting` |
| The bot confirms it is silent                    | Composer opens                                                                         | `session.active` (`version` + 1)                                                                   |
| No confirmation in **60 s**                      | The claim reverts: request back to `NEW`, no assignee                                  | `request.released` + `session.ended` (`liveSession.state: WAITING`)                                |
| `finish`                                         | Request `RESOLVED`, session `ENDING`, the bot says goodbye                             | `session.ending`                                                                                   |
| The bot confirms it is back (or **10 min** pass) | Session `ENDED`                                                                        | `session.ended`                                                                                    |
| Customer silent **2 h**                          | The backend finishes by itself (automatic note)                                        | `session.ending`                                                                                   |

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

`text`: plain text, 1 to 4096 characters, line breaks allowed, trimmed; control characters are `400`. It goes to the customer **as written**: no prefix, no rewriting. `200`:

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
| `409 WINDOW_CLOSED` `{templateAllowed, whatsappWindowClosesAt}` | The 24 h window is closed. **`templateAllowed` is `false` in this slice** (the paid template command is not built yet): show the composer blocked |
| `422 ACTION_NOT_ALLOWED`                                        | Not a conversation                                                                                                                                |
| `404`, `400`, `401`, `403 INSUFFICIENT_PERMISSIONS`             | As everywhere                                                                                                                                     |

**Delivery status** arrives by SSE `message.status {requestId, messageId, seq, deliveryStatus}`: `QUEUED` → `SENT` (the bot's Meta ACK) → `DELIVERED` → `READ`; `DEFERRED` (the bot found the window closed: show "No enviado, ventana cerrada"); `UNKNOWN` ("Entrega dudosa": a resend is a **new** message); `FAILED`. Show "Pendiente de envío" yourself after 30 s with no `SENT` (§4.7). The attendee's own message also arrives as `conversation.message` (reconcile with `clientMessageId`).

## 4. Finish: `POST /chatbot-requests/:id/finish`

`read` + `update:ChatbotRequest`; `Idempotency-Key`; body `{ "expectedVersion": 5, "note": "Resuelto por teléfono", "complaintOutcome": "NO_ACTION" }`. `note` is internal, 1 to 1000 characters, required. `complaintOutcome` (`RETURN | REPLACEMENT | REFUND | NO_ACTION`) is **stored only**: nothing is triggered (D19). It is optional here; making it mandatory for `COMPLAINT` belongs to unit 12.

`200 {request}` (status `RESOLVED`). Errors: `409 SESSION_NOT_ACTIVE` (not `ACTIVE`), `403 NOT_ASSIGNEE` (someone else holds it and you lack `update:ChatbotRequestAssignment`), `409 VERSION_CONFLICT`, `409 REQUEST_CLOSED`, `422 ACTION_NOT_ALLOWED` (not a conversation, or nobody holds it).

## 5. Reading the conversation

`GET /chatbot-requests/:id/conversation` (unit 9) now also serves the attendee **without** `read:ChatbotConversation`: they see only the messages of **their session** (from the first `seq` after the claim). With the permission, the whole chat as before. Opening the chat as an attendee does not move the unread marker.

## 6. Decisions and what is not in this slice

- **Release.** `release` of a live request is `422 ACTION_NOT_ALLOWED`: a live conversation never goes back to `NEW` while the bot is muted. The way out is `finish`; a reassigner can force it. (The proposal's §4.2 sentence "release ≡ return to bot" is implemented as that.)
- **Reassign** keeps the epoch and the session; the customer is **not** told (open question Q2 of the bot contract).
- **Cancel** stays `WAITING`-only (`409 CANCEL_NOT_ALLOWED` while a session runs), as before.
- **Not built yet:** the template command and `templateCostText` in the detail; staff photos and PDFs (`type` is `TEXT` only); the "5/15 minutes unanswered" and "customer wrote" notices; the 24 h window of the **list row** (`whatsappWindowClosesAt`, `windowClosingSoon`) still uses the value the bot sent when it created the request. Sending uses the chat's real window.
- **Revert notice.** When the start reverts you get `request.released` + `session.ended` (state `WAITING`); there is no persistent notification yet.
