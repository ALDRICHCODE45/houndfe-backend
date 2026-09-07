# Public Online Catalog — Backend Response Guide

**Canonical backend-only response evidence through F2.WU7; frontend implementation and activation remain paused.**

---

## 1. Overview

Public storefront for end customers to browse products by branch, see availability and prices, build a local cart, validate it, and (in a future SDD) send the order via WhatsApp.

**In scope (v1, available now):**

- List active branches.
- Browse products with filters, search, sort, pagination, and category facets.
- View product detail with variants and per-branch availability.
- Validate a local cart against current backend state (prices, stock).

**Out of scope (deferred to future SDDs):**

- WhatsApp order endpoint (`POST /public/catalog/:slug/orders/whatsapp`).
- Real order creation in POS from the public catalog.
- Product ratings (no reviews infrastructure yet).
- `featuredLabel` ("Más vendido", "Premium", etc. — no sales analytics yet).
- Category slugs (filter uses UUIDs).

---

## 2. Authentication and base URL

- Only `/public/catalog/...` routes are public. `/tenants/:tenantId/catalog-settings` and authenticated product/variant management require authentication and their documented permissions.
- **Base URL pattern**: `${API_BASE}/public/catalog/:tenantSlug/...`
- **Branch discovery**: `GET /public/catalog/branches` (no tenant slug — global discovery).
- **Rate limiting**: per-IP, two tiers.
  - `public-browse`: 60 req/min — all GET endpoints.
  - `public-validate`: 20 req/min — cart validate.
  - Excess requests receive `429`.
- **HTTP cache**: response guidance is header-only; there is no application cache to purge.

---

## 3. Publication and catalog settings

Authenticated settings source of truth: `GET`/`PATCH /tenants/:tenantId/catalog-settings`; `catalogPublished` is the opt-in, `effectivePublication` is active-tenant AND `catalogPublished`, `priceContexts` supplies catalog-public `{ priceListId, name, isCatalogDefault }` values (omission uses its default), and `DEFAULT_CONTEXT_HAS_NO_VALID_PRICES` is a warning, never a price or fallback.

### Authenticated settings PATCH

`PATCH /tenants/:tenantId/catalog-settings` accepts these optional settings fields:

- `publicPriceListIds: string[]` — unique catalog-public price-list UUIDs.
- `catalogDefaultPriceListId: string | null` — the default UUID, which must belong to `publicPriceListIds`.
- `stockPresentationDefault: { mode, customQuantity?: number | null }` — the tenant default; `CUSTOM_QUANTITY` requires a non-negative integer quantity, while other modes use `null`.

The authenticated settings PATCH response has `Cache-Control: no-store`.

Authenticated product writes/reads include `includeInOnlineCatalog`, `hidePriceInOnlineCatalog`, `supportedCatalogPriceListIds`, `supportsAllCatalogPriceLists`, `onlineStockPresentation`, and `onlineStockPresentationCustomQty`; variant writes/reads include `catalogPublishMode` (`INHERIT`/`ON`/`OFF`) and stock configuration. Omitted/empty allowlists support all tenant-public contexts; new/inline variants use `INHERIT` and null overrides inherit. No F3 public stock-presentation response is documented.

## 4. Endpoints

### 4.1 `GET /public/catalog/branches`

Lists every active, catalog-published branch (tenant). No tenant context is required. The response can contain zero, one, or many branches; use only the documented fields below.

**Request**

```http
GET /public/catalog/branches
```

No params, no query, no body.

**Response 200**

```ts
type PublicBranchDto = {
  id: string;          // tenant UUID — used as branchId elsewhere
  name: string;
  slug: string;        // use this for URL :tenantSlug
  address: string | null;
  phone: string | null;
};

// Body: PublicBranchDto[]
```

**Headers**

- `Cache-Control: public, max-age=300`

**Errors**

- `429` — rate limited.

**Example**

```bash
curl https://api.houndfe.com/public/catalog/branches
```

