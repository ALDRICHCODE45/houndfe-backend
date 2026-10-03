# Human Decisions EXPIRATION — Backend API Readiness Handoff

**Status: backend implementation delivered locally at repo HEAD `cde0f58` (branch `feat/human-decisions-expiration`, not deployed). Both human-decision types — RESTOCK and EXPIRATION — flow through the same pipeline.**

> This document records what the backend delivers and where to verify it. It intentionally does NOT restate the full wire contract. The authoritative external contract is the sibling repo doc `houndfe-chatbot-human-decisions/docs/human-decisions-expiration-v1.md` (pointer only; not duplicated here).
>
> No deployment, original-database reconciliation, or activation is confirmed by this document. Those remain separate owner decisions.

---

## 1. Delivered pipeline (both decision types)

One shared, same-row flow for RESTOCK and EXPIRATION:

1. **Bot intake** — bot submits a decision request; server fixes `source`/branch and validates the client-declared `type` discriminant (the RESTOCK canonicalizer fixes the RESTOCK type server-side, while the EXP parser requires the body to declare `type: "EXPIRATION"` and rejects any other value — the type is client-declared and validated, never server-invented); identity `(tenantId, source, sourceRequestId)` is shared across types (cross-type key reuse answers 409); exact replay returns the same immutable snapshot.
2. **POS list/detail** — reviewer sees the pending decision in the list and detail read model, including type-specific payload.
3. **POS resolve** — reviewer resolves with an audited, idempotent resolve (`expectedVersion` + `resolutionRequestId`); EXPIRATION carries validated `expirationText`.
4. **Bot poll** — bot polls the decision by id; response excludes reviewer identity and authority fields by design.
5. **Bot ACK replay** — bot posts the application outcome; the terminal ACK is idempotent — replays answer from the persisted `ackReceivedAt` and never re-validate the time window.

Source map:

| Stage | Source |
| --- | --- |
| Intake (RESTOCK / EXPIRATION) | `src/human-decisions/presentation/bot-restock-intake.controller.ts`, `src/human-decisions/infrastructure/prisma-restock-intake.repository.ts`, `src/human-decisions/infrastructure/prisma-expiration-intake.repository.ts` |
| POS read/resolve | `src/human-decisions/presentation/human-decision-review.controller.ts`, `src/human-decisions/infrastructure/prisma-human-decision-review-read.repository.ts`, `src/human-decisions/infrastructure/prisma-human-decision-review-resolve.repository.ts` |
| Bot poll | `src/human-decisions/presentation/bot-restock-poll.controller.ts`, `src/human-decisions/infrastructure/prisma-bot-restock-poll.repository.ts` |
| Bot ACK | `src/human-decisions/presentation/bot-application-outcome.controller.ts`, `src/human-decisions/infrastructure/prisma-bot-application-outcome.repository.ts` |
| `expirationText` validation (pure) | `src/human-decisions/domain/expiration-text.ts` (HD-EXP-01a) |
| Module wiring | `src/human-decisions/human-decisions.module.ts` |

## 2. Endpoints (routes only)

