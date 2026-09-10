# Public Stock Presentation Specification

## Purpose

Define configurable stock presentation while preserving operational stock as the sole fulfillment authority.

## Requirements

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
