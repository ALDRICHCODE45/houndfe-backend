# Public catalog from Published editorial (P4 T3: S2 S3 S5, T4: S4)

The public catalog (`GET /public/catalog/:tenantSlug/products` and
`GET /public/catalog/:tenantSlug/products/:productId`) reads the editorial
Published version only when the tenant's catalog setting
`catalogRequiresPublishedEditorial` is on (T1, default off).

## Switch off (default)

Nothing changes: the same queries and the same response bytes. No editorial
data is read or returned; `attributes` keys are absent. The PostgreSQL spec
`src/public-catalog/infrastructure/prisma-public-catalog-published.integration.spec.ts`
pins this: list and detail are identical before and after publishing editorial
for the same products.

## Switch on

**Eligibility (S2).** On top of every existing gate (`includeInOnlineCatalog`,
`PRODUCT` type, publication survivorship, price-list allowlist, positive
prices, hidden/prescription precedence), a product needs a current Published
editorial version. Products without one are not listed and their detail is the
same generic `404 Not Found` as an unknown id. The gate is in the SQL `where`
before pagination, so `meta.total`, `totalPages`, `excludedCount` and the
category facets all count the same unique products. `excludedCount` keeps its
meaning (price-context exclusions among published products); unpublished
products are not counted in it.

**Covered variants (S5).** A variant must be a subject the current Published
version covered (`publishedSubjects`; an unrecorded publication covers all). An
uncovered variant is treated exactly like an `OFF` variant everywhere: it does
not keep a product alive, does not satisfy the variant price gate, is not in
`variants`, does not affect `fromPriceCents` and is not a stock-presentation
participant. A simple product needs its presentation (`null`) covered. If no
covered sellable remains, the product is excluded / 404 like an unpublished
one. Republishing with the variant in the draft covers it.

**Text (S3).** The Published `commercialTitle` replaces `name` and the
Published `description` replaces `description` in cards and detail. A `null`
Published description replaces the operational one with `null` (the
operational text is never shown when the switch is on).

**Attributes (S3), detail only.** Additive keys:

- `attributes` on the detail body: values with no variant (product-owned and
  the simple-product presentation).
- `attributes` on each detail variant: that variant's sellable values. For
  variant products the production vocabulary binds every definition to the
  sellable, so the product-level list is usually empty and attributes ride on
  the variants.

Cards never carry attributes.

```ts
interface PublicProductAttributeDto {
  code: string;            // vocabulary definition code, e.g. "animal.target"
  label: string;           // es-MX definition label
  facet: boolean;          // FACET exposure (T4 filters); DETAIL = false
  section: { code: string; label: string } | null; // family form section
  value:
    | { type: 'text'; text: string }
    | { type: 'boolean'; value: boolean }
    | { type: 'single'; option: { code: string; label: string } }
    | { type: 'multi'; options: { code: string; label: string }[] }
    | { type: 'number'; value: number; unit: { code: string; label: string } | null }
    | { type: 'range'; min: number; max: number; unit: { code: string; label: string } };
  display: string;         // es-MX text: "Perro, Gato", "1.5 kg", "30–45 cm", "Sí"
}
```

Rules:

- Only `known` values project; `unknown` and `not_applicable` are omitted.
- Only bindings with exposure FACET or DETAIL in the document's family are read
  (`readEditorialPublicVocabularyV2`); INTERNAL bindings are never queried.
- Labels are the current vocabulary labels (definition, option, unit; a unit
  without a label shows its code). Numbers are raw: no locale formatting,
  rounding or conversion.
- A value whose definition, option or unit is not in the public vocabulary, or
  whose payload type disagrees with the definition, is left out (a multi value
  keeps its known options).
- Order: the family's form sections (`FAMILY_SECTIONS`), then position in the
  section, then binding order; unsectioned definitions last.
- Never exposed: evidence, facts/declarations, care review, attestation,
  `mediaRefs`, family code, revisions, cycle, publishedSubjects or any other
  editorial field. The raw document never leaves the repository.

