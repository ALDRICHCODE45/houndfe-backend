# Chatbot request inbox — staff commands: claim, release, reassign, cancel, merge, link-customer

**Status:** implemented on `feat/human-intervention` (human-intervention unit 2, slice 2b; `merge` and `link-customer` in unit 4, slice 4b), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §2.5, §3.8, §3.10, §6.5, §12.11, §12.12, §12.14.

Shapes in this document come from the controller, DTOs, scoped filter and their specs (`src/chatbot-requests/**`). Nothing was sent to the dev API.

**Not in this slice:**
- The read routes (`GET /chatbot-requests/groups`, `/counts`, `/:id`, `/history`, `/assignable-users`) are documented in `14-chatbot-request-inbox.md`; the `version` to send comes from there.
- `resolve` is documented in `12-chatbot-request-resolve.md` (unit 3). It needs one more permission per subtype on top of `read`/`update:ChatbotRequest`.
- `reply` (answering a clarification) is documented in `19-clarification-replies.md` (unit 10). `messages`, `template`, `finish` and `reschedule` arrive in later units.
- Phone masking (`toStaffPhone`) arrives with unit 4. The command response carries no phone and no `customerKey`.

## 1. Who can do what

Every route uses `JWT → tenant context → active user → CASL`. The tenant and the actor come from the JWT, never from the body.

| Route | CASL required | Extra rule |
| --- | --- | --- |
| `POST /chatbot-requests/:id/claim` | `read:ChatbotRequest` + `update:ChatbotRequest` | — |
| `POST /chatbot-requests/:id/release` | `read:ChatbotRequest` + `update:ChatbotRequest` | Releasing **someone else's** request also needs `update:ChatbotRequestAssignment`; without it: `403 NOT_ASSIGNEE` |
| `POST /chatbot-requests/:id/cancel` | `read:ChatbotRequest` + `update:ChatbotRequest` | Cancelling a request **held by someone else** also needs `update:ChatbotRequestAssignment`; without it: `403 NOT_ASSIGNEE` |
| `POST /chatbot-requests/:id/reply` | `read:ChatbotRequest` + `update:ChatbotRequest` | Replying to a `NEW` clarification claims it for the replier in the same step (S13); a request held by **someone else** only by its holder, no override (`403 NOT_ASSIGNEE`); only `kind = CLARIFICATION`. See `19-clarification-replies.md` |
| `POST /chatbot-requests/:id/reassign` | `read:ChatbotRequest` + `update:ChatbotRequestAssignment` | `toUserId` must be an active member of this sucursal with `read:ChatbotRequest` and `update:ChatbotRequest` |

`merge` and `link-customer` are in sections 3.5 and 3.6 (both `read:ChatbotRequest` + `update:ChatbotRequest`; no extra permission, §3.10).

Initial grants (task log L2): Manager has all four; Cashier has `read`/`update:ChatbotRequest` only (claim, release own, cancel, no reassign). Super Admin acts through its tenant membership.

## 2. Common rules

### Headers

| Header | Rule |
| --- | --- |
| `Authorization: Bearer <jwt>` | Required |
| `Idempotency-Key: <uuid>` | Required on every command. Missing or not a UUID: `400 VALIDATION_ERROR`. Generate **one key per user attempt** and reuse it only for network retries of that same attempt |
| `Content-Type: application/json` | Body is JSON |

### Body

Every body has `expectedVersion` (integer ≥ 1): the `version` of the request the user is looking at. Unknown fields are rejected with `400`.

### Response

`200` with the request after the command. A replay of the same key and body answers the **same stored body**, even if the request changed since:

```json
{
  "request": {
    "id": "2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c",
    "folio": "S-000123",
    "kind": "CLARIFICATION",
    "subtype": "UNKNOWN_QUESTION",
    "status": "IN_PROGRESS",
    "displayStatus": "IN_PROGRESS",
    "version": 2,
    "assignee": { "id": "8d6f…", "displayName": "Ana" },
    "claimedAt": "2026-11-10T16:00:00.000Z",
    "overdueAt": null,
    "closedAt": null
  }
}
```

- `displayStatus` is `EXPIRED` for an open request with `overdueAt` set; otherwise it equals `status`.
- Unit 4 extends this object to the full inbox row (§3.8). Keys here will not change meaning.
- Responses carry `Cache-Control: no-store`.

### Errors

One envelope for every error on these routes, with key **`code`**:

```json
{ "statusCode": 409, "code": "REQUEST_CLAIMED_BY_OTHER", "message": "Another person already took this request",
  "current": { "version": 5, "status": "IN_PROGRESS", "claimedBy": { "id": "8d6f…", "displayName": "Luis" } } }
```

