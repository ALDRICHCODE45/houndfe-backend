# Public Catalog Capability Specification

## Purpose

Define the backend-only public catalog capability: tenant-controlled publication, authenticated catalog settings, exact public price contexts, configurable stock presentation, and stable operational contracts. Frontend work remains paused; F4 branding/contact/SEO and all other frontend deliverables are out of scope.

## Requirements

### Requirement: Tenant Publication Gate

The system MUST persist `Tenant.catalogPublished` with a conservative default of `false`. Every public branch, product list, product detail, and cart validation MUST require `catalogPublished = true`, `isActive = true`, and the effective product/variant publication rules. A tenant that is not published MUST NOT be publicly discoverable.

#### Scenario: T1 unpublished tenant is invisible

- GIVEN an active tenant whose `catalogPublished` is `false`
- WHEN a caller requests branches, a product list, product detail, or cart validation by that tenant slug
- THEN the tenant MUST be absent from branches and the public resource MUST resolve as the existing generic not-found/unavailable response
- AND no product, variant, price, or stock data MUST be disclosed

#### Scenario: T2 tenant isolation

- GIVEN authenticated caller A operates in tenant A and tenant B has catalog settings or products
- WHEN caller A reads or mutates tenant B settings or product/variant publication
- THEN the request MUST be rejected as unauthorized/not found according to existing policy
- AND no tenant B data MUST be read or changed

### Requirement: Effective Publication Cascade

The system MUST evaluate effective publication on every public read and cart validation from current data as the conjunction of tenant publication and activity, `Product.includeInOnlineCatalog`, `Product.type = PRODUCT`, and effective variant publication. `CatalogPublishMode` MUST be `INHERIT`, `ON`, or `OFF`; variants MUST be created with `INHERIT` and MUST resolve inheritance at read time. An `ON` override MUST NOT widen publication beyond a non-published product or tenant.

#### Scenario: T3 effective publication matrix

- GIVEN an unpublished tenant, any product/type/variant state
- WHEN branches, list, detail, or cart are requested
- THEN the tenant MUST be invisible and no resource MUST be usable
- GIVEN a published active tenant and a product with `includeInOnlineCatalog = false`
- WHEN the same four surfaces are requested
- THEN the product MUST be omitted from lists, detail MUST be unavailable, and its cart item MUST be rejected as not in catalog
- GIVEN a published active tenant and a `SERVICE` product
- WHEN public surfaces are requested
- THEN it MUST remain excluded from every public surface
- GIVEN a published PRODUCT with a published product and a variant resolving unpublished
- WHEN list/detail/cart are requested
- THEN the product MAY be represented, the unpublished variant MUST be omitted, and that variant cart item MUST be rejected
- GIVEN a published product whose only variants either resolve unpublished or fail the selected-context pricing check
- WHEN list/detail/cart are requested
- THEN the product MUST be omitted as if it had no surviving variant; only products with at least one surviving variant are represented
- GIVEN a published PRODUCT and variant resolving published
- WHEN list/detail/cart are requested
- THEN the resource MUST be visible and cart-addable subject to price and operational stock validation

#### Scenario: T4 variant inheritance and non-widening

- GIVEN a variant with `catalogPublishMode = INHERIT`
- WHEN the product publication changes
- THEN the variant's effective publication MUST change with the product without copying state
- GIVEN a published product and an explicit `ON` or `OFF` variant override
- WHEN the variant is read publicly
- THEN `ON` MUST publish and `OFF` MUST hide the variant, subject to the product and tenant gates
- GIVEN an unpublished product or tenant and a variant override `ON`
- WHEN any public surface is requested
- THEN the variant MUST NOT be exposed

### Requirement: Tenant Catalog Settings API and Authorization

The system MUST expose authenticated `GET` and `PATCH /tenants/:tenantId/catalog-settings`. The settings MUST include `catalogPublished`, tenant public price-list bindings, exactly one catalog default when bindings exist, and the catalog stock presentation default when applicable. PATCH publication/list changes MUST be atomic; a default price list MUST be public for that tenant. The system MUST use dedicated CASL `TenantCatalogSettings` `read` and `update` permissions, granted only explicitly or by `manage:all`; product editors MUST NOT receive this permission implicitly. Product and variant fields MUST continue to use `update:Product`.

#### Scenario: Settings round trip and validation

- GIVEN an authorized caller and a tenant in the caller's scope
- WHEN the caller GETs settings and PATCHes valid publication, public list, default list, and stock mode values
- THEN GET MUST return the persisted values and PATCH MUST commit them atomically
- AND an invalid UUID, enum, negative custom quantity, or non-public default list MUST be rejected without partial mutation

