# Publication readiness V2 (P2)

`GET /products/:productId/editorial/draft/readiness` reports everything that
blocks publishing the **saved** Draft. `ready: true` ⇔ `items` is empty ⇔ the
V2 publish validation passes for that saved state.

## One rule implementation

Every throwing publication gate delegates to a collecting rule function, so
publish and readiness cannot diverge:

| Throwing gate                                                   | Rule it delegates to                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `assertSelectedBindingReadinessV2`                              | `selectedBindingProblemV2`                                                |
| `assertEditorialEvaluationReadinessV2`                          | `collectEditorialEvaluationProblemsV2`                                    |
| `assertFreshNAAdmissionV2`                                      | `collectFreshNAAdmissionProblemsV2`                                       |
| `assertFreshNumericPayloadV2` / `assertFreshNumericAdmissionV2` | `freshNumericPayloadProblemV2` / `collectFreshNumericAdmissionProblemsV2` |
| `assertFreshDocumentLimitsV2`                                   | `freshDocumentLimitProblemsV2`                                            |
| `admitFreshDocumentV2`                                          | `collectFreshDocumentAdmissionV2`                                         |
| `assertContentKindAgreementV2`                                  | `contentKindAgreementProblemV2`                                           |
| `assertToyDeterminationAgreementV2`                             | `toyDeterminationProblemV2`                                               |
| `assertFactConsistencyV2`                                       | `hasFactConflictV2`                                                       |
| `assertCarePublicationReadinessV2`                              | `carePublicationReadinessGapsV2`                                          |
| `conserveArchivedOptionsV2`                                     | `collectArchivedOptionConservationV2`                                     |

Structural violations (references, facts capture/qualification, care capture,
an unbound option) are not collectable: they still throw `MALFORMED`, and
readiness reports them as one `DRAFT_INVALID` product item.

`evaluatePublicationReadinessV2({document, references, vocabulary,
offeredSubjects, publishedDocument})` runs, in order: fresh admission in
`'publish'` mode; empty E; null family; archived-option conservation against
the current Published (null → empty); the evaluation set over E with binding
readiness; and, per offered subject, fact consistency, S89 `content.kind`
agreement (the subject's own assignment and facts, no aggregation or
inheritance), toy determination (`toy` family) and care review readiness
(`care` family). The output is deduplicated and ordered product → care →
variant → definition, then by E order and binding order.

The readiness GET and the publish writer share one infrastructure step,
`assessSavedDraftV2` (`prisma-editorial-draft-readiness-v2.ts`): parse the saved
Draft (unparseable → `DRAFT_INVALID`), read references (snapshot for the GET,
locked for publish) and E (`readEditorialOfferedSubjectsV2`), evaluate, then
`presentPublicationReadinessV2`. Publish calls it after CAS and the R pin under
its locks; a not-ready result is its `400` body, and only a ready draft reaches
`buildFreshCareAttestationV2`.

## Malformed input never becomes a 500 (L5)

Collecting rules keep running after a collectable problem, where the old
asserts stopped. Reference admission still runs first and throws `MALFORMED`,
so every later rule sees reference-admitted values; facts qualification, care
capture and an unbound NA still throw `MALFORMED`, which readiness turns into
one `DRAFT_INVALID`. The integration spec proves it on 15 shape-valid malformed
documents, each alone and combined with collectable problems (over-long title,
bad evidence, out-of-range number): save → `MALFORMED`, readiness → items,
publish → `400` with items, never a `TypeError`. No precondition fix was needed.
Initialize copying a Published that is not a recognizable V2 document is still
`500` by contract (the recorded-state decoder, as the document GET).

## Transaction

One `READ ONLY` RepeatableRead transaction: product, vocabulary, state,
references (`readEditorialReferencesSnapshot`, lock-free because PostgreSQL
rejects `FOR SHARE` in read-only transactions) and E all come from one
snapshot. There are no locks, writes or receipts.

## Request and errors

The request admission is the editorial read's: principal tenant only, current
`ProductEditorialDraft:read`, no query, no body, no write headers, and exactly
one valid `Editorial-Vocabulary-Revision`. A different current R is
`409 VOCABULARY_CHANGED`, an unknown product is `404 NOT_FOUND`. Responses carry
`Cache-Control: no-store`, `Editorial-Contract-Version: 2` and the revision.

**No draft (decision):** `200` with `ready: false`, `draftRevision: null` and
one product item `NO_DRAFT`, like the read, which also returns `200` with a
null draft. A stored draft that is not a V2 document gives one `DRAFT_INVALID`.

## Problem codes and messages

`message` is es-MX with «tú». The FE agreed on the first eight codes; the
others were added because a real publish rule needs them.

