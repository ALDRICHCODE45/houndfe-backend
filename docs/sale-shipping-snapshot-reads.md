# Sale address reads use the sale snapshot

Delivery fields come exclusively from `Sale.shippingStreet` through `Sale.shippingLongitude`. A non-null `shippingStreet` identifies a captured snapshot. No backfill or live-address fallback is provided.

## Source status (01a1af7f)

Every `shippingAddress` snapshot object listed below carries two computed, read-only fields. The snapshot itself is never rewritten and there is no backfill.

| Field | Type | Meaning |
| --- | --- | --- |
| `sourceStatus` | `"UNCHANGED" \| "CHANGED" \| "DELETED"` | How the customer address the snapshot was copied from compares with the snapshot **now**. Always present when `shippingAddress` is present. |
| `changedFields` | `string[]` | Snapshot keys whose live value differs, in the fixed key order below. `[]` for UNCHANGED and DELETED. |

A sale without a snapshot (`shippingStreet` null) keeps `shippingAddress: null`, with no status.

**Rule.** The 13 compared keys, in `changedFields` order: `street`, `exteriorNumber`, `interiorNumber`, `zipCode`, `neighborhood`, `municipality`, `city`, `state`, `visualReferences`, `carrierPhone`, `label`, `latitude`, `longitude`.

- **DELETED**: the snapshot's `shippingAddressId` is null (the customer address was hard-deleted; FK `ON DELETE SET NULL`), or the live row belongs to another tenant. A foreign row is treated as absent and none of its values are exposed.
- **CHANGED**: at least one of the 13 keys differs under strict equality (`undefined` is treated as `null`; no trimming, no case folding; `latitude`/`longitude` compared exactly, with no tolerance).
- **UNCHANGED**: all 13 keys are equal. A bumped `updatedAt` with identical values is UNCHANGED.
- A **label-only** edit is **CHANGED** with `changedFields: ["label"]`. The backend reports it; the frontend decides to ignore it (the label is a nickname, not a delivery fact).

**One shape everywhere.** Every endpoint below returns the same object (one FE schema; `SaleShippingAddressDto` in `src/sales/dto/sale-shipping-address.dto.ts`, `SaleShippingAddressView` in the domain), or `null`:

```ts
{
  id: string | null;            // source customer-address id; null once deleted
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  visualReferences: string | null;
  carrierPhone: string | null;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
  sourceStatus: 'UNCHANGED' | 'CHANGED' | 'DELETED';
  changedFields: string[];
}
```

The change is additive: route stops gained `visualReferences` and `carrierPhone`, and eligible sales gained those two plus `latitude` and `longitude`. No key was removed or renamed. Object key order follows the shape above (eligible sales previously listed `label` first; JSON consumers are unaffected).

**Endpoints.**

| Endpoint | Object |
| --- | --- |
| `GET /delivery-routes`, `GET /delivery-routes/:id`, and every response reusing the route projection (see the table below) | `stops[].shippingAddress` |
| `GET /delivery-routes/eligible-sales` | `data[].shippingAddress` |
| `GET /sales` | **New** `data[].shippingAddress` |
| `GET /sales/:id`, `PATCH /sales/:id/due-date`, `PUT /sales/:id/seller` and `DELETE /sales/:id/seller` (when they return the confirmed detail) | **New** `shippingAddress` |

**Loading.** The live address is a nested select (`sale.shippingAddress { tenantId, …13 keys }`) in the same query as the page or detail, so no extra query per row. The CLS tenant extension does not rewrite nested to-one relations and Prisma accepts no `where` on them, so the mapper compares `tenantId` itself (`resolveShippingAddressSource` in `src/sales/infrastructure/shipping-address-snapshot.mapper.ts`). The pure comparator is `compareShippingAddressSource` in `src/sales/domain/shipping-address-source-status.ts`.

**Dev reproduction.** Take a confirmed sale with a snapshot, its `customerId`, and `shippingAddress.id` from `GET /sales/:id`:

