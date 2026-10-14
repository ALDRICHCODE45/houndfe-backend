# POS cash-register closing — frontend integration handoff

## Objective

Give the frontend agent everything needed to integrate the **POS cash-register
closing** feature into the existing HoundFe frontend POS, using only documented,
implemented backend behaviour. This document is a handoff and plan, **not** an
implementation and **not** a second copy of the backend contract.

Primary goal: a permissions-aware UI for registers, the current session, manual
cash movements, the **blind** first count, independent verification, custody and
FLOAT, drawer release, immutable closing + folio, closing history, and the
closing PDF receipt — plus the optional `cashSessionId` binding on the three
allowed sales operations, without changing the external/bot path.

## Audience and how to use this document

- Audience: the frontend agent working in the sibling repo at
  `/home/aldrich_coder45/Desktop/workspace/houndfe/frontend-houndfe`.
- This document never overrides the backend contract. On any conflict, the
  contract wins and this file is a bug to report.
- Follow existing frontend language conventions. Preserve the Spanish UI labels
  explicitly named in the backend contract.

## Authoritative contract (read this first)

- Authoritative, complete contract (absolute path, authoritative content):
  `/home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend/.tmp/cash-register-closing/docs/cash-register-closing.md`
- Same file relative to this worktree: [docs/cash-register-closing.md](./cash-register-closing.md)
- It is the single source of truth for routes, DTO shapes, envelopes, status
  codes, permission rows, money/denomination rules, custody rules, errors,
  pagination, the frozen `snapshot`, and the PDF receipt.
