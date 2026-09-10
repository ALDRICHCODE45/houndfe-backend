# Change: `online-catalog-publishing`

## Initialization

- **Change name:** `online-catalog-publishing`
- **Repository:** `houndfe-backend`
- **Artifact store:** OpenSpec (`openspec/changes/online-catalog-publishing/`)
- **Initialization scope:** scaffold change directory + change record only
- **Proposal / spec / design / tasks:** intentionally NOT created in this phase; they are produced by their dedicated SDD phases.

## Source document (feature request)

- Formal backend request from the frontend team, **read in full** before this init:
  `frontend-houndfe/docs/backend-requests/online-catalog-publishing.md`
- Audience: backend (architecture authority). Every modeling suggestion, route name, JSON
  shape and migration step in that document is **non-binding**; the backend decides the
  final names, paths, patterns and implementation. The frontend only consumes the
  eventual contracts and evidence that the backend publishes.
- This README captures the request as seed input for the proposal phase. It is not a
  requirement specification, a design, or a task list.

## Feature intent (as supplied by the frontend request)

Online catalog publishing for tenants, layered on top of the existing public catalog API
(`src/public-catalog/`). Four structural capabilities are missing today:

1. **Tenant-level catalog publishing** — explicit opt-in flag, conservative default
   off; without it every active tenant is publicly discoverable today.
2. **Variant-level publishing** — variants inherit from their product and can be
   explicitly overridden; an override MUST never widen visibility past the product /
   tenant gate.
3. **Selectable public global price lists with a per-visit price context** — the
   tenant marks one or more `GlobalPriceList` rows as public for its catalog and
   picks a default; the visitor selects one list per visit and the cart validates
   against that context with **no fallback** to any other list. Private lists MUST
   NOT be enumerable or inferable from any public surface.
4. **Configurable stock presentation modes** — `SYSTEM_STATUS` (current default) /
   `ABSTRACT_STATUS` / `CUSTOM_QUANTITY` / `HIDDEN`. Presentation only; operational
   zero stock ALWAYS blocks cart validation regardless of the presentation mode.

In addition, several authenticated round-trips need extension:

- Tenant catalog settings: `GET / PATCH /tenants/:tenantId/catalog-settings`
  (publication, public price lists, default list, default stock presentation, contact
  block — optional/later).
- Product round-trip: `hidePriceInOnlineCatalog`, supported public price lists, stock
  presentation mode + custom quantity value.
- Variant round-trip: variant publishing override (`INHERIT`/null vs explicit
  `ON`/`OFF`), plus optional overrides for stock presentation and supported price lists.

And the public surface:

- `GET /public/catalog/branches` filtered by `catalogPublished`.
- List / detail endpoints accept a `priceListId` (omitted → tenant default) and
  return a `priceContext` metadata block; unsupported products are excluded with no
  fallback and any private list id returns the same generic error as "not available".
- `POST /public/catalog/:tenantSlug/cart/validate` carries the price context, never
  trusts client prices, re-checks effective publication, and operational stock zero
  always blocks.

The public cache stays price-context-sensitive; depublication must take effect within
the public TTL.

## Conservative migration envelope (M1–M7) suggested by the request

| Step | Conservative default                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1   | `Tenant.catalogPublished Boolean @default(false)` — opt-in only; existing tenants stay unpublished.                                                                                        |
| M2   | Keep `Product.includeInOnlineCatalog` default, but subordinate it to the tenant flag.                                                                                                      |
| M3   | Backfill existing variants to `INHERIT` / null (inherit from product).                                                                                                                     |
| M4   | Backfill: mark the existing default `PUBLICO` list as public + default per tenant; everything else stays private.                                                                          |
| M5   | Backfill: `SYSTEM_STATUS` for all products/variants = current visible behavior.                                                                                                            |
| M6   | Round-trip the existing `hidePriceInOnlineCatalog = false` value through authenticated DTOs.                                                                                               |
| M7   | Rollback path: if a tenant is published with no valid price rows in its default list, the products without a price in that context MUST be excluded from that list (not shown at price 0). |

## Acceptance matrix requested as evidence (T1–T14)

The request enumerates a T1–T14 acceptance matrix (tenant unpublished, isolation,
effective publication, variant inheritance, price context, no-fallback, private lists
enumeration, hidden price, stock presentation, custom quantity safety, migration /
backfill, permissions, cache / rate limit, contract delivery). These are the
frontend's evidence checklist — they are listed here for the proposal / spec phases
to map onto the eventual specification scenarios; nothing is approved as design in
this phase.

## Open backend-authority questions (Q1–Q8)

The frontend reserves eight architectural decisions to the backend. They are recorded
here so the proposal phase can resolve them. None of them reopens product decisions
that have already been approved; they are gaps only the backend can fill.

- **Q1** Final names / structure for entities, fields and routes (suggested
  `catalogPublished`, `TenantPublicPriceList`, enum `SYSTEM_STATUS|ABSTRACT_STATUS|
CUSTOM_QUANTITY|HIDDEN`).
- **Q2** Variant inheritance / override representation (nullable boolean vs enum)
  and whether creating a variant copies or references the product.
- **Q3** Missing / zero price in the selected list — exclude from listing AND
  reject cart item with a dedicated code, or just one of the two? (Suggestion: both.)
