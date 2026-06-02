# Public Online Catalog — Frontend Implementation Guide

**Backend status**: implemented, tested, merged to `main`.
**Test suite**: 1069/1069 passing.
**Target audience**: HoundFe frontend team.

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
- Admin endpoints to toggle `hidePriceInOnlineCatalog`.
- Category slugs (filter uses UUIDs).

**UX flow:**

```
pick branch  →  browse products  →  product detail  →  build cart  →  validate cart  →  (future: WhatsApp)
```

---

## 2. What changed vs your original wishlist

Backend reviewed your contract document and made 8 decisions with technical criterion. Below is what changed and what you need to adjust in the UI.

| # | Decision | What you need to do |
|---|---|---|
| 1 | **Tenant in URL path**: every endpoint is `/public/catalog/:tenantSlug/...`. We rejected the `branchId`-only approach because it leaked cross-tenant data. | Build URLs using the slug returned by `/branches`. Persist the selected slug in route state. |
| 2 | **`kind` field DROPPED**. Categories already classify products. Adding a parallel taxonomy creates semantic drift. | Map icons/placeholders by `category.id` (or category name) client-side. Maintain a small icon map in your design system. |
| 3 | **`rating` and `featuredLabel` always `null` in v1**. No reviews system, no analytics. Fields exist in the contract reserved for v2. | Render conditionally. If `null`, skip the badge/star row entirely. |
| 4 | **Cart validation endpoint IN scope** (minimal). `POST /:slug/cart/validate` revalidates prices and stock, returns warnings and totals. NO order creation. NO `whatsappUrl`. NO persistence. | Call it before showing the WhatsApp/checkout button so the user sees up-to-date prices and warnings. |
| 5 | **`hidePriceInOnlineCatalog` flag on Product**. Effective rule: `priceHidden = hidePriceInOnlineCatalog OR requiresPrescription`. | When `price.hidden === true`, show "Consultar precio" or equivalent. Numeric price fields will be `null`. |
| 6 | **⚠️ CRITICAL: 1 sucursal = 1 tenant in v1.** The current HoundFe data model has NO separate `Branch` entity. Each tenant IS a branch. `GET /branches` returns exactly 1 entry (the current tenant). `availabilityByBranch[]` always has 1 entry. | The original UX idea of "3 sucursales lado a lado, marcar la seleccionada como TÚ" is **NOT implementable in v1**. Use a top-level branch selector: each "branch" the user picks switches `:tenantSlug` in the URL and reloads the catalog context. The contract keeps `availabilityByBranch[]` as an array so future multi-branch support requires zero contract changes. |
| 7 | **`sort: 'price_asc'` uses product-level default price**, not min-of-variants. MVP limitation. | Show `fromPriceCents` on each card. The sort is "good enough" for HoundFe's current scale (<10K products/tenant). If you see weird ordering on products with widely-priced variants, that's why. |
| 8 | **Category filter uses `categoryId` (UUID)**, not slug. | Use `facets.categories[].id` for the active category filter. URL can look like `?categoryId=<uuid>` or you can map UUIDs to nicer paths client-side. |

---

## 3. Authentication and base URL

- **All endpoints are PUBLIC**. No JWT, no Authorization header.
- **Base URL pattern**: `${API_BASE}/public/catalog/:tenantSlug/...`
- **Branch discovery**: `GET /public/catalog/branches` (no tenant slug — global discovery). Use this to populate the branch selector.
- **Rate limiting**: per-IP, two tiers.
  - `public-browse`: 60 req/min — all GET endpoints.
  - `public-validate`: 20 req/min — cart validate.
  - On 429: show "Demasiadas solicitudes, esperá un momento" and back off.
- **HTTP cache**: GET endpoints return `Cache-Control` headers. Browser cache handles them automatically. Cart validate is `no-store` — always fresh.

---

## 4. Endpoints

### 4.1 `GET /public/catalog/branches`

Lists all active branches (tenants). No tenant context required.

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

- Empty array if no branch is active (rare; show "No hay sucursales disponibles").

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
  branchId?: string;       // UUID. Ignored in v1 (tenant=branch). Reserved.
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

