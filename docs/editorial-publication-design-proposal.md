# Editorial publication: preview → publish → public catalog (PROPOSAL)

**Status: proposal for human decisions. Nothing here is implemented or approved.** It maps what exists today, the proposed slices, and the product decisions the human must take before implementation (§5). The frontend already has the UI pieces waiting: a section index with missing counts, draft/published state, and «Cambios frente a lo publicado» in the history panel.

Evidence: read-only code map of local `main` `ae9a909` (2026-11-05). Line references are approximate anchors.

## 1. What exists today

| Piece | State |
| --- | --- |
| Save, initialize, discard | V2 writers, wired. Save admits the document in `'save'` mode (shape, evidence, numbers, N/A) but never checks completeness. |
| Publish route `POST products/:id/editorial/draft/publish` | Exists (`editorial-write.controller.ts:171-188`) but runs the **legacy v1 adapter** (`prisma-catalog-editorial.ts:220-381`): v1 document validator, v1 definitions, no vocabulary-revision pin, v1 receipt, only a Product lock. A V2 draft very likely fails with `400 MALFORMED` (inferred, not executed). The FE keeps `publicationAvailable=false`. |
| Publication rules (completeness) | Exist as **unwired** pure V2 domain functions: `admitFreshDocumentV2(…,'publish')`, `readEditorialOfferedSubjectsV2`, `buildEditorialEvaluationSetV2`, `assertEditorialEvaluationReadinessV2`, `evaluateFactRuleV2`, `assertContentKindAgreementV2` (S89), `assertToyDeterminationAgreementV2`, `assertCarePublicationReadinessV2`, `buildFreshCareAttestationV2`. S88 «Es solo equipamiento» is not implemented. |
| Preview / readiness | Does not exist. Every `assert*` stops at the first failure and errors carry no field path (`{statusCode, error}` only). |
| Storage | `catalog_editorial_states`: one draft and **only the latest** Published document per product. No published history. |
| Public catalog | Never reads editorial content. Name and description come from `products`; facets are categories only; search is `contains` on product/brand/variant names. |

## 2. Proposed slices

Each slice is a reviewable unit; the order is the dependency order.

### P1 — Publish a V2 draft (backend core)

- Replace the legacy publish with a V2 publish writer modeled on the V2 discard writer: authority, lock order (catalog lifecycle SHARE → Tenant SHARE → Product UPDATE), receipt replay, cycle/revision CAS, vocabulary-revision pin (`VOCABULARY_CHANGED`), V2 receipt and `StateV2` response.
- Run the full publication chain: fresh admission in `'publish'` mode, offered subjects (E), evaluation set, binding readiness, content-kind agreement per offered subject (S89), toy determination, care readiness and attestation for the `care` family.
- Error contract: `400 MALFORMED` for an incomplete draft, `409 CONFLICT` for stale cycle/revision, `409 VOCABULARY_CHANGED`. (Depends on decision D1.)
- Proof: integration tests with real V2 drafts per family, concurrency with save/discard, replay.

### P2 — Readiness (preview of what blocks publishing)

- `GET products/:id/editorial/draft/readiness` (read-only, no writes): runs the same chain as P1 in collecting mode over the **saved** draft and returns every missing or invalid item. Shape agreed with the FE (2026-11-05):

```json
{
  "ready": false,
  "cycle": 3,
  "draftRevision": 12,
  "vocabularyRevision": "ev2-sha256-…",
  "items": [
    { "scope": "definition", "definitionCode": "measure.net_mass", "variantId": null,
      "sectionCode": "contenido-empaque", "problem": "REQUIRED_MISSING",
      "message": "Falta el peso neto." },
    { "scope": "definition", "definitionCode": "animal.target", "variantId": null,
      "sectionCode": "para-quien", "problem": "EVIDENCE_REQUIRED",
      "message": "Agrega de dónde sale este dato." },
    { "scope": "product", "definitionCode": null, "variantId": null, "sectionCode": null,
      "problem": "NO_OFFERED_PRESENTATION",
      "message": "El producto no se ofrece en ninguna lista de precios en línea." }
  ],
  "bySection": { "contenido-empaque": 1, "para-quien": 1 }
}
```

- `scope`: `definition` (one attribute), `variant` (a whole offered variant), `product`, `care` (the care review). Non-definition items have `definitionCode: null` and `sectionCode: null`; the FE shows them above the section index.
- `variantId: null` means product level. Variant labels are not repeated (they come in the editorial read).
- `problem` is the stable code for logic; `message` is human copy built by the backend in neutral Mexican Spanish with «tú».
- Problems (proposal): `REQUIRED_MISSING`, `UNRESOLVED` (a declaration the rule needs is unknown), `EVIDENCE_REQUIRED`, `NA_NOT_ALLOWED`, `MAGNITUDE_MISMATCH`, `CARE_REVIEW_INCOMPLETE`, `NUMERIC_POLICY_PENDING`, `NO_OFFERED_PRESENTATION`.
- `cycle`/`draftRevision` say which saved draft was evaluated. There is no dry-run with a body: the FE calls readiness after each save and, with unsaved changes, says «según lo último que guardaste». Live «falta N» while editing is computed by the FE; readiness is the authority for publishing.
- **Publish failures reuse the same list:** an incomplete draft makes publish return `400` with the same `items[]` (and `bySection`), so the FE shows the same view when someone publishes with a stale readiness.
- Needs collecting variants of the domain checks (today they throw on the first failure). Depends on decision D2, because it relaxes the "no field hints" rule.

