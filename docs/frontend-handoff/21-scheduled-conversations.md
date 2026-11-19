# Chatbot request inbox — scheduled conversations (unit 14)

**Status:** implemented on `feat/human-intervention-u14` (human-intervention unit 14: slots, booking, reschedule, cancel, the schedule sweep, `needsReschedule`), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §4.9, §10.1, owner decisions S19 (Q4, Q6, Q9, Q10). Bot side: `docs/chatbot-handoff/chatbot-requests-bot-contract.md`, "Scheduled conversations (unit 14)". Load-tested at production size: `docs/perf/unit-14-scheduled-conversations.md`.

Shapes in this document come from the controllers, DTOs, domain and their specs (`src/chatbot-requests/**`, `scheduled-conversations.integration.spec.ts`). Nothing was sent to the dev API. Errors use the envelope of `11-chatbot-request-commands.md` ("Errors"): `{statusCode, code, message, current?}`, switch on `code`.

A **scheduled conversation** is a `TALK_TO_HUMAN` or `COMPLAINT` request that the customer booked with the bot outside opening hours, for a 30-minute block (the block length is a setting). The bot books it; **staff only ever reschedule or cancel it**, and take it from 5 minutes before the time. The backend does the rest (the 10-minute reminder to the customer, the "Nueva solicitud" notice at the time).

Nothing here exists for a sucursal until its settings say `scheduling.enabled: true` (handoff 16). With it off, every route below answers `422 SCHEDULING_DISABLED` and no row ever has a `scheduledFor`.

## 1. What changes in the rows

All of this is **additive**: the keys already existed (`scheduledFor`, `requiresTemplateAtStart`, `needsReschedule`, handoff 14) and used to be `null`/`false`; `scheduleVersion` is new.

