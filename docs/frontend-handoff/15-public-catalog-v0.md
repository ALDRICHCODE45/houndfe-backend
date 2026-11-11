# 15 · Public catalog v0: sort, brand search, exact low stock, branch card, bot number, share previews

Backend status: implemented on branch `feat/public-catalog-v0` (S1–S7), not merged and not deployed. Supports the FE branch `design/public-catalog-v0`.

Everything here is additive. A tenant that changes nothing gets the same responses as before, except two new fields: `whatsappNumber` on `GET /public/catalog/branches` and the new routes.

| #   | What                                                               | Route / field                                        |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| S1  | `sort` orders the whole catalog, not one page                      | `GET /public/catalog/:tenantSlug/products?sort=`     |
| S2  | `q` also matches the brand, with the Published-editorial switch on | same route, `q`                                      |
| S3  | Opt-in exact quantity for low stock                                | `stockPresentation.exactQuantity`, new settings mode |
| S4  | Branch card (address, hours, flags)                                | `GET /public/catalog/:tenantSlug/branch`             |
| S5  | One WhatsApp number for the bot                                    | `whatsappNumber` on `/branches` and `/branch`        |
| S6  | Link previews (WhatsApp, Facebook, X)                              | `GET /share/:tenantSlug/p/:productId`                |

## 1. S1 · `sort`

`GET /public/catalog/:tenantSlug/products?sort=<value>&page=&limit=&priceListId=`