```json
[
  {
    "id": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
    "name": "Sucursal Centro",
    "slug": "centro",
    "address": "Av. Juárez 123, Col. Centro",
    "phone": "+52 55 1234 5678"
  },
  {
    "id": "b2c3d4e5-6789-01bc-defa-2345678901bc",
    "name": "Sucursal Norte",
    "slug": "norte",
    "address": "Plaza Cumbres, Local 12",
    "phone": "+52 55 9876 5432"
  }
]
```

**Edge cases**

- Empty array when no active catalog-published branch is available.

---

### 4.2 `GET /public/catalog/:tenantSlug/products`

Paginated product list with filters, search, sort, and category facets.

**Request**

```http
GET /public/catalog/:tenantSlug/products?q=&categoryId=&sort=&page=&limit=
```

**Path params**

| Param | Type | Required |
|---|---|---|
| `tenantSlug` | string | yes |

**Query params** (all optional)

```ts
type ListProductsQueryDto = {
  priceListId?: string;    // optional UUID; omitted => tenant catalog default
  q?: string;              // Search term. Matches product name + brand name (case-insensitive).
  categoryId?: string;     // UUID category filter.
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating_desc';
                            // default: 'newest'. 'rating_desc' silently falls back to relevance (no rating in v1).
  page?: number;           // default: 1. min: 1.
  limit?: number;          // default: 20. min: 1. max: 100.
};
```

**Response 200**

```ts
type PublicCatalogProductCard = {
  id: string;
  name: string;
  slug: string | null;          // null until product slugs are added (v2)
  description: string | null;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  image: { url: string } | null;   // main image only
  price: {
    fromPriceCents: number | null;  // min variant price or product price; null if hidden
    priceCents: number | null;      // product default price; null if hidden
    hidden: boolean;
  };
  availability: 'available' | 'low_stock' | 'out_of_stock';
  hasVariants: boolean;
  rating: null;                // reserved v2
  featuredLabel: null;         // reserved v2
};

type PublicCatalogCategoryFacet = {
  id: string;
  name: string;
  count: number;
};

type PublicPriceContext = {
  priceListId: string;
  name: string;
  isCatalogDefault: boolean;
};

type PublicProductListResponse = {
  items: PublicCatalogProductCard[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  facets: { categories: PublicCatalogCategoryFacet[] };
  excludedCount: number; // context-ineligible products, aggregate only
  priceContext: PublicPriceContext;
};
```

**Headers**

- `Cache-Control: public, max-age=60`
- The full path and query string, including optional `priceListId`, is the cache key. An omitted `priceListId` is a distinct default-context request.

**Errors**

- `400` — invalid query (bad UUID, sort outside enum, limit > 100, etc.).
- `404` — tenant unavailable, or the generic request-level `PRICE_CONTEXT_NOT_AVAILABLE` for a private, nonexistent, cross-tenant, unbound, or missing-default context. Those context cases are intentionally indistinguishable.
- `429` — rate limited.

**Example**

```bash
curl "https://api.houndfe.com/public/catalog/centro/products?categoryId=cat-uuid&sort=price_asc&page=1&limit=12"
```

```json
{
  "items": [
    {
      "id": "prod-uuid-1",
      "name": "Royal Canin Adult Medium 13.6kg",
      "slug": null,
      "description": "Alimento seco para perros adultos raza mediana",
      "category": { "id": "cat-uuid", "name": "Alimento Seco" },
      "brand": { "name": "Royal Canin" },
      "image": { "url": "https://cdn.example.com/img1.jpg" },
      "price": { "fromPriceCents": 125000, "priceCents": 125000, "hidden": false },
      "availability": "available",
      "hasVariants": false,
      "rating": null,
      "featuredLabel": null
    }
  ],
  "meta": { "page": 1, "limit": 12, "total": 142, "totalPages": 12 },
  "facets": {
    "categories": [
      { "id": "cat-uuid", "name": "Alimento Seco", "count": 45 },
      { "id": "cat-uuid-2", "name": "Juguetes", "count": 23 }
    ]
  },
  "excludedCount": 3,
  "priceContext": { "priceListId": "price-list-uuid", "name": "Lista pública", "isCatalogDefault": true }
}
```

**Edge cases**