- Complete, fictitious, strict-JSON response examples (OPEN blind, COUNTING
  blind with `requiredChannels`, SUBMITTED visible, declaration normal and
  fallback comparison, verification, and custody discovery):
  [contract "Complete fictional response examples (S3)"](./cash-register-closing.md#complete-fictional-response-examples-s3).
- **Do not duplicate its DTO tables, money rules or permission tables here.**
  Read them there and cite back to that file in the frontend PR.

Supporting backend docs already in this repo (read as needed, do not copy):

- [docs/RBAC.md](./RBAC.md) — auth, CASL, permission payloads used by the UI.
- [docs/multi-tenant-api.md](./multi-tenant-api.md) — tenant is JWT-derived.
- [docs/sales-pos-charge-frontend.md](./sales-pos-charge-frontend.md) — existing
  POS charge/collection conventions and current POS UI vocabulary.
- [docs/sales-pdf-receipt-frontend.md](./sales-pdf-receipt-frontend.md) — how
  the frontend already consumes backend-generated PDFs.

## Delivery status and non-promises

- Branch: `feat/cash-register-closing`
- Original delivery baseline: `7cd66e314504fbbed5e4840c0398023a267dfb4e`
- State: **implemented locally, committed per unit, NOT merged and NOT
  deployed.** Blind channel discovery (`requiredChannels`), recipient custody
  discovery (`GET /cash-handovers/custody`) and the `read:CashHandover`
  registry row are **locally committed additions** in `3909329` (channels)
  and `03bdf0b` (custody). The offline PDF fixture is in `2b4815d`.
  Final unit verification passed **356 suites / 7,167 tests**. No deployment,
  endpoint availability, new PostgreSQL proof or native review approval is
  claimed for these additions.
- **No endpoint availability is promised.** Do not assume the routes exist in any
  environment until the backend owner confirms a running URL, branch and
  environment (see [Open decisions](#open-decisions-to-coordinate)).
- Do not treat this feature as production-certified. The verification limits in
  the contract apply and are summarized below.

## Cross-cutting rules the UI must not violate

These come straight from the contract; each is a hard rule, not a preference.

- **Server authority.** The backend decides status, visibility, totals,
  differences and folios. Do not replace server-authoritative totals with client
  calculations. Local denomination sums and input validation may assist entry,
  but the backend remains authoritative.
- **Money is integer cents.** Never send decimals or strings; never sum non-cash
  channels into physical cash. Physical drawer = the `CASH` channel only. See
  contract "Money units, channels, and custody" and "UI rules".
- **Auth and tenant.** `Authorization: Bearer <accessToken>` on every route; the
  tenant comes only from the verified JWT. There is no tenant header, and
  `tenantId` in body/query is rejected. Cross-tenant ids fail closed.
- **Idempotency.** Every command route requires an `Idempotency-Key` header.
  Missing/empty/oversized → `400 INVALID_IDEMPOTENCY_KEY`; same key + same
  normalized request replays the stored response; same key + different request →
  `422 CASH_IDEMPOTENCY_CONFLICT`. Send a stable per-attempt key and reuse it for
  retries of the same body; never reuse it for a different body.
- **Null vs missing.** An absent `expectedCashCents`/`differenceCents` means the
  blind window is open. Absence is **not** `0` and must never be coerced to `0`.
  Similarly `cashSessionId: null` on sales is rejected — only omission is
  optional.
- **Blind discovery is identity-only.** In the owner's frozen blind window
  (`status: "COUNTING"`, `blind: true`) the detail adds a top-level
  `requiredChannels` list so the count form knows every channel it must declare
  without any amount. It is derived from the frozen snapshot, never the live
  payment catalog, and is absent (not `null`) before the freeze and after
  submission. Do not read the catalog to build the blind form.
- **Freeze is not drawer release.** `OPEN → COUNTING → SUBMITTED → CLOSED` is the
  lifecycle; `drawerReleasedAt` is a separate nullable event. Moving `OPEN` to
  `COUNTING` freezes operational writes and does **not** release funds.
- **Discrepancy originals are immutable.** On a non-zero difference a written
  note is required (`CASH_DISCREPANCY_NOTES_REQUIRED`); originals are preserved
  and **no balancing movement is manufactured**. Never offer a "new blind count"
  after submission — only append-only `declaration-notes`.
- **Custody is received by a real person.** The receipt actor is the
  authenticated JWT subject, never a body field; the actor must equal the
  designated `recipientUserId`. Sender-only assertion of another person's receipt
  is never allowed.
- **FLOAT transfer is explicit.** `FLOAT` retained and `WITHDRAWAL` are distinct;
  FLOAT can fund the next opening only if received by that opening cashier and
  equal to `openingCents`, and the same FLOAT cannot fund two sessions.
- **No automatic monetary balancing, ever.** The UI must never offer to "fix" a
  difference by writing an offsetting movement.

## Workflow: discover the existing frontend first

The frontend already has POS screens. Integration must extend them, not invent a
parallel layout.

1. Discover existing frontend POS conventions: routing/navigation shell, POS
   layout and tab structure, the existing sales/charge screens, the payments
   screens, PDF/receipt download patterns, table + pagination components,
   permission-gating helpers, tenant/auth client, idempotency header handling,
   and existing Spanish copy conventions.
2. Record the exact files/patterns found (paths + components) in the frontend PR
   description so the backend owner can review the mapping.
3. Only then propose a **minimal navigation** change: a "Caja" entry (register
   selection + current session) next to the existing POS, and a "Cortes" (closing
   history) entry, reusing existing table/detail/PDF primitives.
4. Reuse existing UI patterns and components. Do not invent new layouts,
   component libraries, or state-management approaches when a convention exists.

## Phased plan

Each phase lists the backend routes it consumes. Exact request/response shapes,
enums and error codes are in the contract — link to it, do not restate it.

### Phase 0 — Coordination and environment

- Confirm backend URL + API base path, target branch/environment, and an
  **isolated dataset** (tenant + test users) before any live call.
- Confirm the frontend will not point at production, run migrations, touch real
  databases, or assume push/merge/deploy.
- Agree on how `Idempotency-Key` is generated per attempt and how retries reuse it.

### Phase 1 — Registers

- `GET /cash-registers`, `POST /cash-registers`, `PATCH /cash-registers/:id`
- Permissions: `read:CashRegister`, `create:CashRegister`,
  `update:CashRegister`.
- UI: list, create with `name`, rename/activate (`isActive`). Handle
  `CASH_REGISTER_NAME_CONFLICT` and `CASH_REGISTER_INACTIVE`.

### Phase 2 — Current session and manual movements

- Open: `POST /cash-registers/:id/sessions` with `openingCents`,
  `openingConfirmed: true`, optional `openingHandoverId` (received FLOAT).
  `openingConfirmed` must be literally `true`.
- List/detail: `GET /cash-sessions`, `GET /cash-sessions/:id`.
- Manual movements: `POST /cash-sessions/:id/cash-in`,
  `POST /cash-sessions/:id/cash-out` (`amountCents` + required `reason`).
- Permissions: `create:CashSession`, `read:CashSession` (wider scope needs
  `read:CashSessionAudit`), `create:CashIn`, `create:CashOut`.
- UI: current-session panel showing status, opening fund, and manual movement
  form. Disable movement actions once the session is frozen
  (`CASH_SESSION_NOT_WRITABLE`).

### Phase 3 — Blind first count

- Freeze: `POST /cash-sessions/:id/start-count`
- Declare: `POST /cash-sessions/:id/declarations`
  (body: `lines`, optional `denominations`, optional `notes`; **no**
  `expectedCents`/`differenceCents` field — extra keys are `400`).
- Permission: `create:CashCount`.
- UI: while `blind: true`, render no expected/difference and do not display
  movements; an explicit `0` is a counted zero, an omitted channel is `MISSING`,
  and an empty `lines` array is rejected. When `denominations` are supplied they
  must sum exactly to the `CASH` line.
- Build the blind count form from the frozen `requiredChannels` identities, not
  the live payment catalog (see the contract's S3 example B).
- After submission, only append notes via
  `POST /cash-sessions/:id/declaration-notes`.

### Phase 4 — Verification and review

- Verify: `POST /cash-sessions/:id/verifications` (same body shape as a count),
  permission `create:CashVerification`.
- Independent person only: self-verification is denied
  (`CASH_SELF_VERIFICATION_FORBIDDEN`), and a non-zero difference requires a
  written note.
- UI: a review view for a **different** authenticated user than the cashier,
  showing expected vs declared vs verified as **separate** differences. Never
  merge the two differences into one number.

### Phase 5 — Custody, FLOAT, drawer release

- Declare custody: `POST /cash-sessions/:id/handovers`
  (`handoverKind: "WITHDRAWAL" | "FLOAT"`, `recipientUserId`, `declaredCents`,
  optional `notes`), permission `create:CashHandover`.
- Receive: `POST /cash-handovers/:id/receive` (actor-bound, permission
  `update:CashHandover`).
- Discover: `GET /cash-handovers/custody` (permission `read:CashHandover`)
  returns the authenticated recipient's `pendingHandovers` and `eligibleFloat`,
  paginated. It exposes no filters — the recipient and tenant come from the JWT
  and extras are rejected. Treat `eligibleFloat` as a hint, never a reservation:
  opening re-runs the authoritative checks.
- Release drawer: `POST /cash-sessions/:id/release-drawer`, permission
  `create:CashHandover` (per the contract, release is governed by outgoing
  custody, not receipt).
- UI: an explicit "receive" action for the designated recipient; do not let a
  sender mark another person's receipt. Allocations must equal counted cash and
  all handovers must be received before release/closing.

### Phase 6 — Closing and history

- Close: `POST /cash-sessions/:id/close` (`notes` optional), permission
  `create:CashClosing`. Requires `SUBMITTED`, drawer released, a verification and
  a fully allocated custody split; the closer must differ from the cashier
  (`CASH_SELF_CLOSING_FORBIDDEN`).
- History: `GET /cash-closings` (paginated) and `GET /cash-closings/:id`
  (immutable detail), permission `read:CashClosing`.
- UI: history table with `folio`, `createdAt`, and detail rendered from the
  frozen `snapshot`. Remember: closing totals are **physical cash** totals, and
  per-channel `differenceCents` is declared − expected only.

### Phase 7 — Closing PDF

- `GET /cash-closings/:id/pdf`, permission `read:CashClosing`.
- Server returns `application/pdf` with a `Content-Disposition` filename and
  `Cache-Control: private, no-store`. Reuse the existing frontend PDF download
  pattern from [docs/sales-pdf-receipt-frontend.md](./sales-pdf-receipt-frontend.md).
- The receipt is rendered only from the frozen snapshot; the frontend must not
  recompute its totals.

### Phase 8 — Sales binding (three paths only)

Optional `cashSessionId` on exactly these three operations, permission
`update:Sale` / `update:SaleRefund`, `Idempotency-Key` required:

| Operation         | Route                                       | DTO                               |
| ----------------- | ------------------------------------------- | --------------------------------- |
| Initial charge    | `POST /sales/drafts/:id/charge`             | `ChargeSaleDto.cashSessionId`     |
| Later collection  | `POST /sales/:id/payments`                  | `AddSalePaymentDto.cashSessionId` |
| Refund settlement | `POST /sales/refunds/:refundId/settlements` | `SettleRefundDto.cashSessionId`   |

- Omission preserves the legacy external/bot flow and its idempotency hash.
- `null` is rejected (`400 INVALID_CASH_SESSION_ID`) — send the field only when
  binding, otherwise omit it entirely.
- Session must belong to the caller and be writable
  (`CASH_SESSION_NOT_OWNED`, `CASH_SESSION_NOT_WRITABLE`).
- Reviewer/bot auth mode together with `cashSessionId` is a contradiction
  (`422 CASH_SESSION_REVIEWER_NOT_ALLOWED`); credit refunds cannot be
  session-bound (`422 CASH_SESSION_CREDIT_NOT_ALLOWED`).
- Do not change the external/bot collection path.

## Acceptance checklist per flow

Use these as PR acceptance criteria. Each is observable and cites the contract.

- **Registers**: create/rename/activate work; permission rows gate each action;
  name conflict and inactive register surface the documented errors.
- **Current session**: opening requires `openingConfirmed === true`; the panel
  shows status, opening fund and drawer state as separate facts; movement
  actions are disabled after freeze.
- **Blind count**: while `blind: true` the UI shows no expected/difference values
  and no movements; omitted vs `0` channels are distinguishable; empty count is
  blocked; a post-submission change only appends notes.
- **Verification**: a different authenticated user can verify; self-verification
  is blocked; the two differences are displayed separately; the UI never
  fabricates a balancing movement.
- **Custody / FLOAT**: FLOAT and WITHDRAWAL are visually distinct; receipt is
  performed by the actual recipient; reuse/reuse-violation errors are surfaced;
  FLOAT funding the next opening is explicit, not implicit.
- **Custody discovery**: pending handovers and eligible FLOAT come from
  `GET /cash-handovers/custody` (not a session-audit query); the result is a
  hint, not a reservation, and an unreleased source drawer is displayed rather
  than trusted.
- **Closing**: close is blocked until status, drawer release, verification and
  full custody allocation are satisfied; the resulting folio/detail is treated
  as immutable.
- **History**: pagination uses 1-based `page`/`limit` (defaults 1/25, cap 100)
  with strict unsigned integers; `from`/`to` are ISO-8601 **with timezone**;
  unknown query keys are rejected. See the contract's pagination section.
- **PDF**: download uses the existing pattern; the response content type and
  cache headers are respected; no client-side total recomputation.
- **Sales binding**: only the three routes send `cashSessionId`; it is omitted by
  default; `null` is never sent; the external/bot path is behaviorally unchanged.

## Permissions summary

Permission rows are granular CASL permissions, not named roles. Cite the
contract's route table rather than duplicating it. Registered rows:
`read|create|update` on `CashRegister`; `read|create` on `CashSession`;
`create` on `CashCount`, `CashIn`, `CashOut`, `CashVerification`, `CashHandover`,
`CashClosing`; `read|update` on `CashHandover`; `read` on `CashSessionAudit` and
`CashClosing`. `read:CashHandover` is the dedicated recipient-custody read and
is independent of `read:CashSessionAudit`. No
`delete`/`batch_delete`/`manage` rows exist for any `Cash*` subject. The
frontend should gate UI by these abilities and still handle server-side
`403`/`CASH_PERMISSION_DENIED`.

## Known quirks and traps

- **Custody discovery is not a reservation.** A FLOAT can still appear under
  `eligibleFloat` while its source drawer is unreleased (the item reports
  `sourceDrawerReleasedAt: null`); opening remains authoritative. Never use the
  list to mark a FLOAT as reserved or to block another register. Missing
  `read:CashHandover` is a denial (`CASH_PERMISSION_DENIED`), never a silent
  empty page.
- **Closing list filter quirk**: the shared closing-list DTO accepts and
  validates `cashierUserId`, but the closing query does **not** apply it. Do not
  use it to filter closing history. Without audit permission, the closings list
  is scoped to closings closed by the caller or belonging to the caller's
  sessions.
- **Not-found status**: cash rule/application violations are thrown as
  `BusinessRuleViolationError` and fall through to the global filter's generic
  `422`, so `CASH_*_NOT_FOUND` is `422`, not `404`. DTO failures are `400`;
  guard failures are `401`/`403`.
- **Status codes**: `201` for create-style routes, `200` for `start-count`,
  `release-drawer`, `/cash-handovers/:id/receive` and all `GET`s.
- **Count coverage**: every required channel exactly once; empty `lines` is not a
  zero count; extra keys are rejected by `forbidNonWhitelisted`.
- **Snapshot names**: `cashierName`, `verifierName`, `closedByName` in the frozen
  snapshot come from backend data, not client-supplied names.

## Testing: mocked vs live proof

- Frontend unit tests with mocked API responses prove UI behaviour only. They do
  **not** prove backend integration.
- Treat mocked tests as necessary but insufficient. The frontend must add at
  least one live, end-to-end happy path against the agreed isolated backend
  before claiming integration, and document exactly which routes were exercised
  live.
- Record whether the live path ran against the local worktree build or a shared
  environment; do not label mocked tests as end-to-end.
- Do not claim real CLS propagation, exhaustive races, or load behaviour from
  frontend tests.

## Verification evidence and limits (backend, historical)

Cite these as context, not as a frontend guarantee:

- Historical local full unit run after the PDF safe-integer correction:
  **354 suites, 7,131 tests passed** with fictitious JWT/storage configuration
  and a `localhost:1` DB placeholder.
- **Three real PostgreSQL proofs** passed on a dedicated disposable container
  (concurrent opening + partial unique index; tenant-composite FK and source
  uniqueness rejection; atomic rollback/replay and freeze lock contention).
  Existing databases were untouched and the owned container was removed.
- These are bounded scenarios, not exhaustive races, load, or deployment tests.
  Integration tests use separate CLS-like stores, not real Nest CLS propagation.
  Large-history performance and concurrent lease reclamation remain outside proof.
- **Review status**: domain, persistence/permissions, application units 1–8,
  HTTP/module, repository idempotency, POS, PDF and final docs/PG proof were
  approved and acknowledged. **Application unit 9 has no completed native review**
  (its review was formally abandoned by explicit user decision) and the aggregate
  change was explicitly left unreviewed. This is a known status, not a frontend
  blocker, but it must not be represented as "fully reviewed".

## Open decisions to coordinate

These are real questions for the backend owner / frontend owner. Do not invent
requirements; resolve them together before or during Phase 0.

1. **Backend URL + base path + environment/branch** to point at, and whether the
   worktree build is exposed or only a reviewed commit will be.
2. **Isolated test data**: which tenant and test users can exercise cashier,
   verifier/closer and designated recipient actions. Verifier and closer must
   differ from the cashier; they need not differ from each other. Do not impose
   a new three-distinct-users requirement.
3. **Navigation placement**: where "Caja"/"Cortes" belong in the existing POS IA,
   based on the discovered frontend conventions.
4. **Idempotency-Key lifecycle**: generation per attempt and reuse policy on
   manual retry versus automatic retry.
5. **Audit visibility screens**: whether the frontend needs a session-audit view
   requiring `read:CashSessionAudit`, or only the caller's own sessions.
6. **Money/denomination input UX**: how cents and denomination quantities are
   entered and validated client-side without sending decimals.
7. **Refetch strategy** after freeze/close/handover (no realtime event stream is
   claimed by the contract).
8. **Error copy mapping**: how `CASH_*` `422` errors map to Spanish UI messages.
9. **Closing-list filter**: confirm the frontend must hide the unsupported
   `cashierUserId` filter rather than relying on it server-side.

## Out of scope / do not

- No frontend implementation is performed by the backend owner; the frontend peer
  owns all frontend code.
- No production, migrations, real databases, push, merge, deploy, or environment
  changes are implied by this feature's current state.
- Do not modify any backend DTO, route or rule to fit the UI; raise a contract
  question instead.
- Do not backfill legacy payments, do not route external/bot collections through
  sessions, and do not claim secrecy beyond what the contract claims (sales
  visibility may still allow inference of expected amounts).

## Definition of done for this handoff

- Frontend agent has read the authoritative contract
  (`/home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend/.tmp/cash-register-closing/docs/cash-register-closing.md`).
- The open decisions above are resolved or explicitly deferred with an owner.
- The phased plan is reflected in the frontend PR scope with the acceptance
  checklist used as criteria, and at least one live end-to-end path is recorded.
