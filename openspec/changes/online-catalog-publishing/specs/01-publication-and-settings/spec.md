# Publication and Catalog Settings Specification

## Purpose

Define tenant-scoped publication gates and authenticated catalog settings for the public catalog. This change is backend-only; frontend work remains paused.

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

The system MUST expose authenticated `GET` and `PATCH /admin/tenants/:tenantId/catalog-settings`. The settings MUST include `catalogPublished`, tenant public price-list bindings, exactly one catalog default when bindings exist, and the catalog stock presentation default when applicable. PATCH publication/list changes MUST be atomic; a default price list MUST be public for that tenant. The system MUST use dedicated CASL `TenantCatalogSettings` `read` and `update` permissions, granted only explicitly or by `manage:all`; product editors MUST NOT receive this permission implicitly. Product and variant fields MUST continue to use `update:Product`.

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

### Requirement: Scope Exclusions

The system MUST NOT implement frontend deliverables, F4 branding/contact/SEO/slugs, ratings, WhatsApp order creation, public `SERVICE` products, public tier prices, real multi-branch inventory, or visual redesign in this change.

#### Scenario: Frontend remains paused

- GIVEN this backend change is delivered
- WHEN its artifacts and endpoints are reviewed
- THEN they MUST contain backend contracts and evidence only and MUST NOT reactivate or require frontend work