- `items: []` with valid `meta` is returned when the page is beyond `totalPages`.
- Hidden-price products remain in the response with null numeric price fields.
- Out-of-stock products remain in the response with `availability: 'out_of_stock'`; cart validation reports the operational `OUT_OF_STOCK` block.
- Facets only include categories WITH visible products in the current scope (no zero-count entries).
- Facets/`meta.total` use selected-`priceContext` eligible products; aggregate-only `excludedCount` is pre-pagination. A selected list is exact: missing/non-positive visible prices are excluded with no default/alternate fallback, while hidden-price and prescription products retain null numeric prices.

---

### 4.3 `GET /public/catalog/:tenantSlug/products/:productId`

Product detail with variants under one resolved price context.

**Request**

```http
GET /public/catalog/:tenantSlug/products/:productId?priceListId=
```

**Path params**

| Param | Type | Required |
|---|---|---|
| `tenantSlug` | string | yes |
| `productId` | string (UUID) | yes |

**Query params** (optional)

| Param | Type | Notes |
|---|---|---|
| `priceListId` | UUID | Optional catalog-public global price-list context; omission resolves the tenant catalog default. |

**Response 200**

```ts
type PublicVariantAvailability = {
  branchId: string;
  branchName: string;
  branchSlug: string;
  availability: 'available' | 'low_stock' | 'out_of_stock';
  isSelected: boolean;
};

type PublicVariantDto = {
  id: string;
  name: string;
  option: string | null;
  value: string | null;
  image: { url: string } | null;
  price: {
    priceCents: number | null;   // null if hidden
    hidden: boolean;
  };
  availabilityByBranch: PublicVariantAvailability[];
};

type PublicCatalogProductDetail = {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  images: Array<{ id: string; url: string; isMain: boolean }>;
  price: {
    priceCents: number | null;
    hidden: boolean;
  };
  availability: 'available' | 'low_stock' | 'out_of_stock';
  hasVariants: boolean;
  variants: PublicVariantDto[];
  rating: null;
  featuredLabel: null;
  excludedCount: 0;
  priceContext: PublicPriceContext;
};
```

**Headers**

- `Cache-Control: public, max-age=60`

**Errors**

- `404` — generic tenant/product miss, or the same generic request-level `PRICE_CONTEXT_NOT_AVAILABLE` used for private, nonexistent, cross-tenant, unbound, and missing-default contexts. A selected context never falls back.
- `429` — rate limited.

**Example**

```bash
curl "https://api.houndfe.com/public/catalog/centro/products/prod-uuid-1"
```

```json
{
  "id": "prod-uuid-1",
  "name": "Royal Canin Adult Medium",
  "slug": null,
  "description": "Alimento seco para perros adultos raza mediana",
  "category": { "id": "cat-uuid", "name": "Alimento Seco" },
  "brand": { "name": "Royal Canin" },
  "images": [
    { "id": "img-1", "url": "https://cdn.example.com/img1.jpg", "isMain": true },
    { "id": "img-2", "url": "https://cdn.example.com/img2.jpg", "isMain": false }
  ],
  "price": { "priceCents": 125000, "hidden": false },
  "availability": "available",
  "hasVariants": true,
  "variants": [
    {
      "id": "var-1",
      "name": "13.6 kg",
      "option": "Peso",
      "value": "13.6 kg",
      "image": null,
      "price": { "priceCents": 125000, "hidden": false },
      "availabilityByBranch": [
        {
          "branchId": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
          "branchName": "Sucursal Centro",
          "branchSlug": "centro",
          "availability": "available",
          "isSelected": true
        }
      ]
    }
  ],
  "rating": null,
  "featuredLabel": null,
  "excludedCount": 0,
  "priceContext": { "priceListId": "price-list-uuid", "name": "Lista pública", "isCatalogDefault": true }
}
```

**Edge cases**

- `hasVariants = false` → `variants` may be an empty array. Use the top-level `price` and `availability`.
- `images` is sorted: main first, then by sort order.
- `variants[].image` uses only the variant's own first image and is `null` if the variant has no images; it does not fall back to the product image. Cart item `image` uses the product main image.

---

