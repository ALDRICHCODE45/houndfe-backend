# Caja redesign — recipients, session filters, closing filter, close contract

**Status:** T1 (S1–S6) merged in main (`0b985890`). T2 (S7, §3.1 and `openedAt` in §6) implemented on branch `feat/cash-closings-list-fields`, **not merged, not pushed, not deployed**. **No migration.** Task: `odd/tasks/cash-redesign-reads.md`.

Shapes come from the code and its specs: `src/cash-register/presentation/cash-handover.controller.ts`, `cash-session.controller.ts`, `cash-closing.controller.ts`, `presentation/dto/query.dto.ts`, `infrastructure/cash-adapter-recipients.ts`, `cash-adapter-queries.ts`, `cash-adapter-list-scope.ts`, `cash-adapter-closing.ts`, `src/shared/filters/domain-exception.filter.ts`, and the specs `presentation/cash-register.controller.spec.ts`, `infrastructure/cash-adapter-queries.spec.ts`, `infrastructure/prisma-cash-register.redesign-reads.integration.spec.ts` (real PostgreSQL). Nothing was sent to the dev API.

Everything else (auth, `Idempotency-Key`, blind rules, envelopes) is in the full contract [docs/cash-register-closing.md](../cash-register-closing.md). This file adds, it does not repeat.

## 1. `GET /cash-handovers/recipients?kind=WITHDRAWAL|FLOAT` (new, S2)

Who the cashier can hand cash to. It replaces the raw UUID field.