| `sort`                                         | Order                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newest` (default), `relevance`, `rating_desc` | Newest first (`createdAt` desc). `relevance` and `rating_desc` are accepted for compatibility and behave exactly like `newest`; there is no rating or relevance score yet. Unchanged from before. |
| `price_asc`                                    | Cheapest first by the card's «desde» price.                                                                                                                                                       |
| `price_desc`                                   | Most expensive first by the same price.                                                                                                                                                           |

The «desde» price is the one the card shows in `price.fromPriceCents`, in the **selected price context** (`priceListId`, or the tenant default):

- a product with variants: the lowest positive price among its public (not OFF) variants in that list;
- any other product: the product price in that list.

Rules:

- The order covers **all** eligible products, then the page is cut from it. Page 2 continues exactly where page 1 ended, and `meta.total` is unchanged by the sort.
- Products whose price is hidden (`price.hidden: true`, including prescription products) go **last** in both directions.
- Ties break by the product's internal (operational) `name` ascending, then `id`. With the editorial switch on, cards show the Published title, so two products at the same price may not look alphabetical on screen.
- `q`, `categoryId` and `facet` filters apply before ordering and paging.
- A product that is not sold in the selected price list is not eligible (it is counted in `excludedCount`), exactly as before.

Example: `GET /public/catalog/centro/products?sort=price_asc&limit=2&page=1`

```json
{
  "items": [
    {
      "name": "Barata",
      "price": { "fromPriceCents": 1000, "priceCents": 1000, "hidden": false }
    },
    {
      "name": "Tallas",
      "price": { "fromPriceCents": 1500, "priceCents": 9500, "hidden": false }
    }
  ],
  "meta": { "page": 1, "limit": 2, "total": 7, "totalPages": 4 }
}
```

(Abbreviated: each item has the usual card fields. «Tallas» sorts by its cheapest variant, 1500, not by its product price, 9500.)

The legacy chatbot catalog search (`chatbot-api`) is not part of this change and keeps its previous behavior.

## 2. S2 · Brand search

With the tenant switch `catalogRequiresPublishedEditorial` **on**, `q` used to match only the Published title and description. It now also matches `brand.name` (case-insensitive contains, same as the other fields). Only products that are Published can match; an unpublished product never appears because of its brand.

With the switch off nothing changes: `q` already matched name, brand and variant fields. Operational names still never match with the switch on.

## 3. S3 · Exact low stock (opt-in)

New stock presentation mode: **`SYSTEM_STATUS_EXACT_LOW_STOCK`**. It behaves like `SYSTEM_STATUS`, and when the row's `status` is `low_stock` it also tells the real quantity.

**Admin (set it):** the existing catalog settings, same permissions as before.

`PATCH /tenants/:tenantId/catalog-settings`

```json
{ "stockPresentationDefault": { "mode": "SYSTEM_STATUS_EXACT_LOW_STOCK" } }
```

- `customQuantity` must be omitted or `null` for this mode (like every mode except `CUSTOM_QUANTITY`).
- `GET` returns `"stockPresentationDefault": { "mode": "SYSTEM_STATUS_EXACT_LOW_STOCK", "customQuantity": null }`.
- It is per tenant (per sucursal). A product or variant can also select it through its own `onlineStockPresentation`, and inherits it from the tenant when it has none.
- **Off by default.** The default stays `SYSTEM_STATUS`; no existing tenant, product or variant changes.

**Public (read it):** `stockPresentation` gains `exactQuantity`, present **only** when the effective mode is `SYSTEM_STATUS_EXACT_LOW_STOCK`. Under any other mode the field is absent and the object is byte-identical to before.

| Row                                                             | `status`                    | `exactQuantity`                       |
| --------------------------------------------------------------- | --------------------------- | ------------------------------------- |
| Simple product (card, detail)                                   | `low_stock`                 | the product's real quantity (integer) |
| Simple product                                                  | `available`, `out_of_stock` | `null`                                |
| Variant product, **product-level** row (card, detail top level) | any                         | always `null`                         |
| Variant row in detail `variants[].stockPresentation`            | `low_stock`                 | that variant's own quantity           |
| Variant row                                                     | `available`, `out_of_stock` | `null`                                |
| Stock not tracked (`useStock` false)                            | `available`                 | `null`                                |

For a variant product, show the exact quantity for the **selected variant** from `variants[].stockPresentation.exactQuantity`. The product-level value is `null` on purpose: a quantity summed across variants would not describe anything the customer can buy.

`low_stock` still means `quantity <= minQuantity`. `customQuantity` keeps its meaning (the configured number for `CUSTOM_QUANTITY`) and is `null` here.

Example (detail of a simple product, tenant opted in):

```json
{
  "availability": "low_stock",
  "stockPresentation": {
    "mode": "SYSTEM_STATUS_EXACT_LOW_STOCK",
    "status": "low_stock",
    "customQuantity": null,
    "exactQuantity": 2
  }
}
```

FE note: handle an unknown `mode` string gracefully; `mode` echoes the effective mode, which can now be the new value.

## 4. S4 · Branch card

`GET /public/catalog/:tenantSlug/branch`

- Same gate as every public route: an unknown, inactive or unpublished slug is `404`.
- `Cache-Control: public, max-age=300`. Public; no auth.
- Never returns the internal contact phone of the shipping origin or any tenant id.

Response `200`:

```json
{
  "name": "Sucursal Centro",
  "phone": "+525512345678",
  "address": {
    "addressLine1": "Av. Juárez 123",
    "addressLine2": null,
    "neighborhood": "Centro",
    "municipality": "Cuauhtémoc",
    "state": "CDMX",
    "postalCode": "06000",
    "formatted": "Av. Juárez 123, Centro, Cuauhtémoc, CDMX, C.P. 06000"
  },
  "hours": {
    "timeZone": "America/Mexico_City",
    "days": [
      {
        "day": "MONDAY",
        "label": "Lunes",
        "closed": false,
        "ranges": [{ "open": "09:00", "close": "18:00" }]
      },
      { "day": "SUNDAY", "label": "Domingo", "closed": true, "ranges": [] }
    ],
    "summary": "Lunes a sábado 09:00–18:00"
  },
  "pickupAvailable": true,
  "deliveryAvailable": true,
  "whatsappNumber": "+5215500000000"
}
```

(`days` always has the 7 weekdays, Monday first; two are shown. `summary` is Spanish text from the same formatter the bot uses.)

| Field               | Meaning                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | Sucursal name.                                                                                                                                                                                                                                                         |
| `phone`             | The public phone, the same value `GET /public/catalog/branches` lists. `null` if none.                                                                                                                                                                                 |
| `address`           | Pickup address, or `null`. It is the shipping origin when configured; otherwise the tenant's free-text address, in which case only `formatted` is filled and the other address fields are `null`. Note: this is an object, unlike `address` (a string) in `/branches`. |
| `hours`             | Weekly opening hours, or `null` until the store configures them.                                                                                                                                                                                                       |
| `pickupAvailable`   | `true` when `address` is not `null` (there is a place to collect an order). It does not depend on `hours`.                                                                                                                                                             |
| `deliveryAvailable` | `true` when the sucursal has at least one **active** delivery zone whose type is not `DENIED` (`FREE`, `SURCHARGE` or `CARRIER_ONLY`). It says the sucursal delivers somewhere, not that a given postal code is covered.                                               |
| `whatsappNumber`    | See S5.                                                                                                                                                                                                                                                                |

A sucursal with nothing configured answers `phone: null`, `address: null`, `hours: null`, `pickupAvailable: false`, `deliveryAvailable: false`, `whatsappNumber: null`.

## 5. S5 · Bot WhatsApp number

One global number for every sucursal, from the backend environment variable `PUBLIC_BOT_WHATSAPP` (E.164, for example `+5215500000000`).

- Exposed as `whatsappNumber` on **every** item of `GET /public/catalog/branches` and on `GET /public/catalog/:tenantSlug/branch`.
- `null` when the variable is unset or empty.
- Optional. A malformed value fails backend boot (`^\+[1-9]\d{7,14}$`), so the API never publishes a broken number.

`GET /public/catalog/branches` item, before and after:

```json
{
  "id": "…",
  "name": "Sucursal Centro",
  "slug": "centro",
  "address": "Av. Juárez 123",
  "phone": "+525512345678",
  "whatsappNumber": "+5215500000000"
}
```

The only change is the new last key.

## 6. S6 · Share previews

`GET /share/:tenantSlug/p/:productId[?priceListId=<uuid>]`

Not under `/public/catalog`, no `/api` prefix, no auth. Share this URL (not the storefront URL) when the customer taps «compartir»: crawlers read the tags, people are redirected to the storefront.

Environment:

- `PUBLIC_STORE_URL`: the storefront base URL (production value: `https://sistem.houndfe.com/catalogo`). `http(s)` only, no query or fragment; a trailing slash is ignored. Optional at boot and **required only for this route**. The page always redirects here.
- `PUBLIC_SHARE_BASE_URL` (new, optional): the public base URL of this API (for example `https://api.houndfe.com`), validated as an `http(s)` URL with no query or fragment; a trailing slash is ignored. When set, `og:url` is `${PUBLIC_SHARE_BASE_URL}/share/:tenantSlug/p/:productId` (plus `?priceListId=<uuid>` when valid), so scrapers that re-read `og:url` (Facebook) read this page again and keep the tags. **When unset, `og:url` falls back to the storefront URL**, as in the first version of this route. The redirect target never changes.