1. UNCHANGED: `GET /sales/:id` shows `sourceStatus: "UNCHANGED"`, `changedFields: []`.
2. CHANGED: `PATCH /customers/:customerId/addresses/:addressId` with `{ "street": "Otra calle 1" }`. `GET /sales/:id` (or the route/eligible-sales reads) now shows `sourceStatus: "CHANGED"`, `changedFields: ["street"]`, while `street` keeps the sale-time value. `{ "label": "Otro" }` alone gives `["label"]`.
3. DELETED: `DELETE /customers/:customerId/addresses/:addressId`. The snapshot remains, `id` becomes `null`, and `sourceStatus: "DELETED"`.

## Frontend coordination (01a1417e)

No response keys were added or removed. Where an address object includes `id`, it is now `shippingAddressId`, which can be **null while the rest of the address remains populated** after customer-address deletion. Treat it as an optional reference, not the address's identity or existence signal.

| Endpoint / response | Source and nullability change |
| --- | --- |
| `PUT /sales/drafts/:id/customer` | Same `shippingAddress` fields; snapshot instead of relation. `shippingAddress.id` is nullable. No snapshot means `shippingAddress: null`. |
| `PUT /sales/drafts/:id/shipping-address` | Same rule, including the null-address request body. |
| `PUT /sales/drafts/:id/price-list` | Same enriched draft projection and rule. |
| `PUT /sales/:id/seller` (DRAFT) | Returns the same enriched draft projection; same nullable `shippingAddress.id` rule. |
| `GET /delivery-routes`, `GET /delivery-routes/:id` | `stops[].shippingAddress` fields and coordinates; address `id` is nullable. No snapshot means a null address. Since 01a1af7f the object uses the single shared shape (see *Source status*). |
| `POST /delivery-routes`, `PATCH /delivery-routes/:id`, `POST /delivery-routes/:id/start`, `POST /delivery-routes/:id/cancel`, `POST /delivery-routes/:id/stops`, `POST /delivery-routes/:id/stops/:stopId/check-in` | Responses reuse the same route projection and nullable address id. |
| `PUT /delivery-routes/:id/stops/reorder` | Same route projection and nullable address id. |
| `POST /delivery-routes/:routeId/stops/:stopId/transfer` | Both returned route projections use the same snapshot/nullability rule. |
| `GET /delivery-routes/eligible-sales` | `rows[].shippingAddress` structure (since 01a1af7f the single shared shape, see *Source status*); `id` is nullable. Snapshot-less rows remain visible with null address and `INELIGIBLE/MISSING_ADDRESS`. |
| `GET /chatbot-api/customers/by-phone/:phone/orders` | Same `shippingAddress: { street, zipCode } \| null`; no id exposed. A snapshot survives deletion; a legacy row without one is null even if its live address exists. |

The confirmed POS `GET /sales` and `GET /sales/:id` gained a `shippingAddress` snapshot object in 01a1af7f (see *Source status*). The receipt PDF props still do not expose a shipping address. `GET /sales/drafts` exposes the address reference only through the aggregate response, not an address object. Existing `shippingAddressId` scalar nullability is unchanged.

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
- `EligibleSalesService.toRowDto` / `inferAvailability`, route response mapping, DTOs/ports: consume the now snapshot-backed projections. The route and eligible-sales readers load the live address only for `sourceStatus` (01a1af7f), never as an address fallback. The existing missing-address availability branch is retained.
- `SalesService.listSales` / `getSaleDetail`, `PrismaSaleRepository.findManyConfirmed` / `findOneWithRelations`: since 01a1af7f, they expose the snapshot built from sale columns. The nested live `shippingAddress` relation is selected **only** to compute `sourceStatus`; its values never fill the address.
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
| Confirmed POS list/detail | `shippingAddress: null`, no status; no new rejection. |
| Receipt/PDF data, analytics | No shipping address field; unchanged, no new rejection. |

A deleted customer address does **not** produce these legacy rejections if the sale still has a snapshot. There is no compatibility fallback or data migration.
