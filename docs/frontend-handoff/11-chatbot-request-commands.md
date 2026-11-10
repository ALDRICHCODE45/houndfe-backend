# Chatbot request inbox — staff commands: claim, release, reassign, cancel

**Status:** implemented on `feat/human-intervention` (human-intervention unit 2, slice 2b), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §2.5, §3.8, §3.10, §6.5, §12.11, §12.12, §12.14.

Shapes in this document come from the controller, DTOs, scoped filter and their specs (`src/chatbot-requests/**`). Nothing was sent to the dev API.

**Not in this slice:**
- The read routes (`GET /chatbot-requests/groups`, `/counts`, `/:id`, `/history`, `/assignable-users`) arrive with unit 4. Until then the FE has no `version` to send unless it comes from a command response.
- `resolve` arrives with unit 3 (it needs the wrapped stock, expiry, zone and receipt repositories).
- `reply`, `messages`, `template`, `finish`, `merge`, `link-customer` and `reschedule` arrive in later units.
- Phone masking (`toStaffPhone`) arrives with unit 4. The command response carries no phone and no `customerKey`.

## 1. Who can do what

Every route uses `JWT → tenant context → active user → CASL`. The tenant and the actor come from the JWT, never from the body.

| Route | CASL required | Extra rule |
| --- | --- | --- |
| `POST /chatbot-requests/:id/claim` | `read:ChatbotRequest` + `update:ChatbotRequest` | — |
| `POST /chatbot-requests/:id/release` | `read:ChatbotRequest` + `update:ChatbotRequest` | Releasing **someone else's** request also needs `update:ChatbotRequestAssignment`; without it: `403 NOT_ASSIGNEE` |
| `POST /chatbot-requests/:id/cancel` | `read:ChatbotRequest` + `update:ChatbotRequest` | Cancelling a request **held by someone else** also needs `update:ChatbotRequestAssignment`; without it: `403 NOT_ASSIGNEE` |
| `POST /chatbot-requests/:id/reassign` | `read:ChatbotRequest` + `update:ChatbotRequestAssignment` | `toUserId` must be an active member of this sucursal with `update:ChatbotRequest` |

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
| 403 | `NOT_ASSIGNEE` | Release or cancel of someone else's request without `update:ChatbotRequestAssignment` | ✓ |
| 404 | `NOT_FOUND` | No such request **in this sucursal** (another sucursal's id answers the same) | — |
| 409 | `VERSION_CONFLICT` | `expectedVersion` is stale, or you claim a request you already hold (second tab) | ✓ |
| 409 | `REQUEST_CLAIMED_BY_OTHER` | Claim of a request someone else holds | ✓ |
| 409 | `REQUEST_CLOSED` | The request is already `RESOLVED` or `CANCELLED` | ✓ |
| 409 | `CANCEL_NOT_ALLOWED` | Cancel of a live conversation (`STARTING`/`ACTIVE`/`ENDING`); from unit 11 | ✓ |
| 409 | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key` already used with another body or route | — |
| 422 | `ACTION_NOT_ALLOWED` | Release of a `NEW` request; reassign of a `NEW` request or to the current assignee | ✓ |
| 422 | `CANCEL_NOT_ALLOWED` | Cancel of a `DECISION` (stock, expiry, zone, receipt: close it with its negative action instead), or of a conversation that already ended | ✓ |
| 422 | `USER_NOT_ASSIGNABLE` | `toUserId` is not an active member with `update:ChatbotRequest` | — |
| 500 | `INTERNAL_ERROR` | Unexpected failure; retry with the **same** key | — |

**Order of checks:** `REQUEST_CLOSED` first, then `REQUEST_CLAIMED_BY_OTHER` / `NOT_ASSIGNEE`, then `VERSION_CONFLICT`, then the action rules. So a stale tab that tries to claim someone else's request sees who has it, not a bare version conflict.

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
- Candidates will come from `GET /chatbot-requests/assignable-users` (unit 4).

### 3.4 `POST /chatbot-requests/:id/cancel`

```json
{ "expectedVersion": 1, "reason": "NOT_ACTIONABLE", "note": "Pregunta fuera de giro", "customerNote": "Por ahora no podemos ayudarte con eso." }
```

| Field | Rule |
| --- | --- |
| `reason` | `DUPLICATE` \| `NOT_ACTIONABLE` \| `CUSTOMER_UNREACHABLE` \| `OTHER` |
| `note` | Internal, 1..500 chars. **Required** with `OTHER` |
| `customerNote` | Optional, 1..500 chars. The bot sends it to the customer instead of its generic notice (§12.14). Not sent with `DUPLICATE` |

- Allowed for `CLARIFICATION`, and for `TALK_TO_HUMAN`/`COMPLAINT` while the conversation has not started. Never for `DECISION` (`422 CANCEL_NOT_ALLOWED`).
- Result: `status: CANCELLED`, `closedAt` set, `version` + 1. The request leaves the open inbox.

## 4. Retry recipe

```text
key = uuid()                       // once per click
loop:
  res = POST …/claim  Idempotency-Key: key  { expectedVersion }
  network error / 5xx → retry with the SAME key and body
  200 → done (also for a replay)
  409/403/422 with current → patch the row from current; ask the user; a new attempt uses a NEW key
```
