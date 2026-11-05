# Public catalog from Published editorial (P4 T3: S2 S3 S5)

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

A Published document that cannot be read as document shape V2 fails the
request (generic server error) instead of silently showing operational data;
publish admits only valid documents, so this is an invariant breach.

## Not in this slice

- **Search and facet filters (T4).** With the switch on, `q` still matches
  operational names/brand/variant fields; facet filtering and search on
  Published title/description are T4. The editorial predicates join the same
  `AND` list (`EditorialScope` in the repository) so T4 adds to it.
- **Cart validation** (`POST …/cart/validate`) and the legacy chatbot readers
  (`findProducts`, `findProductById`) do not apply the switch.