| Case                                                                                 | Response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Published product                                                                    | `200 text/html`. Tags: `og:title` (product name; Published title when the switch is on), `og:description` (description, whitespace collapsed, up to 200 characters; the sucursal name when there is none), `og:image` (main image; omitted when none), `og:url`, `og:type`, `og:site_name` (sucursal name), `twitter:card` (`summary_large_image`, or `summary` without image), `twitter:title`, `twitter:description`, `twitter:image`. Redirects with `<meta http-equiv="refresh" content="0;url=…">` and `location.replace(…)` to `${PUBLIC_STORE_URL}/${tenantSlug}/p/${productId}`. `Cache-Control: public, max-age=300`. |
| `?priceListId=<uuid>` valid and published by the tenant                              | The same id is appended to the redirect (`…/p/<id>?priceListId=<uuid>`) and to `og:url`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `?priceListId=<uuid>` valid but **stale** (the tenant no longer publishes that list) | `200 text/html` for the **product**: the og tags are rendered from the tenant's default price context and the redirect goes to the product **without** `priceListId` (`…/p/<id>`). The stale id is never echoed anywhere in the page. Same `Cache-Control: public, max-age=300`. If the product is not available in the default context either, it is a miss (next row).                                                                                                                                                                                                                                                       |
| `?priceListId` not a UUID                                                            | Ignored and **never echoed**; the redirect and `og:url` have no `priceListId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Unknown or unpublished tenant, unknown or unpublished product, malformed `productId` | `404 text/html` page with **no** og tags that redirects (refresh + script) to `${PUBLIC_STORE_URL}` (the storefront home). `Cache-Control: public, max-age=60`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PUBLIC_STORE_URL` unset                                                             | `503 text/plain` («Share previews are not configured»), `Cache-Control: no-store`, no redirect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Notes:

- No price appears anywhere in the page (not even for products with visible prices).
- Every value is HTML-escaped, and the URL is escaped for the attribute and for the script. A product named `"><script>…` is rendered as text.
- `og:description` is cut to 200 **characters counted by Unicode code points**, ending with `…`; an emoji is never split. It uses the sucursal name when the product has no description.
- `og:image` / `twitter:image` are emitted only when the product image URL is an absolute `http(s)` URL; any other value (`javascript:`, `data:`, relative, malformed) is dropped and the card falls back to `twitter:card: summary`.
- `og:url` follows `PUBLIC_SHARE_BASE_URL` as described above; it is the `/share` URL when configured, the storefront URL otherwise.
- The route shares the public throttler (`public-browse`).

Example `GET /share/centro/p/0b2f…?priceListId=6c1d…` with `PUBLIC_SHARE_BASE_URL=https://api.houndfe.com` (head, abbreviated; without that variable `og:url` equals the redirect URL below):

```html
<meta property="og:title" content="Croquetas Indoor para gato 1.5 kg" />
<meta
  property="og:description"
  content="Croquetas horneadas para interiores."
/>
<meta property="og:image" content="https://cdn.example.com/croquetas.jpg" />
<meta
  property="og:url"
  content="https://api.houndfe.com/share/centro/p/0b2f…?priceListId=6c1d…"
/>
<meta name="twitter:card" content="summary_large_image" />
<meta
  http-equiv="refresh"
  content="0;url=https://sistem.houndfe.com/catalogo/centro/p/0b2f…?priceListId=6c1d…"
/>
```

## 7. Configuration and migration

| Item                                         | Value                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BOT_WHATSAPP`                        | optional, E.164                                                                                                                                                             |
| `PUBLIC_SHARE_BASE_URL`                      | optional, public base URL of this API, used for `og:url` of `/share`; unset keeps `og:url` on the storefront URL                                                            |
| `PUBLIC_STORE_URL`                           | optional at boot, needed for `/share`; `https://sistem.houndfe.com/catalogo`                                                                                                |
| Migration `20261111100000_public_catalog_v0` | additive: `ALTER TYPE "CatalogStockPresentation" ADD VALUE 'SYSTEM_STATUS_EXACT_LOW_STOCK'`, with `SET LOCAL lock_timeout = '5s'`. No columns, no defaults, no data change. |

Tests: `src/public-catalog/http/public-catalog.v0.http.integration.spec.ts` exercises S1, S3, S4, S5 and S6 over HTTP against PostgreSQL; S2 is in `prisma-public-catalog-facets.integration.spec.ts`.
