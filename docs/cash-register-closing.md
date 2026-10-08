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
- Sales visibility may still allow inference of expected amounts. This contract
  claims no broader secrecy and does not redesign analytics permissions.

## Independent verification and closing

- Verification requires status `SUBMITTED` and a **different** authenticated
  person than the cashier (`CASH_SELF_VERIFICATION_FORBIDDEN`).
- Closing requires status `SUBMITTED`, the drawer released, a verification and a
  fully allocated custody split; the closer must also differ from the cashier
  (`CASH_SELF_CLOSING_FORBIDDEN`).
- On a declaration or verification difference a written note is required
  (`CASH_DISCREPANCY_NOTES_REQUIRED`); originals are always preserved and no
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
| `/cash-closings` | `GET` | `read:CashClosing` | Paginated history |
| `/cash-closings/:id` | `GET` | `read:CashClosing` | Immutable detail |
| `/cash-closings/:id/pdf` | `GET` | `read:CashClosing` | Frozen receipt |

No `delete`, `batch_delete` or `manage` permission rows exist for any Cash\*
subject; only `read`, `create` and the two `update` rows above are registered.
Permission rows: `read:create:update` on `CashRegister`; `read` + `create` on
`CashSession`; `create` on `CashCount`, `CashIn`, `CashOut`, `CashVerification`,
`CashHandover`, `CashClosing`; `update` on `CashHandover`; `read` on
`CashSessionAudit` and `CashClosing`. `read:CashSessionAudit` widens list/detail
scope (`cashierUserId` filter and other users' rows); without it, listing is
restricted to the caller's own sessions.

¹ `create:CashHandover` governs outgoing custody and drawer release in both
HTTP and application checks. `update:CashHandover` remains the separate receipt
permission; releasing a drawer does not require granting receipt permission.

### Envelope types (all documents are plain JSON; no wrapper key is added)

`GET /cash-registers` → `{ items: [{ id, name, isActive, createdAt }] }`
`POST/PATCH /cash-registers` → `{ id, name, isActive, createdAt }`
`POST /cash-registers/:id/sessions` → `{ session, register: { id, name, isActive } }`
`GET /cash-sessions` → `{ items: CashSessionProjection[], page, limit, total }`
`GET /cash-sessions/:id` → `{ session, register|null, movements[], counts[], handovers[], closing|null, channelSnapshot|null }`
`POST .../start-count` → `{ session }`
`POST .../declarations` → `{ sessionId, status: "SUBMITTED", declaration, comparison }`
`POST .../declaration-notes` → `{ sessionId, revision, lines, denominations|null, notes }`
`POST .../verifications` → `{ sessionId, verification, comparison }`
`POST .../cash-in|cash-out` → `{ id, sessionId, kind, deltaCents, occurredAt }`
`POST .../handovers` and `/cash-handovers/:id/receive` → `{ id, sessionId, kind, declaredCents, receivedCents, senderUserId, receiverUserId, receiptActorUserId, declaredAt, receivedAt, notes, receiptNotes }`
`POST .../release-drawer` → `{ sessionId, drawerReleasedAt }`
`POST .../close` and `GET /cash-closings/:id` → `{ id, sessionId, folio, createdAt, snapshot }`
`GET /cash-closings` → `{ items: [{ id, sessionId, folio, createdAt }], page, limit, total }`

`CashSessionProjection`:
`{ id, tenantId, registerId, status, cashierUserId, openingCents, frozenAt|null, drawerReleasedAt|null, blind }`
plus `expectedCashCents?` and `differenceCents?` only when visible. Hidden means
**absent**, not `null` — never coerce absence to a zero.

`declaration` = `{ revision, lines, denominations|null, notes|null, cashCents }`.
`verification` adds `actorUserId`. `comparison` = `{ expectedCents, declaredCents,
verifiedCents|null, declarationDifferenceCents, verificationDifferenceCents|null,
verifiedVsExpectedDifferenceCents|null, requiresDeclarationNotes,
requiresVerificationNotes, hasDiscrepancy }`.

HTTP status codes are `201` for create-style routes, `200` for
`start-count`, `release-drawer`, `/cash-handovers/:id/receive` and all `GET`s,
`201` for declarations, notes, verifications, cash-in/out, handovers and close.

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
- Do not offer a "new blind count" after submission; only append notes.
- Treat both differences as distinct; never merge them into one number.
- Send `Idempotency-Key` as a stable per-attempt value; reuse it for retries of
  the same request, and never reuse it for a different body.

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