Full request/response shapes, status semantics and error codes live in the sibling contract; only the route map is repeated here.

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/chatbot-api/human-decisions` | POST | ServiceAuthGuard | Bot intake (RESTOCK and EXPIRATION) |
| `/human-decisions` | GET | JWT + tenant/reviewer guards | POS list (both types) |
| `/human-decisions/:id` | GET | JWT + tenant/reviewer guards | POS detail |
| `/human-decisions/:id/resolve` | POST (200) | JWT + tenant/reviewer guards | POS resolve; first resolve and idempotent replay both answer 200 |
| `/chatbot-api/human-decisions/:id` | GET | ServiceAuthGuard | Bot poll |
| `/chatbot-api/human-decisions/:id/application-outcome` | POST (200) | ServiceAuthGuard | Bot terminal ACK |

## 3. Type-aware behavior

- **ACK application window** is per admitted type on the **bot-observed `attemptedAt`**: the half-open `[resolvedAt, resolvedAt + window)` — **1h for RESTOCK, 24h for EXPIRATION** (RESTOCK behavior preserved; see `windowMsForType` in `prisma-bot-application-outcome.repository.ts`). Three distinct timestamps are involved: `attemptedAt` (bot claim; gates the window), `providerAcceptedObservedAt` (bot claim; gates the deadline split) and `ackReceivedAt` (backend server clock; audit-only, independent of both bot claims).
- **The backend does NOT convert outcomes at the deadline.** The bot DECLARES the outcome: for a declared `PROVIDER_ACCEPTED`, `providerAcceptedObservedAt` must fall strictly before the deadline; for a declared `PROVIDER_ACCEPTED_LATE`, it must fall at/after it. A declaration that contradicts the observed timestamps (or an `attemptedAt` outside the window) is rejected — it is never silently reclassified.
- **Internal vs wire error codes**: an out-of-contract window/declaration throws an `InvalidArgumentError` carrying the internal `INVALID_OUTCOME_WINDOW` code; the route-scoped filter maps that `InvalidArgumentError` class to a fixed, value-free **`400 VALIDATION_ERROR`** on the wire (`INVALID_OUTCOME_WINDOW` is never echoed to the client; same for the parser's internal `INVALID_OUTCOME_REQUEST`).
- **ACK replay stability**: a replay is answered from the persisted `ackReceivedAt`; the window is never re-checked on replay.
- **ACK `evidenceCode` prohibition**: the terminal ACK wire explicitly FORBIDS `evidenceCode` (any presence, even `null`, is a sanitized 400, never stripped); the canonical evidence hash EXCLUDES it; and the reserved `applicationEvidenceCode` DB column is always persisted `NULL` by the ACK adapter.
- **`expirationText`**: normalized and length-checked by the pure domain parser before persistence; POS detail verifies the stored text against it. A **negative EXP resolution omits `expirationText` entirely** (never `null`) in both the resolve response and the bot poll response.

## 4. Response-shape guarantees

- **POS** surfaces `resolvedBy` built from the immutable `resolvedByActorId` / `resolvedByDisplayName` snapshots pinned by the HD-01 `CHECK` — never the mutable `resolvedById` relation (see `src/human-decisions/presentation/dto/human-decision-review.response.ts`).
- **Bot** poll/outcome responses deliberately omit reviewer identity and authority fields (`resolvedBy`, `resolvedById`/`resolvedByActorId`/`resolvedByDisplayName`); see the header of `src/human-decisions/presentation/dto/bot-restock-poll.response.ts`.
- **Malformed JSON** on `/human-decisions` answers a fixed, value-free 400 envelope: a route-scoped parser plus sanitizing error handler is installed ahead of Nest's defaults for that path only (documented in code at `src/human-decisions/presentation/filters/human-decision-body-parser.ts`). The bot **terminal-ACK route** (`POST /chatbot-api/human-decisions/:id/application-outcome`) has its own dedicated sanitizing route-scoped parser (`installBotApplicationOutcomeBodyParser` in the same file). The bot **intake** (`POST /chatbot-api/human-decisions`) and **poll** (`GET .../:id`) keep Nest's default parser behavior. Malformed bodies answer 400 before authentication; this is transport-level and does not bypass the guard chain for valid bodies.

## 5. Verification status (facts; no runtime checks were re-run for this document)

- **Integration coverage (recorded execution, NOT re-run for this document)**: 220 PostgreSQL integration tests across **11 suites** were observed passing in the delivering session's recorded run; the **24 offline helper tests** were observed passing by the independent verifier. Both figures are observed facts from that history, not re-executed here and not static estimates.
- The 11 suites — five infrastructure (`prisma-restock-intake`, `prisma-bot-restock-poll`, `prisma-bot-application-outcome`, `prisma-human-decision-review-read`, `prisma-human-decision-review-resolve`, all `.repository.integration.spec.ts`), five controller (`bot-restock-intake`, `bot-restock-poll`, `bot-application-outcome`, `human-decision-review`, `human-decision-review.resolve`, all `*.integration.spec.ts`), and one end-to-end journey:
  - `src/human-decisions/presentation/human-decisions.expiration-journey.integration.spec.ts` — same-decision journey (intake -> POS list/detail -> resolve -> bot poll -> ACK replay) for both positive and negative actions.
- **Concurrency evidence**: one 200/409 scenario verified with the correctly persisted winner. **Forced CAS interleaving was NOT proven** — do not treat race handling as stronger than that evidence.
- **Typecheck**: production typecheck passed. Full-repo `tsc` reported 187 errors (worker-reported; causality vs. baseline unproven — not evidence about this feature).
- **Migrations**: `migrate deploy` + `generate` ran once, explicitly user-authorized, against the `nest-practice` local PostgreSQL (localhost:5432): 58 migrations, none pending. This is **not** a checksum-reconciliation proof; the original-database checksum discrepancy remains unresolved.
- **Reviews**: per-unit reviews are closed. The tracker records IDs and targets for EXP-01 (`review-edf41048cfdda101`), EXP-02 (`review-e17a8215001df098`) and EXP-03 (`review-0599454f52a0a434`), the earlier migration-correction review (`review-abf7b3d871bfced3`) and two acknowledged revision hashes for the intake/HTTP boundary reviews; **EXP-04's closure is recorded without a review ID in the tracker**. A **cumulative review has NOT been done**. A supplemental read-only integration review of the human-decisions/ACK surface was additionally performed in the delivering session (read-only, no severe findings confirmed); it does NOT replace the cumulative review of the full ~9,000-line change, which remains not done. No new runtime checks were executed for this document.

## 6. Not delivered / pending (EXP-05)

- Cross-app frontend + bot smoke against a running backend: **not done**.
- Provider delivery end-to-end (WhatsApp provider): **not done**.
- Original-database checksum reconciliation and deployment/activation: **separate owner decisions**.
- Do not notify frontend/bot that the API is production-ready until EXP-05 closes those items.

## 7. Change magnitude

Range `80561908..cde0f58`: 51 files, 8,778 additions, 222 deletions (~9,000 total). Flagged **needs-review with a scoped review plan** — this is not an automatic large-START approval. Scope, forecasts and per-unit review records live in the tracker.

## 8. Handoff checklist for consumers

- [ ] Read the sibling contract for exact wire shapes; treat this doc as the delivery map only.
- [ ] Do not persist or trust bot-facing reviewer identity — it is intentionally absent.
- [ ] Treat resolve and ACK as idempotent; replay safely on transport failure.
- [ ] Handle the documented 400/404/409 intake semantics (value-free errors) and expect a fixed `400 VALIDATION_ERROR` for out-of-window or contradictory ACK declarations (the internal `INVALID_OUTCOME_WINDOW` code is not exposed on the wire).
- [ ] Await EXP-05 (cross-app smoke, provider delivery) before declaring the integration live.
