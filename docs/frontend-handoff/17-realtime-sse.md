# Realtime stream (SSE): request changes and notifications

**Status:** implemented on `feat/human-intervention` (human-intervention unit 8; conversation events: unit 9), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §5.3, §6.4, §10.1 (R5, R6, R7, R12), §12.1, §12.2, §12.4, §12.8, and the v1.4 note in §15. Model and performance: `docs/chatbot-requests-model.md` ("Realtime stream"), `docs/perf/realtime-sse-load-results.md`.

Shapes in this document come from the controller, the hub, the shaper and the PostgreSQL integration spec `src/realtime/realtime-stream.integration.spec.ts` (a real HTTP client against a real socket). Nothing was sent to the dev API.

> **Not proven in the real deployment yet.** Buffering and idle timeouts of **Traefik / the Swarm are NOT verified**: the owner's test (an event arrives in under 1 s and the connection survives 30 minutes) is still pending (contract R6). **Until the owner confirms it, keep polling** (list every 30 s, `GET /notifications/unread-count`, counts) and treat the stream as an accelerator you can switch on behind a flag. The REST contract does not change when the stream is on, and nothing here replaces a REST read.

**Not in this unit** (the events below simply do not exist yet; keep the REST reads for them):
- `counts.changed`. Refetch `GET /chatbot-requests/counts` (debounced, for example 1 s) when a `request.*` event arrives.
- `session.*` (live conversations are unit 11). `conversation.message` and `message.status` **now exist** (unit 9): section 3.3.
- `permissions.changed` (the stream re-checks permissions itself, section 6).

## 1. Connecting

`GET /realtime/stream`, read with `fetch` (for example `@microsoft/fetch-event-source`), **not** `EventSource` (it cannot send `Authorization`).

| Header | |
| --- | --- |
| `Authorization: Bearer <access token>` | Required. The sucursal comes from the token; there is no tenant header or parameter. |
| `Last-Event-ID: <id>` | Optional. The last `id:` you processed; the server replays everything after it. `fetch-event-source` sends it by itself on its own retries; send it yourself when you reconnect by hand. |
| `?after=<id>` | Same as the header, for clients that cannot set it. The header wins when both are sent. |

Needs `read:ChatbotRequest` (the same as the inbox). The user must be active and a member of the sucursal.

| Status | When |
| --- | --- |
| `200` | The stream (`text/event-stream`). |
| `400 VALIDATION_ERROR` | `Last-Event-ID` / `after` is not 1 to 18 digits. No stream was started; do not retry with the same value. |
| `401` | No or expired token, or the user is inactive. Refresh the token; if that fails, log out. |
| `403` | No membership in the sucursal, or no `read:ChatbotRequest`. Do not retry. |
| `503 STREAM_CAPACITY` | This server is full (1 000 streams). `Retry-After: 5`; retry with backoff. |
| `503 REALTIME_UNAVAILABLE` | This server cannot serve realtime right now (its database listener did not start; transient). Sent **before** any SSE header, so it is a normal HTTP error, never an empty `200`. `Retry-After: 5`; retry with backoff. Keep polling meanwhile. The next attempt retries on the server; no restart is needed. |

Response headers (all anti-buffering, R6): `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, `Connection: keep-alive`, `Content-Encoding: identity` (so a proxy that compresses by default leaves it alone). There is no `Content-Length`. The body starts with `retry: 3000` (the reconnect hint in milliseconds).

**One connection per browser** (contract §12.2): keep a single stream in a leader tab (Web Locks or `BroadcastChannel`) and share the events with the other tabs. Name the channel with `userId` and `tenantId`, and close it when the session or the sucursal changes. The server allows **5 streams per user and sucursal**; the sixth replaces the oldest (section 5).

## 2. Message format

Standard SSE. Every message has `event:` and a JSON `data:` on one line. Messages that **change state** have `id:` (a number, increasing within a sucursal); control messages do not, except where noted, so they never move `Last-Event-ID`.

```text
id: 902118
event: request.claimed
data: {"request":{...},"customer":{...},"previousCustomerKey":null}

