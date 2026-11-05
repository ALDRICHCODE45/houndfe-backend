# 05 · Editorial: readiness and publish

Backend status: implemented on branch `feat/editorial-publish-v2` (P1 publish V2, P2 readiness). Not merged yet. The public catalog does not read Published yet (P4), and unpublish (D6) does not exist yet.

The rules live in the backend (decision D2). The FE never recomputes publishability. It shows what readiness returns and sends publish.

## 1. UI flow (agreed with the FE, proposal §3)

- **Save bar:** «Guardar» first. «Publicar» becomes the primary action only when there are no unsaved changes and the last readiness says `ready: true`.
- **Not ready:** «Publicar» is disabled. The explanation is the readiness list grouped by section (the design-system Issue checklist pattern), not a tooltip:
  - Items with `sectionCode` go under their section, and `bySection` fills the missing count in the section index.
  - Items with `sectionCode: null` (scope `product`, `variant`, `care`) go above the section index.
- **Header state:**
  - «Borrador» when `published` is null.
  - «Publicado · 4 nov» (from the published revision you saw being published) when there is a Published document.
  - Add «Cambios sin publicar» when the draft and Published differ. The FE computes this from the editorial read, which returns both documents (D7).
- **When to call readiness:** after loading the editor and after every successful save. With unsaved edits, label the list «según lo último que guardaste». Readiness evaluates the **saved** draft, never the local buffer.
- **After publish:** `state.draft` is `null`. To keep editing, call `initialize` with `expectedCycle` equal to the returned `cycle` (as today).

## 2. Readiness

`GET /products/:productId/editorial/draft/readiness`

| | |
| --- | --- |
| Permission | `ProductEditorialDraft:read` (same as the editorial read) |
| Request headers | `Authorization`, plus exactly one `Editorial-Vocabulary-Revision: <R>` (the `vocabularyRevision` of the vocabulary you installed). No `Idempotency-Key`, `Editorial-Care-Confirmation`, `Editorial-Contract-Version` or `Editorial-Adoption`. |
| Query / body | none |
| Response headers | `Cache-Control: no-store`, `Editorial-Contract-Version: 2`, `Editorial-Vocabulary-Revision: <R>` |
| Writes | none (read-only snapshot) |

Response `200`:

```ts
type Readiness = {
  ready: boolean;              // true ⇔ items is empty ⇔ publish would pass
  cycle: number | null;
  draftRevision: number | null; // the saved draft that was evaluated
  vocabularyRevision: string;
  items: ReadinessItem[];
  bySection: { [sectionCode: string]: number }; // definition items per section
};
type ReadinessItem = {
  scope: 'definition' | 'variant' | 'product' | 'care'; // closed set
  definitionCode: string | null; // null unless scope is definition
  variantId: string | null;      // null = product level (or a simple product)
  sectionCode: string | null;    // null for non-definition items
  problem: string;               // stable code: treat as an open string
  message: string;               // es-MX copy with «tú», always show it
};
```

Example, a food draft without its net weight (real output from the integration run):

```json
{
  "ready": false,
  "cycle": 1,
  "draftRevision": 4,
  "vocabularyRevision": "ev2-sha256-f2cb1de8523c59c19003b741313638c63744daa8ea585573123f63bf7b648114",
  "items": [
    {
      "scope": "definition",
      "definitionCode": "measure.net_mass",
      "variantId": null,
      "sectionCode": "contenido-empaque",
      "problem": "REQUIRED_MISSING",
      "message": "Falta el peso neto."
    }
  ],
  "bySection": { "contenido-empaque": 1 }
}
```

Ready draft: `{ "ready": true, "cycle": 1, "draftRevision": 4, "vocabularyRevision": "ev2-sha256-…", "items": [], "bySection": {} }`.

No saved draft: `200` with `ready: false`, `draftRevision: null` and one `product` item `NO_DRAFT`.

