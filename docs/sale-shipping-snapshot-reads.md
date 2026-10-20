# Sale address reads use the sale snapshot

Delivery fields come exclusively from `Sale.shippingStreet` through `Sale.shippingLongitude`. A non-null `shippingStreet` identifies a captured snapshot. No backfill or live-address fallback is provided.

## Frontend coordination (01a1417e)

No response keys were added or removed. Where an address object includes `id`, it is now `shippingAddressId`, which can be **null while the rest of the address remains populated** after customer-address deletion. Treat it as an optional reference, not the address's identity or existence signal.

| Endpoint / response | Source and nullability change |
| --- | --- |
| `PUT /sales/drafts/:id/customer` | Same `shippingAddress` fields; snapshot instead of relation. `shippingAddress.id` is nullable. No snapshot means `shippingAddress: null`. |
| `PUT /sales/drafts/:id/shipping-address` | Same rule, including the null-address request body. |
| `PUT /sales/drafts/:id/price-list` | Same enriched draft projection and rule. |
| `GET /delivery-routes`, `GET /delivery-routes/:id` | Same `stops[].shippingAddress` fields and coordinates; address `id` is nullable. No snapshot means a null address. |
| `POST /delivery-routes`, `PATCH /delivery-routes/:id`, `POST /delivery-routes/:id/start`, `POST /delivery-routes/:id/cancel`, `POST /delivery-routes/:id/stops`, `POST /delivery-routes/:id/stops/:stopId/check-in` | Responses reuse the same route projection and nullable address id. |
| `POST /delivery-routes/:routeId/stops/:stopId/transfer` | Both returned route projections use the same snapshot/nullability rule. |
| `GET /delivery-routes/eligible-sales` | Same `rows[].shippingAddress` structure; `id` is nullable. Snapshot-less rows remain visible with null address and `INELIGIBLE/MISSING_ADDRESS`. |
| `GET /chatbot-api/customers/by-phone/:phone/orders` | Same `shippingAddress: { street, zipCode } \| null`; no id exposed. A snapshot survives deletion; a legacy row without one is null even if its live address exists. |

The confirmed POS `GET /sales`, `GET /sales/:id` DTOs do **not** currently expose a shipping address. Neither do the receipt PDF props. These responses were not expanded: keeping the same shape means not adding a new address object to them. `GET /sales/drafts` exposes the address reference only through the aggregate response, not an address object. Existing `shippingAddressId` scalar nullability is unchanged.

## Complete read inventory

### Changed reads

| File / method | Change |
| --- | --- |
| `src/sales/infrastructure/prisma-sale.repository.ts` — `findDraftResponseById` | Removed live address include; builds the existing nine-field address summary plus id from sale columns. |
| `src/chatbot-api/application/chatbot-api.service.ts` — `getOrderHistoryByPhone`, `toOrderHistoryResponse` | Removed relation include/payload type; reads `shippingStreet` and `shippingZipCode`. |
| `src/delivery-routes/infrastructure/prisma-delivery-route.repository.ts` — `STOP_SALE_SELECT`, `mapRouteStopReadModel` | Replaced nested address select with sale snapshot columns; applies to **both** `findOneWithStops` and `list`, including latitude/longitude. Sale/customer tenant defenses remain. |
| `src/delivery-routes/infrastructure/eligible-sales-prisma.reader.ts` — `findEligibleSales`, `mapRow`, `mapAddress` | Reads snapshot columns; keeps precisely the existing structured address projection. |
| Same file — `buildEligibleSalesSearchWhere` | Replaced **all five** live-relation branches: street, neighborhood, municipality, city, zipCode. Tenant-scoped sale columns now drive both page and count queries. |
| `src/delivery-routes/application/delivery-routes.service.ts` — `checkSaleEligibility` | Selects snapshot street, not address FK. The domain eligibility port now carries `hasShippingAddress`, so a deleted FK does not disqualify a snapshot-bearing sale. Used by create/add/start validation. |
| Same file — `composeNextStopPayload` | Formats the saved sale snapshot into `nextAddressLabel`; no live-address select. Existing outbox payload keys, customer/email tenant checks and idempotency are unchanged. |

The common snapshot select/hydrator lives in `src/sales/infrastructure/shipping-address-snapshot.mapper.ts`; it returns null for absent snapshots. Public projection types now permit nullable ids without widening the set of returned fields.

### Intentionally unchanged reads / references

Whole-`src` `shippingAddress` inspection found the following remaining categories:

- `PrismaSaleRepository.findById`, `findDraftsByUserId`, `findByIdForUpdate`: already hydrate snapshots from sale columns (T1). Their remaining `shippingAddress: { select: { id: true } }` includes request **id only** and their results are not used to format an address or establish route eligibility. Scalar FK reads remain reference-only.
- `SalesService` assignment/change/confirmation live `customerAddress` lookups: **write-time capture/validation**, intentionally live while DRAFT. `clearShippingAddress`, request DTOs, idempotency hashes and `Sale.markForDelivery` retain write-time FK semantics. Confirmed reads never use these lookups as fallback.
- `CheckoutService` live address resolution and bot customer-address listing/context/upsert methods: customer address management or write-time assignment, not a read of a past sale's shipping address.
- `Sale` snapshot getters, `toResponse().shippingAddressId`, repository writes, sale events and `SaleEventListener.onSaleShippingAddressSet`: capture/persist/log references only. The listener does not resolve an address.
- `EligibleSalesService.toRowDto` / `inferAvailability`, route response mapping, DTOs/ports: consume the now snapshot-backed projections; they do not query live addresses. The existing missing-address availability branch is retained.
- `SalesService.listSales` / `getSaleDetail`, `PrismaSaleRepository.findManyConfirmed` / `findOneWithRelations`: no shipping-address relation or shipping-address response fields. No source change required.
- `src/pdf-generation/**`: receipt generation consumes `getSaleDetail`; receipt customer props do not contain shipping addresses. Branch/business address props are unrelated. No receipt/template change required.
- `src/analytics/**`: no sale shipping-address reads; report projections deliberately omit address PII. No change required.
- Test fixtures and assertions retain live relation fields where useful to prove those fields are ignored, or model customer-address write paths.

## Legacy: empty versus rejected

| Path without snapshot | Result |
| --- | --- |
| Enriched POS projection, bot history, existing route detail/list | Null shipping address; no new exception. |
| Next-stop outbox composition | Null `nextAddressLabel`; generic notification remains possible. |
| Eligible-sales selector | Returns row with `availability: { state: 'INELIGIBLE', reason: 'MISSING_ADDRESS' }`; not an HTTP error. Address-only search does not match the live address. |
| Route create / add-stop / start | Rejects with `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` (422), details reason `INELIGIBLE_SALE`, `hasShippingAddress: false`. |
| Confirmed POS list/detail, receipt/PDF data, analytics | No shipping address field existed; unchanged, no new rejection. |

A deleted customer address does **not** produce these legacy rejections if the sale still has a snapshot. There is no compatibility fallback or data migration.
