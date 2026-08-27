# Sync Report — `delivery-routes`

- **Status:** `synced`
- **Phase:** `sdd-sync` (file-backed OpenSpec store; change left active — NOT archived)
- **Repository:** `houndfe-backend` @ `feat/delivery-routes-wu3`
- **Change root:** `openspec/changes/delivery-routes/`
- **Canonical target:** `openspec/specs/delivery-routes/spec.md`
- **Sync date:** 2026-08-27 (post-WU3; WU1/WU2/WU3 all committed)

---

## 1. Inputs consumed

| Artifact | Path / source | State |
|---|---|---|
| Proposal | `openspec/changes/delivery-routes/proposal.md` | present |
| Design | `openspec/changes/delivery-routes/design.md` | present |
| Tasks | `openspec/changes/delivery-routes/tasks.md` | present; 39/43 checkboxes resolved (see §5) |
| Apply progress / verification evidence | `openspec/changes/delivery-routes/apply-progress.md` | present; per-WU `### Verification` sections record gates |
| Verify report | `openspec/changes/delivery-routes/verify-report.md` | **absent** — see §6 (finding F-6) |
| Change specs dir | `openspec/changes/delivery-routes/specs/` | **absent** — the spec phase wrote the canonical spec directly at `openspec/specs/delivery-routes/spec.md` (commit `0d76621`) |
| Config | `openspec/config.yaml` | present (`schema: spec-driven`; `rules.sync` not defined — no extra sync rules to apply) |
| Canonical spec | `openspec/specs/delivery-routes/spec.md` (1203 lines pre-sync) | reconciled this phase |

## 2. Domains synced and canonical files updated

- **Domain:** `delivery-routes`
- **Canonical file updated:** `openspec/specs/delivery-routes/spec.md` (80 insertions / 76 deletions)
- No other canonical specs were touched. No change folder was moved to `openspec/archive/` (that is the separate `sdd-archive` phase).

## 3. What was reconciled (drift found between pre-implementation spec and implemented reality)

The canonical spec was authored during the spec phase (pre-implementation). Implementation
(WU1–WU3) was read directly from `src/` and `prisma/` and compared requirement-by-requirement.
The following drift was found and the canonical spec was updated to match the **implemented**
behavior:

### D-1 — One Active Route Per Sale: single-layer enforcement (409), no fast-422 pre-check
- **Spec (before):** two layers — an application-level pre-check that threw
  `DeliveryRouteStopSaleAlreadyOnActiveRouteError` with HTTP **422** on the common case, plus
  the DB partial unique index as the authoritative **409** race guard. Scenario
  *"Pre-check catches the common case as 422"*.
- **Implemented:** no application pre-check query exists. `DeliveryRoute.start()` only asserts
  `DRAFT` + ≥ 1 stop and arms `activeRouteId`; `PrismaDeliveryRouteRepository.save` maps the
  partial-unique-index `P2002` (both common case and race) to
  `DeliveryRouteSaleAlreadyInActiveRouteError` (code
  `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`), which `domain-exception.filter.ts`
  maps to HTTP **409** (verified against real Postgres in the integration spec).
- **Sync action:** requirement renamed to *"One Active Route Per Sale (DB Partial Unique Index)"*,
  body rewritten to the single authoritative layer + aggregate DRAFT-gating, scenario renamed
  to *"A pre-existing active claim resolves as 409"* with `THEN` changed 422 → 409, and the
  `P2002` mapping now names the concrete error class.

### D-2 — `start` does NOT re-validate sale eligibility
- **Spec (before):** `start` MUST re-validate each stop's sale eligibility inside the transition
  transaction; failure → 422 `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE`, rollback. Scenario
  *"Start with a now-ineligible stop is rejected"*.
- **Implemented:** eligibility is validated at `create`/`addStop` only; `start()` re-validates
  nothing. A sale that became `DELIVERED` between stop-add and start still starts; the check-in
  mirror (`Sale.markDelivered`) is idempotent for an already-delivered sale.