Example: a published simple food product detail (abridged where marked).

```json
{
  "id": "4d0c6a3e-…",
  "name": "Croquetas Indoor para perro y gato 1.5 kg",
  "slug": null,
  "description": "Croquetas horneadas para interiores.",
  "category": { "id": "…", "name": "Alimento" },
  "brand": null,
  "images": [],
  "price": { "priceCents": 25000, "hidden": false },
  "availability": "available",
  "stockPresentation": { "…": "unchanged" },
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
      "value": {
        "type": "multi",
        "options": [
          { "code": "ani.dom.dog", "label": "Perro" },
          { "code": "ani.dom.cat", "label": "Gato" }
        ]
      },
      "display": "Perro, Gato"
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
      "code": "food.process",
      "label": "Procesamiento",
      "facet": false,
      "section": { "code": "que-es", "label": "Qué es" },
      "value": { "type": "multi", "options": [{ "code": "food.process.baked", "label": "Horneado" }] },
      "display": "Horneado"
    },
    {
      "code": "text.ingredients",
      "label": "Ingredientes",
      "facet": false,
      "section": { "code": "formula", "label": "Fórmula" },
      "value": { "type": "text", "text": "Pollo, arroz y maíz" },
      "display": "Pollo, arroz y maíz"
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
  "priceContext": { "priceListId": "…", "name": "…", "isCatalogDefault": true },
  "excludedCount": 0
}
```

`text.clinical_analysis` (INTERNAL) in the same document is absent.

## Failure policy

A Published row that is not a valid document shape V2 (for example a legacy
pre-V2 row) **counts as not published** in the public catalog: it is excluded
from the list, `meta.total`, `excludedCount`, category and attribute facets,
search and cart validation (`NOT_IN_CATALOG`), and its detail is the generic
`404`. One bad row never fails the request. Operational data is never shown
in its place. Each request that meets such rows logs one warning with the
product ids only (never document contents):
`Published editorial not readable as document shape V2, treated as not published: <ids>`.

Where it is decided:

- Tenant-wide readers (list, counts, facets, search):
  `publishedDocumentV2Sql` in the SQL `where` of
  `readEditorialTenantPublishedFacetSourcesV2` /
  `readEditorialTenantPublishedCoverageV2` checks the top level (exact keys,
  `schemaVersion` 2, arrays) and every value element (key set by state,
  `payload` object for `known`). The documents stay in the database.
- Per-product reader (detail, cart): `readEditorialPublishedCoverageV2` applies
  the full `parseDocumentShapeV2`.
- Page projection: a row that passes the SQL test but fails the full parse
  (only reachable by direct SQL; publish admits only valid documents) is
  dropped from the page and logged; the counts of that request may include it.

The editorial store (read, readiness, publish, unpublish) is unchanged.
Republishing such a product with a V2 draft makes it public again. Proof:
`prisma-public-catalog-facets.integration.spec.ts` (legacy and broken rows
next to valid ones) and `prisma-editorial-published-coverage-v2.integration.spec.ts`.

## Search (T4, S4)

With the switch on, `q` matches only the Published `commercialTitle` and
`description` (case-insensitive contains, the same `ILIKE` semantics as the
operational search, applied in the SQL `where` before pagination). Operational
product names, brand and variant name/option/value are no longer searched.
Switch off: unchanged (operational name, brand, variant fields).

As today, `%` and `_` in `q` act as LIKE wildcards (neither the operational
nor the published search escapes them); pinned by the integration spec.

## Facet filters (T4, S4)

Request, contextual list only, switch on only:

```
GET /public/catalog/:tenantSlug/products
  ?facet=animal.target:ani.dom.dog
  &facet=animal.target:ani.dom.cat
  &facet=food.format:food.format.pate
```

