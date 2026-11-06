# Shipping packaging, standard boxes and shipping origin

Task T2 of `odd/tasks/shipping-zones.md` (specs S4 and S5). Design: `docs/shipping-and-delivery-zones-proposal.md` §2 and §5.

This step stores the data that carrier quotes need, and adds the pure rule that turns an order into one package. It calls no carrier. The quote engine (T3) uses it.

## 1. Units and limits

| Measure | Unit | Format | Allowed range |
| --- | --- | --- | --- |
| Weight | grams | integer | 1 – 70 000 |
| Length, width, height | centimetres | at most one decimal | 0.1 – 300 |

**Why one decimal for centimetres.** Many products are small (pharmacy, supplements). Rounding a 2.5 cm side up to 3 cm adds 20% of volume, and that can push an order into a bigger box. Carriers accept decimal centimetres. The database stores `DECIMAL(5,1)`, so it keeps exactly what the API accepts.

The limits follow usual parcel-carrier limits. The database also has CHECK constraints for positive values and a 5-digit postal code.

## 2. Packaging per product and per variant (S4)

Packaging is the **packed item as handed to a carrier**: package weight and outer dimensions. It is **not** the editorial net weight.

- A product has at most one packaging record.
- A variant can have its own record. It is a **whole-record override**: when it exists, it replaces the product record completely (no field-by-field inheritance). When it does not exist, the variant uses the product record.

The data is a sub-resource, so product and variant DTOs (and the strict FE decoders built on them) do not change.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| GET | `/products/:productId/packaging` | `read:Product` | 200 |
| PUT | `/products/:productId/packaging` | `update:Product` | 200 |
| DELETE | `/products/:productId/packaging` | `update:Product` | 204 |
| GET | `/products/:productId/variants/:variantId/packaging` | `read:Product` | 200 |
| PUT | `/products/:productId/variants/:variantId/packaging` | `update:Product` | 200 |
| DELETE | `/products/:productId/variants/:variantId/packaging` | `update:Product` | 204 |

PUT replaces the whole record; all four fields are required. DELETE is idempotent.

PUT body (product or variant):

```json
{ "weightG": 450, "lengthCm": 20.5, "widthCm": 12, "heightCm": 8.3 }
```

Product response (`packaging` is `null` until it is set):

```json
{
  "productId": "6f1c…",
  "packaging": {
    "weightG": 450, "lengthCm": 20.5, "widthCm": 12, "heightCm": 8.3,
    "updatedAt": "2026-11-05T18:00:00.000Z"
  }
}
```

Variant response:

```json
{
  "productId": "6f1c…",
  "variantId": "a91e…",
  "override": null,
  "productPackaging": { "weightG": 450, "lengthCm": 20.5, "widthCm": 12, "heightCm": 8.3, "updatedAt": "…" },
  "effective": { "weightG": 450, "lengthCm": 20.5, "widthCm": 12, "heightCm": 8.3, "updatedAt": "…" },
  "source": "PRODUCT"
}
```

`source` is `"VARIANT"` (own override), `"PRODUCT"` (inherited) or `null` (no data). `effective` is what the packing rule uses.

## 3. Standard boxes per sucursal (S5)

A box has a name (unique per sucursal), inner dimensions, its own empty weight, the max weight of its content (the box weight is not included) and an active flag. Only active boxes are used to pack.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| GET | `/tenants/:tenantId/shipping-boxes` | `read:ShippingSettings` | 200 |
| POST | `/tenants/:tenantId/shipping-boxes` | `update:ShippingSettings` | 201 |
| PATCH | `/tenants/:tenantId/shipping-boxes/:boxId` | `update:ShippingSettings` | 200 |
| DELETE | `/tenants/:tenantId/shipping-boxes/:boxId` | `update:ShippingSettings` | 204 |

POST body (PATCH accepts any subset):

```json
{
  "name": "Caja chica",
  "innerLengthCm": 20, "innerWidthCm": 15.5, "innerHeightCm": 10,
  "weightG": 120, "maxContentWeightG": 5000,
  "isActive": true
}
```

`isActive` is optional on create (default `true`). To retire a box without deleting it, PATCH `{ "isActive": false }`.

Box response; GET returns `{ "data": [box, …] }`, active boxes first, then by name:

```json
{
  "id": "c0b7…", "name": "Caja chica",
  "innerLengthCm": 20, "innerWidthCm": 15.5, "innerHeightCm": 10,
  "weightG": 120, "maxContentWeightG": 5000, "isActive": true,
  "createdAt": "…", "updatedAt": "…"
}
```

## 4. Shipping origin per sucursal (S5)

The address that carriers pick up from. It is a separate record. `Tenant.address` keeps its meaning (free text) and is not changed.

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| GET | `/tenants/:tenantId/shipping-origin` | `read:ShippingSettings` | 200 |
| PUT | `/tenants/:tenantId/shipping-origin` | `update:ShippingSettings` | 200 (`Cache-Control: no-store`) |

PUT body (`addressLine2` is optional; omitted or empty means `null`):