#### Scenario: T12 permission separation

- GIVEN a product editor with `update:Product` but without `TenantCatalogSettings`
- WHEN the editor updates product/variant publication fields or attempts tenant catalog settings
- THEN product/variant updates MUST be allowed by the existing permission and settings access MUST be denied

### Requirement: Tenant-Scoped Persistence and DTO Safety

Every new tenant-scoped model, including `TenantCatalogPriceList` and `ProductCatalogPriceList`, MUST be registered in `TENANT_SCOPED_MODELS`. Authenticated repositories MUST enforce tenant filters with explicit tenant IDs as defense in depth. DTOs MUST use strict class-validator UUID and enum validation and custom quantities MUST be integers greater than or equal to zero. Publication changes SHOULD be auditable with actor and timestamp information.

#### Scenario: Cross-tenant identifiers cannot cross boundaries

- GIVEN an identifier for a tenant B binding or product supplied to a tenant A request
- WHEN the request is evaluated
- THEN it MUST behave as unavailable to tenant A and MUST NOT disclose or mutate tenant B data

### Requirement: Catalog Price-List Bindings

The system MUST support `TenantCatalogPriceList` bindings between a tenant and `GlobalPriceList`, with at most one `isCatalogDefault` binding per tenant. `ProductCatalogPriceList` MUST represent a product support allowlist: zero rows MUST mean all tenant-public lists are supported, while present rows MUST restrict support to listed public lists. All such models MUST be tenant-scoped.

#### Scenario: F1 default context is backwards compatible

- GIVEN a published tenant with a valid catalog-default public list
- WHEN a public list or detail request omits `priceListId`
- THEN the backend MUST resolve the tenant catalog default list
- AND the response MUST preserve the prior default-context behavior while identifying the resolved context

### Requirement: Explicit Price Context

Public list and detail routes MUST accept the optional UUID query parameter `priceListId`. `POST /public/catalog/:tenantSlug/cart/validate` MUST accept the selected `priceListId` in its body. Every request MUST resolve that context against the tenant's public bindings and product allowlist; the backend MUST be the authority and MUST recalculate all prices and totals.

#### Scenario: F2 context consistency

- GIVEN two public lists for a published tenant and a product with valid prices in both
- WHEN list, detail, and cart validation are performed with one selected `priceListId`
- THEN every numeric price and cart total MUST come from that same list
- AND each list/detail/cart response MUST include `priceContext` metadata for the resolved list

### Requirement: No-Fallback Pricing

A visible-price product or variant without a valid price (`priceCents` missing or less than or equal to zero) in the selected context MUST be omitted from that context's listing and MUST cause its cart item to be rejected with `PRICE_NOT_AVAILABLE_IN_CONTEXT`. The backend MUST NOT substitute the tenant default or any other list. Unsupported visible-price products MUST be omitted; a response MAY include only an aggregate `excludedCount` and MUST NOT include per-item exclusion details. Hidden-price products (`hidePriceInOnlineCatalog = true` OR `requiresPrescription = true`) bypass this requirement per the Hidden Price Precedence requirement: they MUST remain visible and cart-valid when publication gates pass, return null numeric fields and totals, and MUST NOT be excluded solely for lacking a positive numeric price in the selected context.

#### Scenario: T6 unsupported or missing price has no fallback

- GIVEN a visible-price product that does not support the selected public list, or has no valid price row in it
- WHEN the product list and cart validation are requested with that context
- THEN the product MUST be absent from the list
- AND the cart item MUST be blocked with `PRICE_NOT_AVAILABLE_IN_CONTEXT`
- AND no price from another list MUST appear
- AND a hidden-price product under the same conditions remains visible/cart-valid with null numeric fields per T8

### Requirement: Private Context Non-Enumeration

A private list ID, nonexistent list ID, and list ID belonging to another tenant MUST produce the same generic `PRICE_CONTEXT_NOT_AVAILABLE` code, message, and HTTP status on every public surface. No public response MAY expose private-list existence, name, ID, membership, prices, or distinguishable behavior.

#### Scenario: T7 private, nonexistent, and cross-tenant IDs are indistinguishable

- GIVEN a private list ID, a nonexistent UUID, and a valid list belonging to another tenant
- WHEN each is supplied to public list, detail, or cart validation
- THEN each response MUST use `PRICE_CONTEXT_NOT_AVAILABLE` with the same generic contract
- AND none MUST enumerate or reveal the referenced list

### Requirement: Hidden Price Precedence