### 4.4 `POST /public/catalog/:tenantSlug/cart/validate`

Stateless cart validation. NO persistence. NO order creation. NO `whatsappUrl`.

**Request**

```http
POST /public/catalog/:tenantSlug/cart/validate
Content-Type: application/json
```

**Path params**

| Param | Type | Required |
|---|---|---|
| `tenantSlug` | string | yes |

**Body**

```ts
type ValidateCartBodyDto = {
  priceListId?: string; // optional UUID catalog-public context; omitted => default
  items: Array<{
    productId: string;    // UUID
    variantId?: string;   // UUID, optional
    quantity: number;     // integer, min 1
  }>;
};
```

**Validation rules** (returns `400` on failure)

- `items` is required, non-empty array.
- Each `productId` and `variantId` (if present) must be valid UUIDs.
- `quantity` must be an integer `>= 1`.

**Response 201**

The successful validation returns the default POST status `201 Created` with the documented body — do not expect `200`.

```ts
type CartBlockingCode =
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_NOT_IN_CATALOG'
  | 'PRICE_NOT_AVAILABLE_IN_CONTEXT'
  | 'OUT_OF_STOCK';
type CartWarningCode =
  | CartBlockingCode
  | 'LOW_STOCK'
  | 'PRICE_HIDDEN'
  | 'PRICE_CHANGED';

type CartValidatedItem = {
  productId: string;
  variantId: string | null;
  productName: string | null;
  variantName: string | null;
  image: { url: string } | null;
  quantity: number;
  status: 'VALID' | 'BLOCKED';
  blockingCodes: CartBlockingCode[];
  warnings: CartWarningCode[];
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  availability: 'available' | 'low_stock' | 'out_of_stock';
  priceHidden: boolean;
};

type CartValidationResponseDto = {
  valid: boolean;
  priceContext: { priceListId: string; name: string; isCatalogDefault: boolean };
  items: CartValidatedItem[];
  totalCents: number | null;
  warnings: CartWarningCode[];
};
```

**`totalCents` semantics (important)**

- Excludes items where `availability === 'out_of_stock'`.
- Excludes items where `unitPriceCents === null` (hidden price).
- Includes `low_stock` items (still fulfillable).
- Includes `available` items.
- If ANY item has `priceHidden === true`, the global `totalCents` is `null`.
- Blocked items never contribute; hidden-price/prescription items have null numeric fields and make `totalCents` null. `OUT_OF_STOCK` is operational and independent of context/presentation.

**`valid` semantics**

- `valid` is false for non-empty `blockingCodes`; `PRICE_CHANGED`, `LOW_STOCK`, and `PRICE_HIDDEN` are non-blocking.

**Headers**

- `Cache-Control: no-store`

**Errors**

- `400` — validation errors (bad UUID, empty items, invalid quantity).
- `404` — tenant unavailable, or generic request-level `PRICE_CONTEXT_NOT_AVAILABLE`; private/nonexistent/cross-tenant/unbound/missing-default contexts are indistinguishable.
- `429` — rate limited (stricter: 20 req/min).

**Item error semantics**

`PRICE_CONTEXT_NOT_AVAILABLE` is request-level only. Item-level `status` and `blockingCodes` explain reconciliation against the already resolved context: `NOT_IN_CATALOG`, `VARIANT_NOT_FOUND`, `VARIANT_NOT_IN_CATALOG`, `PRICE_NOT_AVAILABLE_IN_CONTEXT`, or `OUT_OF_STOCK`. No item code causes a fallback to another price list.

**Example**

```bash
curl -X POST "https://api.houndfe.com/public/catalog/centro/cart/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "priceListId": "price-list-uuid",
    "items": [
      { "productId": "prod-uuid-1", "variantId": "var-1", "quantity": 2 },
      { "productId": "prod-uuid-2", "quantity": 1 }
    ]
  }'
```