| Field (row of `groups`, `/`, `/:id`, SSE rows) | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduledFor`                                 | ISO UTC instant the customer booked, or `null` (not a scheduled conversation). Show it in the **sucursal's** time zone (the `timeZone` of the slots answer, or the one of settings).                                                                                                                                                                                                                                                                          |
| `scheduleVersion`                              | Integer, **monotonic per request**: 1 at booking, +1 on every reschedule and on the cancel of a scheduled request, `0` when it was never scheduled. Not the concurrency token (that is still `version`). Use it only to tell "this is the same booking" from "the time changed".                                                                                                                                                                              |
| `needsRescheduleReason`                        | Why `needsReschedule` is set: `"CLOSED_DATE"` (`scheduledFor` falls on a closed date; wins when the hours would also exclude it) or `"HOURS_CHANGED"` (the date is open but the time is outside the changed hours). `null` when not flagged, and `null` for a request flagged before this field existed (show the generic "Por reagendar"). Cleared together with `needsReschedule` by a reschedule. Present on the inbox row, the detail and the stream row. |
| `needsReschedule`                              | `true` when the sucursal's hours or closed dates changed so that `scheduledFor` is no longer inside the open hours (S19 Q6). **Nobody told the customer; staff must move it.** Cleared by a reschedule.                                                                                                                                                                                                                                                       |
| `requiresTemplateAtStart`                      | `true` when the booked time is outside the free 24 h window of the customer's last message: opening the conversation will need the paid template (handoff 20, 3c). Recomputed on every reschedule.                                                                                                                                                                                                                                                            |

**Where scheduled rows appear (S19 Q10).** A future scheduled request is a normal `NEW` request: it is **in the `open` tab, in `counts.new`, in the groups, with its `scheduledFor`**. The claim and overdue clocks start at `scheduledFor`, not at booking, so a future scheduled row is never `overdue` and its `slaLevel` is `OK` before its time (draw it as "agendada", not as green, from `scheduledFor`). The "Nueva solicitud" notification and the 50 %/80 %/overdue notices also wait for `scheduledFor`.

### 1.1 The "Agendadas" tab and the counts

- `GET /chatbot-requests/groups?status=scheduled` and `GET /chatbot-requests?customerKey=…&status=scheduled`: open requests with a `scheduledFor`. Same page shape, same cursor and `limit` as the other tabs. A group appears only if it has a matching request, and `requests`/`moreRequests` count only the matching ones (handoff 14, section 4).
- **Order.** Groups come in the order of their most urgent deadline, and the deadline of a scheduled request is `scheduledFor` plus the subtype's claim minutes. That is **chronological for the same subtype, not strictly across subtypes**: if you draw a day agenda, sort the loaded rows by `scheduledFor` yourself and do not assume a later page only holds later times.
- `GET /chatbot-requests/counts` already carries `scheduled` (open requests with a `scheduledFor`, **including a time already passed that nobody claimed yet**) and `needsReschedule` (open requests flagged). Use them for the tab badge and a "Por reagendar" alert. `new` and `inProgress` still include scheduled rows.
- Closed scheduled requests keep their `scheduledFor` in history and in the closed tabs; they are not in `counts.scheduled`.

### 1.2 `allowedActions` and `deniedActions`

- **`RESCHEDULE`** is in `allowedActions` for the caller who holds `update:ChatbotRequest` on an **open, scheduled, not-started** request (`NEW`, no live session). It is never offered on a closed request, on a request with no `scheduledFor`, or once someone claimed it (`IN_PROGRESS` or a session `STARTING`/`ACTIVE`/`ENDING`: `RESCHEDULE_NOT_ALLOWED`).
- **`CLAIM`** is **not** in `allowedActions` while `now < scheduledFor − 5 min`, and `deniedActions` carries `{action: "CLAIM", code: "SCHEDULED_TOO_EARLY", claimableAt: "<ISO>"}` (informative, like `NOT_ASSIGNEE`: show the button disabled with the reason; `claimableAt` is `scheduledFor − 5 min`, so the row can say "Podrás atenderla a las 09:55" without a failed press; it appears only on this code). From `claimableAt` on, `CLAIM` is in `allowedActions` when the row is read again. The list is computed **when the row is read**, and **no event announces the moment a claim becomes possible**: set a timer for `scheduledFor − 5 min` (use the heartbeat-corrected clock, handoff 17) and re-read the row, or simply enable the button then; the server decides on press.
- Claiming too early: `409 SCHEDULED_TOO_EARLY` with **`claimableAt`** (ISO) next to `code`:

```json
{
  "statusCode": 409,
  "code": "SCHEDULED_TOO_EARLY",
  "message": "The scheduled conversation cannot be claimed yet",
  "claimableAt": "2026-11-14T15:55:00.000Z",
  "current": { "version": 1, "status": "NEW", "claimedBy": null }
}
```

Show "Podrás atenderla a las 09:55" from `claimableAt` (it is `scheduledFor − 5 min`). Once the time has come the claim is the usual one (handoff 11, 3.1, handoff 20): the bot goes silent, the session starts, the greeting runs.

## 2. Staff slots picker: `GET /chatbot-requests/:id/scheduling/slots`

`read:ChatbotRequest` (a reader can look; moving needs `update`). `Cache-Control: no-store`. No query. The request must exist in this sucursal (`404 NOT_FOUND`); it does not have to be scheduled.

```json
{
  "timeZone": "America/Mexico_City",
  "whatsappWindowClosesAt": "2026-11-14T03:10:00.000Z",
  "businessHours": {
    "openNow": false,
    "nextOpenAt": "2026-11-14T15:00:00.000Z",
    "timeZone": "America/Mexico_City",
    "weeklyRanges": [
      { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "18:00" }] }
    ],
    "closedDates": ["2026-12-25"]
  },
  "slots": [
    {
      "startsAt": "2026-11-14T15:00:00.000Z",
      "withinWindow": true,
      "available": true
    },
    {
      "startsAt": "2026-11-14T15:30:00.000Z",
      "withinWindow": true,
      "available": true
    }
  ]
}
```

- `slots`: **up to 24** blocks, earliest first, starting at least **10 minutes** from now and at most **14 days** ahead, each inside the open hours, never on a closed date, **full blocks omitted** (`available` is always `true`: a full block is simply not listed). The list is a fresh read; it can go stale while the dialog is open (see `SLOT_UNAVAILABLE`).
- `withinWindow: false` means the greeting at that time is **outside the customer's free 24 h window**: moving there makes the request need the **paid template** when it is claimed (`requiresTemplateAtStart: true`). Tell the attendee ("Esta hora cuesta una plantilla de WhatsApp") and prefer `withinWindow: true` ones; they are listed in time order, not by cost.
- `whatsappWindowClosesAt`: when the customer's free window closes (last customer message + 24 h, from the mirror; when the backend knows no message it counts from now).
- `businessHours.weeklyRanges` and `closedDates` (today through the next 14 days, `YYYY-MM-DD` in the sucursal zone) are what you need to draw a calendar. All instants are UTC ISO; render in `timeZone`.
- `422 SCHEDULING_DISABLED` when the sucursal has scheduling off.

## 3. Staff reschedule: `POST /chatbot-requests/:id/reschedule`

`read` + `update:ChatbotRequest`. Headers: JWT and **`Idempotency-Key`** (required, like every staff command; reuse it only to retry the same body). Body (exact):

```json
{ "expectedVersion": 1, "scheduledFor": "2026-11-14T16:00:00.000Z" }
```

`scheduledFor`: an ISO 8601 instant **with an explicit zone**. It must be one of the blocks the picker lists (a block start, inside the hours, 10 min to 14 days ahead, with a free seat); anything else is `409 SLOT_UNAVAILABLE`. `200` (also for a replay of the same key and body, which returns the stored answer and changes nothing):

```json
{
  "request": {
    "id": "…",
    "folio": "S-000123",
    "kind": "CONVERSATION",
    "subtype": "TALK_TO_HUMAN",
    "status": "NEW",
    "displayStatus": "NEW",
    "version": 2,
    "assignee": null,
    "claimedAt": null,
    "overdueAt": null,
    "closedAt": null,
    "scheduledFor": "2026-11-14T16:00:00.000Z",
    "previousScheduledFor": "2026-11-14T15:00:00.000Z",
    "scheduleVersion": 2,
    "requiresTemplateAtStart": false,
    "customerNotice": { "expected": true }
  },
  "customerNotice": { "expected": true }
}
```

The `request` is the small command shape of handoff 11 plus the scheduling keys (no phone, no `customerKey`); the full row arrives on the stream. `customerNotice` is repeated at the top level for convenience: read either.

**`customerNotice.expected` (S19 Q9): the screen must warn.** Staff moving a request does **not** tell the customer by itself. The backend asks the bot to send one message ("Tu conversación quedó para el …") **only if the customer's 24 h window is still open** (`expected: true`). When the window is closed (`expected: false`) the bot **cannot** write to the customer without a paid template and the backend sends nothing (the owner chose not to message): the dialog must say it **before** the attendee confirms, and again in the success toast, for example:

| `expected` | When you know it                                                                                | Copy suggestion                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `true`     | After the answer; and before it, when `whatsappWindowClosesAt` from the picker is in the future | "Se avisará al cliente de la nueva hora."                                                                                      |
| `false`    | Same: `whatsappWindowClosesAt` is already past                                                  | "El cliente **no recibirá aviso** de la nueva hora: la ventana de 24 h está cerrada. Avísale por otro medio o cuando escriba." |

Use `whatsappWindowClosesAt` of the picker to warn before confirming; the answer's `customerNotice.expected` is the truth. The warning is also right to show even when `expected: true`: the bot's message is best-effort (the customer may have no active channel).

What the move did: the seat of the old block is freed and the new one taken **atomically**, `scheduleVersion` + 1, `version` + 1, the claim and overdue clocks restart at the new time, `needsReschedule` is cleared, `requiresTemplateAtStart` is recomputed, a `RESCHEDULED` audit event is written (actor = the attendee, `from`, `to`), and the bot is asked to tell the customer when allowed. **Picking the time the request already has is a no-op**: `200`, nothing changes (the flag, if set, stays; the picker never offers a time outside the hours, so a flagged request always needs a different one).

| Status    | `code`                                      | When                                                                                                                                                                    | `current` |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 400       | `VALIDATION_ERROR`                          | Missing `Idempotency-Key`, `scheduledFor` not an ISO instant with a zone, bad `:id`, missing `expectedVersion`                                                          | —         |
| 401 / 403 | `UNAUTHORIZED` / `INSUFFICIENT_PERMISSIONS` | As everywhere (a reader gets 403)                                                                                                                                       | —         |
| 404       | `NOT_FOUND`                                 | No such request in this sucursal                                                                                                                                        | —         |
| 409       | `VERSION_CONFLICT`                          | `expectedVersion` is stale: reload the row and retry with a new key                                                                                                     | ✓         |
| 409       | `REQUEST_CLOSED`                            | Already `RESOLVED` or `CANCELLED`                                                                                                                                       | ✓         |
| 409       | `NOT_SCHEDULED`                             | The request has no `scheduledFor`                                                                                                                                       | ✓         |
| 409       | `RESCHEDULE_NOT_ALLOWED`                    | Someone already claimed it or a live session started: it cannot be moved                                                                                                | ✓         |
| 409       | `SLOT_UNAVAILABLE`                          | The block is full, not on the grid, outside the hours, too soon, too far, or a closed date. **Body adds the fresh list** (below). Nothing changed, the old seat is kept | ✓         |
| 409       | `IDEMPOTENCY_CONFLICT`                      | Same key, other body                                                                                                                                                    | —         |
| 422       | `SCHEDULING_DISABLED`                       | The sucursal turned scheduling off                                                                                                                                      | —         |

```json
{
  "statusCode": 409,
  "code": "SLOT_UNAVAILABLE",
  "message": "That time is not available; choose one of the listed times",
  "slots": [{ "startsAt": "…", "withinWindow": true, "available": true }],
  "timeZone": "America/Mexico_City",
  "whatsappWindowClosesAt": "…",
  "current": { "version": 1, "status": "NEW", "claimedBy": null }
}
```

On `SLOT_UNAVAILABLE`, replace the picker's list with `slots` (the next free blocks, the same shape as section 2 but only the offered few) and let the attendee choose again; it is the normal outcome when two people pick the last seat. On `VERSION_CONFLICT`/`RESCHEDULE_NOT_ALLOWED`, update the row from `current` and close the dialog.

## 4. Cancel

There is no new route. A scheduled request is cancelled by the existing staff `POST /chatbot-requests/:id/cancel` (handoff 11, 3.4) or by the customer through the bot. Either way the **seat is freed in the same transaction**, `scheduleVersion` + 1, the schedule stops (no reminder, no "Nueva solicitud" at the old time) and the request becomes `CANCELLED` as usual (`request.cancelled`). A customer who cancelled can book again immediately. (The "one open scheduled request per customer and subtype" rule identifies the customer by their canonical phone, the request's `customerKey`, not by a linked customer record: one open scheduled request per phone and subtype.) A scheduled request cannot be **merged away** (it is the target of a merge, never the source: handoff 11, 3.5).

## 5. Realtime and notifications

Stream and recovery are unchanged (handoff 17): events carry the **full row** for the recipient, so `scheduledFor`, `scheduleVersion` and `needsReschedule` arrive like any other field. What is new:

| Moment                                                                | SSE event                                                          | What changed on the row                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The bot books                                                         | `request.created`                                                  | The new row, with `scheduledFor`, `scheduleVersion: 1`, `requiresTemplateAtStart`. **No notification yet.**                                                                                                                                            |
| Staff or the bot reschedules                                          | `request.updated`                                                  | New `scheduledFor`, `scheduleVersion` + 1, `version` + 1, `needsReschedule: false`, recomputed deadlines and `requiresTemplateAtStart`. (Used to be "not announced".)                                                                                  |
| The hours or closed dates change and a booked time falls outside them | `request.updated`                                                  | `needsReschedule: true`, `version` + 1, once per request. The settings `PUT` itself answers as before; the flags arrive moments after it commits.                                                                                                      |
| Staff or the bot cancels                                              | `request.cancelled`                                                | As any cancel; the row keeps its old `scheduledFor`.                                                                                                                                                                                                   |
| `scheduledFor` arrives                                                | `notification.created`, type `REQUEST_CREATED` ("Nueva solicitud") | Same notification as any new request, to the same people. **Held until the next opening if the sucursal is closed at that time.** No row event: nothing changed.                                                                                       |
| 10 minutes before                                                     | —                                                                  | A reminder goes to the **customer** through the bot. Nothing for staff, nothing on the stream. The backend skips it when under 3 minutes remain and while `needsReschedule` is set; the bot sends it only if the customer's 24 h window is still open. |

Apply `request.updated` by the usual rule: replace the row only if its `version` is higher. A reschedule and a flag **do** raise `version` (unlike the SLA-level and unread-count updates), and the row itself tells you what changed (`scheduledFor`, `needsReschedule`).

There is no event at `scheduledFor − 5 min` (claim becomes possible) and none at `scheduledFor` for the row (section 1.2).

## 6. What the screens need

1. **Row / detail:** a "Agendada para el sáb 14 nov, 09:00" chip from `scheduledFor` (sucursal zone); a "Plantilla de pago al iniciar" badge from `requiresTemplateAtStart`; a **"Por reagendar"** warning (stronger colour) from `needsReschedule`, with a one-click "Reagendar" that opens the picker; use `needsRescheduleReason` to say why (`CLOSED_DATE`: "La sucursal cerrará ese día"; `HOURS_CHANGED`: "Cambió el horario de la sucursal"). Disable "Atender" while `CLAIM` is denied with `SCHEDULED_TOO_EARLY`, with the time from `scheduledFor − 5 min`.
2. **Reschedule dialog** (`RESCHEDULE` in `allowedActions`): load the picker (section 2), list `slots` in the sucursal zone with the `withinWindow` cost note, show the `customerNotice` warning from `whatsappWindowClosesAt` before confirming, send `expectedVersion` from the row you have and a fresh `Idempotency-Key` per confirmation, handle `SLOT_UNAVAILABLE` by swapping the list.
3. **Agendadas tab:** `status=scheduled`, badge from `counts.scheduled`, alert from `counts.needsReschedule`; sort the loaded rows by `scheduledFor`.
4. **Realtime:** treat `request.updated` with a higher `version` as a replacement of the row; do not show a toast for the flag (nobody changed anything on screen), but do raise the "Por reagendar" count.

## 7. Not in this unit / limits

- Staff cannot **book** a conversation for a customer: only the bot does (the customer chooses the time in the chat).
- The customer is never told about `needsReschedule` automatically; the attendee reschedules and the section 3 notice rules apply.
- Reschedule needs the request still `NEW`; once claimed it is a live conversation (handoff 20) and the time no longer matters.
- Per-person calendars do not exist: the cap is per block and sucursal (`maxScheduledPerSlot`, handoff 16).
- The request detail has no history of previous times beyond the audit (`GET /chatbot-requests/:id/audit`, `RESCHEDULED` rows carry `from`, `to`, `requiresTemplate`, `scheduleVersion` and the actor).
