# Cash register closing — frontend integration contract

Backend-only contract for the POS cash register (`feat/cash-register-closing`).
Everything below is derived from the current controllers, DTOs, ports, domain
policies and query projections in this worktree — no frontend code is changed.

> **Status: implemented, locally committed and tested; not deployed.**
> Domain, persistence, application units 1–8, HTTP/module (`e7bba6f`), repository
> idempotency (`c6f312a`), POS (`51235e7`) and PDF (`4713c72`) have approved and
> acknowledged native reviews. Application unit 9 remains without a completed
> native review: its review was formally abandoned by explicit user decision.
> Local verification and historical disposable PostgreSQL proofs are described
> below. No push, deployment or production certification is claimed.
>
> **Locally committed additions after baseline `7cd66e3`:** blind channel
> discovery (`requiredChannels`) is in `3909329`; recipient custody discovery
> (`GET /cash-handovers/custody`) and `read:CashHandover` are in `03bdf0b`.
> Offline quotation PDF test fixtures are in `2b4815d`. The final unit run passed
> **356 suites / 7,167 tests** with fictitious configuration. No deployment,
> endpoint availability, new PostgreSQL proof or native review approval is
> claimed for these additions.

## Quick path

1. `POST /cash-registers/:id/sessions` — open a session with a confirmed opening fund.
2. `POST /cash-sessions/:id/start-count` — freeze: the expected snapshot is written and operational money writes stop.
3. `POST /cash-sessions/:id/declarations` — the cashier submits the **blind** first count.
4. `POST /cash-sessions/:id/verifications` — a different authenticated person verifies independently.
5. `POST /cash-sessions/:id/handovers` + `POST /cash-handovers/:id/receive` — custody moves and is received.
6. `POST /cash-sessions/:id/release-drawer` — the physical drawer is released (separate from the status).
7. `POST /cash-sessions/:id/close` — immutable closing snapshot + folio.
8. `GET /cash-closings/:id/pdf` — frozen receipt.

## Money units, channels, and custody

- **All monetary fields are integer cents.** Minimum/maximum is the persisted
  PostgreSQL `Int` window (`0 .. 2147483647`); arithmetic overflow is rejected,
  never wrapped. Never send decimals or strings.
- **A channel** is `{ channelKey, channelLabel, method }` plus an integer amount:
  - physical cash is always one pooled channel: `channelKey: "CASH"`,
    `channelLabel: "Efectivo"`, `method: "CASH"`;
  - non-cash keeps catalog identity: `channelKey: "PM:<paymentMethodId>"` with the
    label captured at operation time, or `channelKey: "METHOD:<METHOD>"` with the
    base label (`Efectivo`, `Tarjeta de crédito`, `Tarjeta de débito`, `Transferencia`).
  - `method` is one of `CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER`.
- A count must contain **every required channel exactly once**. A required channel
  omitted is `MISSING` (an error), an explicit `0` is a counted zero. An empty
  `lines` array is rejected: an empty count is not a zero count.
- **Custody is not a status.** `OPEN → COUNTING → SUBMITTED → CLOSED` is the
  lifecycle; releasing the shared drawer is the separate `drawerReleasedAt` event.
  Changing `OPEN` to `COUNTING` never releases funds.
- The opening fund (`openingCents`) is counted **once**, is not netted against
  withdrawals, and the next session's opening comes from a **received FLOAT**,
  never from the previous session's expected/difference.

## Status model

| Status | Meaning | Allowed next |
|--------|---------|--------------|
| `OPEN` | Operating; money may move | `COUNTING` |
| `COUNTING` | Frozen: counting started, operational writes rejected | `SUBMITTED` |
| `SUBMITTED` | First declaration persisted | `CLOSED` |
| `CLOSED` | Immutable cut + folio exist | — |

`drawerReleasedAt` is `null | ISO-8601` and independent of `status`. Closing
requires the drawer to be released first.

## Blind count (S4) — hard rules

- Pre-submission, the declarant's own session projection returns `blind: true`,
  **omits** `expectedCashCents` and `differenceCents` (absent, never `null`),
  returns `channelSnapshot: null` and `movements: []`, disclosing no movement
  metadata.
- The count body accepts only `lines`, optional `denominations`, optional `notes`.
  There is **no** `expectedCents`/`differenceCents` field; the global
  `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`) rejects any
  extra key with `400`.
- The first declaration is persisted **unchanged before** any expected-dependent
  comparison. A mismatch must never roll it back or surface a pre-submission oracle.
- Post-submission explanation is **append-only**: `declaration-notes` appends a new
  immutable revision carrying the same amounts plus notes. A later recount after
  expected values are visible is not a new blind count.
- Before submission, a blind session detail returns `movements: []` and
  `channelSnapshot: null`, including for its owner with audit permission.
  Operation counts, kinds and channel metadata are not disclosed.
- **Blind channel discovery (S1).** Because the blind snapshot is hidden, the
  owner's frozen detail additionally returns an additive `requiredChannels`
  list, so the client knows every channel the count must declare without
  learning any amount:
  `requiredChannels: [{ channelKey, channelLabel, method }]`. It is derived
  from the **frozen** expected snapshot (never the current payment catalog), so
  a later catalog rename or removal cannot rewrite history, and it lists
  exactly the channels `DECLARE` accepts as required (always including pooled
  `CASH`). It carries identity only — no `expectedCents`, differences, movement
  or source metadata, and no activity counts. The field is **present** only for
  the owner's own frozen blind window (`status: "COUNTING"`, `blind: true`) and
  is **absent** (not `null`) before the freeze (an `OPEN` session has no frozen
  channels yet), for a wider audit reader, and once the declaration is
  submitted — at which point `channelSnapshot` already exposes the identities.
  The same tenant/owner/audit/conditional authorization as the detail still
  applies; discovery never widens access.
- Sales visibility may still allow inference of expected amounts. This contract
  claims no broader secrecy and does not redesign analytics permissions.

## Independent verification and closing

- Verification requires status `SUBMITTED` and a **different** authenticated
  person than the cashier (`CASH_SELF_VERIFICATION_FORBIDDEN`).
- Closing requires status `SUBMITTED`, the drawer released, a verification and a
  fully allocated custody split; the closer must also differ from the cashier
  (`CASH_SELF_CLOSING_FORBIDDEN`).
- A non-zero declaration difference is **reported, not thrown, at DECLARE
  time**: the first blind declaration is persisted unchanged and the response
  `comparison` carries `requiresDeclarationNotes` (or the fallback
  `notesRequired`). The missing explanation then blocks the later independent
  verification and closing, where the comparator runs directly and raises
  `CASH_DISCREPANCY_NOTES_REQUIRED`. Originals are always preserved and no
  balancing movement is manufactured.

## Custody and FLOAT receipt