```json
{
  "valid": true,
  "priceContext": { "priceListId": "price-list-uuid", "name": "Lista pública", "isCatalogDefault": true },
  "items": [
    {
      "productId": "prod-uuid-1",
      "variantId": "var-1",
      "productName": "Royal Canin Adult Medium",
      "variantName": "13.6 kg",
      "image": { "url": "https://cdn.example.com/img1.jpg" },
      "quantity": 2,
      "status": "VALID",
      "blockingCodes": [],
      "warnings": [],
      "unitPriceCents": 125000,
      "lineTotalCents": 250000,
      "availability": "available",
      "priceHidden": false
    }
  ],
  "totalCents": 250000,
  "warnings": []
}
```

---

## 5. Operational stock and hidden-price response rules

The public response exposes semantic `availability`, never raw `quantity` or `minQuantity`. `OUT_OF_STOCK` remains an operational cart block even when a context is valid; it is not a price-context result and is not affected by F3 presentation work.

When `hidePriceInOnlineCatalog` or `requiresPrescription` applies, list/detail numeric price fields are `null`; cart `unitPriceCents`, `lineTotalCents`, and response `totalCents` are `null` under the rules above. The item remains context-valid without a numeric-price fallback.

When `price.hidden === true`:

- `priceCents` is `null`.
- `fromPriceCents` is `null` (in list view).

**When does this happen?**

- Product has `requiresPrescription = true` (auto-hidden — medicines).
- Product has `hidePriceInOnlineCatalog = true` (admin UI for `hidePriceInOnlineCatalog` is not yet available; the flag already applies through authenticated product writes).

Request-level `PRICE_CONTEXT_NOT_AVAILABLE` is generic 404; item `blockingCodes` are `NOT_IN_CATALOG`, `VARIANT_NOT_FOUND`, `VARIANT_NOT_IN_CATALOG`, `PRICE_NOT_AVAILABLE_IN_CONTEXT`, or operational `OUT_OF_STOCK`.

---

## 6. Errors

All errors follow standard NestJS shapes.

| Status | Backend response / contract fact |
|---|---|
| `400` | Validation failed (bad UUID, empty items, quantity < 1, sort outside enum, or limit > 100). |
| `404` | Tenant/product/branch is unavailable; the generic response does not enumerate inactive or missing entities. |
| `429` | The applicable per-IP rate limit was exceeded. |
| `5xx` | The backend returned a server error. |

---

## 7. Pagination and sorting

| Param | Default | Min | Max |
|---|---|---|---|
| `page` | 1 | 1 | — |
| `limit` | 20 | 1 | 100 |

**Sort options accepted**

| Value | Behavior |
|---|---|
| `newest` (default) | Most recently created first. |
| `relevance` | Same as `newest` in v1 (no FTS scoring). |
| `price_asc` | Cheapest first. Sort is in-page only (limitation for >10K products). Hidden-price products sort last. |
| `price_desc` | Most expensive first. Same in-page limitation. |
| `rating_desc` | Silently falls back to `relevance` because `rating` is `null` in v1. Accepted (no 400). |

---

## 8. Recommended TypeScript types

