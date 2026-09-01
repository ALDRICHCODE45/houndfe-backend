# Proposal — `online-catalog-publishing` (Tenant Catalog Publishing, Public Price Contexts, Stock Presentation)

Status: approved

> **Frontend pause note (binding).** All frontend work is paused by product decision, including
> the slice-1 integration against the existing public v1 endpoints. **This change delivers
> backend contracts and evidence only; it contains no frontend deliverables and does not
> reactivate frontend work.** The frontend resumes solely on an explicit user instruction
> after the backend publishes contracts and evidence.

## Intent

Let a commerce tenant open its online catalog on its own terms: an explicit opt-in publication
flag at the tenant level, per-variant publication with inheritance, tenant-selected public
global price lists with a per-visit price context (no-fallback), and configurable stock
presentation modes that can never turn operational zero stock into sellable availability.
The backend remains the sole authority for prices, stock, context, and effective publication;
the public cart stays stateless, idempotent, and `no-store`.

## Business problem & goal

Today every active tenant is publicly discoverable by the public catalog API
(`PublicTenantGuard` resolves any tenant with `{ slug, isActive: true }`). A merchant has no
way to decide _when_ their catalog goes live, _what_ appears (variants), _at what price_
(the public API hardcodes the global default list), or _how inventory is presented_ (stock
status is always derived from operational quantities). The goal is that a tenant can publish
its catalog deliberately, control exactly what is visible, at which price list and with which
inventory presentation, with a backend-validated cart — without leaking private price lists
or operational stock.

## Current state & gap (verified in code)

| #   | Gap                                                                                                                                                    | Evidence                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No tenant publication gate; any active tenant is publicly resolvable by slug.                                                                          | `src/public-catalog/http/guards/public-tenant.guard.ts` (`findFirst({ slug, isActive: true })`); `prisma/schema.prisma:332-339` (`Tenant` has `isActive` only).                              |
| 2   | No variant-level publication; every variant of a published product is exposed and cart-addable.                                                        | `Variant` model (`prisma/schema.prisma:575-596`) has no publication field.                                                                                                                   |
| 3   | Public price resolution hardcodes the global default list; no price context.                                                                           | `src/public-catalog/infrastructure/prisma-public-catalog.repository.ts:108,122,216,229` and `validate-public-cart.use-case.ts` (`globalPriceList: { isDefault: true }` in four query sites). |
| 4   | `ValidateCartBodyDto` declares an optional price-list field the use case never consumes.                                                               | `src/public-catalog/http/request-dto/validate-cart-body.dto.ts:28` (declaration only).                                                                                                       |
| 5   | `hidePriceInOnlineCatalog` exists on `Product` and is read by the public mapper, but has no authenticated round-trip.                                  | `prisma/schema.prisma:487`; `CreateProductDto`/`UpdateProductDto`/`ProductsService` do not map it.                                                                                           |
| 6   | Stock presentation is always system-derived (`out_of_stock` / `low_stock` / `available`); no configurability.                                          | `src/public-catalog/domain/value-objects/stock-status.vo.ts`.                                                                                                                                |
| 7   | Caching is HTTP-header-only (`CacheControlInterceptor`): branches 300s, list/detail 60s, cart `no-store`; there is no server-side cache to invalidate. | `src/public-catalog/http/interceptors/cache-control.interceptor.ts` (sets `Cache-Control` header only); controller annotations in `public-catalog.controller.ts`.                            |
| 8   | Throttling uses two named scopes: `public-browse` 60/min, `public-validate` 20/min.                                                                    | `src/public-catalog/public-catalog.module.ts` (`ThrottlerModule.forRoot`), `@Throttle` on `validateCartEndpoint`.                                                                            |

## Scope

### In scope (backend only)

