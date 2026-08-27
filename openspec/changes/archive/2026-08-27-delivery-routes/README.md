# Change: `delivery-routes`

## Initialization

- **Change name:** `delivery-routes`
- **Repository:** `houndfe-backend`
- **Artifact store:** OpenSpec (`openspec/changes/delivery-routes/`)
- **Initialization scope:** scaffold change directory + change record only
- **Proposal / spec / design / tasks:** intentionally NOT created in this phase; they are produced by their dedicated SDD phases.

## Feature context (for the change record only)

Configurable delivery route tracking (Circuit-like) inside HoundFe:

- A driver is a `User` granted a dedicated role (e.g. `Driver`).
- A driver is assigned a `DeliveryRoute`, which is an ordered list of stops.
- Each stop is an existing `Sale` whose `deliveryStatus` is `PENDING` or `SHIPPED` and which carries a `shippingAddress`.
- The driver starts the route and checks in stop-by-stop.
- When a stop is completed, the system emails the customer of the NEXT stop with a "your package is arriving soon" message, but only when that customer has an email address.
- Manual route ordering is exposed today; the ordering logic sits behind an abstracted `IRouteOptimizer` port so a map provider can be plugged in later without changing domain code.
- GPS / live location tracking is explicitly **out of scope** for the MVP.

This block is the seed input for the proposal phase. It is not a requirement specification, a design, or a task list.

## Repository conventions to preserve

Reference: `openspec/project-context.md` and `openspec/config.yaml`.

- Place new bounded-context code under `src/delivery-routes/` (or the context name selected during proposal) with the established domain / application / infrastructure / DTO / presentation layering.
- Domain entities stay free of Nest and Prisma dependencies; use `static create(...)` and `static fromPersistence(...)`.
- Co-locate Jest unit specs with source files; name database tests `*.integration.spec.ts`.
- Add any new tenant-scoped model to `tenant-scoped-models.constant.ts` so `TenantPrismaService` enforces tenant filters and tenant attribution.
- Keep authorization type-safe through `AppSubjects` and `PERMISSION_REGISTRY`; seed the new driver / route permissions at application bootstrap.
- Use RFC 2119 keywords and Given/When/Then acceptance scenarios in the eventual specification.
- The change is expected to introduce outbox events for the "email the next customer" side effect so it remains durable and retryable, consistent with the rest of the codebase.
- Migration, Prisma client generation, unit tests, build, and any relevant database integration verification belong in task scope.

## Phase state

- Change directory created: `openspec/changes/delivery-routes/`.
- No `proposal.md`, `spec.md`, `design.md`, `tasks.md`, or `specs/` content has been authored yet.
- The next phase is the proposal phase for change `delivery-routes`.

## OpenSpec configuration reference

- **Schema:** `spec-driven`
- **Proposal rule:** include a rollback plan for risky changes.
- **Spec rules:** RFC 2119 keywords + Given/When/Then scenarios.
- **Design rules:** sequence diagrams for complex flows, decisions with rationale.
- **Task rules:** grouped by phase, hierarchical numbering, completable in one session.
- **Apply TDD:** disabled (`tdd: false`).
- **Verify test command:** `pnpm test`.
- **Verify build command:** `pnpm build`.
- **Verify coverage threshold:** `0`.