- A handover is `kind: "WITHDRAWAL"` (leaves the drawer to another person) or
  `kind: "FLOAT"` (retained as the next opening fund).
- The receipt actor is the **authenticated JWT subject**, never a body field.
  The application requires the authenticated actor to equal the designated
  `recipientUserId`, requires an explicit amount + timestamp, and rejects a
  receipt that predates its declaration.
- **Same-person FLOAT is allowed** (a cashier retaining their own float) because
  the receipt is still explicit and actor-bound. **Same-person WITHDRAWAL is
  denied** (`CASH_HANDOVER_SELF_WITHDRAWAL`).
- A FLOAT can fund the next opening only if it was received by the opening
  cashier (`CASH_HANDOVER_RECIPIENT_INVALID`) and the received amount equals
  `openingCents` (`CASH_OPENING_FUNDS_MISMATCH`). The same FLOAT cannot fund two
  sessions (`CASH_OPENING_FLOAT_REUSE`).
- All handovers must be received before drawer release/closing
  (`CASH_CUSTODY_NOT_RECEIVED`), and allocations must equal the counted cash
  (`CASH_HANDOVER_ALLOCATION_MISMATCH`).

## Recipient custody discovery (S2)

- `GET /cash-handovers/custody` lets a recipient find the custody owed to them
  and the FLOAT they already hold, without a broad session-audit grant:
  - `pendingHandovers` — handovers addressed to the authenticated recipient
    that are still unreceived (`receivedAt = null` **and**
    `receivedByUserId = null`);
  - `eligibleFloat` — received `FLOAT` addressed to **and** received by the
    authenticated recipient, whose receipt the shared policy accepts, and
    that no tenant session already consumes as its `openingHandoverId`.
    Eligibility reuses the same `resolveOpeningFundCents` validation opening
    runs: the receipt must be explicit (`receivedCents` present and in range)
    and must not predate its declaration, otherwise the row is excluded. A
    received amount that differs from the declared amount is valid and stays
    eligible — the opening fund is the **received** amount, never an equality
    of declared vs received.
- Scope is the JWT tenant plus the authenticated user as recipient. The route
  accepts only `page` / `limit`; `tenantId`, `recipientUserId` or any other
  extra query key is rejected by `forbidNonWhitelisted` (`400`), and the
  recipient can never be supplied or widened by the client.
- The guard requires `read:CashHandover`. `read:CashSessionAudit` is **not** a
  substitute: without `read:CashHandover` the query is denied
  (`CASH_PERMISSION_DENIED`), never a silent successful empty page. Conditional
  grants are evaluated **per row** against the handover instance
  (recipient/sender/session/kind) before totals and pagination, so a
  conditional rule can neither widen the total nor leak a row.
- Items carry narrow custody data only — `{ id, sessionId, kind, declaredCents,
  receivedCents, senderUserId, receiverUserId, declaredAt, receivedAt }`,
  plus `sourceRegisterId` and `sourceDrawerReleasedAt` for `kind: "FLOAT"`.
  Source-session expected totals, movements and channel snapshots are never
  exposed.
- **Same-register release rule is preserved and discovery is not a
  reservation.** A received, unconsumed FLOAT is listed even while its source
  drawer is still unreleased; the response reports `sourceDrawerReleasedAt`
  (`null` while open) and `sourceRegisterId` so the client can explain the
  state. Opening a session still performs the authoritative checks (received
  by the opener, amount equality, same-register source-drawer release, single
  reuse). Discovery does not globally filter unreleased drawers, does not
  block use on another register, and does not reserve the FLOAT.
- **Role assignment (discovery ≠ guarantee).** `read:CashHandover` is a
  registry row only; boot upserts the row but grants it to no role by default
  (there are no named-role checks). A tenant administrator must compose it into
  a role through the existing dynamic role-permission flow. Holding the row
  only enables *discovery* — receipt (`update:CashHandover`), drawer release
  and opening keep their own checks and remain authoritative.

## Authentication, tenant, and idempotency headers

- `Authorization: Bearer <accessToken>` on every route.
- The tenant is taken **only** from the verified JWT tenant context
  (`JwtAuthGuard` → `TenantContextGuard`). There is no tenant header, and
  `tenantId` in a body/query is rejected by `forbidNonWhitelisted`. Cross-tenant
  ids fail closed.
- Every command route requires an `Idempotency-Key` header:
  - missing / non-string / empty after trim, or longer than 200 chars → `400`
    with `error: "INVALID_IDEMPOTENCY_KEY"`;
  - same key + same normalized request → the stored response is returned;
  - same key + a different request → `422 CASH_IDEMPOTENCY_CONFLICT`.