- **Permission:** `create:CashHandover` (the sender's own permission). `read:User` is **not** needed.
- **Query:** `kind` is **required** and must be `WITHDRAWAL` or `FLOAT`. A missing/other value or any other key → `400`.
- **Response `200`:**

```json
{
  "items": [
    { "userId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", "displayName": "Beatriz Admin", "roleName": "Administrador" },
    { "userId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f", "displayName": "Luis Supervisor", "roleName": "Supervisor" }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `userId` | UUID string | Send it as `recipientUserId` in `POST /cash-sessions/:id/handovers`. |
| `displayName` | string | `User.name`. |
| `roleName` | string | The name of the role in this sucursal that grants receipt. If several of the user's roles grant it, the names are sorted and joined with `", "`. |

Rules:

- A user is listed when they are **active** (`isActive`), are a **member of the current sucursal** (tenant from the JWT), and one of their roles in this sucursal grants **`update:CashHandover`** (the receipt permission). A role with `manage:all` (or `manage:CashHandover`, `update:all`) counts, exactly like the app's own permission check.
- **Self rule:** for `kind=WITHDRAWAL` the caller is **never** listed, because the backend rejects a withdrawal to oneself (`422 CASH_HANDOVER_SELF_WITHDRAWAL`). For `kind=FLOAT` the caller **is** listed when they hold `update:CashHandover` (keeping one's own float is allowed).
- Sorted by `displayName` (Spanish collation, case- and accent-insensitive), then `userId`. No paging (it is the sucursal staff).
- No email and no other user data is returned.
- The list is a hint. Creating and receiving the handover still run the authoritative checks.

Errors: `401` (no/invalid token), `403 INSUFFICIENT_PERMISSIONS` (no `create:CashHandover`), `400` (query), `422 CASH_ACTOR_INACTIVE` / `CASH_TENANT_MEMBERSHIP_REQUIRED` (the caller is inactive or not in the sucursal).

## 2. `GET /cash-sessions` — new `status` and `drawerOpen` filters (S3)

| Param | Values | Meaning |
| --- | --- | --- |
| `status` | `OPEN`, `COUNTING`, `SUBMITTED`, `CLOSED` | Exact lifecycle, **any of**. Repeat the param (`status=OPEN&status=COUNTING`) or send a comma list (`status=OPEN,COUNTING`); both work and duplicates are ignored. Unknown or lowercase value, or empty `status=` → `400`. |
| `drawerOpen` | `true` \| `false` | `true` = the drawer is still held (`drawerReleasedAt: null`); `false` = released. Anything else → `400`. |

- **Every filter narrows.** `status`, `drawerOpen`, `pendingOnly`, `cashierUserId`, `registerId`, `from`/`to` combine with AND. `pendingOnly=true` (`COUNTING` or `SUBMITTED`) together with `status` gives the **intersection**: `pendingOnly=true&status=OPEN,SUBMITTED` returns only `SUBMITTED`; `pendingOnly=true&status=OPEN` returns an empty page (`total: 0`).
- **Visibility unchanged.** Without `read:CashSessionAudit` you only see your own sessions; filtering by another cashier returns an empty page. The blind projection rules are unchanged.
- Suggested use: «Tu turno» = `status=OPEN,COUNTING,SUBMITTED&drawerOpen=true` with the own-sessions scope; supervisor = `status=SUBMITTED` (to verify/close) and `drawerOpen=true` (drawers still held).
- Order: `openedAt` newest first; equal `openedAt` values are ordered by `id` (descending) so pages are stable.

## 3. `GET /cash-closings` — `cashierUserId` now filters (S4)

`cashierUserId` (UUID) keeps only cuts whose **closed session** belongs to that cashier (not who closed it). It narrows together with `registerId` and `from`/`to`. Without `read:CashSessionAudit` you still only see cuts you closed or cuts of your own sessions, so filtering by another cashier returns only the cuts you closed for them. Order: `createdAt` newest first, then `id`.

### 3.1 List item fields: register, cashier, difference (S7)

Each item of `GET /cash-closings` now also carries the register, the cashier and the cut's difference, so the list no longer needs `GET /cash-closings/:id` per row. Existing keys are unchanged.

```json
{
  "items": [
    {
      "id": "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "sessionId": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
      "folio": "CC-000124",
      "createdAt": "2026-11-05T22:45:30.120Z",
      "register": { "id": "a1f3e0b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "name": "Caja Mostrador 2" },
      "cashier": { "userId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f", "displayName": "Ana Cajera" },
      "differenceCents": -500
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `register` | `{ id, name }` \| null | The closed session's register. `name` is the register's **current** name (string \| null). |
| `cashier` | `{ userId, displayName }` \| null | The closed session's cashier (not who closed it). `displayName` is the **current** `User.name` (string \| null). |
| `differenceCents` | integer \| null | Frozen cash difference **declared − expected** (physical cash), read from the snapshot: `comparison.declarationDifferenceCents`, or `declaredCents − expectedCents` when an old snapshot has no `comparison`. Negative = shortage. `null` when the snapshot has neither. Never recomputed from live data. |

- `register`/`cashier` are `null` only if the source session cannot be read (not expected; the database keeps the link).
- Names here are current; the closing detail and PDF keep the names **frozen at close** (`snapshot.registerName`, `snapshot.cashierName`). If a register or user was renamed later, the list and the detail can differ.
- `differenceCents` is the same "declared − expected" value as `comparison.declarationDifferenceCents` in §6 and as the session list's `differenceCents`. The verifier's difference (verified − declared) stays in the detail only.
- Visibility, filters, order and paging are unchanged (§3, §4). The fields are filled with a fixed number of batched lookups per page (no per-row reads).

### 3.2 Closing folio format (pdf-a4-redesign T6)

New closings get a **per-sucursal consecutive folio**: `CC-` + the sequence zero-padded to 6 digits (`CC-000001`, `CC-000124`); past `999999` it simply grows (`CC-1000000`), never truncated. Each sucursal has its own sequence starting at `CC-000001`, and concurrent closings in one sucursal never share a number.

Closings created **before** this change keep their stored folio untouched, which is UUID-shaped (`CC-3f9a1c2b-7d4e-4b8a-9c01-5e6f7a8b9c0d`). There is no backfill: `GET /cash-closings` can return both shapes, so treat `folio` as an opaque string (the field is still unique per sucursal). The closing PDF shortens an old UUID folio to `CC-3f9a1c2b` when it prints it; the API value is unchanged.

## 4. Real paging (S5)

Both lists (`/cash-sessions`, `/cash-closings`) now filter, count and page **in the database** (`skip`/`take`, `total` from a count) when the caller's cash permissions are plain grants, which is every role the app builds today. Results, `total` and order are the same as before (proved by a spec comparing both paths page by page). The response shape `{ items, page, limit, total }` does not change.

## 5. `POST /cash-sessions/:id/close` — exact contract (S6)

**Permission:** `create:CashClosing`. **Headers:** `Authorization: Bearer …`, `Idempotency-Key: <1–200 chars after trim>`, `Content-Type: application/json`.

**Body** (optional; it may be empty or omitted):

```json
{ "notes": "Cierre sin novedad" }
```

`notes`: optional string, trimmed, must not be empty after trim, max 2000 chars. `null` or any other key → `400`.

**Response `201`** (`snapshot` keys in §6):

```json
{
  "id": "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "sessionId": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
  "folio": "CC-000124",
  "createdAt": "2026-11-05T22:45:30.120Z",
  "snapshot": {
    "sessionId": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
    "tenantId": "ced6cc10-a037-4f41-92af-ee69bbb51c8b",
    "registerId": "a1f3e0b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
    "folio": "CC-000124",
    "cashierUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f",
    "openingCents": 100000,
    "expectedCents": 150000,
    "declaredCents": 149500,
    "verifiedCents": 149500,
    "verifierUserId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    "channels": [
      { "channelKey": "CASH", "channelLabel": "Efectivo", "method": "CASH", "expectedCents": 150000, "declaredCents": 149500, "verifiedCents": 149500, "differenceCents": -500 },
      { "channelKey": "METHOD:CARD_DEBIT", "channelLabel": "Tarjeta de débito", "method": "CARD_DEBIT", "expectedCents": 32000, "declaredCents": 32000, "verifiedCents": 32000, "differenceCents": 0 }
    ],
    "handovers": [
      { "handoverId": "e4b1c7d2-9a3f-4e6b-8c5d-1f2a3b4c5d6e", "kind": "WITHDRAWAL", "declaredCents": 49500, "receivedCents": 49500, "senderUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f", "receiverUserId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", "receiptActorUserId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", "declaredAt": "2026-11-05T22:20:00.000Z", "receivedAt": "2026-11-05T22:25:00.000Z", "senderName": "Ana Cajera", "receiverName": "Luis Supervisor", "receiptActorName": "Luis Supervisor" },
      { "handoverId": "f5c2d8e3-0b4a-4f7c-9d6e-2a3b4c5d6e7f", "kind": "FLOAT", "declaredCents": 100000, "receivedCents": 100000, "senderUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f", "receiverUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f", "receiptActorUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f", "declaredAt": "2026-11-05T22:21:00.000Z", "receivedAt": "2026-11-05T22:22:00.000Z", "senderName": "Ana Cajera", "receiverName": "Ana Cajera", "receiptActorName": "Ana Cajera" }
    ],
    "countedAt": "2026-11-05T22:12:00.000Z",
    "verifiedAt": "2026-11-05T22:18:00.000Z",
    "closedAt": "2026-11-05T22:45:30.000Z",
    "closedByUserId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    "openedAt": "2026-11-05T14:00:00.000Z",
    "registerName": "Caja Mostrador 2",
    "cashierName": "Ana Cajera",
    "verifierName": "Luis Supervisor",
    "closedByName": "Luis Supervisor",
    "declarationNotes": "Faltan 5 pesos de cambio",
    "verificationNotes": null,
    "comparison": {
      "expectedCents": 150000,
      "declaredCents": 149500,
      "verifiedCents": 149500,
      "declarationDifferenceCents": -500,
      "verificationDifferenceCents": 0,
      "verifiedVsExpectedDifferenceCents": -500,
      "requiresDeclarationNotes": true,
      "requiresVerificationNotes": false,
      "hasDiscrepancy": true
    },
    "closingNotes": "Cierre sin novedad"
  }
}
```

(Fictional, self-consistent values.) `GET /cash-closings/:id` returns the same document. Replaying the same `Idempotency-Key` with the same body returns the stored `201` document again, even after the session is closed.

### Errors, in the order the backend checks them

The first failing check wins. Guards run before pipes. When several of `:id`, the body and `Idempotency-Key` are invalid at once, which 400 is returned is not guaranteed (all are 400); after them, the domain checks below run in this order.

Body shapes: guard/domain errors are `{ "statusCode", "error": "<CODE>", "message", "timestamp" }` plus the listed detail keys at top level; a `400` from DTO validation is Nest's `{ "statusCode": 400, "error": "Bad Request", "message": [<ValidationError>…] }`; a `400` from the UUID pipe is `{ "statusCode": 400, "error": "Bad Request", "message": "Validation failed (uuid is expected)" }`. Switch on `error`, never on `message`. **There is no cash `404`/`409`: every `CASH_*` error is `422`.**

| # | HTTP | `error` | Requirement not met | Detail keys |
| --- | --- | --- | --- | --- |
| 1 | 401 | `Unauthorized` | Bearer token missing/invalid, or no tenant in it | — |
| 2 | 403 | `INSUFFICIENT_PERMISSIONS` | Caller lacks `create:CashClosing` | — |
| 3 | 400 | `Bad Request` | `:id` is not a UUID | — |
| 4 | 400 | `Bad Request` | Body: `notes` `null`, not a string, empty after trim, > 2000 chars, or an extra key | — |
| 5 | 400 | `INVALID_IDEMPOTENCY_KEY` | `Idempotency-Key` missing, empty after trim, or > 200 chars | — |
| 6 | 422 | `CASH_IDEMPOTENCY_CONFLICT` | Same key already used with a different body/actor/session (or a concurrent request with the same key won) | `key` |
| 7 | 422 | `CASH_ACTOR_INACTIVE` | Caller user is inactive | `userId` |
| 8 | 422 | `CASH_TENANT_MEMBERSHIP_REQUIRED` | Caller is not a member of the sucursal | `userId`, `tenantId` |
| 9 | 422 | `CASH_SESSION_NOT_FOUND` | No such session in this sucursal (also another sucursal's id) | `sessionId` |
| 10 | 422 | `CASH_PERMISSION_DENIED` | `create:CashClosing` rechecked against the session fails | `action`, `subject`, `userId` |
| 11 | 422 | `CASH_SESSION_NOT_WRITABLE` | Status is not `SUBMITTED` (`OPEN`, `COUNTING`, or already `CLOSED` — a second close lands here) | `sessionId`, `status` |
| 12 | 422 | `CASH_SELF_CLOSING_FORBIDDEN` | Closer is the session's cashier | `cashierUserId` |
| 13 | 422 | `CASH_DRAWER_NOT_RELEASED` | `release-drawer` has not been done | `sessionId` |
| 14 | 422 | `CASH_VERIFICATION_REQUIRED` | No independent verification exists | `sessionId` |
| 15 | 422 | `CASH_DISCREPANCY_NOTES_REQUIRED` | A channel (any channel, then the cash totals) has a declared≠expected difference without declaration notes (`stage: "DECLARATION"`), or a verified≠declared difference without verification notes (`stage: "VERIFICATION"`). Fix with `declaration-notes` (stage DECLARATION). | `stage` |
| 16 | 422 | `CASH_CUSTODY_NOT_RECEIVED` | A handover of this session is not received yet | `handoverId` |
| 17 | 422 | `CASH_HANDOVER_ALLOCATION_MISMATCH` | The handovers' declared amounts do not add up exactly to the declared cash | `declaredCents`, `allocatedCents` |

Defensive codes that the normal flow cannot reach (the earlier steps guarantee their data), listed so the UI can map them to a generic error: `CASH_SESSION_NOT_WRITABLE` with message "Expected snapshot is missing for closing" (`sessionId`), `CASH_DECLARATION_NOT_FOUND` (`sessionId`), `CASH_COUNT_MISSING_CHANNEL` (`channelKey`), `CASH_HANDOVER_DUPLICATE_ALLOCATION` (`handoverId`), `CASH_CENTS_OUT_OF_RANGE` / `CASH_ARITHMETIC_OVERFLOW`, `CASH_SNAPSHOT_SESSION_NOT_CLOSED`, `CASH_FOLIO_REQUIRED`, `CASH_IDENTITY_REQUIRED`, `CASH_DATE_INVALID`, and `CASH_IDEMPOTENCY_KEY_REQUIRED` / `CASH_IDEMPOTENCY_KEY_TOO_LONG` (the header pipe answers `400` first). Concurrent closes are serialized by a row lock: the loser gets `CASH_SESSION_NOT_WRITABLE` (row 11).

Suggested readiness checklist for the detail screen (all from `GET /cash-sessions/:id`): `session.status === "SUBMITTED"`; `session.cashierUserId !== me`; `session.drawerReleasedAt !== null`; a `counts[]` entry with `kind: "VERIFICATION"`; every `handovers[]` item has `receivedAt`; the backend still decides.

## 6. Closing snapshot fields (verified against the code)

The snapshot is frozen at close; it is never recomputed. Field list checked against `createCashClosingSnapshot` (`src/cash-register/domain/cash-snapshot.ts`) and `close()` (`cash-adapter-closing.ts`, which adds `openedAt` and the display extras); it matches [cash-register-closing.md](../cash-register-closing.md#frozen-snapshot-closing-detail-and-pdf).

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId`, `tenantId`, `registerId` | UUID string | Source session, sucursal, register. |
| `folio` | string | Same as the top-level `folio`. New closings: `CC-000124` (see *Closing folio format*); closings made before that change keep `CC-<uuid>`. |
| `cashierUserId` | UUID string | Session owner. |
| `openingCents` | integer | Opening fund (counted once). |
| `expectedCents` | integer | Expected **physical cash** (`CASH` channel) at freeze. |
| `declaredCents` | integer | Cash in the latest declaration revision (same amounts as revision 1). |
| `verifiedCents` | integer \| null | Cash counted by the verifier. Always a number in a cut made by close (verification is required). |
| `verifierUserId` | UUID string \| null | Verifier. Always set by close. |
| `channels[]` | array | One per frozen channel: `channelKey` (string), `channelLabel` (string), `method` (`CASH`\|`CARD_CREDIT`\|`CARD_DEBIT`\|`TRANSFER`), `expectedCents` (int), `declaredCents` (int), `verifiedCents` (int \| null), `differenceCents` (int, **declared − expected only**). |
| `handovers[]` | array | Every handover of the session: `handoverId` (UUID), `kind` (`WITHDRAWAL`\|`FLOAT`), `declaredCents` (int), `receivedCents` (int \| null), `senderUserId` (UUID), `receiverUserId` (UUID \| null; the designated recipient), `receiptActorUserId` (UUID \| null), `declaredAt` (ISO), `receivedAt` (ISO \| null), plus the **optional** names `senderName`, `receiverName`, `receiptActorName` (string \| null; see below). At close all are received, so the nullable ones are set. No guaranteed order: sort by `declaredAt` in the UI. |
| `countedAt` | ISO string | Time of the **original** declaration (revision 1), not of later notes. |
| `verifiedAt` | ISO string \| null | Verification time. Always set by close. |
| `closedAt` | ISO string | Close time (server clock, can differ by milliseconds from the top-level `createdAt`). |
| `closedByUserId` | UUID string | Closer. |
| `openedAt` | ISO string \| null | Session opening time, frozen at close (T2/S7). **`null` for cuts closed before T2**: those snapshots never stored it, and the backend does not fill it from the live session because the cut is frozen. Use `GET /cash-sessions/:id` → `session.openedAt` if you need it for an old cut. The PDF shows it as «Apertura» only when present. |
| `registerName` | string \| null | Register name at close. |
| `cashierName`, `verifierName`, `closedByName` | string \| null | `User.name` at close (`null` only if the user row is missing; absent on very old cuts, see the read-time fill below). |
| `handovers[].senderName`, `.receiverName`, `.receiptActorName` | string \| null, **optional** (pdf-a4-redesign T2) | `User.name` of the handover's sender / designated recipient / receipt actor, frozen at close with one batched read (`null` when the id is null or the user row is missing). **The key can be absent**: cuts closed before T2 never stored it. `GET /cash-closings/:id` fills an absent name with the user's **current** name at read time (display only, tenant-scoped, frozen names win; the row is not rewritten); if it still cannot be resolved the key stays absent/`null`, so render a fallback such as «Usuario sin nombre» instead of the UUID. The same read-time fill applies to a missing `cashierName`/`verifierName`/`closedByName`. The PDF already prints names only. |
| `declarationNotes` | string \| null | Notes of the latest declaration revision. |
| `verificationNotes` | string \| null | Verifier notes. |
| `comparison` | object | Cash totals: `expectedCents`, `declaredCents`, `verifiedCents` (int \| null), `declarationDifferenceCents` (declared − expected), `verificationDifferenceCents` (verified − declared, int \| null), `verifiedVsExpectedDifferenceCents` (int \| null), `requiresDeclarationNotes`, `requiresVerificationNotes`, `hasDiscrepancy` (booleans). |
| `closingNotes` | string \| null | Body `notes` of the close. |

Totals are physical cash only; never add non-cash channels into them. Show the two differences separately.

## 7. `GET /cash-registers` — drawer hold per register (cash-register-held-by)

**Status:** implemented on branch `feat/cash-register-held-by`. Additive response fields only: no new route, permission, query param or migration. Proposal and evidence: [docs/proposals/cash-register-held-by.md](../proposals/cash-register-held-by.md).

Fixes the «Abrir caja» selector showing «Disponible» for a register whose opening then fails with `422 CASH_REGISTER_UNRELEASED_SESSION`.

- **Permission:** unchanged, `read:CashRegister`. The per-row register filter is unchanged too. Hold fields are only computed for the registers you can already see.
- **Response `200`.** Each item keeps `id`, `name`, `isActive` and `createdAt`, and adds four keys:

```json
{
  "items": [
    {
      "id": "a1f3e0b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
      "name": "Caja Mostrador 1",
      "isActive": true,
      "createdAt": "2026-10-01T12:00:00.000Z",
      "drawerHeld": true,
      "drawerHeldStatus": "COUNTING",
      "drawerHeldSince": "2026-11-26T09:12:00.000Z",
      "heldBy": null
    },
    {
      "id": "b2e4f1c3-4d5e-4f6a-9b0c-1d2e3f4a5b6c",
      "name": "Caja Mostrador 2",
      "isActive": true,
      "createdAt": "2026-10-01T12:00:00.000Z",
      "drawerHeld": true,
      "drawerHeldStatus": "OPEN",
      "drawerHeldSince": "2026-11-26T08:30:00.000Z",
      "heldBy": {
        "sessionId": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
        "status": "OPEN",
        "openedAt": "2026-11-26T08:30:00.000Z",
        "cashierDisplayName": "Ana Cajera",
        "byMe": true
      }
    },
    {
      "id": "c3f5a2d4-5e6f-4a7b-8c9d-2e3f4a5b6c7d",
      "name": "Caja Mostrador 3",
      "isActive": true,
      "createdAt": "2026-10-01T12:00:00.000Z",
      "drawerHeld": false,
      "drawerHeldStatus": null,
      "drawerHeldSince": null,
      "heldBy": null
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `drawerHeld` | boolean | Always present. `true` when the register has a session whose drawer was never released (`drawerReleasedAt: null`), **whatever its status**, including `CLOSED`. This is the same rule that makes `POST /cash-registers/:id/sessions` fail with `422 CASH_REGISTER_UNRELEASED_SESSION`, and both use one shared backend filter. |
| `drawerHeldStatus` | `OPEN` \| `COUNTING` \| `SUBMITTED` \| `CLOSED` \| `null` | Status of the holding session. Set whenever `drawerHeld` is `true`, **for every caller**. `null` when the register is free. For display only. |
| `drawerHeldSince` | ISO string \| `null` | `openedAt` of the holding session. Set whenever `drawerHeld` is `true`, for every caller. `null` when free. |
| `heldBy` | object \| `null` | Details of the holding session, **only if you can see that session** (see privacy). Otherwise `null`, even when `drawerHeld` is `true`. |
| `heldBy.sessionId` | UUID string | Holding session id. Use it for «Continuar / Liberar caja». |
| `heldBy.status`, `heldBy.openedAt` | same values as `drawerHeldStatus` / `drawerHeldSince` | |
| `heldBy.cashierDisplayName` | string \| `null` | `User.name` of the session's cashier. `null` only if the user row is missing. |
| `heldBy.byMe` | boolean | `true` when the holding session is yours. |

- **Privacy:** this uses the same rule as `GET /cash-sessions`. `heldBy` (and so the cashier name) is filled only when the session is **yours** (with `read:CashSession`) or you have `read:CashSessionAudit`. An ordinary cashier sees another cashier's register as «Ocupada · en conteo desde 09:12» (`drawerHeldStatus` + `drawerHeldSince`), never their name. A supervisor sees «Ocupada por Ana desde 09:12».
- **Inactive registers** (`isActive: false`) report the same fields. A held inactive drawer still needs releasing.
- **Snapshot, not a guarantee.** The value is read without locks. Another device can open or release the register between the list and your `POST`. `POST /cash-registers/:id/sessions` stays the authoritative check. **Keep handling `422 CASH_REGISTER_UNRELEASED_SESSION`**: show «La caja tiene una sesión sin liberar» and refresh the list.
- The database already allows at most one unreleased session per register (partial unique index `cash_sessions_one_unreleased_per_register`), so at most one session holds a register.