event: heartbeat
data: {"serverTime":"2026-11-12T01:28:44.294Z"}
```

Treat `id` as an opaque string and store the **last processed one** per `userId` + `tenantId`. Ids are only comparable within one sucursal.

## 3. Events

### 3.1 Request events: `request.*`

`request.created`, `request.claimed`, `request.released`, `request.reassigned`, `request.resolved`, `request.cancelled`, `request.overdue`, `request.updated`. Same payload for all:

```json
{
  "request": { /* the inbox row of handoff 14 section 3, complete */ },
  "customer": { "id": "…", "displayName": "Juan Pérez", "phone": "55 **** 5678", "isTrusted": false },
  "previousCustomerKey": null
}
```

- **`request` is the same row as `GET /chatbot-requests/groups`**, with every field of handoff 14 (section 14 included: `allowedActions`, `deniedActions`, `slaLevel`, `cancelReason`, `staffCancelReason`, `mergedInto`, `closedAt`, `resolvedBy`, `version`), **built for you**: `allowedActions` / `deniedActions` are computed with your permissions, and `customerKey` is the same opaque `k1.…` token you get from the REST routes, so you can place the row in its group.
- **`customer`** (additive to contract §12.8, see §15 of the proposal) is what a group header needs for a customer you may not have cached: `phone` is **masked unless you have `read:CustomerPhone`** (`"55 **** 5678"` vs `"+525512345678"`), exactly as in `groups`. `id` and `displayName` are `null` for an unlinked customer. **Never mask or unmask in the frontend.**
- **T7g (additive):** `request` carries `windowClosingSoon: boolean` like every inbox row (handoff 14 section 16): open request, `whatsappWindowClosesAt` set, closing within the sucursal's `windowWarningMinutes` from the moment the event is delivered; `false` for closed rows and rows with no window. It is the same rule as the `windowClosingSoon` filter. No event is sent when time alone flips it, so keep computing the live countdown from `whatsappWindowClosesAt` and treat this boolean as the server's value at delivery.
- **S9 (v1.5):** nothing was added to `request`, and there is no new event type. `customer` has the same four fields as the `customer` card of a history row (handoff 14 section 15.4). `overdueCount` of a group (handoff 14 section 15.3) and `counts.unassigned` are not in the stream: refetch the group or `counts` as for `openCount`.
- **`previousCustomerKey`** is `null` today (no command changes a request's `customerKey`). When it is present it is a sealed `k1.…` token like `customerKey`, never a phone: remove the row from that group and put it in the new one.
- **The row is the state at the moment the event is delivered**, not a snapshot of when it happened. After a reconnect you can receive three events for the same request, each with its latest row. That is intended: apply the row, do not replay transitions.
- **Applying a row (differs from contract §12.8, v1.4):** replace the cached row when `request.version` is **greater than or equal to** the cached one; ignore it only if it is **lower**. Equal must be applied because the SLA sweep and `link-customer` change a row **without** changing `version`: `request.overdue` sets `overdueAt` / `displayStatus: EXPIRED` / `slaLevel: OVERDUE`, and a milestone that only moves `slaLevel` arrives as `request.updated`, both with the same `version` as before. Applying an equal row is harmless because rows are always current.
- Place the row by `customerKey` and `mostUrgentAt` as in handoff 14; drop it from a view whose filters it no longer meets (for example `status=open` after `request.resolved` / `request.cancelled`).
- **What the row does not carry** and you must refetch when the detail is open: `audit[]`, `deliveries[]`, `decision`, `zoneImpact`, `customer.recentOrders`. Refetch `GET /chatbot-requests/:id` when the open request's `version` jumped by more than the event explains, or after `request.resolved` / `request.cancelled` / `request.reassigned` on it.
- **You only receive requests you may read.** A recipient without `read:ChatbotRequest` gets no row (and their stream is closed, section 6).

What each type means:

| Event | When |
| --- | --- |
| `request.created` | A request was created (bot, or a legacy restock / expiration / zone / receipt flow). Not sent for rows created by the backfill. |
| `request.claimed` / `request.released` | Claim; release (also the automatic release). |
| `request.reassigned` | Reassigned (the new assignee also gets a notification). |
| `request.resolved` | Resolved, including zone siblings resolved together and legacy-route resolves. |
| `request.cancelled` | Cancelled by staff or by the customer, **or merged into another request** (the source of a merge: `cancelReason: "SUPERSEDED"`, `mergedInto` set). |
| `request.overdue` | The SLA sweep marked it overdue (`overdueAt` set). |
| `request.updated` | A row change that is not a transition: an SLA milestone that moved `slaLevel` (50 % / 80 %), `link-customer`, a **reschedule** of a scheduled conversation and the **`needsReschedule` flag** (unit 14, handoff 21: both raise `version`, `scheduledFor` / `needsReschedule` change on the row), and (unit 9, S12) a change of `unreadCustomerMessages`: a customer message arrived in the request's chat, or someone opened the conversation. `version` does not change; apply it by the equal-version rule above. |

Events that are **not** announced: replies, templates and finish (units 10 and 11), delivery outcomes of the bot feed, and the **target** of a merge (its row did not change). New customer or bot messages are **not** a request event: they arrive as `conversation.message` (section 3.3) and do not change `version`.

### 3.2 Notifications

Only to the person they belong to, never to anyone else of the sucursal.

```text
event: notification.created
data: {"notification":{"id":"…","type":"REQUEST_CREATED","title":"Nueva solicitud","body":"Pregunta sin respuesta · S-000123","requestId":"…","createdAt":"…","readAt":null},"unreadCount":3}