| scope      | problem                        | message                                                                                                                                 |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| definition | `REQUIRED_MISSING`             | «Falta el peso neto.» / «Falta la especie.» / «Faltan los ingredientes.»; customized, custom or adjective labels: «Completa «{label}».» |
| definition | `UNRESOLVED`                   | Responde las preguntas de la presentación para saber si este dato aplica.                                                               |
| definition | `EVIDENCE_REQUIRED`            | Agrega de dónde sale este dato.                                                                                                         |
| definition | `NA_NOT_ALLOWED`               | Este dato sí aplica: no lo marques como «No aplica».                                                                                    |
| definition | `MAGNITUDE_MISMATCH`           | El tipo de contenido no coincide con cómo se mide el contenido de la presentación.                                                      |
| definition | `NUMERIC_POLICY_PENDING`       | Este dato todavía no tiene reglas de captura; pide a un administrador que las defina.                                                   |
| product    | `NO_OFFERED_PRESENTATION`      | El producto no se ofrece en ninguna lista de precios en línea.                                                                          |
| care       | `CARE_REVIEW_INCOMPLETE`       | see the care table below                                                                                                                |
| definition | `NOT_APPLICABLE_VALUE` (added) | Este dato no aplica a este producto; quítalo.                                                                                           |
| definition | `INVALID_VALUE` (added)        | Revisa este valor: está fuera del rango permitido.                                                                                      |
| definition | `TOY_TYPES_MISMATCH` (added)   | Las medidas de la presentación deben cubrir exactamente los tipos de juguete elegidos.                                                  |
| definition | `ARCHIVED_OPTION` (added)      | Esta opción ya no está disponible; elige otra.                                                                                          |
| variant    | `FACTS_CONFLICT` (added)       | Hay respuestas que se contradicen en las preguntas de esta presentación.                                                                |
| product    | `REQUIRED_MISSING` (title)     | Falta el título comercial.                                                                                                              |
| product    | `REQUIRED_MISSING` (family)    | Elige el tipo de producto.                                                                                                              |
| product    | `MEDIA_NOT_ALLOWED` (added)    | Quita las imágenes: todavía no se pueden publicar.                                                                                      |
| product    | `DRAFT_INVALID` (added)        | Tu borrador ya no coincide con el producto o el vocabulario actual; revísalo y guárdalo de nuevo.                                       |
| product    | `NO_DRAFT` (added)             | Todavía no hay un borrador guardado; guarda tus cambios para revisar qué falta.                                                         |

Care items, one per distinct gap and offered subject (`variantId` is the subject):

| gap                                              | message                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| missing, unknown or unprepared review            | Completa la revisión de cuidado de esta presentación.                                  |
| no review evidence                               | Agrega de dónde sale la revisión de cuidado.                                           |
| `none_applicable` with entries                   | Si no aplica ningún requisito, quita los requisitos y las advertencias de la revisión. |
| `identified` without requirements                | Agrega al menos un requisito a la revisión de cuidado.                                 |
| requirement not satisfied/NA or without evidence | Resuelve cada requisito de cuidado y agrega de dónde sale.                             |
| `public_required` warning (D11)                  | Hay una advertencia que se debe mostrar al público; por ahora no se puede publicar.    |
| unresolved warning or without evidence           | Indica cómo se maneja cada advertencia y agrega de dónde sale.                         |

`sectionCode` comes from `FAMILY_SECTIONS`. It is null for non-definition
items, non-production families and unsectioned definitions. `bySection` counts
definition items per section.

## Decisions and pending

- **Confirmed (T3):** a draft without a family cannot publish
  (`REQUIRED_MISSING`, family). Single contract §7 defines publication minima
  only per family, and §3 makes a null family carry no values or facts, so a
  family-less publish would skip every completeness rule.
- **Confirmed (T3):** readiness requires exactly one
  `Editorial-Vocabulary-Revision` and answers `409 VOCABULARY_CHANGED` on a
  different R. Single contract §2 pins every document-bearing GET to R, items
  carry vocabulary labels and section codes, and the FE installs vocabulary and
  document only with equal R. The FE reloads the vocabulary and retries once.
- D9: all production policies set `evidenceRequired: true`. Missing evidence
  is checked by binding readiness over the evaluation set, so it is required for
  known product-level values and known values of offered subjects (E). A value
  only on a non-offered variant is not checked for missing evidence; evidence
  that is present must still be fresh on every value (fresh admission). Custom
  option-case policies keep their own `evidenceRequired` flag.
- S88 «Es solo equipamiento» (habitat equipment-only exception) is still not
  implemented and stays out of scope. It is an extra exception, not a gate:
  habitat already publishes through its declared facts (`relevantDimensionCodes`,
  `relevantCapacityCodes`, `electricalApplies`, `relevantEquipmentCodes`).
  Undeclared space facts leave the space bindings `UNRESOLVED`. Pinned on
  PostgreSQL by the habitat cases of the readiness and publish integration specs.