```ts
export type PublicStockStatus = 'available' | 'low_stock' | 'out_of_stock';

export type PublicSortOption =
  | 'relevance'
  | 'price_asc'
  | 'price_desc'
  | 'newest'
  | 'rating_desc';

export type PublicPriceContext = {
  priceListId: string;
  name: string;
  isCatalogDefault: boolean;
};
export type CartBlockingCode =
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_NOT_IN_CATALOG'
  | 'PRICE_NOT_AVAILABLE_IN_CONTEXT'
  | 'OUT_OF_STOCK';
export type CartWarningCode =
  | CartBlockingCode
  | 'LOW_STOCK'
  | 'PRICE_HIDDEN'
  | 'PRICE_CHANGED';

/** GET /public/catalog/branches */
export type PublicBranchDto = {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
};

/** GET /public/catalog/:tenantSlug/products — query */
export type ListProductsQuery = {
  priceListId?: string; // optional UUID; omission selects the catalog default
  q?: string;
  categoryId?: string;
  sort?: PublicSortOption;
  page?: number;
  limit?: number;
};

/** GET /public/catalog/:tenantSlug/products — item */
export type PublicCatalogProductCard = {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  image: { url: string } | null;
  price: {
    fromPriceCents: number | null;
    priceCents: number | null;
    hidden: boolean;
  };
  availability: PublicStockStatus;
  hasVariants: boolean;
  rating: null;
  featuredLabel: null;
};

export type PublicCatalogCategoryFacet = {
  id: string;
  name: string;
  count: number;
};

export type PublicProductListResponse = {
  items: PublicCatalogProductCard[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  facets: { categories: PublicCatalogCategoryFacet[] };
  excludedCount: number;
  priceContext: PublicPriceContext;
};

/** GET /public/catalog/:tenantSlug/products/:productId */
export type PublicVariantAvailability = {
  branchId: string;
  branchName: string;
  branchSlug: string;
  availability: PublicStockStatus;
  isSelected: boolean;
};

export type PublicVariantDto = {
  id: string;
  name: string;
  option: string | null;
  value: string | null;
  image: { url: string } | null;
  price: {
    priceCents: number | null;
    hidden: boolean;
  };
  availabilityByBranch: PublicVariantAvailability[];
};

export type PublicCatalogProductDetail = {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  images: Array<{ id: string; url: string; isMain: boolean }>;
  price: {
    priceCents: number | null;
    hidden: boolean;
  };
  availability: PublicStockStatus;
  hasVariants: boolean;
  variants: PublicVariantDto[];
  rating: null;
  featuredLabel: null;
  excludedCount: 0;
  priceContext: PublicPriceContext;
};

/** POST /public/catalog/:tenantSlug/cart/validate — request */
export type ValidateCartItem = {
  productId: string;
  variantId?: string;
  quantity: number;
};

export type ValidateCartBody = {
  priceListId?: string;
  items: ValidateCartItem[];
};

/** POST /public/catalog/:tenantSlug/cart/validate — response */
export type CartValidatedItem = {
  productId: string;
  variantId: string | null;
  productName: string | null;
  variantName: string | null;
  image: { url: string } | null;
  quantity: number;
  status: 'VALID' | 'BLOCKED';
  blockingCodes: CartBlockingCode[];
  warnings: CartWarningCode[];
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  availability: PublicStockStatus;
  priceHidden: boolean;
};

export type CartValidationResponse = {
  valid: boolean;
  priceContext: PublicPriceContext;
  items: CartValidatedItem[];
  totalCents: number | null;
  warnings: CartWarningCode[];
};
```

---

## 9. Deferred backend scope

- Order creation and WhatsApp order routes are not part of cart validation.
- **Real `rating`** — requires reviews infrastructure. v1 returns `null`.
- **Real `featuredLabel`** — requires sales analytics ("Más vendido", "Premium", etc.). v1 returns `null`.
- **Category slugs** — pretty URLs by category. v1 uses UUIDs.
- F3 public stock-presentation output is intentionally not documented in this slice.

---

## 10. Quick reference card

**Base URL**: `${API_BASE}/public/catalog/:tenantSlug/...`

| Endpoint | Purpose |
|---|---|
| `GET /public/catalog/branches` | List active catalog-published branches. |
| `GET /:slug/products?priceListId=` | Context-aware list; omit the optional UUID for the catalog default. |
| `GET /:slug/products/:id?priceListId=` | Context-aware detail; no selected-list fallback. |
| `POST /:slug/cart/validate` | Server-authoritative context-bound reconciliation. |

**Stock statuses**: `available` · `low_stock` · `out_of_stock`

**Sort options**: `newest` · `relevance` · `price_asc` · `price_desc` · `rating_desc` (falls back to relevance)

**Cart blocks**: `NOT_IN_CATALOG` · `VARIANT_NOT_FOUND` · `VARIANT_NOT_IN_CATALOG` · `PRICE_NOT_AVAILABLE_IN_CONTEXT` · `OUT_OF_STOCK`

**Rate limits (per IP)**: browse 60/min · validate 20/min

**Cache TTLs**: branches 300s · products list/detail 60s · cart validate no-store

---

## Evidence boundary

This is backend response guidance through F2.WU7. It deliberately excludes frontend activation, historical suite totals, merge status, and F3 public stock-presentation output. Report a contract discrepancy with its request and response to the backend maintainers.