event: notification.read
data: {"ids":["…"],"all":false,"unreadCount":2}
```

- `notification` has exactly the shape of `GET /notifications` items (handoff 13), including the Spanish `title` and `body` built by the server.
- `notification.read` is sent to the **same person's other tabs and devices** when they mark one notice (`ids: [id]`, `all: false`) or all of them (`ids: null`, `all: true`) as read. Repeating a read does not send a second event.
- **`unreadCount` is the person's count at the moment of delivery**: set your badge to it. It changes only with these two events. The 90-day retention does not announce anything: refetch `GET /notifications/unread-count` on connect and on `resync`.

### 3.3 Conversation events (unit 9)

Only to users with `read:ChatbotConversation` **and** `read:ChatbotRequest` (the same pair the REST page and the media proxy need); everyone else on the stream does not receive them. Full semantics (replace by `seq`, one event per open request of the chat, the message is the state at delivery) in `18-conversation.md` section 4.

```text
event: conversation.message
data: {"requestId":"…","message":{ /* the message of 18-conversation.md section 2 */ }}

event: message.status
data: {"requestId":"…","messageId":"…","seq":18,"deliveryStatus":"DELIVERED"}
```

- Both carry an `id:` and move `Last-Event-ID`; both replay after a reconnect.
- The payload never has the chat reference, the customer key or a phone (R12). They do not change `request.version` and do not touch the inbox row.
- `session.*` and the "attend without `read:ChatbotConversation`" case arrive with unit 11.

### 3.4 Control events

| Event | `id:` | `data` | What to do |
| --- | --- | --- | --- |
| `ready` | the current cursor (absent if the sucursal has no events yet) | `{"serverTime": "…", "heartbeatSeconds": 15}` | First message of every connection that came **without** a cursor. See section 4. |
| `heartbeat` | no | `{"serverTime": "…"}` | Every 15 s. If **nothing at all** arrives for **45 s**, consider the connection dead and reconnect with your `Last-Event-ID`. |
| `resync` | the current cursor | `{"reason": "CURSOR_EXPIRED" \| "REPLAY_TOO_LARGE" \| "DELIVERY_FAILED"}` | **Refetch your lists** (groups, counts, `GET /notifications/unread-count`, the open detail). The stream stays open and continues from now. |
| `auth-expired` | no | `{}` | The token reached its `exp`; the stream ends. Refresh the token and reconnect with `Last-Event-ID`. If the refresh fails, log out. |
| `access-revoked` | no | `{"reason": "USER_INACTIVE" \| "MEMBERSHIP_REMOVED" \| "PERMISSION_REVOKED"}` | The stream ends. **Do not reconnect in a loop.** Refetch the session / permissions (`/auth/me/permissions`); reconnect only if you still have `read:ChatbotRequest` in this sucursal, otherwise leave the inbox. |
| `connection-replaced` | no | `{}` | The user opened a 6th stream; this one (the oldest) ends. **Do not reconnect automatically**: show "Abierto en otra ventana" with a button to reconnect (this is what prevents two tabs from expelling each other forever). |
| `slow-consumer` | no | `{"reason": "BUFFER_FULL" \| "WRITE_BLOCKED" \| "BACKLOG"}` | The server dropped a connection that was not reading fast enough. Reconnect with your `Last-Event-ID`: nothing is lost, the log replays it. If it repeats, back off. |
| `server-shutdown` | no | `{"reason": "SHUTDOWN" \| "ERROR" \| "RESYNC_FAILED"}` | The server is restarting (deploy), hit an error while resuming, or (`RESYNC_FAILED`) could not deliver a batch and could not send you the `resync` either (database trouble). Reconnect with `Last-Event-ID` and backoff (the load balancer sends you to another instance): the log replays everything after your cursor, including what the server could not deliver. Do **not** treat it as `resync`; nothing was skipped for you. |
| `server-unavailable` | no | `{"reason": "REALTIME_UNAVAILABLE"}` | Rare: the server lost the ability to serve realtime after it had already accepted the connection (race with a transient failure). The response ends. Reconnect with `Last-Event-ID` and backoff (start at 5 s), as for `503 REALTIME_UNAVAILABLE`. |

All of them except `ready`, `heartbeat` and `resync` are followed by the end of the response.

## 4. Reconnect and replay (no event is lost)

The server keeps every event **24 hours** in a durable log. A connection with a cursor receives, in order, everything after it, and then the live events, with no gap and **no id repeated**.

Recommended client logic:

1. **First connection of a session (no cursor).** Open the stream, wait for `ready`, then fetch the lists (groups, counts, `unread-count`). Events that arrive while you fetch are applied by the version rule; an event older than the fetched list is ignored or harmless. Store the `id` of `ready` and of every later state-changing message.
2. **Reconnection** (network, `slow-consumer`, `server-shutdown`, `server-unavailable`, `auth-expired` after refreshing): send `Last-Event-ID` with the stored id. You do **not** need to refetch lists. Dedupe by `id` anyway (cheap): the log never repeats an id on one connection, but your own retry logic might.
3. **`resync`**: you were away more than 24 hours (`CURSOR_EXPIRED`) or missed more than 1 000 events (`REPLAY_TOO_LARGE`, a very busy sucursal), or the server could not deliver a batch after 5 attempts and skipped it (`DELIVERY_FAILED`, rare; the events of that batch are NOT replayed; if the server cannot even send you the `resync`, it closes the stream with `server-shutdown` `RESYNC_FAILED` and the reconnect replays them): refetch everything and continue with the id of the `resync` message. Treat every `reason` the same way; show nothing to the user.
4. **No stored cursor** (a new device, cleared storage): connect without one and follow step 1.

Backoff: start at the `retry:` value (3 s), double up to 30 s, add jitter. Reset it after a message arrives.

If the ticket expires mid-stream you get `auth-expired` exactly at the token's expiry; refresh a little before it to avoid the gap.

## 5. Limits

- **5 streams per user and sucursal.** Opening a 6th ends the oldest with `connection-replaced` (section 3.4).
- **1 000 streams per server instance** (`503 STREAM_CAPACITY`). The expected load is one stream per open browser.
- **Slow readers are dropped**: a connection that stays blocked for more than 10 s, or has more than 512 KiB waiting, is ended with `slow-consumer`. Process messages promptly (do not do heavy work inside the message handler).

## 6. Permissions are re-checked while you are connected

The stream never gives you more than the REST routes:

- **On every delivery** the server re-checks that the user is still active, still a member of the sucursal and still has `read:ChatbotRequest` (the check is shared for one second per user, so a burst of events costs one check). If not, you get `access-revoked` and **nothing else**: the event that triggered the check is not sent.
- **Every 5 minutes** the same check runs even if no event arrives.
- The rows are built with the **current** permissions: if `read:CustomerPhone` is removed, the very next event arrives with the masked phone, and `allowedActions` follow the new permissions.
- A request of another sucursal never reaches the stream, whatever its id.

## 7. What to refetch (summary)

| Situation | Refetch |
| --- | --- |
| `request.*` arrives | `GET /chatbot-requests/counts` (debounced); nothing else for the list |
| The open detail's request changes | `GET /chatbot-requests/:id` (for `audit[]`, `deliveries[]`, `decision`, `zoneImpact`) |
| `resync` | everything: groups, counts, unread count, the open detail |
| Connected after being offline with a valid cursor | nothing (replay) |
| `notification.*` | nothing: `unreadCount` is in the event |
| `access-revoked` | permissions / session |

## 8. Notes for testing

- A request created, claimed, released or cancelled from another browser or from the dev tools shows up on the stream in tens of milliseconds (measured p95 50 ms with 200 streams, `docs/perf/realtime-sse-load-results.md`; this is on one machine, not behind Traefik).
- To see `access-revoked`, deactivate the user or remove their role while the stream is open and trigger any request event.
- `curl -N -H "Authorization: Bearer $TOKEN" https://<api>/realtime/stream` shows the raw stream (use `-N` so curl does not buffer).
