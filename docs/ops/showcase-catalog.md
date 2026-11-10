# Showcase catalog loader

`scripts/ops/load-showcase-catalog.cjs` loads a realistic demo catalog into one tenant so the public online catalog shows its complete version: real names and long descriptions, several images per product uploaded to Spaces, simple and variant products, public and Mayoreo prices, stock that is available, low or out, and a Published editorial V2 document for every product (attributes and facets).

Everything goes through the backend's own application services, the same code paths the HTTP routes use. The only exception is the editorial cleanup in `--delete`, which uses Prisma `deleteMany` directly because no service removes editorial state (see [Delete](#delete)). Products are created with `minQuantity` 5, so 1-5 units show as low stock in the public catalog. `--catalog-switch off` turns `catalogRequiresPublishedEditorial` back off but leaves `catalogPublished` as it is.

## What a run does

Dry run (default): reads only. It validates every product, makes HEAD requests for the images, prints the plan and never boots Nest.

`--apply`:

1. `--grant` (optional): adds the grants listed in [Flags](#flags) to the global `Super Admin` role.
2. Price contexts: creates the global `Mayoreo` list if it is missing (`PriceListsService.create`). Then it makes `Mayoreo` a public catalog price context of the tenant (`UpdateCatalogSettingsUseCase`, the `PATCH /tenants/:id/catalog-settings` code path). If the tenant has no catalog default yet, the default becomes the global default list.
3. Categories and brands named by the data that do not exist yet (`CategoriesService.create`, `BrandsService.create`).
4. Per product:
   - `ProductsService.create`: variants, `INITIAL` stock in the inventory journal, the public price and the Mayoreo price.
   - `ProductsService.bulkUpsertVariantPrices`: each variant's own public and Mayoreo price.
   - `ProductPackagingService.putProduct`: packaging.
   - Images: each one is downloaded, then sent to `ProductsService.uploadProductImage` (Spaces, the `POST /products/:id/images/upload` path). The first image becomes the main one.
   - Editorial: the in-container writers do initialize → save → readiness → publish, the way the editorial HTTP routes call them. A care product is published with `review-v1`.
5. Tenant switch: `catalogPublished=true` and `catalogRequiresPublishedEditorial=true` (`--catalog-switch on`, the default).
6. It prints how many online products the switch hides (online products minus products with a Published editorial V2). It writes a JSON manifest (product and variant ids, image credits and storage URLs, editorial status) to `/tmp/showcase-catalog-<slug>-<time>.json` or to `--manifest <path>`.

The run exits `2` if any product failed or did not reach Published, `1` on a fatal error, and `0` otherwise.

## Data

`scripts/ops/showcase-catalog/products/index.cjs` concatenates `food-treat-care.cjs` and `toy-hygiene-accessory-habitat.cjs` (the content files). The contract is in `engine/core.cjs` and in `odd/tasks/prod-showcase-catalog.md` L5. Rules the engine enforces before any write:

- Every product and variant SKU matches `^SC-[A-Z0-9][A-Z0-9_-]*$` and is unique. `SC-` is the only marker of a showcase product, and it is invisible in the public catalog.
- Prices and Mayoreo prices are in pesos and must be > 0. Stock is an integer >= 0, and `0` means out of stock. Names and category and brand names must fit the DTO limits. Packaging dimensions must be > 0. Image URLs must be https.
- Editorial values must use a code bound to the family in the tenant's current vocabulary, read from the DB, with existing, non-archived options and allowed units.
- Simple products use `variantKey: null`. Products with variants repeat every value and every fact once per variant (`variantKey` set). The engine maps `variantKey` to the created variant id.
- The engine fills `owner` (from the family binding), the evidence of values and declarations (`{ sourceRef: "Ficha del fabricante", verifiedOn: <today, UTC> }`) and `mediaRefs: []`. Care reviews pass through exactly as authored.

`--fixture` uses `engine/fixture.cjs` instead: 3 products (a simple food, a collar with 2 variants, one of them out of stock, and a care shampoo).

## Flags

| Flag | Effect |
| --- | --- |
| `--tenant <slug>` | Required. Active tenant. |
| `--actor-email <email>` | Required. Active member of the tenant. Needs create/update (delete for `--delete`) on `Product`. Needs create on `Category`, `Brand` and `GlobalPriceList` when something is missing. Needs update on `TenantCatalogSettings`. Needs editorial read, update and publish (or global editorial administrator). |
| `--apply` | Write. Without it nothing is written. |
| `--grant` | Adds `ProductEditorialDraft` read/update/publish and `TenantCatalogSettings:update` to the global `Super Admin` role. Additive upserts, like the permission seeder: other rows are never touched. There is no `ProductEditorialDraft:create` action: `update` is «Create and save product editorial drafts». |
| `--delete` | Removes every `SC-` product of the tenant instead of loading. |
| `--fixture` | Load the engine fixture instead of `products/`. |
| `--only <key,...>` | Only these product keys. Useful to retry a few products. |
| `--manifest <path>` | Where to write the manifest. |
| `--image-mode upload\|url` | `upload` (default) sends the images to Spaces. `url` stores the source URL as the image (`POST /products/:id/images`). |
| `--skip-image-check` | Dry run without the image HEAD requests. |
| `--catalog-switch on\|off\|keep` | `on` (default when loading) sets both flags to true. `off` sets `catalogRequiresPublishedEditorial=false`. `keep` (default with `--delete`) leaves both flags alone. |

Idempotent: a product whose SKU already exists is skipped (no prices, images or packaging). Its editorial is completed only if it was never published.

## Run in the production container

The scripts are not in the image. Copy the `scripts` directory in and run it from `/app`, the app root that holds `dist/`:

```sh
# on the VPS
docker cp scripts houndfe-system-backend:/app/
docker exec -it houndfe-system-backend sh -c 'cd /app && \
  node scripts/ops/load-showcase-catalog.cjs --tenant <slug> --actor-email <email> --grant'   # dry run
docker exec -it houndfe-system-backend sh -c 'cd /app && \
  node scripts/ops/load-showcase-catalog.cjs --tenant <slug> --actor-email <email> --grant --apply \
    --manifest /tmp/showcase-manifest.json'
docker cp houndfe-system-backend:/tmp/showcase-manifest.json ./showcase-manifest.json
```

- The container env provides `DATABASE_URL`, the JWT keys and `SPACES_*`. The script prints `host:port/db`, never credentials.
- `--apply` boots the full `AppModule`. That runs the permission seeder (idempotent, same as an API start), and the script then stops the outbox pollers so they don't compete with the running API.
- Image hosts rate-limit bursts. Requests are spaced 500 ms apart and retried on 429/503. Wikimedia also requires a User-Agent with a contact URL; override it with `SHOWCASE_IMAGE_USER_AGENT` if needed.
- Read the printed readiness items of any product that did not publish, fix its content and rerun with `--only <key>`. The product is skipped and only its editorial is retried.

## Delete

```sh
node scripts/ops/load-showcase-catalog.cjs --tenant <slug> --actor-email <email> --delete            # dry run
node scripts/ops/load-showcase-catalog.cjs --tenant <slug> --actor-email <email> --delete --apply \
  [--catalog-switch off]
```

For each `SC-` product of the tenant:

- A product with sale, quotation or order lines is kept and reported.
- Otherwise every image is removed with `ProductsService.removeImage`, which also deletes its FileObject and the Spaces object.
- Then the product's editorial receipts and editorial state are deleted.
- Then the product is removed with `ProductsService.remove`. Its stock leaves through `REMOVAL` journal movements.

The editorial delete is direct Prisma, scoped to that product. No application service removes editorial state, and `catalog_editorial_states` restricts the product delete (`ON DELETE RESTRICT`). So `DELETE /products/:id` fails today for any product that has editorial content.

Add `--catalog-switch off` if the tenant should show its operational catalog again. Otherwise, with the switch on and the showcase gone, the public catalog shows only the products that still have a Published editorial.

Categories, brands, the `Mayoreo` list and its price context, and the `--grant` rows stay. They are shared configuration.

## Known limits

- The Published editorial has no media: publish requires `mediaRefs` to be empty. The public images come from the operational product images, not from the editorial document.
- Number and range facets (weight, sizes, capacities) appear in the detail `attributes` with `facet: true`, but are not filterable yet. Only single and multi choice facets are list filters.
- Variant images are not loaded. Product images apply to every variant.
- The public cache is `max-age=60`, so allow up to a minute after a run or a switch flip.
- Cart lines show the operational product and variant names, not the Published title (doc 07 §10).