- **Sync action:** requirement text updated to state eligibility is add-time only and `start`
  does not re-validate; scenario replaced with *"Start does not re-validate eligibility — a
  now-ineligible stop still starts"*. `Verification Surface` entry for
  `delivery-route.entity.spec.ts` updated ("re-validation on `start()`" → "create-time
  eligibility validation").

### D-3 — Outbox payload fields differ
- **Spec (before):** payload carried `nextSaleFolio` and `nextEstimatedApproach: 'soon'`.
- **Implemented:** `DeliveryNextStopNotifyPayload` =
  `{ tenantId, routeId, currentStopId, nextStopId, nextSaleId, nextCustomerName, nextAddressLabel, nextCustomerEmail, idempotencyKey, occurredAt }`
  (see `src/delivery-routes/outbox/delivery-route-outbox.types.ts`). `idempotencyKey` =
  `${tenantId}:${currentStopId}`; `occurredAt` = ISO-8601 check-in timestamp.
- **Sync action:** payload list in *Durable Next-Stop Notification Pipeline* rewritten to the
  implemented field set (adds `nextStopId`, `idempotencyKey`, `occurredAt`; drops
  `nextSaleFolio`, `nextEstimatedApproach`).

### D-4 — Stop-set mutation endpoints are dedicated routes, not PATCH fields
- **Spec (before):** `PATCH /delivery-routes/:id` allowed mutating `driverUserId` and the stop
  set (addStop / removeStop / reorderStops / assignDriver).
- **Implemented:** `PATCH /delivery-routes/:id` mutates `driverUserId` + `notes` only;
  `POST /delivery-routes/:id/stops` = addStop; `PUT /delivery-routes/:id/stops/reorder` =
  reorderStops; **`removeStop` is NOT exposed** (no such method/endpoint exists in `src/`).
- **Sync action:** *Edit DeliveryRoute Stops and Driver Only While DRAFT* rewritten to the
  actual endpoint surface; `removeStop` explicitly documented as not exposed.

### D-5 — Subject-instance resolver wiring mechanism
- **Spec (before):** `DeliveryRoutesModule` MUST **provide**
  `{ DeliveryRoute: { resolveSubject } }` via DI.
- **Implemented:** same seam (`SUBJECT_INSTANCE_RESOLVERS = Symbol.for('SubjectInstanceResolvers')`)
  but registered into the static `SubjectInstanceResolverRegistry` at module construction
  (avoids AuthModule ↔ DeliveryRoutesModule circular DI); the guard reads the registry on every
  `canActivate`. Behavior is identical (resolver returns `{ driverUserId }` or `null`; null
  defers to the service-layer 404).
- **Sync action:** requirement text updated from "provide" to "register into the static
  `SubjectInstanceResolverRegistry` (seam token …) at module construction time".

### D-6 — Outbox poller effective interval
- **Spec (before):** "fixed interval (default `1000ms`)".
- **Implemented:** `@Interval(1000)` decorator tick; effective default poll interval `5000ms`
  (DI-overridable symbol), batch size 25, `FOR UPDATE SKIP LOCKED` + `lockToken`/`lockedUntil`.
- **Sync action:** numeric detail reconciled in the requirement text.

### D-7 — Verification Surface accuracy
- Removed three spec bullets whose files do not exist:
  `dto/delivery-route-response.dto.spec.ts`, `outbox/delivery-routes-outbox.poller.spec.ts`,
  `outbox/delivery-routes-outbox.dispatcher.spec.ts` (DTO mapper covered by service +
  integration read-model specs; claim-disjointness covered by the extended
  `src/shared/outbox/outbox-poller.service.spec.ts`).
- Added the actual `src/delivery-routes/infrastructure/manual-route-optimizer.spec.ts` bullet.
- Fixed paths: `permissions.guard.spec.ts` → `src/auth/authorization/guards/permissions.guard.spec.ts`;
  `notification-config.drift.spec.ts` → `src/notification-config/domain/notification-config.drift.spec.ts`;
  `prisma-sale.repository.integration.spec.ts` →
  `prisma-sale.repository.markSaleDelivered.integration.spec.ts`.
- Final verification line updated to the real numbers: `pnpm test` → **211 suites / 2929 tests
  green**; integration specs green on test DB 5433 (incl. ADR-7 `P2002` → 409 vs real Postgres).

## 4. ADDED / MODIFIED / REMOVED requirements

No requirements were added or removed — all 18 requirements remain. The sync was **reconciliatory
(MODIFIED content within existing requirement blocks)**:

- `DeliveryRoute Lifecycle States` — unchanged (verified: 4-state lifecycle, timestamps, indexes all match schema/entity).
- `Route Stop Model and Ordering` — unchanged (verified: model, `@@unique([routeId, sortOrder])`, SKIPPED reserved).
- `Create DeliveryRoute in DRAFT` — unchanged (verified: DTO `saleIds ≥ 1`, eligibility at create, 201 + DTO).
- `Edit DeliveryRoute Stops and Driver Only While DRAFT` — **MODIFIED** (D-4 endpoint surface).
- `Start DeliveryRoute (DRAFT → ACTIVE)` — **MODIFIED** (D-2 no re-validation).
- `Check-In Stop Atomically Writes Stop, Sale Mirror, and Outbox Event` — unchanged (verified: single tx, idempotent replay, auto-complete, P2025 → 404 mapping).
- `Sale Delivery Status Is Mirrored Atomically by the Route Flow` — unchanged (verified: `markDelivered` idempotent + `SALE_NOT_DELIVERABLE`; `markSaleDelivered` tenant-scoped `WHERE { id, tenantId }`).
- `One Active Route Per Sale (Application Pre-Check + DB Partial Unique Index)` — **MODIFIED** (D-1; renamed to `One Active Route Per Sale (DB Partial Unique Index)`).
- `Tenant Scoping of DeliveryRoute and DeliveryRouteStop` — unchanged (verified: `TENANT_SCOPED_MODELS` entries, cross-tenant 404, FK cascade/restrict).
- `RBAC Permissions for DeliveryRoute` — unchanged (verified: `AppSubjects` + 4 `PERMISSION_REGISTRY` entries).
- `Driver Ownership Enforced by CASL Subject-Instance Condition` — **MODIFIED** (D-5 resolver wiring wording; behavior unchanged).
- `List, Get, Cancel, and Delete Endpoints` — unchanged (verified: list scoping via `request.ability`, DRAFT+zero-stops delete, 422 on any other delete).
- `Durable Next-Stop Notification Pipeline` — **MODIFIED** (D-3 payload fields; D-6 poller interval).
- `NotificationConfig Re-Gate at Send Time` — unchanged (verified: 3-step Inngest fn, authoritative email lookup).
- `NotificationActionKey Registry Accepts DELIVERY_NEXT_STOP` — unchanged (verified: union + `NOTIFICATION_ACTION_KEYS` + Prisma enum + drift spec + `ALTER TYPE` migration).
- `DeliveryRouteResponseDto Read Model` — unchanged (verified: DTO shape, `activeRouteId` not on the wire, `findOneWithStops` projection).
- `DeliveryRoute Timeline Mirrors buildSaleTimeline` — unchanged (verified: event types, actor defaults, sort by `at`).
- `IRouteOptimizer Port with Manual Default Adapter` — unchanged (verified: `Symbol.for('IRouteOptimizer')`, identity adapter).
- `Verification Surface` — **MODIFIED** (D-7 accuracy).

**API surface confirmation (all matched the spec, no drift):** 10 endpoints with
`@RequirePermissions` — `POST /delivery-routes` (create), `GET /delivery-routes` (read),
`GET /delivery-routes/:id` (read), `PATCH /delivery-routes/:id` (update),
`DELETE /delivery-routes/:id` (delete), `POST /delivery-routes/:id/start` (update),
`POST /delivery-routes/:id/cancel` (update), `POST /delivery-routes/:id/stops` (update),
`POST /delivery-routes/:id/stops/:stopId/check-in` (update),
`PUT /delivery-routes/:id/stops/reorder` (update). Error codes confirmed on the wire:
`DELIVERY_ROUTE_INVALID_TRANSITION` (422), **`DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` (409)**
via `domain-exception.filter.ts`, `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` (422),
`SALE_NOT_DELIVERABLE` (422), `DELIVERY_ROUTE_NOT_FOUND` (404). Timeline events confirmed:
`ROUTE_CREATED` (actor null), `ROUTE_STARTED`, `STOP_CHECKED_IN`, `ROUTE_COMPLETED`,
`ROUTE_CANCELLED` (actor = driver), sorted by `at`. `NotificationActionKey` includes
`DELIVERY_NEXT_STOP` (TS + Prisma enum + drift spec).

## 5. Tasks (`openspec/changes/delivery-routes/tasks.md`)

- **No stale checkboxes:** all implementation-owned tasks (1.1–3.24, including WU gates 1.9 /
  2.20 / 3.22 / 3.24) are `[x]` and correctly reflect the committed, verified state.
- Remaining `[ ]` items are **parent-owned** (`<!-- sdd-owner: parent -->`): Phase 0 pre-flight
  (review-mode switch state, `chain_strategy`) and Phase 4 bounded reviews + archive. They are
  deferred parent lifecycle actions, not implementation blockers; per the status contract they
  are reconciled by the parent at their native lifecycle boundaries. The sync phase does not
  check them off.
- One acceptance-prose note (non-blocking): task 2.12's acceptance text describes
  pre-implementation DTO field guesses (`position`, `customerName`, `addressLabel`); the
  shipped DTO uses `sortOrder`, `customer`, `shippingAddress` (task body and spec are
  correct). Historical task text is left untouched to preserve the apply audit trail.

## 6. Findings and risks for the parent

- **F-1 (no blocker):** no standalone `openspec/changes/delivery-routes/verify-report.md` exists.
  Verification evidence was consumed from `apply-progress.md` per-WU `### Verification`
  sections (WU1: build green + 19 suites/148 tests; WU2: build green + 2 suites/35 tests +
  regression 35 suites/803; WU3: **211 suites / 2929 tests green**, integration
  markSaleDelivered 4/4 + delivery-route repository 9/9 on test DB 5433, `pnpm build` green)
  plus the parent-provided verification context. **Recommendation:** create/commit a
  `verify-report.md` before the `sdd-archive` phase so the archive gate has a first-class
  verify artifact.
- **F-2 (informational):** the change folder has no `specs/` subdirectory; the spec phase wrote
  the canonical spec directly. Future changes should follow the standard
  `openspec/changes/<change>/specs/<domain>/spec.md` → canonical sync flow; this sync treated
  the pre-existing canonical spec as the delta source and reconciled in place (equivalent
  result).
- **F-3 (informational):** this was a reconciliatory sync with MODIFIED blocks only — no
  REMOVED requirements, no destructive deltas, no approval gate triggered.
- **F-4 (no blocker):** `PrismaDeliveryRouteRepository.save` maps **any** `P2002` during the
  stops `createMany` to the 409 error, including the `@@unique([routeId, sortOrder])` case
  (spec: "duplicate sortOrder rejected at persist time" — still raised as P2002, but with the
  409 code rather than a sortOrder-specific one). Acceptable per spec scenario; noted for
  awareness.
- **F-5 (informational):** generic poller exclusion verified —
  `NOT IN ('stock.low.detected', 'hr.timeoff.requested', 'delivery.next_stop.notify')`;
  dedicated `DeliveryRoutesOutboxPoller` claims only `delivery.next_stop.notify` rows.
- **F-6:** no active same-domain collision — no other active change touches
  `openspec/specs/delivery-routes/spec.md`.

## 7. Validation performed (read-only)

Per delegation, the full test suite was NOT re-run. Targeted read-only checks performed:

- `git log`/`git show` — WU1/WU2/WU3 commits present (`d37d261`, `aad4e40`, `3b45d19`); working tree clean before sync.
- Schema vs spec: `prisma/schema.prisma` models/enums/indexes match; migrations
  `20260827032834_add_delivery_routes` (partial unique index) and
  `20260827032835_add_delivery_next_stop_action` (`ALTER TYPE … DELIVERY_NEXT_STOP`) present.
- Endpoints/DTOs/errors: controller, DTOs, `delivery-route.errors.ts`, and
  `domain-exception.filter.ts` (409 mapping) inspected.
- Timeline: `build-delivery-route-timeline.ts` matches the spec union exactly.
- Outbox: poller/dispatcher/types + `outbox-poller.service.ts` exclusion inspected.
- Inngest: `delivery-next-stop-notify.functions.ts` (id/trigger/idempotency/retries/concurrency,
  3-step re-gate) inspected.
- CASL/guard: `casl-ability.factory.ts` (`isRouteManager` discriminator, conditional rules),
  `permissions.guard.ts` (subject-instance step + `request.ability`), and
  `subject-instance-resolver.ts` (static registry) inspected.
- Sale mirror: `markDelivered` (idempotent, `CONFIRMED`-only) and `markSaleDelivered`
  (tenant-scoped `WHERE`) inspected.
- Spec file list in `Verification Surface` cross-checked against actual files on disk.
- `git diff` review of the reconciled canonical spec (80+/76- lines) — no src/ or prisma/
  files touched (see §8).

## 8. Scope discipline

- `src/` and `prisma/` were NOT modified (implementation is done; sync reconciles
  specs/reports only).
- The change folder was NOT moved to archive, and nothing was committed (working tree contains
  only the two sync artifacts: the reconciled canonical spec and this report).
- No child subagents were launched.

## 9. Structured status and actionContext (reconstructed — no native JSON provided)

```yaml
schemaName: spec-driven
changeName: delivery-routes
artifactStore: openspec            # per openspec/changes/delivery-routes/README.md + config.yaml
planningHome:
  root: /home/aldrich/Escritorio/workspace/houndfe/houndfe-backend
  changesDir: openspec/changes
changeRoot: openspec/changes/delivery-routes
artifactPaths:
  proposal: openspec/changes/delivery-routes/proposal.md
  specs: openspec/specs/delivery-routes/spec.md     # written directly to canonical (see F-2)
  design: openspec/changes/delivery-routes/design.md
  tasks: openspec/changes/delivery-routes/tasks.md
  applyProgress: openspec/changes/delivery-routes/apply-progress.md
  verifyReport: (missing — see F-1)
  syncReport: openspec/changes/delivery-routes/sync-report.md
artifacts:
  proposal: done
  specs: done
  design: done
  tasks: done
  applyProgress: done
  verifyReport: missing            # evidence present in apply-progress + parent context; F-1
  syncReport: done
taskProgress:
  total: 39 implementation tasks (1.1–3.24) + 4 parent-owned (Phase 0 × 2, Phase 4 × 2)
  complete: 39 implementation / 0 parent-owned
  remaining: 0 implementation / 4 parent-owned
  unchecked: []  # implementation; parent-owned items are deferredParentActions
deferredParentActions: 4  # tasks lines 43, 44, 157–160 (Phase 0 + Phase 4)
taskArtifactErrors: []
applyState: all_done
dependencies:
  apply: all_done
  verify: ready                  # per parent verification context + apply-progress evidence
  sync: ready                    # this phase executed
  archive: ready                 # see F-1 recommendation before archive
actionContext:
  mode: repo-local               # no workspace-planning/allowedEditRoots narrowing provided
  workspaceRoot: /home/aldrich/Escritorio/workspace/houndfe/houndfe-backend
  allowedEditRoots: [ /home/aldrich/Escritorio/workspace/houndfe/houndfe-backend ]
  warnings: [ "verify-report.md absent (F-1)" ]
nextRecommended: sdd-archive
isNonAuthoritative: false
```

## 10. Next recommended phase

- **`sdd-archive`** — the change is synced, all implementation tasks are complete, and
  verification evidence is green. Before archiving, the parent should (a) commit a
  `verify-report.md` (F-1) and (b) reconcile the 4 parent-owned Phase 0/Phase 4 items at their
  lifecycle boundaries.
