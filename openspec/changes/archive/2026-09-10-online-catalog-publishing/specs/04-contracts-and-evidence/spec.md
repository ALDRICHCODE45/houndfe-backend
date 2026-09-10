# Online Catalog Contracts and Evidence Specification

## Purpose

Define stable backend contracts, authorization, caching, and evidence obligations for the phased delivery of online catalog publishing.

## Requirements

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