- **F1 — Publication gate + authenticated round-trips (migrations M1–M6).**
  - `Tenant.catalogPublished` (default `false`) gates the entire public surface: branches,
    list, detail, and cart.
  - Authenticated tenant catalog settings round-trip (`GET`/`PATCH`).
  - Authenticated product round-trip extension: `hidePriceInOnlineCatalog`, stock
    presentation mode (+ custom quantity), supported public lists (allowlist).
  - Authenticated variant round-trip extension: publication mode (`INHERIT`/`ON`/`OFF`), stock
    presentation override (+ custom quantity).
  - `GET /public/catalog/branches` filtered by publication; public v1 list/detail/cart remain
    behavior-compatible for the default-context case (price = the current global default list
    semantics via the tenant's public default).
- **F2 — Public price context.**
  - `priceListId` parameter on public list/detail; omission resolves to the tenant's catalog
    default list.
  - Price-context binding in `POST /public/catalog/:tenantSlug/cart/validate` (consuming the
    existing declared-but-unused field, renamed as decided in Q1), full server-side recalculation.
  - Public-list allowlist per tenant; per-product support allowlist; **no-fallback** pricing.
  - Private-list non-disclosure: private vs nonexistent vs not-permitted are indistinguishable.
  - Price-context-sensitive cache keys/documentation of the HTTP caching semantics.
- **F3 — Stock presentation modes + inheritance/override validation.**
  - Effective public stock presentation per mode (`SYSTEM_STATUS`, `ABSTRACT_STATUS`,
    `CUSTOM_QUANTITY`, `HIDDEN`) with product→variant inheritance and variant override.
  - Product-with-variants aggregation rule (Q6).
  - M5 `SYSTEM_STATUS` backfill ⇒ no observable behavior change on rollout.
- Migration envelope M1–M7 (below), tenant-scoped-model allowlist registration, RBAC seeding
  (Q5), unit specs (co-located `*.spec.ts`) plus integration specs (`*.integration.spec.ts`)
  for Prisma adapters and migrations, `pnpm test`, `pnpm build`.

### Out of scope / non-goals

- **F4 branding/contact** (display name, WhatsApp phone, hours, fulfillment methods, policies,
  slugs, SEO): explicitly deferred, separate change.
- **No frontend deliverables** of any kind (frontend is paused by product decision).
- Ratings/reviews, featured labels; WhatsApp orders or any order-creation workflow
  (cart stays validation-only); public `SERVICE` products (exclusion retained); public tier
  prices; real multi-branch inventory (v1 keeps `Tenant` = branch); visual redesign of the
  catalog; variant-level supported-lists override (product-level allowlist only in this
  change; variant override is additive later); active cache purging (see Q4); any change to
  POS, sale, or internal pricing semantics.

## Requirements outline (invariants — MUST-level)

- **(a) Zero-stock safety.** Operational zero stock MUST always block cart validation
  (`OUT_OF_STOCK`) regardless of the configured presentation mode. Presentation is never
  authoritative for fulfillment; `useStock = false` remains always-available; the public
  custom quantity never writes to, nor substitutes for, operational stock.
- **(b) No enumeration of private price lists.** No public surface MAY expose the existence,
  names, IDs, or prices of lists not marked catalog-public by the tenant. A private list ID,
  a nonexistent list ID, and a list belonging to another tenant MUST be indistinguishable:
  same error code, same message, same status.
- **(c) No-fallback pricing.** A product/variant without a valid price (`priceCents` missing
  or ≤ 0) in the selected context MUST be excluded from that context's listing and MUST be
  rejected in the cart with the dedicated code `PRICE_NOT_AVAILABLE_IN_CONTEXT`. There MUST
  never be a silent substitution from the default list or any other list.
- **(d) Effective publication gate.** Effective publication MUST be evaluated as
  `tenant.catalogPublished AND tenant.isActive AND product.includeInOnlineCatalog AND
product.type = PRODUCT AND variant effective publication` (variant: product published AND
  variant mode resolves to published). Every public read and every cart validation MUST
  re-derive this gate from current data; no cached/stale gate decision is trusted.
- **(e) Backend sole authority; stateless cart.** Prices, availability, totals, and context
  MUST be recomputed server-side on every cart validation; any client-sent prices are ignored.
  Cart validation MUST remain stateless, idempotent, and `Cache-Control: no-store`, keeping
  the `public-validate` 20/min scope.
- **(f) Non-widening inheritance.** A variant override MUST never widen visibility beyond its
  product's effective publication; effective publication is conjunctive top-down
  (tenant → product → variant).
- **Tenant isolation.** Every new tenant-scoped model MUST be registered in
  `src/shared/tenant/tenant-scoped-models.constant.ts`; repositories use explicit
  `where: { id, tenantId }` defense in depth; the `priceListId` is validated against the
  tenant of the request slug on every public call.
- **Permission non-implicitness.** The catalog-settings permission MUST NOT be implicitly
  granted to product editors; only explicit role grants and `manage:all` satisfy it (Q5).
- **Strict DTO validation.** All new inputs use `class-validator` (UUID validation for
  `priceListId`, strict enum for modes, custom quantity ≥ 0) consistent with the bootstrap
  `whitelist`/`forbidNonWhitelisted`/`transform` pipe.

## Bounded context placement

- **Public surface:** extend `src/public-catalog/` (existing bounded context): new/extended
  use cases (`list-public-products`, `get-public-product-detail`, `list-public-branches`,
  `validate-public-cart`), extended `PUBLIC_CATALOG_REPOSITORY` port + Prisma adapter,
  extended request DTOs, a price-context resolver (application service). No new module for
  the public side.
- **Tenant catalog settings (admin):** new bounded context `src/catalog-settings/`
  (domain / application / infrastructure / dto / presentation) mirroring the
  `src/admin/payment-details/` layout. Rationale: it owns new aggregate-shaped data
  (tenant-public price list bindings + settings projection) that will grow in F4 (branding/
  contact) without bloating `src/tenants/`. It exposes `GET/PATCH /admin/tenants/:tenantId/
catalog-settings` (note: authenticated controllers live under the `admin/` prefix per
  `TenantsController`; the request's suggested `/tenants/...` path is adjusted accordingly).
- **Product/variant round-trips:** extend the existing `src/products/` DTOs and service
  mapping (no new context) — these are fields of existing aggregates.

## Data model & migration envelope (M1–M7)

New Prisma objects (additive; names per Q1):

```prisma
enum CatalogPublishMode { INHERIT ON OFF }        // Q2: variant publication tri-state
enum CatalogStockPresentation { SYSTEM_STATUS ABSTRACT_STATUS CUSTOM_QUANTITY HIDDEN }

model Tenant {
  // additive
  catalogPublished Boolean @default(false)        // M1: opt-in, conservative

  // Tenant stock-presentation default (M5/F3 contract): null product modes and
  // custom quantities inherit these. CUSTOM_QUANTITY requires a non-null
  // catalogStockPresentationDefaultCustomQty >= 0; other modes require null.
  catalogStockPresentationDefault          CatalogStockPresentation @default(SYSTEM_STATUS)
  catalogStockPresentationDefaultCustomQty Int?
}

model TenantCatalogPriceList {                     // per-tenant public-list binding (Q1)
  id                String   @id @default(uuid())
  tenantId          String
  globalPriceListId String
  isCatalogDefault  Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  // @@unique([tenantId, globalPriceListId]); partial unique index: one
  // isCatalogDefault per tenant
}

model ProductCatalogPriceList {                    // per-product support allowlist (Q1)
  id                String   @id @default(uuid())
  tenantId          String
  productId         String
  globalPriceListId String
  // @@unique([tenantId, productId, globalPriceListId])
  // Semantics: zero rows for a product ⇒ product supports ALL tenant-public lists
  // (default, no backfill); rows present ⇒ supports only the listed ones.
}

model Product {
  // additive
  onlineStockPresentation           CatalogStockPresentation?  // M5 backfill SYSTEM_STATUS
  onlineStockPresentationCustomQty  Int?                       // CUSTOM_QUANTITY only, ≥ 0
  // hidePriceInOnlineCatalog already exists (M6: DTO round-trip only)
}

model Variant {
  // additive
  catalogPublishMode  CatalogPublishMode @default(INHERIT)  // M3
  onlineStockPresentation          CatalogStockPresentation? // override; null = inherit
  onlineStockPresentationCustomQty Int?
}
```

(Indexes: `Variant @@index([productId, catalogPublishMode])`; existing
`@@index([tenantId, includeInOnlineCatalog, ...])` on `Product` is reused for the public
filter; `TenantCatalogPriceList @@index([tenantId])`.)

| Step   | Content (conservative defaults)                                                                                                                                                                                                                                     | Risk covered                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **M1** | `Tenant.catalogPublished Boolean @default(false)` — existing tenants become non-discoverable until explicit activation.                                                                                                                                             | Public inventory leakage (today's default).           |
| **M2** | No column change: `Product.includeInOnlineCatalog` keeps default `true` but is subordinated to the tenant gate in all effective-publication logic.                                                                                                                  | Traumatic product migration; POS semantics untouched. |
| **M3** | `Variant.catalogPublishMode` added and backfilled to `INHERIT` for all existing variants.                                                                                                                                                                           | Unexpected variant exposure/hiddenness.               |
| **M4** | For each tenant: bind the list referenced by the current public logic — the `GlobalPriceList` with `isDefault = true` — as `TenantCatalogPriceList` with `isCatalogDefault = true`; all other lists stay private.                                                   | Loss of public prices when the context is introduced. |
| **M5** | Backfill `Product.onlineStockPresentation = SYSTEM_STATUS` (and variant override left `null` = inherit). Tenant defaults `catalogStockPresentationDefault = SYSTEM_STATUS` and `catalogStockPresentationDefaultCustomQty = null` so existing tenants get the pre-change presentation; a tenant default of `CUSTOM_QUANTITY` requires an integer custom quantity `>= 0`, and other default modes require null custom quantity.                                                                                                                                                            | Observable behavior change.                           |
| **M6** | No data change: `hidePriceInOnlineCatalog` (existing default `false`) exposed through authenticated DTOs.                                                                                                                                                           | —                                                     |
| **M7** | Consistency rule (policy, not schema): a tenant that is published but whose default public context has no valid price rows for a product results in that product being **excluded** from that context (never price 0). Enforced by the no-fallback requirement (c). | Accidental $0 listings.                               |

## Open backend-authority questions — resolved (Q1–Q8)

| Q                                                   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rationale                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** Names / routes                               | `Tenant.catalogPublished` (accepted as suggested); `TenantCatalogPriceList` (renamed from suggested `TenantPublicPriceList` — "catalog" matches the feature vocabulary and the sibling `ProductCatalogPriceList`); `ProductCatalogPriceList` for the product allowlist; `CatalogPublishMode` (`INHERIT`, `ON`, `OFF`); `CatalogStockPresentation` (`SYSTEM_STATUS`, `ABSTRACT_STATUS`, `CUSTOM_QUANTITY`, `HIDDEN` — enum values accepted); admin routes `GET/PATCH /admin/tenants/:tenantId/catalog-settings` (adjusted: this repo mounts authenticated tenant management under `admin/`, see `TenantsController`); public parameter `priceListId` on list/detail and in the cart body; public error code `PRICE_CONTEXT_NOT_AVAILABLE`; cart item code `PRICE_NOT_AVAILABLE_IN_CONTEXT`. | Keeps suggested names where they are sound, documents every deviation. `admin/` prefix follows existing `TenantsController` convention instead of inventing a second tenant-management path. |
| **Q2** Variant inheritance                          | **Enum `CatalogPublishMode { INHERIT, ON, OFF }`**, not a nullable boolean. Variants are always created with `INHERIT` (reference semantics: resolution happens at read time; nothing is copied at creation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Tri-state is explicit and self-documenting; `null` booleans are ambiguous between "inherit" and "not yet set", complicate `class-validator` DTOs, and make the Prisma query filters less readable. Resolution at read time means product publication changes propagate instantly — no write amplification. |
| **Q3** Missing/zero price in context                | **Both.** Excluded from that context's listing AND rejected in cart with `PRICE_NOT_AVAILABLE_IN_CONTEXT` (blocking). `priceCents <= 0` is treated exactly like a missing price. Hidden-price products (`hidePriceInOnlineCatalog = true` OR `requiresPrescription = true`) bypass this rule per T8: they remain visible/cart-valid with null numeric fields.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Exclusion alone leaves the cart ambiguous (an item could be browsed-then-invalidated without explanation); cart rejection alone forces the frontend to render unpriceable products. Both give consistent, explainable behavior and enforce the no-fallback invariant (c) from both surfaces. Hidden-price bypass keeps the displayed catalog reconcilable with the cart.               |
| **Q4** Cache invalidation                           | **TTL-bounded only; no active invalidation.** The existing `CacheControlInterceptor` emits HTTP `Cache-Control` headers only — there is no server-side cache to purge, so "active invalidation" has no local target and would require new infrastructure (CDN purge API) out of proportion to the risk. Depublication/list changes are therefore effective within the existing public TTLs (≤ 300s branches, ≤ 60s list/detail); cart is `no-store` and always live. Public responses become price-context-keyed: the list/detail endpoints' `max-age` stays 60s and the contract documents that responses are keyed by `priceListId`; settings PATCH responses are emitted `no-store`. If a CDN is introduced later, a purge hook is a separate change. | Matches the actual caching mechanism (HTTP headers to browsers/proxies); bounded staleness is explicitly accepted by the product expectation "effective within the public TTL"; zero new infrastructure.                                                                                                   |
| **Q5** Permission model                             | **New dedicated CASL subject `TenantCatalogSettings`** with `read` and `update` actions in `PERMISSION_REGISTRY` (seeded at bootstrap by the existing seeder). Catalog-settings controller uses `@RequirePermissions(['read', 'update', 'TenantCatalogSettings'])`. **Not** granted to product editors; only explicit role assignment via the admin-role service, or `manage:all`. Product/variant publication fields keep `update:Product` as today.                                                                                      | A tenant publication flag is a business decision (go-live), not a content edit; a distinct subject makes grants auditable and prevents accidental implicit access, as the request requires. The existing subjects lack a natural fit (`update:Tenant` is super-admin tenant administration). |
| **Q6** Stock aggregation for products with variants | Product-level public presentation for a product with variants is the **aggregate over the effective availability of its published variants**: any published variant available → `available`; else any `low_stock` → `low_stock`; else `out_of_stock`. `HIDDEN` at product level → hidden regardless of variants. `CUSTOM_QUANTITY` on a product with variants: the product card shows the aggregate availability (custom quantity is per-variant only); for a variant product the custom quantity on a variant applies to that variant. Cart validation always checks **per-variant operational stock** — aggregation is presentation-only.                                                                                                              | Consistent with the request's suggested rule (§8.2); keeps operational truth per-variant while giving the product card a single stable status; prevents custom quantities from manufacturing sellability.                                                                                                  |
| **Q7** Throttler scope                              | **No new scope.** `public-validate` 20/min already applies to the validation endpoint regardless of price context; context validation adds no meaningful per-request cost worth a separate budget, and a split scope would fragment the client's error/retry behavior. Scope names unchanged (`public-browse`, `public-validate`).                                                                                                                                                                                                                                                                                                                                                                                                                       | Current limit already covers the worst case; fewer scopes = simpler contract; revisit only if abuse patterns appear.                                                                                                                                                                                       |
| **Q8** Exclusion semantics                          | **Omission with an aggregate count only.** Products/variants unsupported in the selected context are omitted from `items`; the list/detail response MAY include `excludedCount` (integer) and nothing more (no per-item identity, so private-list memberships stay non-inferable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Omission is the only option fully compatible with invariant (b): per-item exclusion markers let an attacker probe which lists a product has prices in. The count is enough for pagination UX.                                                                                                              |

## Delivery phases

- **F1:** M1–M6 migrations + backfills; `src/catalog-settings/` bounded context (settings
  GET/PATCH, Q5 permission); product/variant authenticated round-trip extensions;
  `branches` filtered by publication; effective-publication gate enforced in all public
  use cases (default context = tenant's catalog default list bound in M4, preserving current
  price behavior for already-published-POS data). Public v1 responses remain
  behavior-compatible apart from the publication gate.
- **F2:** `priceListId` on public list/detail; allowlist resolution (tenant + product);
  no-fallback filtering (Q3/Q8); cart context binding (replacing the declared-but-unused DTO
  field), full server-side recalculation, new cart codes (`PRICE_CONTEXT_NOT_AVAILABLE`,
  `PRICE_NOT_AVAILABLE_IN_CONTEXT`, `VARIANT_NOT_IN_CATALOG`); context-aware public
  responses (`priceContext` metadata) and cache semantics per Q4. Omitting the parameter
  ⇒ F1 behavior (backwards compatible).
- **F3:** Effective stock presentation modes + product→variant inheritance/override
  resolution (Q6 aggregation); M5 backfill makes this behaviorally neutral on rollout;
  custom-quantity safety validations (never mutates operational stock; zero stock always
  blocks).
- **F4:** out of scope (non-goal).

## Risks & rollback plan (required by `openspec/config.yaml` proposal rule)

| #   | Risk                                                                                                                                 | Likelihood       | Mitigation                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **M1 visibility flip**: after adding `catalogPublished = false`, every currently discoverable tenant disappears from the public API. | High (by design) | Intended conservative behavior; rolled out together with an explicit tenant activation step; documented in the response guide. Unit + integration specs assert unpublished tenants are invisible (T1/T11).                                             |
| 2   | Backfill M4 binds the wrong list per tenant (multiple `isDefault` rows or none).                                                     | Low              | M4 derives from the existing invariant (one `GlobalPriceList` with `isDefault = true`); backfill SQL is idempotent and guarded; integration spec asserts exactly one catalog default per tenant.                                                       |
| 3   | No-fallback filtering silently empties a tenant's catalog when its default list lacks price rows.                                    | Med              | M7 rule makes this explicit and detectable; `excludedCount` surfaces the magnitude; settings response could expose a per-context price coverage check (read-side only) — validation at PATCH time warns when the default context covers zero products. |
| 4   | Private-list inference via response timing/differential errors.                                                                      | Low              | Single generic `PRICE_CONTEXT_NOT_AVAILABLE` code/path for private/nonexistent/not-permitted (b); Q8 omission with aggregate count only.                                                                                                               |
| 5   | Presentation modes regress cart safety (custom quantity or abstract status enabling sales at zero stock).                            | Med              | Invariant (a) enforced in the validate use case independent of presentation; dedicated unit specs across every mode × zero-stock combination (T9/T10).                                                                                                 |
| 6   | Cache semantics drift once context is added (cached responses mixing contexts).                                                      | Med              | Contract documents context-keyed caching; `priceContext` is part of the response body so a mismatched cache entry is self-evident; cart stays `no-store`.                                                                                              |
| 7   | DTO/enum drift between Prisma enums and TS unions (`CatalogPublishMode`, `CatalogStockPresentation`).                                | Low              | Mirror the existing enum-drift spec precedent.                                                                                                                                                                                                         |

**Rollback plan.**

1. **Code rollback.** Single revert removes `src/catalog-settings/`, the public-catalog
   use-case/DTO/repository extensions, products DTO extensions, and the
   `AppSubjects`/`PERMISSION_REGISTRY` entries. Seeded `TenantCatalogSettings` permission
   rows are inert after rollback and can be cleaned up later.
2. **M1 (risky visibility flip).** Forward rollback = additive migration setting
   `UPDATE tenants SET "catalogPublished" = true` for an explicitly approved tenant set
   (restores today's behavior) or, if the feature is abandoned, dropping the column and
   reverting the gate checks. Because the column default is `false`, **the migration
   itself must be applied together with a product decision on which tenants (if any) to
   activate immediately** — pre-decided in the deploy runbook, not improvised during the
   migration. **Never blanket-publish:** emergency restoration only restores the explicit
   approved set after verifying that every restored tenant has valid default-list bindings
   and selected-context price coverage (M4/M7).
3. **Data-mutating backfills (M3, M4, M5).** All are idempotent (`WHERE NOT EXISTS`-guarded)
   and derived from current state; each has a documented inverse:
   - M3: `UPDATE variants SET "catalogPublishMode" = 'INHERIT'` is a no-op restore; column
     drop removes the feature without affecting POS.
   - M4: delete rows from `tenant_catalog_price_lists` (restores pre-context behavior once
     the code that reads them is reverted; code revert must precede the data rollback).
   - M5: setting presentation back to `SYSTEM_STATUS` is itself the safe default; column drop
     is safe because F3 code treats absence as `SYSTEM_STATUS` (nullable column, not NOT NULL).
4. **Ordering rule.** Code reverts before destructive schema/data rollbacks; migrations are
   never edited in place — inverse changes are new additive migrations.
5. **Verification after rollback.** `pnpm test`, `pnpm build`; smoke-check that the public
   API behaves as pre-change for any tenant the operator re-publishes (branches/list/detail/
   cart with the default list).

## Acceptance criteria

The request's T1–T14 matrix (README §"Acceptance matrix") is adopted as the evidence
checklist and will be mapped to Given/When/Then specification scenarios in the spec phase
(T1 unpublished tenant invisibility, T2 tenant isolation, T3 effective publication matrix,
T4 variant inheritance, T5 price-context consistency, T6 no-fallback, T7 private-list
non-enumeration, T8 hidden price precedence, T9 stock presentation × zero stock, T10 custom
quantity safety, T11 migration/backfill, T12 permissions, T13 cache/rate limit, T14 contract
delivery). Engineering success criteria: `pnpm test` (existing suites + new co-located unit
specs + integration specs for adapters/migrations) and `pnpm build` pass; all new
tenant-scoped models are in `TENANT_SCOPED_MODELS`; Q5 permission seeded idempotently at
bootstrap; public v1 contract changes are delivered as an updated backend response guide
(T14-equivalent) for the paused frontend.

## Proposal question round

The delegated instruction resolved Q1–Q8 as backend-authority decisions (table above).
Per SDD policy these assumptions are surfaced for review before spec finalization — the
user may correct any of them or request a second question round. The decisions with the
largest product impact, in case the user wants to revisit:

1. **M1 makes every existing tenant publicly invisible on deploy** until activation (Q1/M1
   default). Assumption: no tenant currently relies on public discoverability in production.
2. **Depublication latency is TTL-bounded** (up to 300s for branches; Q4) — no instant purge.
   Assumption: this latency is acceptable.
3. **Catalog settings get a dedicated permission subject** not granted to product editors
   (Q5). Assumption: the role/permission UI will surface `TenantCatalogSettings`.
4. **Variant supported-lists override is deferred** (product-level allowlist only in this
   change). Assumption: product-level granularity is sufficient for F2.
5. **Q6 aggregation rule** (available > low > out over published variants) — assumption this
   matches merchant expectations; alternatives (strictest-wins, most-stock-wins) are
   possible if product prefers.

## Key decisions (rationale encoded)

1. Gate publication at the tenant first (conjunctive gate, invariant d) — cheapest, safest
   default; product/variant controls only narrow.
2. Tri-state enum over nullable boolean (Q2) — explicitness, simpler DTOs and queries.
3. No-fallback pricing enforced symmetrically at listing and cart (Q3) — both surfaces must
   tell the same story or the context becomes unexplainable.
4. TTL-bounded cache effectiveness (Q4) — matches the header-only caching reality; no new
   invalidation infrastructure.
5. Dedicated CASL subject for settings (Q5) — publication is a business go-live decision;
   never implicitly bundled with content editing.
6. Allowlist via join tables with "absent rows = supports all public lists" semantics —
   avoids a products × lists backfill while giving explicit narrowing.
7. Extend `src/public-catalog/` and `src/products/`, one new small `src/catalog-settings/`
   context — no premature context explosion; settings growth (F4) has a home.