Readiness errors: `400 MALFORMED` (query, body, a forbidden header, a missing or duplicated R), `401`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 VOCABULARY_CHANGED`.

## 3. Publish

`POST /products/:productId/editorial/draft/publish`

| | |
| --- | --- |
| Permission | `ProductEditorialDraft:read` + `ProductEditorialDraft:publish`. Update is not needed, and `read` + `update` alone is `403`. |
| Request headers | `Authorization`, `Idempotency-Key` (1–200 characters, untrimmed), exactly one `Editorial-Vocabulary-Revision: <R>`. For a draft with `familyCode: "care"` only: `Editorial-Care-Confirmation: review-v1`, sent after the publisher has seen every care review (contract §7). Never send it for another family. |
| Body | `{ "expectedCycle": <draft cycle>, "expectedRevision": <draft revision> }`, exactly these keys |
| Response headers | `Cache-Control: no-store`, `Editorial-Contract-Version: 2`, `Editorial-Vocabulary-Revision: <R>` |

Effect: the saved draft is copied to Published exactly as stored, `published.revision` becomes the previous revision + 1 (1 the first time), the draft is cleared, and `cycle` is kept. Only the latest Published is kept.

`200`, publishing the food draft (real output; the `document` is the saved draft as stored, and JSONB storage reorders object keys):

```json
{
  "contractVersion": 2,
  "vocabularyRevision": "ev2-sha256-c4bd4c45a57fd932187560a13fb8896a5382f5d95f374806789bf1a74835f7a3",
  "state": {
    "cycle": 1,
    "draft": null,
    "published": {
      "revision": 1,
      "document": {
        "facts": [
          {
            "variantId": null,
            "careReview": null,
            "declarations": [
              {
                "key": "contentMagnitude",
                "basis": "Dice el empaque",
                "state": "known",
                "value": "mass",
                "evidence": { "sourceRef": "Etiqueta del empaque", "verifiedOn": "2026-11-01" }
              }
            ],
            "presentation": "Pieza"
          }
        ],
        "values": [
          {
            "code": "animal.target", "owner": "sellable", "state": "known",
            "payload": { "type": "multi", "value": ["ani.dom.dog"] },
            "evidence": { "sourceRef": "Etiqueta del empaque", "verifiedOn": "2026-11-01" },
            "variantId": null
          },
          {
            "code": "food.format", "owner": "sellable", "state": "known",
            "payload": { "type": "single", "value": "food.format.kibble" },
            "evidence": { "sourceRef": "Etiqueta del empaque", "verifiedOn": "2026-11-01" },
            "variantId": null
          },
          {
            "code": "measure.net_mass", "owner": "sellable", "state": "known",
            "payload": { "type": "number", "unit": "kg", "value": 2 },
            "evidence": { "sourceRef": "Etiqueta del empaque", "verifiedOn": "2026-11-01" },
            "variantId": null
          }
        ],
        "mediaRefs": [],
        "familyCode": "food",
        "description": null,
        "schemaVersion": 2,
        "commercialTitle": "Croquetas para perro adulto 2 kg"
      }
    }
  }
}
```

`400`, a draft that is not ready (real output). Nothing is written. The `items` and `bySection` are the same as readiness for that saved draft, so show the same checklist:

```json
{
  "statusCode": 400,
  "error": "MALFORMED",
  "items": [
    {
      "scope": "definition",
      "definitionCode": "measure.net_mass",
      "variantId": null,
      "sectionCode": "contenido-empaque",
      "problem": "REQUIRED_MISSING",
      "message": "Falta el peso neto."
    }
  ],
  "bySection": { "contenido-empaque": 1 }
}
```

`409`, a stale cycle or revision, or the vocabulary changed:

```json
{ "statusCode": 409, "error": "CONFLICT" }
```

```json
{ "statusCode": 409, "error": "VOCABULARY_CHANGED" }
```

### Order of checks

1. Auth, permission, then request shape and headers.
2. Same `Idempotency-Key` with the same body and headers: the recorded `200` is returned again, even if the state has changed since. Same key with another body or R: `409 CONFLICT`.
3. Stale `expectedCycle`/`expectedRevision`, or no draft: `409 CONFLICT`.
4. `Editorial-Vocabulary-Revision` differs from the current vocabulary: `409 VOCABULARY_CHANGED`.
5. Readiness of the saved draft: not ready gives `400` **with** `items`.
6. Care confirmation, ready drafts only: a care draft without `review-v1`, or a non-care draft with it, gives a plain `400 MALFORMED` **without** `items`.

## 4. Errors

| Status | `error` | Endpoint | When | FE action |
| --- | --- | --- | --- | --- |
| 400 | `MALFORMED` + `items`, `bySection` | publish | The saved draft is not ready | Show the checklist; publish stays disabled |
| 400 | `MALFORMED` (no `items`) | both | Bad body, query or headers; care confirmation missing on a ready care draft, or sent for another family | Bug in the request: fix it, do not retry blindly |
| 401 | `UNAUTHORIZED` | both | Missing or invalid token | Log in again |
| 403 | `FORBIDDEN` | both | No editorial permission for this tenant or product (publish needs `:publish`) | Hide or disable «Publicar» |
| 404 | `NOT_FOUND` | both | The product disappeared after authorization | Leave the editor |
| 409 | `CONFLICT` | publish | Stale cycle/revision, no draft, or a reused key with a different body | Keep the edits, reload the editorial read, then let the user retry with a **new** key |
| 409 | `VOCABULARY_CHANGED` | both | The vocabulary changed since you installed it | Reload the vocabulary, then retry **once** (see below) |
| 500 | `INTERNAL_ERROR` | both | Unexpected | Generic error |

Every error has `Cache-Control: no-store` and `Editorial-Contract-Version: 2`, and no `Editorial-Vocabulary-Revision`.

**`VOCABULARY_CHANGED` pattern (readiness and publish):** reload `GET /catalog-editorial/vocabulary` and the editorial read pinned to the new R, install the pair, then retry once with the new R. For publish the retry is a new user attempt: use a **new** `Idempotency-Key` and the current `expectedCycle`/`expectedRevision`. If it fails again, stop and show the error.

**Ambiguous network failure on publish** (no response): retry with the **same** key, body and headers. The backend returns the recorded result if the first attempt committed.

## 5. Problem codes

`problem` is an open string: show `message` for any code you do not know. `scope` is a closed set; the backend will not add values to it.

| scope | problem | message |
| --- | --- | --- |
| definition | `REQUIRED_MISSING` | Shipped labels: «Falta el peso neto.», «Falta la especie.», «Faltan los ingredientes.» (article + label). Customized labels: «Completa «{label}».» |
| definition | `UNRESOLVED` | Responde las preguntas de la presentación para saber si este dato aplica. |
| definition | `EVIDENCE_REQUIRED` | Agrega de dónde sale este dato. |
| definition | `NA_NOT_ALLOWED` | Este dato sí aplica: no lo marques como «No aplica». |
| definition | `NOT_APPLICABLE_VALUE` | Este dato no aplica a este producto; quítalo. |
| definition | `MAGNITUDE_MISMATCH` | El tipo de contenido no coincide con cómo se mide el contenido de la presentación. |
| definition | `TOY_TYPES_MISMATCH` | Las medidas de la presentación deben cubrir exactamente los tipos de juguete elegidos. |
| definition | `NUMERIC_POLICY_PENDING` | Este dato todavía no tiene reglas de captura; pide a un administrador que las defina. |
| definition | `INVALID_VALUE` | Revisa este valor: está fuera del rango permitido. |
| definition | `ARCHIVED_OPTION` | Esta opción ya no está disponible; elige otra. |
| variant | `FACTS_CONFLICT` | Hay respuestas que se contradicen en las preguntas de esta presentación. |
| product | `REQUIRED_MISSING` (title) | Falta el título comercial. |
| product | `REQUIRED_MISSING` (family) | Elige el tipo de producto. |
| product | `MEDIA_NOT_ALLOWED` | Quita las imágenes: todavía no se pueden publicar. |
| product | `NO_OFFERED_PRESENTATION` | El producto no se ofrece en ninguna lista de precios en línea. |
| product | `DRAFT_INVALID` | Tu borrador ya no coincide con el producto o el vocabulario actual; revísalo y guárdalo de nuevo. |
| product | `NO_DRAFT` (readiness only) | Todavía no hay un borrador guardado; guarda tus cambios para revisar qué falta. |
| care | `CARE_REVIEW_INCOMPLETE` | One of the care messages below |

Care items (`scope: "care"`, `variantId` is the presentation):

| Gap | message |
| --- | --- |
| Missing, unknown or unprepared review | Completa la revisión de cuidado de esta presentación. |
| No review evidence | Agrega de dónde sale la revisión de cuidado. |
| `none_applicable` with entries | Si no aplica ningún requisito, quita los requisitos y las advertencias de la revisión. |
| `identified` without requirements | Agrega al menos un requisito a la revisión de cuidado. |
| A requirement not satisfied/NA or without evidence | Resuelve cada requisito de cuidado y agrega de dónde sale. |
| A `public_required` warning (D11) | Hay una advertencia que se debe mostrar al público; por ahora no se puede publicar. |
| An unresolved warning or one without evidence | Indica cómo se maneja cada advertencia y agrega de dónde sale. |

More real `400` examples from the integration run (one item each unless noted):

```json
{"scope":"definition","definitionCode":"food.format","variantId":null,"sectionCode":"que-es","problem":"EVIDENCE_REQUIRED","message":"Agrega de dónde sale este dato."}
{"scope":"definition","definitionCode":"animal.target","variantId":null,"sectionCode":"para-quien","problem":"NA_NOT_ALLOWED","message":"Este dato sí aplica: no lo marques como «No aplica»."}
{"scope":"care","definitionCode":null,"variantId":null,"sectionCode":null,"problem":"CARE_REVIEW_INCOMPLETE","message":"Hay una advertencia que se debe mostrar al público; por ahora no se puede publicar."}
{"scope":"product","definitionCode":null,"variantId":null,"sectionCode":null,"problem":"NO_OFFERED_PRESENTATION","message":"El producto no se ofrece en ninguna lista de precios en línea."}
```

An accessory that says «la talla no decide la compra» but lists neck size returns four items: one `variant` `FACTS_CONFLICT`, plus `UNRESOLVED` on `measure.fit.neck`, `measure.fit.chest` and `measure.fit.back_length` (`bySection: {"medidas-ajuste": 3}`).

## 6. Business rules to know

- Every known value needs its source and date to publish (D9). Product title needs no evidence.
- A product that is not offered on any online price list cannot publish (D10, `NO_OFFERED_PRESENTATION`). Offer comes from the tenant catalog price lists, not stock.
- Each offered presentation is checked on its own: no values are borrowed from a sibling or aggregated (S89).
- A draft without a product type (`familyCode: null`) cannot publish.
- Media must be empty to publish, for now.
- Pending, out of scope: S88 «Es solo equipamiento» for habitat, and D8 per-type defaults for accessories («collar, arnés, correa → No»).