When `hidePriceInOnlineCatalog` is true OR `requiresPrescription` is true, hidden-price behavior MUST take precedence over price-list support and price resolution. The product MUST remain visible in the selected context, MUST bypass the product allowlist and the selected-context positive-price requirement, MUST remain cart-valid when publication gates pass, and MUST return `null` for every public numeric price field and for cart totals. The item MUST NOT be treated as unavailable solely because its numeric price is hidden. The selected tenant context binding remains mandatory, so a private/nonexistent context still returns `PRICE_CONTEXT_NOT_AVAILABLE`.

#### Scenario: T8 hidden price wins over context

- GIVEN a published product with either hiding or prescription requirement enabled, regardless of selected-list support or positive-price availability
- WHEN list, detail, and cart validation are requested
- THEN the product MUST remain visible and, in the cart, valid subject to publication and operational-stock checks
- AND all numeric public price fields and totals MUST be `null`
- AND no alternate-list price MUST be exposed
- AND the item MUST NOT be blocked with `PRICE_NOT_AVAILABLE_IN_CONTEXT` solely due to the hidden numeric value

### Requirement: Cart Anti-Disclosure for Missing or Unpublished Items

Cart validation MUST treat a missing product ID and a product that fails the effective publication gate with a single generic catalog-membership miss outcome (`NOT_IN_CATALOG`) and MUST redact name and image metadata on every blocked item that is missing or unpublished in the catalog. Validated items that survive all gates return their full metadata. No cart response MAY disclose private-list membership, price-list existence, or product identity for items the catalog no longer serves.

#### Scenario: Cart blocks missing or unpublished items uniformly and redacts metadata

- GIVEN a cart containing a product ID that does not exist in the tenant catalog, and a product ID that exists but fails the effective publication gate
- WHEN the cart is validated
- THEN both items MUST be blocked with the same generic `NOT_IN_CATALOG` code
- AND both items MUST return `null` for `productName`, `variantName`, and `image`
- AND no alternate code or metadata MAY distinguish the missing case from the unpublished case

### Requirement: Stateless Server-Authoritative Cart

Cart validation MUST accept one context per request, ignore client-supplied prices, re-check publication, context, price, and stock against current data, remain stateless and idempotent, and return `Cache-Control: no-store`. Variant publication failures MUST use `VARIANT_NOT_IN_CATALOG`.

#### Scenario: Cart context change is revalidated

- GIVEN a previously displayed cart and a changed selected public list or changed server price
- WHEN the cart is validated
- THEN the backend MUST recalculate each item and total under the submitted context
- AND repeated identical validation MUST have no side effects
- AND client prices MUST have no influence on the result

#### Scenario: Unpublished variant cart error

- GIVEN a published product and a variant that resolves to unpublished
- WHEN that variant is submitted to cart validation
- THEN the item MUST be blocked with `VARIANT_NOT_IN_CATALOG`

### Requirement: Context-Sensitive Cache and Limits

Public list/detail cache semantics MUST remain cacheable for at most 60 seconds and MUST be keyed by tenant and `priceListId` (including the resolved default context), so contexts cannot share responses. Branches MAY remain cached for at most 300 seconds. Depublication and public-list changes MUST become effective within the applicable TTL; public reads MUST re-derive the publication/context gate rather than trust stale decisions. Browse throttling MUST remain `public-browse` at 60/min and validation MUST remain `public-validate` at 20/min.

#### Scenario: T13 cache and rate-limit contract

- GIVEN cached list/detail responses for two contexts and a tenant whose publication or public-list binding changes
- WHEN requests are made
- THEN responses MUST never mix contexts and changes MUST be effective within the stated TTL
- AND cart validation MUST be no-store and limited to 20 requests per minute while browse remains limited to 60 per minute

### Requirement: Stock Presentation Modes

The system MUST support `CatalogStockPresentation { SYSTEM_STATUS | ABSTRACT_STATUS | CUSTOM_QUANTITY | HIDDEN }` on products, with optional variant overrides and custom quantities validated as integers greater than or equal to zero. A null product mode MUST inherit the tenant's `catalogStockPresentationDefault`, and a null custom quantity MUST inherit the tenant's `catalogStockPresentationDefaultCustomQty`. A tenant default of `CUSTOM_QUANTITY` MUST require a tenant default custom quantity that is an integer greater than or equal to zero; other tenant default modes MUST NOT carry a non-null custom quantity. A variant with no override MUST inherit the resolved product mode and value. `SYSTEM_STATUS` MUST preserve the existing available/low_stock/out_of_stock presentation without exposing operational quantities; `HIDDEN` MUST expose no stock indicator.

#### Scenario: F3 mode resolution and inheritance