- **Q4** Cache invalidation strategy to keep depublication / public-list changes
  effective within the public TTL (active invalidation vs short TTL).
- **Q5** Permissions: new dedicated permission for tenant catalog settings vs reuse,
  and which roles receive it.
- **Q6** Stock aggregation rule for products with variants when variants carry
  different stock-presentation overrides.
- **Q7** Whether validation with context warrants an extra throttler scope (current
  `validate` is 20/min — suggested sufficient).
- **Q8** Explicit exclusion in the listing — omit items unsupported by the context, or
  return them with an exclusion marker? (Suggestion: omit, expose only counts if
  needed.)

## Proposed phasing (F1 / F2 / F3 / F4 optional)

The request recommends a phased delivery:

- **F1** Migrations M1–M6 with conservative defaults; authenticated round-trips
  (tenant catalog settings, product, variant); branches filtered by publication.
  Public v1 endpoints stay byte-equivalent for the slice-1 frontend integration.
- **F2** Public price context: parameter in list/detail, binding in cart/validate,
  allowlists, no-fallback, context-sensitive caching. Backwards compatible (no
  parameter → F1 behavior).
- **F3** Effective stock presentation + inheritance / override validation.
  Backfill `SYSTEM_STATUS` = no observable change.
- **F4 (optional, deferred)** Premium branding / contact / slugs / SEO.

The phasing is a delivery plan hint, not a commit.

## Pause note — frontend work is paused

By product decision in the source document, **all** frontend work is paused,
including the slice-1 integration against the current public v1 endpoints (which is
technically possible today without any of the changes listed above). The frontend
will resume only after the user gives an explicit instruction following the
backend's contract and evidence delivery. **The backend's response does NOT
reactivate frontend work on its own.** This change records that pause; it does not
propose any frontend work.

## Repository conventions to preserve

Reference: `openspec/project-context.md` and `openspec/config.yaml`.

- Place new bounded-context code under `src/<chosen-context>/` (the eventual name is
  decided during proposal; options observed in the codebase include admin-style
  modules for settings and extensions to `src/public-catalog/` for the public
  surface). Maintain the established domain / application / infrastructure / DTO /
  presentation layering.
- Domain entities stay free of Nest and Prisma dependencies; use `static create(...)`
  and `static fromPersistence(...)`.
- Co-locate Jest unit specs with source files; name database tests
  `*.integration.spec.ts`. The existing unit Jest config still excludes integration
  specs, and `pnpm test` must remain runnable without PostgreSQL.
- Any new tenant-scoped model MUST be added to
  `tenant-scoped-models.constant.ts` so `TenantPrismaService` enforces tenant filters
  and tenant attribution.
- Keep authorization type-safe through `AppSubjects` and `PERMISSION_REGISTRY`;
  permissions are seeded at application bootstrap. The new permission for tenant
  catalog settings is Q5 and is not auto-granted to product editors.
- Money stays in integer cents; trusted during validation; never trust client-supplied
  prices in public cart/validate.
- Public catalog cache controls (`CacheControlInterceptor`, `@CacheControl('no-store')`
  on cart, `public-browse` 60/min, `public-validate` 20/min) MUST be preserved and
  extended: a depublication must be effective within the public TTL (Q4).
- The conservative migration defaults above MUST be honored unless the proposal
  phase explicitly justifies a deviation with rationale.
- Use RFC 2119 keywords (MUST, SHALL, SHOULD, MAY) and Given/When/Then scenarios in
  the eventual specification.
- Migration, Prisma client generation, unit tests (`pnpm test`), build (`pnpm build`),
  and any relevant database integration verification belong in task scope.

## Phase state

- Change packet exists at `openspec/changes/online-catalog-publishing/` with
  `proposal.md`, `design.md`, `tasks.md`, `specs/`, and `review-ledger.md`.
- **Completed work units:** F1.WU1a (additive persistence foundation),
  F1.WU1b (migration and clean-seed evidence), F1.WU2a (catalog-settings domain,
  port, and internal GET use case), and F1.WU2b (catalog-settings Prisma adapter
  and real persistence evidence — 10 commits / 11 files / 3,648 A+D / completed,
  passed, and published) are recorded in `review-ledger.md`, `apply-progress.md`,
  and `verify-report.md`.
- **Next slice:** F1.WU3 (catalog-settings HTTP contract and dedicated authorization).
- **Frontend:** paused by product decision; this change delivers backend contracts
  and evidence only and does not reactivate frontend work.

## OpenSpec configuration reference

- **Schema:** `spec-driven`
- **Proposal rule:** include a rollback plan for risky changes (multi-tenant defaults,
  cache, and the conservative migration envelope qualify as risky).
- **Spec rules:** RFC 2119 keywords + Given/When/Then scenarios.
- **Design rules:** sequence diagrams for the price-context flow, the publication
  cascade (tenant → product → variant), and cart/validate re-validation; decisions
  with rationale for each of Q1–Q8.
- **Task rules:** grouped by phase (F1 / F2 / F3 / F4-optional), hierarchical
  numbering, completable in one session.
- **Apply TDD:** disabled (`tdd: false`).
- **Apply test command:** `pnpm test`.
- **Verify test command:** `pnpm test`.
- **Verify build command:** `pnpm build`.
- **Verify coverage threshold:** `0`.