type PublicProductListResponse = {
  items: PublicCatalogProductCard[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  facets: {
    categories: PublicCatalogCategoryFacet[];
  };
};
```

**Headers**

- `Cache-Control: public, max-age=60`

**Errors**

- `400` — invalid query (bad UUID, sort outside enum, limit > 100, etc.).
- `404` — tenant slug not found or inactive (generic message; no enumeration).
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
  }
}
```

**Edge cases**

- `items: []` with valid `meta` if page is beyond `totalPages` (don't error — show "Sin resultados").
- Hidden-price products still appear; just show "Consultar precio".
- Out-of-stock products still appear; disable add-to-cart.
- Facets only include categories WITH visible products in the current scope (no zero-count entries).

---

### 4.3 `GET /public/catalog/:tenantSlug/products/:productId`

Product detail with variants and per-branch availability.

**Request**

```http
GET /public/catalog/:tenantSlug/products/:productId?branchId=
```

**Path params**

| Param | Type | Required |
|---|---|---|
| `tenantSlug` | string | yes |
| `productId` | string (UUID) | yes |

**Query params** (optional)

| Param | Type | Notes |
|---|---|---|
| `branchId` | string (UUID) | Ignored in v1. Reserved for multi-branch. |

**Response 200**

```ts
type PublicVariantAvailability = {
  branchId: string;      // tenantId (tenant=branch in v1)
  branchName: string;
  branchSlug: string;
  availability: 'available' | 'low_stock' | 'out_of_stock';
  isSelected: boolean;   // always true in v1 (single entry)
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
  availabilityByBranch: PublicVariantAvailability[];   // exactly 1 entry in v1
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
};
```

**Headers**

- `Cache-Control: public, max-age=60`

**Errors**

- `404` — tenant or product not found; product not in this tenant; `includeInOnlineCatalog = false`.
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
  "featuredLabel": null
}
```

**Edge cases**

- `hasVariants = false` → `variants` may be an empty array. Use the top-level `price` and `availability`.
- `images` is sorted: main first, then by sort order.
- Variant images fall back to the product main image if `variant.image === null`.

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
  items: Array<{
    productId: string;    // UUID
    variantId?: string;   // UUID, optional
    quantity: number;     // integer, min 1
  }>;
  customer?: {
    globalPriceListId?: string;  // UUID, for customer-specific pricing (v2)
  };
};
```

**Validation rules** (returns `400` on failure)

- `items` is required, non-empty array.
- Each `productId` and `variantId` (if present) must be valid UUIDs.
- `quantity` must be an integer `>= 1`.

**Response 200**

```ts
type CartWarningCode =
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'LOW_STOCK'
  | 'PRICE_HIDDEN'
  | 'NOT_FOUND'
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND';

type CartValidatedItem = {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  image: { url: string } | null;
  quantity: number;
  unitPriceCents: number | null;    // null if price hidden
  lineTotalCents: number | null;    // null if price hidden
  availability: 'available' | 'low_stock' | 'out_of_stock';
  priceHidden: boolean;
  warnings: CartWarningCode[];
};

type CartValidationResponseDto = {
  valid: boolean;                    // false if any item has blocking warnings
  items: CartValidatedItem[];
  totalCents: number | null;         // sum of lineTotalCents excluding OOS + hidden-price items
                                     // null if any item has hidden price
  warnings: CartWarningCode[];       // deduplicated global warnings
};
```

**`totalCents` semantics (important)**

- Excludes items where `availability === 'out_of_stock'`.
- Excludes items where `unitPriceCents === null` (hidden price).
- Includes `low_stock` items (still fulfillable).
- Includes `available` items.
- If ANY item has `priceHidden === true`, the global `totalCents` is `null` (you can't show a meaningful total).

**`valid` semantics**

- `false` if any item has blocking warnings: `NOT_FOUND`, `NOT_IN_CATALOG`, `VARIANT_NOT_FOUND`, or `OUT_OF_STOCK`.
- `true` otherwise (even with `PRICE_CHANGED`, `LOW_STOCK`, or `PRICE_HIDDEN` warnings).

**Headers**

- `Cache-Control: no-store`

**Errors**

- `400` — validation errors (bad UUID, empty items, invalid quantity).
- `404` — tenant not found.
- `429` — rate limited (stricter: 20 req/min).

**Note on warnings enum**

The backend implementation returns a slightly richer enum than the original spec (`NOT_FOUND`, `NOT_IN_CATALOG`, `VARIANT_NOT_FOUND` instead of a single `PRODUCT_UNAVAILABLE`). This is intentional — more granular signals for the UI. If you need to map them to a single user-facing message, treat all three as "Producto ya no disponible".

**Example**

```bash
curl -X POST "https://api.houndfe.com/public/catalog/centro/cart/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "productId": "prod-uuid-1", "variantId": "var-1", "quantity": 2 },
      { "productId": "prod-uuid-2", "quantity": 1 }
    ]
  }'
```

```json
{
  "valid": true,
  "items": [
    {
      "productId": "prod-uuid-1",
      "variantId": "var-1",
      "productName": "Royal Canin Adult Medium",
      "variantName": "13.6 kg",
      "image": { "url": "https://cdn.example.com/img1.jpg" },
      "quantity": 2,
      "unitPriceCents": 125000,
      "lineTotalCents": 250000,
      "availability": "available",
      "priceHidden": false,
      "warnings": []
    },
    {
      "productId": "prod-uuid-2",
      "variantId": null,
      "productName": "Pelota de Goma",
      "variantName": null,
      "image": null,
      "quantity": 1,
      "unitPriceCents": 8500,
      "lineTotalCents": 8500,
      "availability": "low_stock",
      "priceHidden": false,
      "warnings": ["LOW_STOCK"]
    }
  ],
  "totalCents": 258500,
  "warnings": ["LOW_STOCK"]
}
```

---

## 5. Stock semantics — never trust quantities

The backend NEVER returns raw `quantity` or `minQuantity`. Do not ask for them; do not assume they exist. You get only semantic status:

| Status | Label | UI guidance |
|---|---|---|
| `available` | Disponible | Normal state. Add to cart enabled. |
| `low_stock` | Pocas piezas | Subtle warning badge. Add to cart enabled. |
| `out_of_stock` | Agotado | Disable add-to-cart. Show "Agotado" badge. |

For products with `useStock = false` (services, etc.), the backend always returns `available`. You don't need to handle this differently.

---

## 6. Price hidden behavior

When `price.hidden === true`:

- `priceCents` is `null`.
- `fromPriceCents` is `null` (in list view).
- In cart validate: `unitPriceCents` and `lineTotalCents` are `null`, item gets `PRICE_HIDDEN` warning, contributes 0 to `totalCents`.

**UI guidance**: show "Consultar precio" instead of a number. The user can still add it to the cart and ask the price via WhatsApp.

**When does this happen?**

- Product has `requiresPrescription = true` (auto-hidden — medicines).
- An admin explicitly set `hidePriceInOnlineCatalog = true` (admin UI doesn't exist yet).

---

## 7. Cart validation flow (recommended client integration)

When the user opens the cart drawer or the "checkout" screen:

1. Call `POST /:slug/cart/validate` with the local cart contents.
2. Use the response to:
   - Update displayed prices (if `PRICE_CHANGED`, server price wins).
   - Show warnings per item.
   - Disable the "Enviar por WhatsApp" button if `valid === false`.
   - Show `totalCents` if not `null`; otherwise show "Total a consultar" because at least one item has hidden price.

**Warning handling cheat sheet**

| Warning | Item meaning | UI |
|---|---|---|
| `PRICE_CHANGED` | Price differs from what you had locally | Soft yellow alert. Update price. Let user decide. |
| `LOW_STOCK` | Quantity is low but still available | Small "Pocas piezas" badge. Allow purchase. |
| `OUT_OF_STOCK` | Cannot fulfill | Red. Block from WhatsApp send. Suggest remove. |
| `PRICE_HIDDEN` | Price not public | Show "Consultar precio". Don't include in numeric total. |
| `NOT_FOUND` | Product no longer exists | Remove item with notice. |
| `NOT_IN_CATALOG` | Product removed from online catalog | Same as NOT_FOUND. |
| `VARIANT_NOT_FOUND` | Variant no longer exists | Suggest re-select variant. |

**Future WhatsApp flow (next SDD)**: a follow-up endpoint will accept the same cart shape and return a `whatsappUrl` ready to open. For v1, build the WhatsApp text locally using the validated cart response:

```ts
const text = `Hola, quiero hacer este pedido para ${branchName}:\n\n` +
  items.filter(i => i.availability !== 'out_of_stock')
       .map(i => `${i.quantity}x ${i.productName}${i.variantName ? ` — ${i.variantName}` : ''}` +
                  (i.unitPriceCents !== null ? ` — $${(i.lineTotalCents! / 100).toFixed(2)}` : ' — consultar precio'))
       .join('\n') +
  (totalCents !== null ? `\n\nTotal estimado: $${(totalCents / 100).toFixed(2)}` : '');

const url = `https://wa.me/${OFFICIAL_PHONE}?text=${encodeURIComponent(text)}`;
```

---

## 8. Errors

All errors follow standard NestJS shapes.

| Status | When | UI message suggestion |
|---|---|---|
| `400` | Validation failure (bad UUID, empty items, quantity < 1, sort outside enum, limit > 100). | Show inline field errors if you can. |
| `404` | Tenant/product/branch not found, inactive entity. Generic — never enumerates. | "Producto no disponible" / "Sucursal no encontrada". |
| `429` | Rate limited. | "Demasiadas solicitudes, esperá un momento". Implement client-side backoff. |
| `5xx` | Backend error. | "Hubo un problema. Intentá de nuevo en unos segundos". |

---

## 9. Pagination and sorting

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

## 10. Recommended TypeScript types

Copy this file into your frontend project:

```ts
// public-catalog.types.ts
// Generated from backend SDD public-online-catalog (v1).

export type PublicStockStatus = 'available' | 'low_stock' | 'out_of_stock';

export type PublicSortOption =
  | 'relevance'
  | 'price_asc'
  | 'price_desc'
  | 'newest'
  | 'rating_desc';

export type CartWarningCode =
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'LOW_STOCK'
  | 'PRICE_HIDDEN'
  | 'NOT_FOUND'
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND';

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
  branchId?: string;
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
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  facets: {
    categories: PublicCatalogCategoryFacet[];
  };
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
};

/** POST /public/catalog/:tenantSlug/cart/validate — request */
export type ValidateCartItem = {
  productId: string;
  variantId?: string;
  quantity: number;
};

export type ValidateCartCustomer = {
  globalPriceListId?: string;
};

export type ValidateCartBody = {
  items: ValidateCartItem[];
  customer?: ValidateCartCustomer;
};

/** POST /public/catalog/:tenantSlug/cart/validate — response */
export type CartValidatedItem = {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  image: { url: string } | null;
  quantity: number;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  availability: PublicStockStatus;
  priceHidden: boolean;
  warnings: CartWarningCode[];
};

export type CartValidationResponse = {
  valid: boolean;
  items: CartValidatedItem[];
  totalCents: number | null;
  warnings: CartWarningCode[];
};
```

---

## 11. Open follow-ups (next SDDs)

These are NOT available yet. Plan UI accordingly with feature flags or empty states.

- **WhatsApp order endpoint** — `POST /public/catalog/:slug/orders/whatsapp` will accept the validated cart and return a `whatsappUrl`. For v1, build the URL client-side.
- **Real `rating`** — requires reviews infrastructure. v1 returns `null`.
- **Real `featuredLabel`** — requires sales analytics ("Más vendido", "Premium", etc.). v1 returns `null`.
- **Multi-branch per tenant** — if HoundFe ever introduces real multi-branch chains, `availabilityByBranch[]` will start returning multiple entries. The contract is ready.
- **Admin endpoints** — to toggle `hidePriceInOnlineCatalog` from an admin UI. v1 only the data layer supports it.
- **Category slugs** — pretty URLs by category. v1 uses UUIDs.

---

## 12. Quick reference card

**Base URL**: `${API_BASE}/public/catalog/:tenantSlug/...`

| Endpoint | Purpose |
|---|---|
| `GET /public/catalog/branches` | List active branches (tenants). |
| `GET /:slug/products` | Paginated product list with filters and facets. |
| `GET /:slug/products/:id` | Product detail with variants. |
| `POST /:slug/cart/validate` | Revalidate cart prices and stock. |

**Stock statuses**: `available` · `low_stock` · `out_of_stock`

**Sort options**: `newest` · `relevance` · `price_asc` · `price_desc` · `rating_desc` (falls back to relevance)

**Cart warning codes**: `PRICE_CHANGED` · `OUT_OF_STOCK` · `LOW_STOCK` · `PRICE_HIDDEN` · `NOT_FOUND` · `NOT_IN_CATALOG` · `VARIANT_NOT_FOUND`

**Rate limits (per IP)**: browse 60/min · validate 20/min

**Cache TTLs**: branches 300s · products list/detail 60s · cart validate no-store

---

## Backend references

- SDD proposal: engram observation `#2238`
- SDD spec: engram observation `#2239` (31 requirements, 37 scenarios)
- SDD design: engram observation `#2240`
- SDD apply-progress: engram observation `#2242` (13 commits)
- SDD verify report: engram observation `#2243` (verdict PASS)

**Commits on `main`** (oldest first):

```
a33d9eb chore(public-catalog): scaffold module and throttler wiring
19a88e5 chore(prisma): add hidePriceInOnlineCatalog field and catalog indexes
735f6de feat(public-catalog): add tenant guard with CLS context
3dd0190 feat(public-catalog): add stock and price-hidden mappers
9825310 feat(public-catalog): expose public branches endpoint
c497ffc feat(public-catalog): implement products listing and facets
af8a4c2 feat(public-catalog): implement product detail endpoint
c43cb79 feat(public-catalog): implement cart validation endpoint
aa08504 test(public-catalog): harden isolation snapshots and http policies
9e711c5 fix(public-catalog): scope throttler to public-catalog controller
f8e36aa fix(public-catalog): accept rating_desc sort with relevance fallback
216d890 fix(public-catalog): exclude out-of-stock and hidden-price items from cart total
0f7a19b fix(public-catalog): sort price_asc by product priceCents instead of price-list count
```

If you find a contract discrepancy, ping backend with the request/response and we sync.
