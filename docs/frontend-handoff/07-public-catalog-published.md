# 07 · Public catalog from Published editorial, and «Despublicar»

Backend status: implemented on branch `feat/public-catalog-published` (P4: S1–S8), not merged yet. Runtime-proven on the dev DB for Sucursal Centro on 2026-11-05 (section 11).

The backend decides what is public. The FE never filters by editorial state, never recomputes coverage and never merges editorial data into the operational product. It shows what the public endpoints return.

What is new:

- A per-tenant switch, `catalogRequiresPublishedEditorial`, default **off**.
- With the switch on, the public catalog shows only products with a Published editorial. Name and description come from the Published version. Detail gains `attributes`. The list gains `facet` filters and `facets.attributes`. Search reads only Published text.
- `POST /products/:productId/editorial/published/unpublish` («Despublicar»).
- Accessory per-type defaults (D8) are already described in [05 §6](05-editorial-publish-readiness.md#6-business-rules-to-know). No route, payload or problem code changed for them.

With the switch off, every public response is byte-identical to today (section 8).

## 1. The switch (admin)

The existing tenant catalog settings endpoint, with one more field.

| | `GET /tenants/:tenantId/catalog-settings` | `PATCH /tenants/:tenantId/catalog-settings` |
| --- | --- | --- |
| Permission | `TenantCatalogSettings:read` | `TenantCatalogSettings:update` |
| Who has it | Nobody by default. An admin grants it per role. Global `manage:all` (super admin) also passes. The dev showcase grants both to the Centro `Manager` role. | Same |
| Tenant | `:tenantId` must be the JWT tenant. Otherwise `404` (not an oracle), unless `manage:all`. | Same |
| Body | — | Any subset of the settings fields. To flip the switch, send only `{ "catalogRequiresPublishedEditorial": true }` (or `false`). |
| Response headers | — | `Cache-Control: no-store` |

`catalogRequiresPublishedEditorial` is a boolean. It is never `null`, and existing tenants have `false`. The PATCH rejects `null` and non-booleans with `400` from the validation pipe.

Response `200` (both routes; real output, dev DB):

```json
{
  "tenantId": "ced6cc10-a037-4f41-92af-ee69bbb51c8b",
  "catalogPublished": true,
  "catalogRequiresPublishedEditorial": false,
  "effectivePublication": true,
  "priceContexts": [
    { "priceListId": "afc925de-abbd-4460-abaa-fcac228413ef", "name": "Mayoreo", "isCatalogDefault": false },
    { "priceListId": "dae52cee-79b8-44e8-b5b2-8d2502f8f7e3", "name": "PUBLICO", "isCatalogDefault": true }
  ],
  "stockPresentationDefault": { "mode": "SYSTEM_STATUS", "customQuantity": null },
  "warnings": [],
  "updatedAt": "2026-11-05T22:45:05.967Z"
}
```

`400` for `{ "catalogRequiresPublishedEditorial": null }` (real output):

```json
{
  "message": [
    {
      "property": "catalogRequiresPublishedEditorial",
      "children": [],
      "constraints": { "isBoolean": "catalogRequiresPublishedEditorial must be a boolean value" }
    }
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

The switch takes effect on the next public request. List and detail responses are still `Cache-Control: public, max-age=60` (unchanged), so a browser or CDN can show the old state for up to 60 seconds after a switch flip or an unpublish.

UI suggestion: a toggle in catalog settings, «Mostrar solo productos con ficha publicada». Show the section 9 checklist before turning it on.

## 2. Public list and detail with the switch on

Same routes and query params as today: `GET /public/catalog/:tenantSlug/products` and `GET /public/catalog/:tenantSlug/products/:productId`. Only the behavior below changes.

**Who is public.** A product needs a current Published editorial version that reads as document shape V2, on top of every existing gate: `includeInOnlineCatalog`, type `PRODUCT`, price list allowlist, positive price, hidden-price/prescription rules and OFF variants.

- Products without one are not listed.
- Their detail is the same generic `404` as an unknown id: `{"message":"Not Found","error":"Not Found","statusCode":404}`.
- `meta.total`, `totalPages`, `excludedCount` and `facets.categories` count the same unique products, before pagination.
- `excludedCount` keeps its meaning: price-context exclusions among published products. Unpublished products are not counted in it.

**Text.** The Published `commercialTitle` replaces `name`, and the Published `description` replaces `description`, in cards and in detail. A `null` Published description is returned as `null`: the operational description is never shown while the switch is on. Brand, images, prices, stock and category stay operational.

**Variants (D5).** A variant that became offered after the last publish is hidden until the product is republished. It behaves exactly like an OFF variant:

- it is not in `variants`;
- it does not change `fromPriceCents`;
- it does not keep the product alive;
- the cart rejects it.

If no covered variant remains, the product disappears (`404`). A simple product needs its presentation covered. Republishing covers the variants the draft includes.

**Cards never carry attributes.** The card keys are unchanged.

### Detail `attributes`

Two additive keys, present only with the switch on:

- `attributes` on the detail body: values that belong to the product itself, or to the presentation of a simple product.
- `attributes` on each detail variant: that variant's own values. For variant products the product-level list is usually `[]` and the attributes ride on the variants.

```ts
interface PublicProductAttribute {
  code: string;            // vocabulary definition code, e.g. "animal.target" (stable key)
  label: string;           // es-MX definition label, e.g. "Especie"
  facet: boolean;          // true = also a list filter (FACET); false = detail only (DETAIL)
  section: { code: string; label: string } | null; // form section, for grouping
  value:
    | { type: 'text'; text: string }
    | { type: 'boolean'; value: boolean }
    | { type: 'single'; option: { code: string; label: string } }
    | { type: 'multi'; options: { code: string; label: string }[] }
    | { type: 'number'; value: number; unit: { code: string; label: string } | null }
    | { type: 'range'; min: number; max: number; unit: { code: string; label: string } };
  display: string;         // ready-to-show es-MX text: "Perro, Gato", "1.5 kg", "30–45 cm", "Sí"
}
```

Rules:

- Show `display`. Use `value` only if you need structure, for example chips per option. Numbers are raw: no locale formatting, rounding or unit conversion.
- Order is meaningful: the family's form sections, then position. Keep it.
- Only known values appear. Unknown and «No aplica» are omitted.
- Internal data never appears: INTERNAL definitions (for example `text.clinical_analysis`), evidence, declarations/facts, care review, media refs, family code, revisions and coverage.
- `value.type` is a closed set today, but render an unknown `type` with `display` instead of failing.

Real output, «Croqueta Royal Canin Indoor para gato 1.5 kg» (`123d1b11-44a7-4f26-a3c5-168e1e1b22fe`), dev DB, switch on:

```json
{
  "id": "123d1b11-44a7-4f26-a3c5-168e1e1b22fe",
  "name": "Croqueta Royal Canin Indoor para gato 1.5 kg",
  "slug": null,
  "description": null,
  "category": { "id": "0f288cac-65b5-4813-a13d-d9d659ed3555", "name": "Alimento para gato" },
  "brand": { "name": "Royal Canin" },
  "images": [
    {
      "id": "2930a000-87a2-4563-90d9-d59253057a8c",
      "url": "https://placehold.co/600x600/png?text=Royal%20Canin%0AAlimento%20para%20gato",
      "isMain": true
    }
  ],
  "price": { "priceCents": 54900, "hidden": false },
  "availability": "low_stock",
  "stockPresentation": { "mode": "SYSTEM_STATUS", "status": "low_stock", "customQuantity": null },
  "hasVariants": false,
  "variants": [],
  "rating": null,
  "featuredLabel": null,
  "attributes": [
    {
      "code": "animal.target",
      "label": "Especie",
      "facet": true,
      "section": { "code": "para-quien", "label": "Para quién" },
      "value": { "type": "multi", "options": [{ "code": "ani.dom.cat", "label": "Gato" }] },
      "display": "Gato"
    },
    {
      "code": "food.format",
      "label": "Formato del alimento",
      "facet": true,
      "section": { "code": "que-es", "label": "Qué es" },
      "value": { "type": "single", "option": { "code": "food.format.kibble", "label": "Croquetas" } },
      "display": "Croquetas"
    },
    {
      "code": "measure.net_mass",
      "label": "Peso neto",
      "facet": true,
      "section": { "code": "contenido-empaque", "label": "Contenido y empaque" },
      "value": { "type": "number", "value": 1.5, "unit": { "code": "kg", "label": "kg" } },
      "display": "1.5 kg"
    }
  ],
  "priceContext": {
    "priceListId": "dae52cee-79b8-44e8-b5b2-8d2502f8f7e3",
    "name": "PUBLICO",
    "isCatalogDefault": true
  },
  "excludedCount": 0
}
```

A variant product carries the same array on each variant, for example `"variants": [{ "id": "…", "name": "…", …, "attributes": [ … ] }]`, with `"attributes": []` on the body. More examples (text, DETAIL, a variant product) are in [public-catalog-published-projection.md](../public-catalog-published-projection.md).

## 3. Facet filters

Request (list only, switch on only):

```text
GET /public/catalog/:tenantSlug/products
  ?facet=animal.target:ani.dom.dog
  &facet=animal.target:ani.dom.cat
  &facet=food.format:food.format.pate
```

- `facet` is repeatable. Each value is `<definition code>:<option code>`, and each side must match `[A-Za-z0-9._-]{1,120}`. Send at most 50, with no duplicates.
- Options of the same definition are OR'ed. Different definitions are AND'ed. Combine freely with `q`, `categoryId`, `priceListId`, `sort`, `page` and `limit`.
- Matching is per sellable: a product matches only when **one** covered variant (or the simple presentation) satisfies every selected definition. «Perro» on one variant plus «Paté» on another variant is not a match.
- Take the codes from `facets.attributes` in the previous response, never from hard-coded lists.
- Only choice facets (single/multi) are filterable. Number and range FACETs (weight, sizes, capacities) are not filterable yet. They still appear in detail `attributes` with `facet: true`.

Errors:

| When | Status | Body |
| --- | --- | --- |
| Malformed token (no `:`, bad characters, more than 50, duplicates) | `400` | Validation pipe body: `{"message":[{"property":"facet","children":[],"constraints":{"matches":"each value in facet must match /^[A-Za-z0-9._-]{1,120}:[A-Za-z0-9._-]{1,120}$/ regular expression"}}],"error":"Bad Request","statusCode":400}` |
| Unknown definition or option, a DETAIL/INTERNAL definition, a number/range FACET, **or any `facet` while the switch is off** | `400` | `{"statusCode":400,"error":"FACET_NOT_AVAILABLE","message":"Facet is not available: animal.target:nope.nope","timestamp":"…"}` |

FE action on `FACET_NOT_AVAILABLE`: drop the stale facet from the URL and reload the list. This happens when the vocabulary changed or the switch was turned off. Switch on `error`, never on `message`.

Response (switch on only): `facets` gains `attributes`. With the switch off, `facets` is still exactly `{ "categories": [...] }`.

```ts
interface PublicAttributeFacet {
  code: string;    // definition code, the left side of the facet token
  label: string;   // es-MX
  options: { code: string; label: string; count: number }[];
}
```

Real output (dev DB, Centro, no selection):

```json
"facets": {
  "categories": [
    { "id": "0f288cac-65b5-4813-a13d-d9d659ed3555", "name": "Alimento para gato", "count": 1 },
    { "id": "f01009a1-e1aa-4849-ae1a-da2910db95e6", "name": "Alimento para perro", "count": 1 },
    { "id": "563d68f9-36dd-4ad8-ab54-a26f34198076", "name": "Higiene y cuidado", "count": 1 }
  ],
  "attributes": [
    {
      "code": "animal.target",
      "label": "Especie",
      "options": [
        { "code": "ani.dom.cat", "label": "Gato", "count": 2 },
        { "code": "ani.dom.dog", "label": "Perro", "count": 1 }
      ]
    },
    { "code": "life.stage", "label": "Etapa de vida", "options": [{ "code": "life.dog.adult", "label": "Adulto", "count": 1 }] },
    { "code": "food.format", "label": "Formato del alimento", "options": [{ "code": "food.format.kibble", "label": "Croquetas", "count": 2 }] },
    { "code": "size.animal", "label": "Tamaño de mascota", "options": [
      { "code": "size.animal.medium", "label": "Mediano", "count": 1 },
      { "code": "size.animal.small", "label": "Pequeño", "count": 1 }
    ] }
  ]
}
```

The example is abridged: the real response also has `food.role`, `care.form`, `food.texture` and `care.type`.

- `count` is the number of unique products in the current context (price list, `q`, category and every **other** selected facet) that would match if this option were added. A facet's own selection is excluded, so its sibling options keep useful counts. With `facet=animal.target:ani.dom.cat`, the list has 2 products and «Especie» still shows Gato 2 · Perro 1.
- Options with count 0 are omitted unless selected. A selected option with no match stays, with count 0. Definitions without options are omitted. Definitions and options come ordered by es-MX label: keep that order.

## 4. Search

With the switch on, `q` matches only the Published title and description (case-insensitive contains). Operational names, brand and variant name/option/value are **no longer searched**. A brand matches only if it is in the Published title or description.

Example: `q=Adulto` finds nothing in Centro with the switch on, because only unpublished products have it in their operational name. As today, `%` and `_` act as wildcards. With the switch off, search is unchanged.

## 5. Cart validation

`POST /public/catalog/:tenantSlug/cart/validate`: same request and the same redacted contract, with the same scope as the list when the switch is on.

| Line | Result |
| --- | --- |
| Product without a valid Published version (or its simple presentation not covered) | `status: "BLOCKED"`, `blockingCodes: ["NOT_IN_CATALOG"]`, `productName: null` |
| Variant not covered by the current Published version | `status: "BLOCKED"`, `blockingCodes: ["VARIANT_NOT_IN_CATALOG"]` |
| Published and covered | As today (`VALID`, or the other existing codes) |

Real output, an unpublished product with the switch on:

```json
{
  "valid": false,
  "priceContext": { "priceListId": "dae52cee-79b8-44e8-b5b2-8d2502f8f7e3", "name": "PUBLICO", "isCatalogDefault": true },
  "items": [
    {
      "productId": "c89a04e8-c39f-430b-b570-e8556a2993d2",
      "variantId": null,
      "productName": null,
      "variantName": null,
      "image": null,
      "quantity": 1,
      "status": "BLOCKED",
      "blockingCodes": ["NOT_IN_CATALOG"],
      "warnings": ["NOT_IN_CATALOG"],
      "unitPriceCents": null,
      "lineTotalCents": null,
      "availability": "out_of_stock",
      "priceHidden": false
    }
  ],
  "warnings": ["NOT_IN_CATALOG"],
  "totalCents": 0
}
```

FE action: remove the line or mark it «Ya no está disponible», exactly like an existing `NOT_IN_CATALOG`. This happens to carts saved before the switch was turned on or before an unpublish.

`productName`/`variantName` on valid lines are still the **operational** names, not the Published title (known gap, section 10). The cart can show a different name than the card.

## 6. «Despublicar» (unpublish)

`POST /products/:productId/editorial/published/unpublish`

| | |
| --- | --- |
| Permission | `ProductEditorialDraft:read` + `ProductEditorialDraft:publish`, the same as «Publicar». `read` + `update` alone gives `403`. |
| Request headers | `Authorization`, `Idempotency-Key` (1–200 characters, one value, no commas), exactly one `Editorial-Vocabulary-Revision: <R>`. Never send `Editorial-Care-Confirmation`, `Editorial-Contract-Version` or `Editorial-Adoption` (any of them gives `400`), even for care products. |
| Query | none (any query gives `400`) |
| Body | `{ "expectedCycle": <state.cycle>, "expectedRevision": <state.published.revision> }`, exactly these keys. `expectedRevision` is the **Published** revision being removed, not the draft revision. |
| Response headers | `Cache-Control: no-store`, `Editorial-Contract-Version: 2`, `Editorial-Vocabulary-Revision: <R>` |

Effect: the Published version and its coverage are removed. The draft, if any, and the cycle are kept. With the switch on, the product leaves the public list, its detail becomes `404` and the cart rejects it, all on the next request (subject to the 60-second public cache, section 1).

`200` (real output, Shampoo Bio-Groom; the kept draft document is abridged):

```json
{
  "contractVersion": 2,
  "vocabularyRevision": "ev2-sha256-1c0e15b91c7fe78bff36f9021a80339ad7d72e7729988807d06c0777cdd426a9",
  "state": {
    "cycle": 3,
    "draft": { "revision": 1, "basePublishedRevision": 2, "document": { "…": "the kept draft, as stored" } },
    "published": null
  }
}
```

Without a draft, `state.draft` is `null`.

**Keep the content before unpublishing.** After an unpublish without a draft, `initialize` starts from an **empty** document, because Published is gone. If the user wants to edit and republish the same content later, call `initialize` first (it copies Published into a new draft), then unpublish. The header can then say «Borrador» and «Publicar» republishes it. The runtime proof did exactly this.

**Revision numbering continues.** Republishing after an unpublish uses the next revision (rev 2 → unpublish → republish gives rev 3), so a cycle and revision pair is never reused.

Order of checks (like publish):

1. Auth, permission, then request shape and headers.
2. Same `Idempotency-Key` with the same body and R: the recorded `200` is returned again, even if the state has changed since. Same key with another body or R: `409 CONFLICT`.
3. `expectedCycle`/`expectedRevision` do not match, or nothing is published: `409 CONFLICT`.
4. The vocabulary changed: `409 VOCABULARY_CHANGED`.

| Status | `error` | When | FE action |
| --- | --- | --- | --- |
| 400 | `MALFORMED` | Bad body, a query, a forbidden header, a missing/duplicated `Idempotency-Key` or R | Bug in the request; do not retry |
| 401 | `UNAUTHORIZED` | Missing or invalid token | Log in again |
| 403 | `FORBIDDEN` | No `:read` + `:publish` for this tenant/product | Hide «Despublicar» |
| 404 | `NOT_FOUND` | The product disappeared | Leave the editor |
| 409 | `CONFLICT` | Stale cycle/revision, already unpublished, or a reused key with another body | Reload the editorial read; retry with a **new** key if still published |
| 409 | `VOCABULARY_CHANGED` | The vocabulary changed | Reload the vocabulary and read, retry once with a new key (as in 05 §4) |
| 500 | `INTERNAL_ERROR` | Unexpected | Generic error |

Errors carry `Cache-Control: no-store` and `Editorial-Contract-Version: 2`, and no `Editorial-Vocabulary-Revision`. On an ambiguous network failure (no response), retry with the **same** key, body and headers.

UI suggestion: in the editor header, when `published` is not null, a secondary «Despublicar» action with a confirmation that says the product leaves the online catalog if the tenant shows only published products. Afterwards the header shows «Borrador» (with a draft) or no editorial state.

## 7. Republish a care product

This is not new, but the proof hit it: publishing a draft with `familyCode: "care"` (for example the shampoo) needs `Editorial-Care-Confirmation: review-v1`. Without it, publish returns `400 MALFORMED` without `items` (05 §3, step 6).

## 8. Switch off: what is guaranteed

With `catalogRequiresPublishedEditorial: false` (the default), the list, detail, cart and search responses are **byte-identical** to before this branch:

- no editorial read;
- no `attributes` keys;
- `facets` is exactly `{ "categories": [...] }`;
- operational names and search are unchanged.

The only difference is that any `facet` param gives `400 FACET_NOT_AVAILABLE`, where the main API today gives a validation `400` (`"property facet should not exist"`).

PostgreSQL integration specs pin this. The runtime proof confirmed it: this build's switch-off responses for Centro were equal byte for byte to the main API's responses before the migrations, and equal again after switching on and back off.

## 9. Before turning the switch on («Antes de encender el interruptor»)

- [ ] **Strict decoders accept the new keys.** Detail gains `attributes` (body and every variant). The list `facets` gains `attributes`. If your decoders reject unknown keys, update them first: the attribute shape is in §2 and the facet shape in §3. Treat `value.type` and facet codes as data, not as a closed enum.
- [ ] **Publish first.** Every product that must stay online needs a Published editorial («Publicar», 05). With the switch on, everything else disappears from the public catalog. In Centro today only 3 products qualify (section 11).
- [ ] **Republish legacy rows.** A Published row saved before editorial V2 does not count as published: it is hidden, its detail is `404` and the cart rejects it. Open such a product in the editor, review the draft, save it as V2 and «Publicar». Centro has two: «Croqueta Diamond Naturals Cordero y Arroz 13.6 kg» (`ed023419-e9e8-4c24-aab9-7b52141987ea`) and «Correa de nylon reforzada Kong 1.8 m» (`b52ea5e2-0a75-41f2-a2ed-a88b305cecde`). The backend logs their ids as a warning.
- [ ] **Republish after adding variants.** A variant created or offered after the last publish stays hidden until you republish.
- [ ] **Handle `NOT_IN_CATALOG` / `VARIANT_NOT_IN_CATALOG`** in saved carts (§5).
- [ ] **Handle `FACET_NOT_AVAILABLE`** by dropping the facet from the URL (§3).
- [ ] **Search copy.** Search no longer finds operational names or brand unless they are in the Published title or description.
- [ ] **Grant `TenantCatalogSettings:update`** only to whoever decides go-live.
- [ ] **Caching.** Allow up to 60 seconds for public caches after flipping the switch.

## 10. Not in this slice

- The chatbot's legacy catalog readers ignore the switch: they still show operational data and unpublished products.
- Cart lines show operational product and variant names (§5).
- Number and range facet filters (weight, size, capacity) need unit normalization first.
- Media in the Published version (publish still requires empty media).

## 11. Runtime proof and test data (dev DB, 2026-11-05)

Built app on a separate port over the dev DB, Sucursal Centro (`slug: centro`, id `ced6cc10-a037-4f41-92af-ee69bbb51c8b`), logged in as `admin@houndfe.com` (dev login, no email code). Real HTTP. All checks passed except the first republish attempt, which lacked the care header (see the C7 row).

| # | Check | Result |
| --- | --- | --- |
| S1a | `GET catalog-settings` | `200`, `catalogRequiresPublishedEditorial: false` |
| A1–A2 | Switch off: list (86 products) and the Royal Canin detail vs the main API before the migrations | Byte-identical |
| A3 | Switch off: shampoo and an unpublished product's detail, list vs the main API now | Byte-identical |
| A4 | Switch off: no `attributes`, `facets` keys `["categories"]` | Pass |
| A5 | Switch off: `facet=animal.target:ani.dom.dog` | `400 FACET_NOT_AVAILABLE` |
| B0 | `PATCH {catalogRequiresPublishedEditorial:true}` | `200`, `Cache-Control: no-store` |
| B1 | Switch on: list | `total 3` (was 86): Alimento para Cachorro Raza Mediana 3 kg, Shampoo de avena Bio-Groom 355 ml, Croqueta Royal Canin Indoor 1.5 kg |
| B1b | The 2 legacy pre-V2 Published rows | Absent from the list (`200`), detail `404`, cart `NOT_IN_CATALOG`; one warning per request with only their ids |
| B2 | Detail of an unpublished product (Croquetas Adulto 15 kg) | `404` generic body |
| B3–B4 | Royal Canin detail `attributes` | `animal.target`, `food.format`, `measure.net_mass`; no evidence, facts, INTERNAL or editorial internals |
| B5–B6 | `facets.attributes`; `facet=animal.target:ani.dom.cat` | 8 facet definitions; filtered `total 2` = option count 2; «Especie» counts unchanged by its own selection |
| B7 | Unknown option / malformed token | `400 FACET_NOT_AVAILABLE` / validation `400` |
| B8 | `q=Croqueta` (Published title word) / `q=Adulto` (operational only) | Royal Canin found / `total 0` |
| B9–B10 | Cart: unpublished product / published shampoo | `BLOCKED NOT_IN_CATALOG` / `valid: true` |
| C1–C2 | Shampoo: `initialize` (keep content), then `unpublish` | `201` cycle 3 / `200`, `published: null`, draft kept |
| C3–C5 | Replay same key / new key, already unpublished / no key | Identical `200` / `409 CONFLICT` / `400 MALFORMED` |
| C6 | After unpublish | Shampoo out of the list (`total 2`), detail `404`, cart `NOT_IN_CATALOG` |
| C7 | Republish the kept draft | The first attempt without `Editorial-Care-Confirmation` gave `400` (care family, §7). With `review-v1`: `200`, revision 3 (was 2), same document |
| C8 | After republish (switch on) | Shampoo detail and the list byte-identical to before the unpublish |
| D1 | `PATCH {…:false}`, list and detail | Byte-identical to the first switch-off read |
| D2 | Main API list at the end | Unchanged |

End state: switch **off** for Centro. The shampoo is published again, now at cycle 3 and revision 3 instead of cycle 2 and revision 2, with the same document and identical public output. The probe added receipt rows for its initialize, unpublish and publish calls. The legacy rows were left untouched.

Products to try with the switch on: «Croqueta Royal Canin Indoor para gato 1.5 kg» `123d1b11-44a7-4f26-a3c5-168e1e1b22fe`, «Shampoo de avena Bio-Groom para perro 355 ml» `618ef15d-fcc1-4797-a3d6-22e5d2763002` (care family) and «Alimento para Cachorro Raza Mediana 3 kg» `a1ef3ac2-832c-470f-b6c4-de4edf12d1b5`. Anything else in Centro shows the unpublished behavior.