- `facet` is repeatable; each value is `<definition code>:<option code>`
  (`[A-Za-z0-9._-]{1,120}` on each side), at most 50, no duplicates.
  Malformed → `400` from the validation pipe, like every other list param.
- Options of one definition are OR'ed; definitions are AND'ed.
- **Correlated variant matching:** a product matches when ONE covered sellable
  subject (a non-OFF covered variant, or the simple presentation) satisfies
  every selected definition. Product-level values (no `variantId`) apply to
  every variant. `dog` on variant 1 and `pate` on variant 2 is not a match.
- Values count exactly like the detail `attributes` with `facet: true`: `known`
  single/multi values whose definition is FACET in the document's family and
  whose option is in the vocabulary.
- The selection becomes one `id IN (...)` gate in the same SQL `where` before
  pagination, so `meta.total`, `totalPages`, `excludedCount` and
  `facets.categories` all count the same unique products under the filter.
- Unknown definition, unknown option, a DETAIL/INTERNAL definition, a
  number/range FACET, or any `facet` while the switch is off →
  `400 { "error": "FACET_NOT_AVAILABLE", "message": "Facet is not available: <code[:option]>" }`
  (`InvalidArgumentError` through the domain filter).

**Number/range FACETs are not filterable yet.** `measure.net_mass`,
dimensions, fit ranges, capacity etc. carry mixed units (mg/g/kg, mm/cm/m)
that need normalization and a range-overlap rule to be defined first; choice
facets cover the shopper's main navigation (species, format, type, size,
life stage). They stay visible in detail `attributes`.

Response, switch on only (additive key; switch off keeps `facets` exactly
`{ "categories": [...] }`):

```json
"facets": {
  "categories": [{ "id": "…", "name": "Alimento", "count": 1 }],
  "attributes": [
    {
      "code": "animal.target",
      "label": "Especie",
      "options": [
        { "code": "ani.dom.cat", "label": "Gato", "count": 3 },
        { "code": "ani.dom.dog", "label": "Perro", "count": 1 }
      ]
    },
    {
      "code": "food.format",
      "label": "Formato del alimento",
      "options": [
        { "code": "food.format.kibble", "label": "Croquetas", "count": 2 },
        { "code": "food.format.pate", "label": "Paté", "count": 1 }
      ]
    }
  ]
}
```

- `count` = unique context-eligible products (price/allowlist/q/category
  applied) with a subject that holds the option and satisfies every OTHER
  selected definition — a facet's own selection is excluded, so its sibling
  options keep useful counts.
- Options with count 0 are omitted unless selected; definitions with no
  option are omitted. Definitions and options are ordered by es-MX label.
- Only FACET single/multi definitions appear.

**Cost.** With the switch on a list request adds: one raw read of the
tenant's Published rows extracting only coverage, family and known choice
values (`jsonb_array_elements` in SQL; text, numbers, evidence and facts are
not transferred), one vocabulary read of FACET choice bindings, one
`id/hasVariants/variant ids` read over eligible products, and — only with a
selection — the same read over the base scope. Matching and counting run in
memory, linear in products × subjects. Fine for the current catalog sizes
(< 10K products per tenant); a materialized facet table would be the next step
if that grows.

## Cart validation (T4, S2/S5)

`POST /public/catalog/:tenantSlug/cart/validate` applies the same scope when
the switch is on, with the existing redacted contract:

- no Published version, or a simple product whose presentation is not
  covered → `NOT_IN_CATALOG`;
- a variant not covered by the current Published revision →
  `VARIANT_NOT_IN_CATALOG` (exactly like an OFF variant).

Switch off: unchanged (no editorial read). Product/variant names in valid
lines are still the operational ones.

## Not in this slice

- The legacy chatbot readers (`findProducts`, `findProductById`,
  `findCategoryFacets`) do not apply the switch.
- Number/range facet filters (see above).

FE handoff: [frontend-handoff/07-public-catalog-published.md](frontend-handoff/07-public-catalog-published.md).
