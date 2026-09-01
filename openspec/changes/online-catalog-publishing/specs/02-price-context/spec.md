# Public Price Context Specification

## Purpose

Define tenant-public price-list selection, consistent price context, and private-list protection across public browsing and cart validation.

## Requirements

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