- GIVEN a product configured with any supported mode and a variant with no override
- WHEN the product or variant is returned publicly
- THEN the variant MUST present the effective product mode
- GIVEN a variant with an explicit stock mode override
- WHEN it is returned
- THEN the variant MUST present its override without changing operational stock

### Requirement: Abstract and Custom Presentation

`ABSTRACT_STATUS` MUST present only the configured abstract availability semantics and MUST resolve to an exhausted/unavailable state when operational stock is zero. `CUSTOM_QUANTITY` MAY present its configured public quantity, but that value MUST be separate from and MUST NOT write, replace, or substitute operational stock. For products with variants, product presentation MUST aggregate published variants with precedence available over low_stock over out_of_stock; product-level `HIDDEN` MUST remain hidden, and product-level custom quantity MUST show aggregate status while variant custom quantities apply per variant.

#### Scenario: T9 presentation matrix with positive and low stock

- GIVEN operational stock greater than zero or at/below the operational low threshold
- WHEN each stock presentation mode is used
- THEN the public presentation MUST match that mode, with `SYSTEM_STATUS`/equivalent status reflecting available or low stock, `CUSTOM_QUANTITY` showing only its configured public value, and `HIDDEN` showing no indicator
- AND cart validation MUST permit positive stock and MAY return a low-stock warning, subject to other validation rules

#### Scenario: T9 zero stock blocks in every mode

- GIVEN operational stock is zero
- WHEN the item is represented using `SYSTEM_STATUS`, `ABSTRACT_STATUS`, `CUSTOM_QUANTITY`, or `HIDDEN`
- THEN the presentation MUST never claim sellable availability (abstract status MUST resolve as exhausted)
- AND cart validation MUST block the item with `OUT_OF_STOCK` in every mode

#### Scenario: T10 custom quantity cannot manufacture availability

- GIVEN a product or variant has `CUSTOM_QUANTITY` with a positive public quantity and operational stock zero
- WHEN the public item is read and cart validation is performed
- THEN the public quantity MAY be shown as presentation data
- AND operational stock MUST remain unchanged
- AND cart validation MUST still block the item with `OUT_OF_STOCK`

### Requirement: Operational Stock Authority

Cart validation MUST always inspect operational stock independently of presentation. `useStock = false` MUST retain its existing always-available semantics. No stock presentation update or public read MAY mutate fulfillment inventory.

#### Scenario: Stock safety under non-stock-controlled product

- GIVEN a product with `useStock = false`
- WHEN it is validated with any presentation mode
- THEN it MUST be treated as operationally available, without exposing raw operational quantities or writing stock

### Requirement: Migration and Backfill Compatibility

M1 MUST leave existing tenants unpublished. M3 MUST backfill existing variants to `CatalogPublishMode.INHERIT`. M4 MUST bind the existing global default list as public and catalog-default per tenant, leaving other lists private. M5 MUST backfill `SYSTEM_STATUS` for existing products; variant presentation overrides MUST remain inherited. M6 MUST preserve existing `hidePriceInOnlineCatalog` values, including `false`, while adding authenticated round-trip support. M7 MUST exclude products lacking valid prices in the default context rather than exposing price zero.

#### Scenario: T11 conservative migration outcomes

- GIVEN existing tenant, variant, price-list, product, and hide-price records before migration
- WHEN migrations and backfills complete
- THEN the tenant MUST be invisible until explicitly published, variants MUST resolve `INHERIT`, the prior default list MUST be public/default, products MUST resolve `SYSTEM_STATUS`, other lists MUST remain private, and no hidden-price value MUST be lost
- AND products without a valid default-context price MUST be omitted rather than priced at zero

### Requirement: Phased Contract Delivery

The backend MUST deliver the capability in sequenced phases: F1 publication gate, conservative M1–M6 migration/backfill, settings and authenticated product/variant round-trips, and published branch discovery; F2 `priceListId` context, allowlists, no-fallback pricing, metadata, and cart binding; F3 stock presentation and inheritance/aggregation. F1 requests without a price context MUST remain backwards compatible with the tenant catalog default. F4 MUST remain deferred.

#### Scenario: F1 through F3 sequencing

- GIVEN a deployment at F1
- WHEN existing public list/detail/cart calls omit `priceListId`
- THEN they MUST use the tenant catalog default and preserve the default-context contract
- GIVEN F2 or later
- WHEN a caller supplies `priceListId`
- THEN list, detail, and cart MUST use that context consistently
- GIVEN F3
- WHEN stock presentation is configured
- THEN effective presentation MUST be resolved without changing zero-stock cart blocking

### Requirement: Authenticated Round-Trip Contracts