```json
{
  "addressLine1": "Av. Juárez 123",
  "addressLine2": "Local 4",
  "neighborhood": "Centro",
  "municipality": "Cuauhtémoc",
  "state": "Ciudad de México",
  "postalCode": "06000",
  "contactPhone": "5512345678"
}
```

- `postalCode`: exactly 5 digits.
- `contactPhone`: 10 to 15 digits, optionally starting with `+`.
- Text fields are trimmed; blank values are rejected.

Response (`configured: false, origin: null` until the first PUT):

```json
{
  "configured": true,
  "origin": {
    "addressLine1": "Av. Juárez 123", "addressLine2": "Local 4",
    "neighborhood": "Centro", "municipality": "Cuauhtémoc",
    "state": "Ciudad de México", "postalCode": "06000",
    "contactPhone": "5512345678", "updatedAt": "…"
  }
}
```

## 5. Permissions

| Data | Permission | Why |
| --- | --- | --- |
| Packaging | `read:Product` / `update:Product` | It is product data, edited by the same people as other product sub-resources. |
| Boxes and origin | New subject `ShippingSettings`: `read`, `update` | Sucursal configuration, like `TenantCatalogSettings`. `update` covers creating, editing and deleting boxes and replacing the origin. |

Roles in `prisma/seed.ts`:

- The Manager role gets `ShippingSettings:read` and `ShippingSettings:update`.
- The Cashier role gets neither.
- Super Admin keeps `manage:all`.

`PermissionSeeder` creates the permission rows on boot. Existing roles in other environments need an explicit grant.

## 6. Errors

| Case | Status | Body |
| --- | --- | --- |
| Invalid body (range, decimals, missing or unknown field, bad postal code or phone) | 400 | Standard `ValidationPipe` response (same as other DTO routes) |
| Missing or invalid token | 401 | |
| Missing permission | 403 | |
| Product, variant or box not found in the caller's tenant | 404 | `{ "statusCode": 404, "error": "ENTITY_NOT_FOUND", "message": "…", "timestamp": "…" }` |
| `:tenantId` in the path is not the caller's tenant (and no `manage:all`) | 404 | Same 404 whether the tenant exists or not, so the route does not reveal other tenants |
| Duplicate box name in the sucursal | 409 | `{ "error": "ENTITY_ALREADY_EXISTS", … }` |

Tenant isolation:

- The four new models are in `TENANT_SCOPED_MODELS`.
- Every query also filters by `tenantId` explicitly.
- A variant must belong to the product in the path.

## 7. Packing rule: one package per order

`buildOrderPackage(items, activeBoxes)` in `src/shipping/packaging/domain/order-package.ts` is a pure function (no database, no carrier).

**Input.**

- Items: `{ productId, variantId, quantity, packageWeightG, dims }`.
- Boxes: the sucursal's active boxes.

`ProductPackagingService.resolvePackageItems(tenantId, lines)` builds the items with the effective packaging of each line. `ShippingSettingsService.listActiveBoxes(tenantId)` returns the boxes.

**Rule.**

1. Every item needs package weight and dimensions. If some do not have them, the function fails with `PACKAGING_DATA_MISSING`. `details.missing` lists every `{ productId, variantId }` without data, without duplicates.
2. Content weight = Σ package weight × quantity.
3. A box is a candidate when all of these hold:
   - **Each item fits on its own.** Dimensions are compared after sorting them from largest to smallest, so an item can be rotated.
   - **The total item volume fits.** Σ item volume × quantity must not be larger than the inner volume. This is a deliberate extra check: without it, 50 small items would "fit" in a box made for one.
   - **The box can carry the content.** `maxContentWeightG` must be at least the content weight.
4. The chosen box is the candidate with the smallest inner volume. Ties go to the lighter box, then to the lower id (deterministic).
5. Total weight = content weight + box weight. The package dimensions sent to carriers are the box's inner dimensions.
6. If no box qualifies, the function fails with `NO_SHIPPING_BOX_FITS`. `details` has `contentWeightG` and `boxesConsidered`, and `boxesConsidered: 0` means the sucursal has no active box. The store has to add a box.

Both errors are `BusinessRuleViolationError`s. If they reach HTTP, the global filter answers 422 with `error` set to the code and the `details` spread into the body.

An empty order, or a quantity that is not a positive integer, raises `InvalidArgumentError` (400).

Output:

```json
{
  "box": { "id": "c0b7…", "name": "Caja chica", "innerLengthCm": 20, "innerWidthCm": 15.5, "innerHeightCm": 10, "weightG": 120, "maxContentWeightG": 5000 },
  "contentWeightG": 750,
  "totalWeightG": 870,
  "dims": { "lengthCm": 20, "widthCm": 15.5, "heightCm": 10 }
}
```

## 8. Storage

Migration `20261106020000_shipping_packaging` adds four tables. It only adds; nothing existing changes.

| Table | Key | Notes |
| --- | --- | --- |
| `product_packagings` | `productId` | Cascade from product and tenant |
| `variant_packagings` | `variantId` | Cascade from variant and tenant |
| `shipping_boxes` | `id` | Unique `(tenantId, name)`; index `(tenantId, isActive)` |
| `shipping_origins` | `tenantId` | One row per sucursal |

Code: `src/shipping/packaging/` (`ShippingPackagingModule`).