### P3 — Published vs draft comparison

- The history panel's «Cambios frente a lo publicado» can be computed by the FE from the existing read (`draft` and `published` documents are both returned to an authorized editor). No backend work unless the human wants a server-side diff (decision D7).

### P4 — Published content in the public catalog (C3.3)

- Accepted rule S3 «Solo publicados»: products without a Published editorial are excluded from listings and their detail returns 404.
- Published title and description feed the card and detail; attributes are projected by exposure: FACET (filter + detail), DETAIL (detail only), INTERNAL never. Evidence, facts, care review and attestation are never exposed.
- Facet filters with OR within a facet, AND between facets, counts excluding the own facet, unique products before pagination (accepted C3.3 scope).
- **Rollout risk:** turning P4 on hides every product that has not been published. It needs a switch per tenant (or a migration window) so the public catalog does not go empty (decision D3).

## 3. What the frontend needs (from the FE session)

- Readiness per section, to fill the section index with missing counts (P2).
- Draft vs published state and the published revision (already in the read).
- «Cambios frente a lo publicado» (P3).
- A publish button that is enabled only when readiness is `ready: true` (P1 + P2).
- The «Publicar» button lives in the new save bar next to «Guardar»: «Guardar» first, then «Publicar» becomes primary when there are no unsaved changes and `ready: true`.
- With `ready: false`, «Publicar» is disabled and the explanation is the readiness list grouped by section (design-system Issue checklist pattern), not a tooltip.
- Header state: «Borrador», or «Publicado · 4 nov» plus «Cambios sin publicar» when draft and published differ.

## 4. Accepted decisions that apply

- **S3:** «Solo publicados (recomendado)» — unpublished products are excluded from the list and the detail returns 404.
- **S33:** numeric values with a pending policy can be saved; publishing returns `400 MALFORMED` until resolved (already implemented in the domain).
- **S88:** «Es solo equipamiento» habitat exception, with source, date and justification (pending implementation).
- **S89:** the same known magnitude in every offered variant, without aggregation or inheritance; with no offered presentation, the draft stays unpublished (pending wiring).
- **S32 vs S35:** S32 (`409 EDITORIAL_ADOPTION_REQUIRED` / `EDITORIAL_CLIENT_UPGRADE_REQUIRED`) appears superseded by S35 («podemos quitar la v1 por completo… supersedes earlier compatibility/adoption requirements»). To confirm in D1.

## 5. Decisions for the human

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Do the adoption/upgrade `409` errors from S32 still exist? | (a) No, S35 removed v1: publish errors are only `MALFORMED`, `CONFLICT`, `VOCABULARY_CHANGED`. (b) Keep them. | (a) |
| D2 | May the backend tell the editor exactly what is missing (readiness endpoint with per-field items)? | (a) Yes, `GET …/draft/readiness`. (b) No, the FE recomputes the rules itself. | (a): the rules live in the backend; duplicating them in the FE drifts. |
| D3 | How does the public catalog switch to «Solo publicados» without emptying it? | (a) Per-tenant switch, turned on after publishing the products. (b) Products without editorial keep showing their operational name and description until published. (c) Switch all at once. | (a) |
| D4 | What does the public catalog show from the editorial? | (a) Title, description and FACET/DETAIL attributes, with editorial title and description replacing the operational ones. (b) Same but showing both. (c) Title only at first. | (a) |
| D5 | A variant that becomes offered after publishing (new price list, new variant) | (a) Hide that variant until republished. (b) Hide the whole product. (c) Show it with the published product data. | (a) |
| D6 | Do we need «Despublicar» before the public catalog uses editorial? | (a) Yes, a simple unpublish. (b) Later. | (a): with «Solo publicados», unpublishing is the only way to pull a product from the catalog. |
| D7 | «Cambios frente a lo publicado» | (a) The FE computes it from draft vs published. (b) A backend diff endpoint. | (a) |
| D8 | Collars and other obviously non-electrical, non-container accessories are asked «¿Es eléctrico?» and «¿La capacidad determina la elección?», and an unknown answer blocks publishing. | (a) Keep asking (one click each). (b) Per accessory type defaults (for example collar, arnés, correa → «No»), editable. (c) Do not ask for those types at all. | (b) |
| D9 | Must every known value have evidence (source and date) to publish? | (a) Yes, as the contract says. (b) Only for health, care and regulatory fields. | Human call: (a) is stricter and slower to fill; (b) eases editing. |
| D10 | A product that is not offered anywhere (no online price list) | (a) Cannot publish (S89 blocks it). (b) Can publish the product-level data. | (a), consistent with S89. |
| D11 | Care warnings marked «must be shown to the public» | (a) Block publishing until the public treatment exists. (b) Publish without them. | (a) |

## 6. Effort (rough)

- P1: large (new writer, locks, receipts, full rule chain, tests per family).
- P2: medium (collecting variants of the checks, endpoint, contract).
- P3: none or small.
- P4: large (public projection, facets, search, rollout switch).

Suggested order: D1–D3 decided → P1 + P2 together (the FE gets an enabled publish button with a reliable checklist) → P4 behind the switch.