Authenticated product responses and updates MUST round-trip `includeInOnlineCatalog`, `hidePriceInOnlineCatalog`, supported public price lists or the all-public inheritance policy, stock presentation mode, and custom quantity. Authenticated variant responses and updates MUST round-trip `CatalogPublishMode` and stock presentation overrides, with no new mandatory fields. All identifiers MUST be UUIDs and all enums MUST be strict.

#### Scenario: T14 authenticated contracts

- GIVEN valid product and variant settings submitted by a caller with `update:Product`
- WHEN the resources are read after update
- THEN the response MUST contain the persisted publication, hidden-price, allowlist, mode, and custom-value semantics
- AND malformed UUIDs, unknown enum values, unknown properties, and negative custom quantities MUST be rejected

### Requirement: Public Response Contracts

Public branches MUST include only active, catalog-published tenants. Public list/detail responses MUST identify the resolved `priceContext`, omit unsupported or unpriceable items, and MUST NOT expose private-list metadata. Cart validation MUST return server-reconciled item statuses, `priceContext`, authoritative numeric prices where allowed, null numeric prices/totals when hidden, and stable blocking codes including `PRICE_CONTEXT_NOT_AVAILABLE`, `PRICE_NOT_AVAILABLE_IN_CONTEXT`, `VARIANT_NOT_IN_CATALOG`, and existing `OUT_OF_STOCK` semantics.

#### Scenario: T14 public contracts cover all surfaces

- GIVEN a published tenant, a public selected list, a published product, and a published variant
- WHEN branches, list, detail, and cart validation are requested
- THEN every response MUST conform to the documented DTO shape and identify the same price context
- AND a client-supplied price MUST never be echoed as authoritative

### Requirement: Authorization and Auditability

The settings controller MUST enforce `TenantCatalogSettings` `read`/`update` permissions, with explicit grants or `manage:all` only. Product and variant publication changes MUST enforce `update:Product`. Publication and public-list changes SHOULD record actor and timestamp for auditability.

#### Scenario: Settings permission is not inherited

- GIVEN a caller who can edit products but has no explicit catalog-settings permission
- WHEN the caller attempts to GET or PATCH tenant catalog settings
- THEN the request MUST be denied
- AND the caller MUST retain only the product/variant permissions explicitly granted

### Requirement: Cache, Rate Limit, and Isolation Guarantees

Every public and authenticated query MUST enforce tenant isolation. Public list/detail responses MUST be context-keyed and cacheable for no more than 60 seconds; branches MUST be no more than 300 seconds; settings PATCH and cart validation MUST be `Cache-Control: no-store`. Depublication MUST take effect within the applicable public TTL, and cart validation MUST retain stateless idempotence and the `public-validate` 20/min limit; browse MUST retain `public-browse` 60/min.

#### Scenario: T13 operational guarantees

- GIVEN concurrent settings changes, cached browse responses, and repeated cart validation requests
- WHEN the system handles them
- THEN settings changes MUST be atomic with last-write-wins acceptable, stale public data MUST be bounded by TTL, cart responses MUST not be stored, and repeated validation MUST have no side effects
- AND no request MUST read another tenant's settings, price binding, product, variant, or stock

### Requirement: Evidence and Frontend Boundary

The change MUST provide co-located unit evidence and relevant migration/adapter integration evidence for T1–T14 and MUST update or publish `docs/backend-responses/public-online-catalog-frontend-guide.md` with every changed authenticated and public DTO, examples, error codes, cache semantics, and rate limits. This evidence MUST NOT include frontend implementation or reactivate paused frontend work.

#### Scenario: T1–T14 acceptance evidence is complete

- GIVEN the implementation is reviewed against the acceptance matrix
- WHEN evidence is collected
- THEN T1 unpublished visibility, T2 isolation, T3 publication matrix, T4 inheritance, T5 context consistency, T6 no-fallback, T7 private-list protection, T8 hidden-price precedence, T9 stock safety, T10 custom quantity, T11 backfills, T12 permissions, T13 cache/limits, and T14 contracts MUST each have a passing scenario or documented integration result
- AND the backend delivery MUST remain independent of frontend scheduling

### Requirement: Scope Exclusions

The system MUST NOT implement frontend deliverables, F4 branding/contact/SEO/slugs, ratings, WhatsApp order creation, public `SERVICE` products, public tier prices, real multi-branch inventory, or visual redesign in this change.

#### Scenario: Frontend remains paused

- GIVEN this backend change is delivered
- WHEN its artifacts and endpoints are reviewed
- THEN they MUST contain backend contracts and evidence only and MUST NOT reactivate or require frontend work