- Session-bound sales acquisition now uses conflict-safe insertion inside the
  ambient transaction instead of recovering from a duplicate-insert error in an
  aborted transaction. Independent source review and 285 repository tests passed.
  Disposable PostgreSQL proved rollback and committed same-key replay;
  concurrent collision and lease-reclamation races are not exhaustively covered.
  See [Verification evidence and limits](#verification-evidence-and-limits).

## Routes and responses

Granular CASL permissions, no named-role checks. A role is an arbitrary
composition of these rows; tenant/ownership/state/receiver constraints are
enforced separately from holding a permission.

| Route | Method | Guard permission | Notes |
|-------|--------|------------------|-------|
| `/cash-registers` | `GET` | `read:CashRegister` | List |
| `/cash-registers` | `POST` | `create:CashRegister` | Create |
| `/cash-registers/:id` | `PATCH` | `update:CashRegister` | Rename / activate |
| `/cash-registers/:id/sessions` | `POST` | `create:CashSession` | Open session |
| `/cash-sessions` | `GET` | `read:CashSession` | Own sessions unless audit |
| `/cash-sessions/:id` | `GET` | `read:CashSession` (+ `read:CashSessionAudit` for wider scope) | Detail |
| `/cash-sessions/:id/start-count` | `POST` | `create:CashCount` | Freeze |
| `/cash-sessions/:id/declarations` | `POST` | `create:CashCount` | Blind declaration |
| `/cash-sessions/:id/declaration-notes` | `POST` | `create:CashCount` | Append-only notes |
| `/cash-sessions/:id/verifications` | `POST` | `create:CashVerification` | Independent verify |
| `/cash-sessions/:id/cash-in` | `POST` | `create:CashIn` | Manual movement |
| `/cash-sessions/:id/cash-out` | `POST` | `create:CashOut` | Manual movement |
| `/cash-sessions/:id/handovers` | `POST` | `create:CashHandover` | Declare custody |
| `/cash-sessions/:id/release-drawer` | `POST` | `create:CashHandover`¹ | Release physical drawer |
| `/cash-sessions/:id/close` | `POST` | `create:CashClosing` | Close |
| `/cash-handovers/:id/receive` | `POST` | `update:CashHandover` | Recipient confirms |
| `/cash-handovers/custody` | `GET` | `read:CashHandover` | Recipient's pending handovers + eligible FLOAT |
| `/cash-closings` | `GET` | `read:CashClosing` | Paginated history |
| `/cash-closings/:id` | `GET` | `read:CashClosing` | Immutable detail |
| `/cash-closings/:id/pdf` | `GET` | `read:CashClosing` | Frozen receipt |

No `delete`, `batch_delete` or `manage` permission rows exist for any Cash\*
subject; only `read`, `create` and the two `update` rows above are registered.
Permission rows: `read:create:update` on `CashRegister`; `read` + `create` on
`CashSession`; `create` on `CashCount`, `CashIn`, `CashOut`, `CashVerification`,
`CashHandover`, `CashClosing`; `read` + `update` on `CashHandover`; `read` on
`CashSessionAudit` and `CashClosing`. `read:CashSessionAudit` widens list/detail
scope (`cashierUserId` filter and other users' rows); without it, listing is
restricted to the caller's own sessions. `read:CashHandover` is the dedicated
recipient-custody read and is deliberately independent of
`read:CashSessionAudit`.

¹ `create:CashHandover` governs outgoing custody and drawer release in both
HTTP and application checks. `update:CashHandover` remains the separate receipt
permission; releasing a drawer does not require granting receipt permission.

### Envelope types (all documents are plain JSON; no wrapper key is added)

`GET /cash-registers` → `{ items: [{ id, name, isActive, createdAt }] }`
`POST/PATCH /cash-registers` → `{ id, name, isActive, createdAt }`
`POST /cash-registers/:id/sessions` → `{ session, register: { id, name, isActive } }`
`GET /cash-sessions` → `{ items: CashSessionProjection[], page, limit, total }`
`GET /cash-sessions/:id` → `{ session, register|null, movements[], counts[], handovers[], closing|null, channelSnapshot|null, requiredChannels?[] }`
`POST .../start-count` → `{ session }`
`POST .../declarations` → `{ sessionId, status: "SUBMITTED", declaration, comparison }`
`POST .../declaration-notes` → `{ sessionId, revision, lines, denominations|null, notes }`
`POST .../verifications` → `{ sessionId, verification, comparison }`
`POST .../cash-in|cash-out` → `{ id, sessionId, kind, deltaCents, occurredAt }`
`POST .../handovers` and `/cash-handovers/:id/receive` → `{ id, sessionId, kind, declaredCents, receivedCents, senderUserId, receiverUserId, receiptActorUserId, declaredAt, receivedAt, notes, receiptNotes }`
`GET /cash-handovers/custody` → `{ pendingHandovers: { items, page, limit, total }, eligibleFloat: { items, page, limit, total } }`
`POST .../release-drawer` → `{ sessionId, drawerReleasedAt }`
`POST .../close` and `GET /cash-closings/:id` → `{ id, sessionId, folio, createdAt, snapshot }`
`GET /cash-closings` → `{ items: [{ id, sessionId, folio, createdAt }], page, limit, total }`

`CashSessionProjection`:
`{ id, tenantId, registerId, status, cashierUserId, openingCents, frozenAt|null, drawerReleasedAt|null, blind }`
plus `expectedCashCents?` and `differenceCents?` only when visible. Hidden means
**absent**, not `null` — never coerce absence to a zero.

`requiredChannels?` is a top-level detail field (sibling of `channelSnapshot`),
not part of `CashSessionProjection`. It is `[{ channelKey, channelLabel,
method }]` and appears only in the owner's frozen blind detail; it is omitted
entirely in every other state.

`declaration` = `{ revision, lines, denominations|null, notes|null, cashCents }`.
`verification` adds `actorUserId`. The **normal** `comparison` (returned by
VERIFY, CLOSE and by DECLARE when the comparator accepts the request) is
`{ expectedCents, declaredCents, verifiedCents|null, declarationDifferenceCents,
verificationDifferenceCents|null, verifiedVsExpectedDifferenceCents|null,
requiresDeclarationNotes, requiresVerificationNotes, hasDiscrepancy }`.
The DECLARE command may instead return the **fallback** comparison
`{ expectedCents, declaredCents, verifiedCents|null, differenceCents|null,
requiresDeclarationNotes, requiresVerificationNotes, hasDiscrepancy,
notesRequired }` when `compareSafely` catches a missing-note or
arithmetic-overflow rule instead of rolling the persisted declaration back. The
fallback deliberately has no `declarationDifferenceCents`; it carries a single
`differenceCents` (declared − expected, `null` when that subtraction itself is
unrepresentable). See the complete examples below.

HTTP status codes are `201` for create-style routes, `200` for
`start-count`, `release-drawer`, `/cash-handovers/:id/receive` and all `GET`s,
`201` for declarations, notes, verifications, cash-in/out, handovers and close.

### Complete fictional response examples (S3)

**These blocks are hand-authored, fictitious and self-consistent; they are NOT
live API output.** UUIDs, folios, names and timestamps are invented, and the
cent arithmetic is internally consistent within each scenario. They are
grounded field-by-field in the current controllers, DTOs, projections, mappers
and query modules, and are strict JSON (no comments, placeholders or
ellipsis) so they can be parsed directly.

**Wrapped HTTP vs application document.** The controllers return the
`CashDocument` verbatim and `main.ts` installs no response-wrapping
interceptor, so the HTTP JSON body *is* the document: there is no `data`,
`result` or `payload` key. The only HTTP-level additions are the status code
and headers (for example `201` for `POST /cash-sessions/:id/declarations`).

The examples below describe additions after baseline `7cd66e3`;
`requiredChannels` and the custody fields are locally committed in `3909329`
and `03bdf0b`, respectively, and do not exist in the baseline contract.

**A. `GET /cash-sessions/:id` — owner, `OPEN`, blind, before the freeze.**
`blind` is already `true` at `OPEN` for the declarant; `expectedCashCents`,
`differenceCents` and `requiredChannels` are **absent** (not `null`) because
nothing is frozen yet.

```json
{
  "session": {
    "id": "33333333-3333-4333-8333-333333333333",
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "registerId": "22222222-2222-4222-8222-222222222222",
    "status": "OPEN",
    "cashierUserId": "44444444-4444-4444-8444-444444444444",
    "openingCents": 50000,
    "frozenAt": null,
    "drawerReleasedAt": null,
    "blind": true
  },
  "register": {
    "id": "22222222-2222-4222-8222-222222222222",
    "name": "Caja principal",
    "isActive": true
  },
  "movements": [],
  "counts": [],
  "handovers": [],
  "closing": null,
  "channelSnapshot": null
}
```

**B. `GET /cash-sessions/:id` — owner, `COUNTING`, blind, with the new
`requiredChannels`.** Identity only: no `expectedCents`, differences, movement
or source metadata.

```json
{
  "session": {
    "id": "33333333-3333-4333-8333-333333333333",
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "registerId": "22222222-2222-4222-8222-222222222222",
    "status": "COUNTING",
    "cashierUserId": "44444444-4444-4444-8444-444444444444",
    "openingCents": 50000,
    "frozenAt": "2026-10-07T18:30:00.000Z",
    "drawerReleasedAt": null,
    "blind": true
  },
  "register": {
    "id": "22222222-2222-4222-8222-222222222222",
    "name": "Caja principal",
    "isActive": true
  },
  "movements": [],
  "counts": [],
  "handovers": [],
  "closing": null,
  "channelSnapshot": null,
  "requiredChannels": [
    {
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "method": "CASH"
    },
    {
      "channelKey": "PM:77777777-7777-4777-8777-777777777777",
      "channelLabel": "Visa Crédito",
      "method": "CARD_CREDIT"
    }
  ]
}
```

**C. `GET /cash-sessions/:id` — owner, `SUBMITTED`, expected values revealed.**
Full movement, count and handover documents plus the visible `channelSnapshot`.
The physical `CASH` expected total is `157500` (opening `50000` plus the net
`107500` of physical movements); the non-cash `PM:` channel is its own
`40000`. The declared `CASH` is `158000`, so `differenceCents` is `500`. The two
handovers allocate `150000 + 8000 = 158000`, and the `WITHDRAWAL` is still
unreceived.

```json
{
  "session": {
    "id": "33333333-3333-4333-8333-333333333333",
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "registerId": "22222222-2222-4222-8222-222222222222",
    "status": "SUBMITTED",
    "cashierUserId": "44444444-4444-4444-8444-444444444444",
    "openingCents": 50000,
    "frozenAt": "2026-10-07T18:30:00.000Z",
    "drawerReleasedAt": null,
    "blind": false,
    "expectedCashCents": 157500,
    "differenceCents": 500
  },
  "register": {
    "id": "22222222-2222-4222-8222-222222222222",
    "name": "Caja principal",
    "isActive": true
  },
  "movements": [
    {
      "id": "b0000001-0000-4000-8000-000000000001",
      "kind": "SALE_PAYMENT",
      "deltaCents": 128500,
      "method": "CASH",
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "sourceType": "PAYMENT",
      "sourceId": "99999999-9999-4999-8999-999999999991",
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "reason": null,
      "occurredAt": "2026-10-07T16:10:00.000Z"
    },
    {
      "id": "b0000002-0000-4000-8000-000000000002",
      "kind": "SALE_CHANGE",
      "deltaCents": -28500,
      "method": "CASH",
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "sourceType": "SALE",
      "sourceId": "88888888-8888-4888-8888-888888888881",
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "reason": null,
      "occurredAt": "2026-10-07T16:10:05.000Z"
    },
    {
      "id": "b0000003-0000-4000-8000-000000000003",
      "kind": "SALE_PAYMENT",
      "deltaCents": 40000,
      "method": "CARD_CREDIT",
      "channelKey": "PM:77777777-7777-4777-8777-777777777777",
      "channelLabel": "Visa Crédito",
      "sourceType": "PAYMENT",
      "sourceId": "99999999-9999-4999-8999-999999999992",
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "reason": null,
      "occurredAt": "2026-10-07T16:40:00.000Z"
    },
    {
      "id": "b0000004-0000-4000-8000-000000000004",
      "kind": "CASH_IN",
      "deltaCents": 20000,
      "method": "CASH",
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "sourceType": "MANUAL",
      "sourceId": "a1000004-0000-4000-8000-000000000004",
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "reason": "Cambio adicional para morralla",
      "occurredAt": "2026-10-07T17:15:00.000Z"
    },
    {
      "id": "b0000005-0000-4000-8000-000000000005",
      "kind": "CASH_OUT",
      "deltaCents": -2500,
      "method": "CASH",
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "sourceType": "MANUAL",
      "sourceId": "a1000005-0000-4000-8000-000000000005",
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "reason": "Compra de bolsas",
      "occurredAt": "2026-10-07T17:45:00.000Z"
    },
    {
      "id": "b0000006-0000-4000-8000-000000000006",
      "kind": "REFUND_SETTLEMENT",
      "deltaCents": -10000,
      "method": "CASH",
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "sourceType": "REFUND",
      "sourceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "reason": null,
      "occurredAt": "2026-10-07T18:05:00.000Z"
    }
  ],
  "counts": [
    {
      "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "kind": "DECLARATION",
      "revision": 1,
      "actorUserId": "44444444-4444-4444-8444-444444444444",
      "lines": [
        {
          "channelKey": "CASH",
          "amountCents": 158000
        },
        {
          "channelKey": "PM:77777777-7777-4777-8777-777777777777",
          "amountCents": 40000
        }
      ],
      "denominations": [
        {
          "denominationCents": 100000,
          "quantity": 1
        },
        {
          "denominationCents": 50000,
          "quantity": 1
        },
        {
          "denominationCents": 5000,
          "quantity": 1
        },
        {
          "denominationCents": 2000,
          "quantity": 1
        },
        {
          "denominationCents": 1000,
          "quantity": 1
        }
      ],
      "notes": "Sobrante de 500 centavos por cambio no entregado al cliente",
      "createdAt": "2026-10-07T19:05:00.000Z"
    }
  ],
  "handovers": [
    {
      "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
      "sessionId": "33333333-3333-4333-8333-333333333333",
      "kind": "FLOAT",
      "declaredCents": 150000,
      "receivedCents": 150000,
      "senderUserId": "44444444-4444-4444-8444-444444444444",
      "receiverUserId": "66666666-6666-4666-8666-666666666666",
      "receiptActorUserId": "66666666-6666-4666-8666-666666666666",
      "declaredAt": "2026-10-07T19:20:00.000Z",
      "receivedAt": "2026-10-07T19:25:00.000Z",
      "notes": "Fondo para el siguiente turno",
      "receiptNotes": "Recibido completo"
    },
    {
      "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
      "sessionId": "33333333-3333-4333-8333-333333333333",
      "kind": "WITHDRAWAL",
      "declaredCents": 8000,
      "receivedCents": null,
      "senderUserId": "44444444-4444-4444-8444-444444444444",
      "receiverUserId": "66666666-6666-4666-8666-666666666666",
      "receiptActorUserId": null,
      "declaredAt": "2026-10-07T19:30:00.000Z",
      "receivedAt": null,
      "notes": "Retiro para cambio de turno",
      "receiptNotes": null
    }
  ],
  "closing": null,
  "channelSnapshot": [
    {
      "channelKey": "CASH",
      "channelLabel": "Efectivo",
      "method": "CASH",
      "expectedCents": 157500
    },
    {
      "channelKey": "PM:77777777-7777-4777-8777-777777777777",
      "channelLabel": "Visa Crédito",
      "method": "CARD_CREDIT",
      "expectedCents": 40000
    }
  ]
}
```

`channelSnapshot` is the **frozen expected** channel list
(`channelKey, channelLabel, method, expectedCents`). It is not the closing
snapshot `channels[]`, which adds `declaredCents`, `verifiedCents` and
`differenceCents`.

**D. `POST /cash-sessions/:id/declarations` → `201`, normal `comparison`.**
The declaration was persisted, then compared; the note is present, so the
normal comparison is returned with all three difference fields (the verified
ones are `null` until VERIFY).

```json
{
  "sessionId": "33333333-3333-4333-8333-333333333333",
  "status": "SUBMITTED",
  "declaration": {
    "revision": 1,
    "lines": [
      {
        "channelKey": "CASH",
        "amountCents": 158000
      },
      {
        "channelKey": "PM:77777777-7777-4777-8777-777777777777",
        "amountCents": 40000
      }
    ],
    "denominations": [
      {
        "denominationCents": 100000,
        "quantity": 1
      },
      {
        "denominationCents": 50000,
        "quantity": 1
      },
      {
        "denominationCents": 5000,
        "quantity": 1
      },
      {
        "denominationCents": 2000,
        "quantity": 1
      },
      {
        "denominationCents": 1000,
        "quantity": 1
      }
    ],
    "notes": "Sobrante de 500 centavos por cambio no entregado al cliente",
    "cashCents": 158000
  },
  "comparison": {
    "expectedCents": 157500,
    "declaredCents": 158000,
    "verifiedCents": null,
    "declarationDifferenceCents": 500,
    "verificationDifferenceCents": null,
    "verifiedVsExpectedDifferenceCents": null,
    "requiresDeclarationNotes": true,
    "requiresVerificationNotes": false,
    "hasDiscrepancy": true
  }
}
```

**E. `POST /cash-sessions/:id/declarations` → `201`, fallback `comparison`.**
Same persisted declaration but the body omitted `notes`, so `compareSafely`
caught the missing-explanation rule and returned the fallback instead of
rolling the submission back. The fallback carries `differenceCents` and
`notesRequired`. The equivalent arithmetic-overflow catch uses the same shape
and sets `differenceCents` to `null` because the subtraction itself is
unrepresentable. (The count body has no `expectedCents` or `differenceCents`
field.)

```json
{
  "sessionId": "33333333-3333-4333-8333-333333333333",
  "status": "SUBMITTED",
  "declaration": {
    "revision": 1,
    "lines": [
      {
        "channelKey": "CASH",
        "amountCents": 158000
      },
      {
        "channelKey": "PM:77777777-7777-4777-8777-777777777777",
        "amountCents": 40000
      }
    ],
    "denominations": [
      {
        "denominationCents": 100000,
        "quantity": 1
      },
      {
        "denominationCents": 50000,
        "quantity": 1
      },
      {
        "denominationCents": 5000,
        "quantity": 1
      },
      {
        "denominationCents": 2000,
        "quantity": 1
      },
      {
        "denominationCents": 1000,
        "quantity": 1
      }
    ],
    "notes": null,
    "cashCents": 158000
  },
  "comparison": {
    "expectedCents": 157500,
    "declaredCents": 158000,
    "verifiedCents": null,
    "differenceCents": 500,
    "requiresDeclarationNotes": true,
    "requiresVerificationNotes": false,
    "hasDiscrepancy": true,
    "notesRequired": true
  }
}
```

**F. `POST /cash-sessions/:id/verifications` → `201`, fully populated
`comparison`.** A different authenticated user recounts `158300`; both
verified differences are non-null and both notes are present. VERIFY/CLOSE use
the normal comparator directly, so a missing note here is a thrown
`CASH_DISCREPANCY_NOTES_REQUIRED`, not a fallback document.

```json
{
  "sessionId": "33333333-3333-4333-8333-333333333333",
  "verification": {
    "revision": 1,
    "actorUserId": "55555555-5555-4555-8555-555555555555",
    "lines": [
      {
        "channelKey": "CASH",
        "amountCents": 158300
      },
      {
        "channelKey": "PM:77777777-7777-4777-8777-777777777777",
        "amountCents": 40000
      }
    ],
    "denominations": [
      {
        "denominationCents": 100000,
        "quantity": 1
      },
      {
        "denominationCents": 50000,
        "quantity": 1
      },
      {
        "denominationCents": 5000,
        "quantity": 1
      },
      {
        "denominationCents": 2000,
        "quantity": 1
      },
      {
        "denominationCents": 1000,
        "quantity": 1
      },
      {
        "denominationCents": 200,
        "quantity": 1
      },
      {
        "denominationCents": 100,
        "quantity": 1
      }
    ],
    "notes": "Recuento: 3 pesos de más (300 centavos)",
    "cashCents": 158300
  },
  "comparison": {
    "expectedCents": 157500,
    "declaredCents": 158000,
    "verifiedCents": 158300,
    "declarationDifferenceCents": 500,
    "verificationDifferenceCents": 300,
    "verifiedVsExpectedDifferenceCents": 800,
    "requiresDeclarationNotes": true,
    "requiresVerificationNotes": true,
    "hasDiscrepancy": true
  }
}
```

**G. `GET /cash-handovers/custody` → `200`, recipient's narrow discovery.**
The authenticated recipient is `66666666-6666-4666-8666-666666666666` and the
response is tenant-scoped to them. `WITHDRAWAL` items have no
`sourceRegisterId`/`sourceDrawerReleasedAt`; `FLOAT` items add them. Both
sub-pages share the requested `page`/`limit`, and each has its own `total`.
The first eligible FLOAT shows `receivedCents` (`29500`) differing from
`declaredCents` (`30000`) and still being eligible, and the second shows a
still-unreleased source drawer that is listed rather than filtered. Each shown
FLOAT source session lives on its own register (or its drawer was already
released), so the one-unreleased-session-per-register invariant still holds;
only `FLOAT` items expose `sourceRegisterId`/`sourceDrawerReleasedAt`.

```json
{
  "pendingHandovers": {
    "items": [
      {
        "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        "sessionId": "33333333-3333-4333-8333-333333333341",
        "kind": "WITHDRAWAL",
        "declaredCents": 12000,
        "receivedCents": null,
        "senderUserId": "44444444-4444-4444-8444-444444444445",
        "receiverUserId": "66666666-6666-4666-8666-666666666666",
        "declaredAt": "2026-10-07T20:00:00.000Z",
        "receivedAt": null
      },
      {
        "id": "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
        "sessionId": "33333333-3333-4333-8333-333333333342",
        "kind": "FLOAT",
        "declaredCents": 30000,
        "receivedCents": null,
        "senderUserId": "44444444-4444-4444-8444-444444444445",
        "receiverUserId": "66666666-6666-4666-8666-666666666666",
        "declaredAt": "2026-10-07T20:05:00.000Z",
        "receivedAt": null,
        "sourceRegisterId": "22222222-2222-4222-8222-222222222223",
        "sourceDrawerReleasedAt": null
      }
    ],
    "page": 1,
    "limit": 25,
    "total": 2
  },
  "eligibleFloat": {
    "items": [
      {
        "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
        "sessionId": "33333333-3333-4333-8333-333333333343",
        "kind": "FLOAT",
        "declaredCents": 30000,
        "receivedCents": 29500,
        "senderUserId": "44444444-4444-4444-8444-444444444445",
        "receiverUserId": "66666666-6666-4666-8666-666666666666",
        "declaredAt": "2026-10-07T19:00:00.000Z",
        "receivedAt": "2026-10-07T19:10:00.000Z",
        "sourceRegisterId": "22222222-2222-4222-8222-222222222224",
        "sourceDrawerReleasedAt": "2026-10-07T19:30:00.000Z"
      },
      {
        "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
        "sessionId": "33333333-3333-4333-8333-333333333344",
        "kind": "FLOAT",
        "declaredCents": 12000,
        "receivedCents": 12000,
        "senderUserId": "44444444-4444-4444-8444-444444444445",
        "receiverUserId": "66666666-6666-4666-8666-666666666666",
        "declaredAt": "2026-10-07T18:00:00.000Z",
        "receivedAt": "2026-10-07T18:05:00.000Z",
        "sourceRegisterId": "22222222-2222-4222-8222-222222222225",
        "sourceDrawerReleasedAt": null
      }
    ],
    "page": 1,
    "limit": 25,
    "total": 2
  }
}
```

### Frozen `snapshot` (closing detail and PDF)

`{ sessionId, tenantId, registerId, folio, cashierUserId, openingCents,
expectedCents, declaredCents, verifiedCents|null, verifierUserId|null, channels[],
handovers[], countedAt, verifiedAt|null, closedAt, closedByUserId, registerName,
cashierName, verifierName, closedByName, declarationNotes, verificationNotes,
comparison, closingNotes }`

`countedAt` is the original declaration's timestamp, not a later annotation's.
`closingNotes` is frozen by CLOSE and consumed directly by the receipt parser.

`channels[]` = `{ channelKey, channelLabel, method, expectedCents, declaredCents,
verifiedCents|null, differenceCents }` where `differenceCents = declaredCents −
expectedCents` per channel.
`handovers[]` = `{ handoverId, kind, declaredCents, receivedCents|null,
senderUserId, receiverUserId|null, receiptActorUserId|null, declaredAt,
receivedAt|null }`.

Totals note: `snapshot.expectedCents`, `declaredCents` and `verifiedCents` are the
**physical cash** totals (the `CASH` channel), not the sum of all channels.

## Request examples

Create register:

```http
POST /cash-registers
Authorization: Bearer <accessToken>
Idempotency-Key: 4d0f0f0e-1
Content-Type: application/json

{ "name": "Caja principal" }
```

Open session with a received FLOAT opening:

```http
POST /cash-registers/8b0d.../sessions
Authorization: Bearer <accessToken>
Idempotency-Key: open-2026-10-07-01
Content-Type: application/json

{
  "openingCents": 50000,
  "openingConfirmed": true,
  "openingHandoverId": "1f2e..."   // optional
}
```

`openingConfirmed` must be literally `true`; `false` or a string is rejected.

Declaration / verification (same body shape):

```http
POST /cash-sessions/3c9a.../declarations
Authorization: Bearer <accessToken>
Idempotency-Key: decl-3c9a-1
Content-Type: application/json

{
  "lines": [
    { "channelKey": "CASH", "amountCents": 128500 },
    { "channelKey": "PM:9d12...", "amountCents": 40000 }
  ],
  "denominations": [
    { "denominationCents": 100000, "quantity": 1 },
    { "denominationCents": 28500, "quantity": 1 }
  ],
  "notes": "Conteo inicial sin novedad"
}
```

When `denominations` are supplied they must sum exactly to the `CASH` line
(`CASH_DENOMINATION_SUM_MISMATCH`).

Manual movement, handover, receipt, notes:

```jsonc
// POST /cash-sessions/3c9a.../cash-out
{ "amountCents": 2500, "reason": "Compra de bolsas" }

// POST /cash-sessions/3c9a.../handovers
{ "handoverKind": "FLOAT", "recipientUserId": "7a1b...", "declaredCents": 50000, "notes": "Fondo para turno siguiente" }

// POST /cash-handovers/5e77.../receive
{ "receivedCents": 50000, "notes": "Recibido en efectivo" }

// POST /cash-sessions/3c9a.../declaration-notes
{ "notes": "Faltante de 500 por cambio entregado sin registrar" }
```

Close:

```http
POST /cash-sessions/3c9a.../close
Authorization: Bearer <accessToken>
Idempotency-Key: close-3c9a-1
Content-Type: application/json

{ "notes": "Cierre sin novedad" }
```

## The two differences (do not conflate)

| Field | Formula | Meaning |
|-------|---------|---------|
| `declarationDifferenceCents` | declared − expected | Cashier's blind first count vs system expectation |
| `verificationDifferenceCents` | verified − declared | Verifier's independent recount vs the declaration |
| `verifiedVsExpectedDifferenceCents` | verified − expected | Router convenience only |

- Per-channel `differenceCents` in the snapshot is **declared − expected only**.
- Either difference being non-zero requires a written note. A missing note blocks
  verification/closing without touching the preserved originals.
- The PDF derives both differences from the frozen totals, so the UI should show
  them the same way rather than recomputing from live data.

## Sales integration — `cashSessionId` on three operations only

The field is optional and only **omission** is optional: `null` is rejected
(`400`, message `INVALID_CASH_SESSION_ID`). Omission keeps the legacy external
flow and the exact legacy idempotency request hash.

| Operation | Route | DTO | Permission | Idempotency |
|-----------|-------|-----|------------|-------------|
| Initial charge | `POST /sales/drafts/:id/charge` | `ChargeSaleDto.cashSessionId` | `update:Sale` | `Idempotency-Key` required |
| Later collection | `POST /sales/:id/payments` | `AddSalePaymentDto.cashSessionId` | `update:Sale` | `Idempotency-Key` required |
| Actual refund settlement | `POST /sales/refunds/:refundId/settlements` | `SettleRefundDto.cashSessionId` | `update:SaleRefund` | `Idempotency-Key` required |

```jsonc
// POST /sales/:id/payments — session-bound POS collection
{ "payments": [ { "paymentMethodId": "9d12...", "amountCents": 50000 } ], "cashSessionId": "3c9a..." }
```

Rules:

- A session id binds the operation to that session only if it belongs to the
  tenant and to the caller (`CASH_SESSION_NOT_OWNED` otherwise), and the session
  must not be frozen (`CASH_SESSION_NOT_WRITABLE`).
- **Bot/external legacy path:** omitting `cashSessionId` leaves the reviewer/bot
  collection path unchanged and outside these cuts. Supplying `cashSessionId`
  together with the reviewer/bot auth mode is a contradiction and is rejected
  (`422 CASH_SESSION_REVIEWER_NOT_ALLOWED`).
- A `credit` refund cannot be session-bound: only actual tender settlements bind
  (`422 CASH_SESSION_CREDIT_NOT_ALLOWED`).
- Customer tender and change are accounted **once**: the change movement is
  recorded one per sale (`sourceType: "SALE"`), the tender once per payment
  (`sourceType: "PAYMENT"`), and the refund once per settlement
  (`sourceType: "REFUND"`). Duplicates fail closed via source uniqueness.
- Pending refund obligations have no session impact; only actual settlements do.

## Pagination and filters

- `GET /cash-sessions` and `GET /cash-closings` use 1-based `page` / `limit`
  (default `1` / `25`, cap `100`; `limit: 0` and values above the cap are `400`).
  Query values must be strict unsigned decimals — no `+`, `-`, `01`, `1e0` or
  fractions. `limit` above `100`, and `page` above the safe-page cap derived from
  the 32-bit `skip` argument, are rejected.
- Both list routes filter by `registerId` (UUID) and `from`/`to` ISO-8601
  timestamps **with an explicit timezone** (local wall-clock strings are
  rejected; `from` inclusive, `to` exclusive). `GET /cash-sessions` also filters
  by `cashierUserId` (UUID) and accepts `pendingOnly=true|false`
  (`COUNTING`/`SUBMITTED` only). Unknown query keys are rejected with `400`.
- `GET /cash-handovers/custody` shares the same `page` / `limit` bounds and
  strict unsigned-decimal grammar, but exposes no filters: it is always scoped
  to the authenticated recipient.
- On the sessions list, `cashierUserId` is applied before permission visibility.
  Without `read:CashSessionAudit`, results remain scoped to the caller: filtering
  by another cashier returns no rows rather than ignoring the filter.
- The shared closing-list DTO accepts and validates `cashierUserId`, but the
  closing query does not apply it. Do not use it to filter closing history.
  Without audit permission, the closings list is scoped to closings closed by
  the caller or belonging to the caller's sessions.

## Closing PDF

`GET /cash-closings/:id/pdf` returns:

- `Content-Type: application/pdf`
- `Content-Disposition: attachment; filename="corte-caja-<folio|id>.pdf"`
  (sanitized to `[A-Za-z0-9_-]`, fallback to the UUID, CRLF-safe)
- `Cache-Control: private, no-store`

The receipt is rendered exclusively from the frozen `snapshot`; it never reads
sales or catalog live. A malformed snapshot fails closed with
`500 CASH_CLOSING_SNAPSHOT_INVALID` rather than rendering guessed values. The
existing Spanish labels are kept (`CORTE DE CAJA`, `FONDO INICIAL (APERTURA)`,
`Detalle por canal`, `TOTALES DEL CORTE`, `Custodia y entregas`,
`ENTREGAS Y RECEPCIONES`, `DECLARADO`, `VERIFICADO`, `RECIBIDO`).

## Errors

All cash rule/application violations are thrown as `BusinessRuleViolationError`
and, with one exception, fall through to the global filter's generic
`422` with `{ statusCode, error, message, timestamp, ...details }`. There is no
cash-specific mapping in `DomainExceptionFilter`, so **`CASH_*_NOT_FOUND` is
`422`, not `404`** in the current code. DTO failures are plain `400`
(`{ statusCode: 400, message: [...], error: "Bad Request" }`), guard failures are
`401`/`403`.

Representative codes (all prefixed `CASH_`):

| Code | Typical status | Meaning |
|------|----------------|---------|
| `CASH_IDEMPOTENCY_KEY_REQUIRED` / `_TOO_LONG` | 422 (header path is `400 INVALID_IDEMPOTENCY_KEY`) | Key missing/oversized |
| `CASH_IDEMPOTENCY_CONFLICT` | 422 | Key reused with a different request / raced |
| `CASH_PERMISSION_DENIED` | 422 | Missing ability during the instance recheck |
| `CASH_SESSION_NOT_FOUND`, `CASH_CLOSING_NOT_FOUND`, `CASH_HANDOVER_NOT_FOUND`, `CASH_REGISTER_NOT_FOUND` | 422 | Not in tenant scope |
| `CASH_SESSION_NOT_OWNED` | 422 | Session belongs to another cashier |
| `CASH_REGISTER_INACTIVE`, `CASH_REGISTER_NAME_CONFLICT` | 422 | Register lifecycle |
| `CASH_REGISTER_UNRELEASED_SESSION` | 422 | Register already has an unreleased session |
| `CASH_OPENING_NOT_CONFIRMED`, `_FUNDS_MISMATCH`, `_FLOAT_REUSE`, `_SOURCE_DRAWER_NOT_RELEASED`, `_HANDOVER_NOT_FOUND` | 422 | Opening-fund rules |
| `CASH_SESSION_NOT_WRITABLE` | 422 | Frozen / wrong status |
| `CASH_DECLARATION_ALREADY_SUBMITTED`, `CASH_DECLARATION_NOT_FOUND`, `CASH_ANNOTATION_BLOCKED` | 422 | Declaration rules |
| `CASH_ALREADY_VERIFIED`, `CASH_VERIFICATION_REQUIRED` | 422 | Verification rules |
| `CASH_SELF_VERIFICATION_FORBIDDEN`, `CASH_SELF_CLOSING_FORBIDDEN` | 422 | Separation of duties |
| `CASH_COUNT_EMPTY`, `_DUPLICATE_CHANNEL`, `_UNKNOWN_CHANNEL`, `_MISSING_CHANNEL` | 422 | Count coverage |
| `CASH_DENOMINATION_INVALID`, `_SUM_MISMATCH`, `_CASH_LINE_REQUIRED` | 422 | Denominations |
| `CASH_DISCREPANCY_NOTES_REQUIRED` | 422 | Note required for a non-zero difference |
| `CASH_HANDOVER_RECIPIENT_INVALID`, `_ALREADY_RECEIVED`, `_ALLOCATION_EXCEEDED`, `_SELF_WITHDRAWAL` | 422 | Custody rules |
| `CASH_CUSTODY_NOT_RECEIVED`, `CASH_DRAWER_NOT_RELEASED`, `CASH_DRAWER_ALREADY_RELEASED` | 422 | Release/closing ordering |
| `CASH_QUERY_INVALID_PAGE`, `_DATE_INVALID`, `_RANGE_INVALID` | 422 | Query bounds |
| `CASH_LEDGER_OUTSIDE_TRANSACTION`, `CASH_LEDGER_METHOD_INVALID` | 422 | Internal ledger contract |

Smaller/legacy codes: `CASH_CENTS_NOT_INTEGER`, `CASH_CENTS_OUT_OF_RANGE`,
`CASH_CENTS_NEGATIVE`, `CASH_ARITHMETIC_OVERFLOW`, `CASH_IDENTITY_REQUIRED`,
`CASH_DATE_INVALID`, `CASH_TENANT_MISMATCH`, `CASH_INVALID_STATUS_TRANSITION`,
`CASH_MOVEMENT_*`, `CASH_HANDOVER_*`, `CASH_SNAPSHOT_*`, `CASH_FOLIO_REQUIRED`,
`CASH_UNSUPPORTED_COMMAND`, `CASH_ACTOR_INACTIVE`,
`CASH_TENANT_MEMBERSHIP_REQUIRED`, `CASH_CATALOG_IDENTITY_INVALID`,
`CASH_CHANNEL_METHOD_MISMATCH`, `CASH_CHANNEL_LABEL_CONFLICT`.
Sales-bound codes exposed on the three operations: `CASH_SESSION_REVIEWER_NOT_ALLOWED`,
`CASH_SESSION_CREDIT_NOT_ALLOWED` (both `422`), plus `400 INVALID_CASH_SESSION_ID`
for validation.

## UI rules

- Never sum non-cash channels into physical cash. The physical drawer is the
  `CASH` channel (`Efectivo`); catalog channels are reported separately, and the
  closing totals are physical-cash totals.
- Count the opening fund (`FONDO INICIAL`) once and show it apart from custody
  withdrawals; FLOAT retained and WITHDRAWAL do not add to each other.
- Do not render an absent `expectedCashCents`/`differenceCents` as `0`; absence
  means the blind window is still open.
- Render the blind count form from the frozen `requiredChannels` identities; do
  not read the live payment catalog for it, and do not expect the field outside
  the owner's frozen blind window.
- Do not offer a "new blind count" after submission; only append notes.
- Treat both differences as distinct; never merge them into one number.
- Send `Idempotency-Key` as a stable per-attempt value; reuse it for retries of
  the same request, and never reuse it for a different body.
- Discover pending handovers and reusable FLOAT from
  `GET /cash-handovers/custody`, not from a session-audit query. Treat
  `eligibleFloat` as a hint: the decisive amount/reuse/source-drawer checks run
  again when a session is opened, so the list is not a reservation.

## Correction status

Corrections for the eight application findings passed focused regressions and
bounded independent rechecks, including the follow-up OPEN_SESSION context fix:

1. Commands and replays evaluate authoritative resource instances against CASL.
2. All query kinds require active user and tenant membership.
3. Base read and audit conditions filter individual rows before counts/pagination.
4. Both recording entry points independently lock and validate the active owner's OPEN session.
5. Blind projections omit all movements and their metadata.
6. Frozen `closingNotes` reaches the receipt parser from the actual adapter response.
7. `countedAt` comes from declaration revision 1, while notes use the latest revision.
8. Verification and closing require discrepancy explanations for every channel,
   including noncash. The first blind declaration still persists without them.

The release-drawer permission mapping is also aligned. Current session/closing
lists load tenant-matching rows before permission filtering in memory; large
histories need performance evaluation before production rollout.

## Verification evidence and limits

- Final full unit run after the PDF safe-integer correction: **354 suites,
  7,131 tests passed**, using fictitious JWT/storage configuration and a
  localhost:1 database placeholder. The PDF correction also passed
  **45 focused tests**, including four new signed safe-integer boundary cases,
  plus an independent recheck. No real environment or credentials were copied.
- Final non-DB runner checks confirmed that the proof config rejects missing
  opt-in, discovers exactly one proof spec with `--listTests`, and remains
  excluded from the normal unit suite. These discovery checks did not execute
  PostgreSQL tests; the real-database evidence below is historical.
- All migrations, including the cash migration, applied successfully to a new,
  owned PostgreSQL 16 container with temporary storage and a random loopback port.
  Existing database containers and ports 5432/5433 were untouched.
- **Three real PostgreSQL proofs passed:** concurrent opening and the partial
  unique index; tenant-composite FK and source uniqueness rejection; atomic
  rollback of payment, movement and idempotency; committed ambient replay;
  observed lock contention during freeze, inclusion of the 35,000-cent net
  movement, and rejection of later direct refund recording.
- PostgreSQL exposed an advisory-lock result decoding error hidden by mocks.
  Casting the `void` result to text fixed it without changing lock semantics.
  The final proof harness and cast received a bounded independent source review.
- Scoped ESLint, production `tsc --noEmit --incremental false` and
  `git diff --check` passed. Touched legacy sales files retain pre-existing
  lint debt; no claim of a clean project-wide lint run is made.
- These are bounded scenarios, not exhaustive race, load or deployment tests.
  Integration tests use separate CLS-like stores, not real Nest CLS propagation.
  Concurrent settlement lease reclamation and large-history performance remain
  outside the real-DB proof. Resource ownership comes from provisioning, not
  merely the URL guard.
- Initial application, sales, presentation and security work violated test-first
  ordering. Subsequent parent closing/authorization fixes and the repository
  idempotency fix have genuine RED/GREEN evidence; earlier chronology is not
  retroactively relabeled.
- Native reviews for domain, persistence, application units 1–8, HTTP/module,
  repository idempotency, POS and PDF were approved and acknowledged separately.
  Application unit 9's incomplete review was formally abandoned by explicit
  user decision; it is not approved and must not be resumed. Commits are local:
  no push, PR, frontend change or deployment is claimed.

### Running the dedicated PostgreSQL proof

Use only a newly provisioned, owned disposable PostgreSQL instance: loopback,
random port other than 5432/5433, database `cash_closing_proof_test`, user
`cash_proof`. Verify container ownership before applying migrations or tests.
Do not point this runner at an existing database or weaken the shared runner's
port protections. Apply migrations explicitly to the owned URL first.

```sh
CASH_PROOF_DISPOSABLE=1 \
CASH_PROOF_DATABASE_URL="$OWNED_DISPOSABLE_DATABASE_URL" \
DATABASE_URL="$OWNED_DISPOSABLE_DATABASE_URL" \
pnpm exec jest --config jest.cash-proof.config.cjs --runInBand
```

The dedicated config requires explicit opt-in; the spec validates matching URLs
before constructing Prisma. It does not load dotenv or the shared DB setup.
Remove only the owned disposable container after collecting results.