Switch on `code`, never on `message`. Command errors that come from the request's state carry `current`, so the FE can update the row without reloading.

| Status | `code` | When | `current` |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing/invalid `Idempotency-Key`, bad body, bad `:id`; `cancel` with `reason: OTHER` and no `note` | Only for the `OTHER` case |
| 401 | `UNAUTHORIZED` | No or expired JWT, inactive user | — |
| 403 | `INSUFFICIENT_PERMISSIONS` | Missing a permission from §1 | — |
| 403 | `FORBIDDEN` | No membership in the JWT's sucursal | — |
| 403 | `NOT_ASSIGNEE` | Release or cancel of someone else's request without `update:ChatbotRequestAssignment`; `reply` of a clarification **held by someone else** (no permission lifts it) | ✓ |
| 404 | `NOT_FOUND` | No such request **in this sucursal** (another sucursal's id answers the same) | — |
| 409 | `VERSION_CONFLICT` | `expectedVersion` is stale, or you claim a request you already hold (second tab) | ✓ |
| 409 | `REQUEST_CLAIMED_BY_OTHER` | Claim of a request someone else holds | ✓ |
| 409 | `REQUEST_CLOSED` | The request is already `RESOLVED` or `CANCELLED` | ✓ |
| 409 | `CANCEL_NOT_ALLOWED` | Cancel of a live conversation (`STARTING`/`ACTIVE`/`ENDING`); from unit 11 | ✓ |
| 409 | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key` already used with another body or route | — |
| 422 | `ACTION_NOT_ALLOWED` | Release of a `NEW` request; reassign of a `NEW` request or to the current assignee | ✓ |
| 422 | `CANCEL_NOT_ALLOWED` | Cancel of a `DECISION` (stock, expiry, zone, receipt: close it with its negative action instead), or of a conversation that already ended | ✓ |
| 422 | `USER_NOT_ASSIGNABLE` | `toUserId` is not an active member with `read:ChatbotRequest` and `update:ChatbotRequest` (an update-only user is refused) | — |
| 422 / 409 | `MERGE_NOT_ALLOWED` | `merge` rule not met (section 3.5); `409` for a different or missing conversation | ✓ |
| 422 | `CUSTOMER_PHONE_MISMATCH` | `link-customer` to a customer whose phone is not the request's (section 3.6) | ✓ |
| 500 | `INTERNAL_ERROR` | Unexpected failure; retry with the **same** key | — |

**Why a button is missing (v1.3).** The inbox rows and the detail (handoff 14, sections 14.1 and 14.4) carry `deniedActions: [{action, code}]` with the codes of this table that depend on the caller or the state: `INSUFFICIENT_PERMISSIONS`, `REQUEST_CLAIMED_BY_OTHER`, `NOT_ASSIGNEE` and `CANCEL_NOT_ALLOWED`. They are the same codes these commands answer, from the same rules, so a disabled button can show the reason the command would give. `allowedActions` on a row is a hint: the command can still answer `409` if the request changed after the list was read.

**Order of checks.** The first failing check answers; later ones are not evaluated. A stale tab that tries to claim someone else's request therefore sees who has it, not a bare version conflict.

| Route | Order |
| --- | --- |
| `claim` | `404 NOT_FOUND` → `REQUEST_CLOSED` → `REQUEST_CLAIMED_BY_OTHER` → `VERSION_CONFLICT` (stale version, or the request is not `NEW`) |
| `release` | `404` → `REQUEST_CLOSED` → `403 NOT_ASSIGNEE` → `VERSION_CONFLICT` → `422 ACTION_NOT_ALLOWED` (not `IN_PROGRESS`) → `CANCEL`-style live-session refusal (from unit 11) |
| `reassign` | `422 USER_NOT_ASSIGNABLE` (checked first, before the request is even looked up) → `404` → `REQUEST_CLOSED` → `VERSION_CONFLICT` → `422 ACTION_NOT_ALLOWED` (not `IN_PROGRESS`, or `toUserId` is already the assignee) |
| `cancel` | `404` → `REQUEST_CLOSED` → `422 CANCEL_NOT_ALLOWED` for a `DECISION` → `400 VALIDATION_ERROR` for `OTHER` without `note` → `403 NOT_ASSIGNEE` → `VERSION_CONFLICT` → live-session `CANCEL_NOT_ALLOWED` (409 while it runs, 422 once ended; from unit 11) |
| `reply` | `404` → `REQUEST_CLOSED` → `422 ACTION_NOT_ALLOWED` (not a clarification) → `403 NOT_ASSIGNEE` → `VERSION_CONFLICT`; `400` for the text is answered before any of them |

`merge` and `link-customer` list their own order of checks in sections 3.5 and 3.6; a target-side `409` of `merge` carries `current` of the target plus `intoRequestId`.

**Failed commands store nothing.** Retrying the same key after a `409`/`422` evaluates the command again against the current request.

## 3. Routes

### 3.1 `POST /chatbot-requests/:id/claim`

Body: `{ "expectedVersion": 1 }`. `NEW` → `IN_PROGRESS`, assignee = caller, `version` + 1.

Two people (or two tabs) claim at once: exactly one gets `200`; the other gets `409 REQUEST_CLAIMED_BY_OTHER` (or `VERSION_CONFLICT` for the same person) with `current.claimedBy`.

### 3.2 `POST /chatbot-requests/:id/release`

Body: `{ "expectedVersion": 2 }`. `IN_PROGRESS` → `NEW`, assignee cleared, `version` + 1.

### 3.3 `POST /chatbot-requests/:id/reassign`

```json
{ "expectedVersion": 2, "toUserId": "3c1f…", "note": "Cambio de turno" }
```

- `toUserId`: string, 1..100 chars. Only an `IN_PROGRESS` request can be reassigned; the status stays `IN_PROGRESS`, the assignee changes, `claimedAt` restarts.
- `note`: optional, 1..500 chars; it is kept in the audit only.
- Candidates come from `GET /chatbot-requests/assignable-users` (handoff 14, section 13): the list is exactly the set this route accepts.

### 3.4 `POST /chatbot-requests/:id/cancel`

```json
{ "expectedVersion": 1, "reason": "NOT_ACTIONABLE", "note": "Pregunta fuera de giro", "customerNote": "Por ahora no podemos ayudarte con eso." }
```

| Field | Rule |
| --- | --- |
| `reason` | `DUPLICATE` \| `NOT_ACTIONABLE` \| `CUSTOMER_UNREACHABLE` \| `OTHER` |
| `note` | Internal, 1..500 chars. **Required** with `OTHER` |
| `customerNote` | Optional, 1..500 chars. Stored now. It reaches the bot **from unit 5, when the feed exists**; the bot then sends it instead of its generic notice (§12.14). Not sent with `DUPLICATE` |

- Allowed for `CLARIFICATION`, and for `TALK_TO_HUMAN`/`COMPLAINT` while the conversation has not started. Never for `DECISION` (`422 CANCEL_NOT_ALLOWED`).
- Result: `status: CANCELLED`, `closedAt` set, `version` + 1. The request leaves the open inbox.

### 3.5 `POST /chatbot-requests/:id/merge`

```json
{ "expectedVersion": 2, "intoRequestId": "9d1e…", "intoExpectedVersion": 4 }
```

`:id` is the request that **disappears** (the source); `intoRequestId` is the one that stays. Candidates, with their `id` and `version`, come from `GET /chatbot-requests/:id/merge-candidates` (handoff 14, section 10); `MERGE` is in `allowedActions` only when the caller may merge this request **and** there is at least one candidate.

- **`intoExpectedVersion` is required** (v1.2 deviation from contract §12.11, which lists only `expectedVersion` and `intoRequestId`): the version of the request that stays, so a merge never lands on one that changed under you (for example, a colleague just took it). Missing → `400`. It is only checked: the target's `version` does **not** go up.
- **Rules** (§12.11): same customer, same subtype, both open, only `UNKNOWN_QUESTION`, `TALK_TO_HUMAN` and `COMPLAINT` (never a decision), neither with a started live session, and **both in the same conversation**: the same non-null `conversationRef` (a merge across conversations, or of a request with none, is `409 MERGE_NOT_ALLOWED`). The candidate list already applies all of these.
- **Who may merge.** Merging a request **held by someone else** needs `update:ChatbotRequestAssignment`, exactly like cancelling it (owner decision; same check order as `cancel`): without it, `403 NOT_ASSIGNEE` with the current holder. The holder merges their own request with plain `update:ChatbotRequest`. Who holds the **target** does not matter.
- Result `200 {request}` is the **source**: `status: CANCELLED`, `closedAt` set, `version` + 1 (the cancel reason is `SUPERSEDED`, not a staff reason). Both requests get a `MERGED` audit event (`data.role` is `SOURCE` or `TARGET`, with the other request's id and folio). **The target's `version` does not change** (reload it only if you show it): so two sources merged into one target at once both succeed.
- If the source was held by someone **else**, that person gets an in-app notice "Otra persona la unió con otra solicitud del cliente". Nobody is notified when you merge your own.
- **The bot is told** with one informational feed item `request.merged {requestId, intoRequestId, conversationRef}`, created in the same transaction (nothing is created when the merge is rejected). When the target is answered later only the target gets an answer; nothing is sent for the source. See `docs/chatbot-handoff/chatbot-requests-bot-contract.md`.
- Errors, in the order they are checked (the first failure answers):

  | Status | `code` | When | `current` |
  | --- | --- | --- | --- |
  | `404` | `NOT_FOUND` | `:id` or `intoRequestId` does not exist in this sucursal (the other sucursal's id answers the same) | — |
  | `422` | `MERGE_NOT_ALLOWED` | A wrapped subtype (stock, expiry, zone, receipt, discount), checked first and before anything is locked | the failing request |
  | `409` | `MERGE_NOT_ALLOWED` | The two are not in the same conversation, or one has none; also checked before anything is locked (and again under the lock) | the target, plus `intoRequestId` |
  | `409` | `REQUEST_CLOSED` | The source is already closed | source |
  | `403` | `NOT_ASSIGNEE` | The source is held by someone else and you lack `update:ChatbotRequestAssignment` | source |
  | `409` | `VERSION_CONFLICT` | `expectedVersion` is stale | source |
  | `422` | `MERGE_NOT_ALLOWED` | Merged into itself, another subtype, another customer, a closed target or a started session on either | source (or target) |
  | `409` | `VERSION_CONFLICT` | `intoExpectedVersion` is stale | **the target**, and the body adds `intoRequestId` so you can tell which side moved |

- A pair merged in both directions at the same time: exactly one wins (`200`), the other answers `422 MERGE_NOT_ALLOWED` (its target is now closed). No deadlock.

### 3.6 `POST /chatbot-requests/:id/link-customer`

```json
{ "expectedVersion": 1, "customerId": "0c1d…" }
```

R1: when several customers share the request's phone, the bot leaves it unlinked (`customer.ambiguous: true` in the detail) and staff picks one of `customer.candidates[]` (handoff 14, section 8). `LINK_CUSTOMER` in `allowedActions` says the button applies: the request is open, has no customer, has a phone identity **and at least one candidate customer exists**.

- The server checks that the customer belongs to this sucursal **and** that its canonical phone is the request's phone (`521…` and `52…` are the same number). The user does **not** need `read:CustomerPhone`: the candidates come masked and the server proves the match.
- Result `200 {request}`: the request, `version` + 1 and a `CUSTOMER_LINKED` audit event. It also links **every other request of the same phone that has no customer** (open or closed) and clears their ambiguity, with a `CUSTOMER_LINKED` event each; those other requests keep their `version`. The phone does not change, so inbox groups do not move: reload the detail to show the customer card.
- Allowed on an open request whoever holds it. Not for a request that already has a customer, nor a legacy `unknown:` request (no phone to match): `422 ACTION_NOT_ALLOWED`.
- Errors, **in the order the code checks them** (the first failure answers):

  | Status | `code` | When | `current` |
  | --- | --- | --- | --- |
  | `404` | `NOT_FOUND` | The request does not exist in this sucursal (another sucursal's id answers the same) | — |
  | `409` | `REQUEST_CLOSED` | The request is closed | ✓ |
  | `409` | `VERSION_CONFLICT` | `expectedVersion` is stale (also when a claim got there first) | ✓ |
  | `422` | `ACTION_NOT_ALLOWED` | Already linked, or an `unknown:` request | ✓ |
  | `404` | `NOT_FOUND` | The `customerId` does not exist **in this sucursal** (a customer of another sucursal answers the same, even with the same phone). Checked **after** the request's own state, so a closed or stale request answers its state error, not this one | — |
  | `422` | `CUSTOMER_PHONE_MISMATCH` | The customer's phone is not the request's phone (or the customer has none) | ✓ |
  | `409` | `VERSION_CONFLICT` | Very rare: a request of the same phone with a delivery zone was created at the very moment you linked, and it happened twice in a row. Nothing was changed; reload and retry | ✓ |

- Two people linking the same phone at once: one wins; the other gets `422 ACTION_NOT_ALLOWED` (already linked). A claim of another request of the same phone at the same moment succeeds and keeps its claim.

## 4. Retry recipe

```text
key = uuid()                       // once per click
loop:
  res = POST …/claim  Idempotency-Key: key  { expectedVersion }
  network error / 5xx → retry with the SAME key and body
  200 → done (also for a replay)
  409/403/422 with current → patch the row from current; ask the user; a new attempt uses a NEW key
```
