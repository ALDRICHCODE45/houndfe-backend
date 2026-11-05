# Editorial publication V2 (P1 publish + P2 readiness)

Branch `feat/editorial-publish-v2` (worktree `.tmp/publish-v2`, base local main `11f0801`). Implements slices P1 and P2 of `docs/editorial-publication-design-proposal.md` with the human decisions of 2026-11-05 (L1). P3 is FE-only; P4 (public catalog) and D6 (unpublish) are later features.

## Specs

- **S1 Decisions applied (L1).** D1 (a): publish errors are only `400 MALFORMED`, `409 CONFLICT`, `409 VOCABULARY_CHANGED` (plus auth/tenant errors); no adoption/upgrade 409s (S35 supersedes S32). D2 (a): the backend reports what is missing. D9 (a): every known value needs fresh evidence (source and date) to publish. D10 (a): a product with no offered presentation cannot publish. D11 (a): care warnings that must be shown publicly block publishing.
- **S2 Readiness endpoint (P2).** `GET /products/:productId/editorial/draft/readiness`, read-only, no writes, same auth/tenant/permission rules as the editorial read (`ProductEditorialDraft:read`), `Cache-Control: no-store`. Evaluates the **saved** draft with the same chain as publish, in collecting mode. Response shape agreed with the FE (proposal §2 P2):
  `{ ready, cycle, draftRevision, vocabularyRevision, items: [{ scope, definitionCode, variantId, sectionCode, problem, message }], bySection: { [sectionCode]: count } }`.
  `scope` ∈ `definition|variant|product|care`; non-definition items have `definitionCode: null`, `sectionCode: null`; `variantId: null` = product level; `sectionCode` comes from the family sections map; `message` is es-MX with «tú». Problems: `REQUIRED_MISSING`, `UNRESOLVED`, `EVIDENCE_REQUIRED`, `NA_NOT_ALLOWED`, `MAGNITUDE_MISMATCH`, `CARE_REVIEW_INCOMPLETE`, `NUMERIC_POLICY_PENDING`, `NO_OFFERED_PRESENTATION` (add only if a real rule needs another; document it). No draft → `ready: false` with a single `product` item, or 404 consistent with the editorial read (decide and document). `ready: true` ⇔ `items` empty ⇔ publish would pass validation.
- **S3 Publish V2 (P1).** `POST /products/:productId/editorial/draft/publish` keeps its route, permission (`read` + `publish`), body `{expectedCycle, expectedRevision}`, `Idempotency-Key` and `no-store`, but runs a V2 writer modeled on the V2 discard writer: authority, lock order (catalog lifecycle SHARE → Tenant SHARE → Product UPDATE → state FOR UPDATE, then the vocabulary SHARE locks), receipt replay, cycle/revision CAS (`409 CONFLICT`), vocabulary-revision pin (`409 VOCABULARY_CHANGED`), V2 receipt, `StateV2` response. Effect as today: draft copied to Published as stored, `publishedRevision + 1`, draft cleared, cycle kept, only latest Published kept. The legacy v1 publish path is removed.
- **S4 Publish validation = readiness.** Publish runs exactly the readiness evaluation inside its transaction; if it is not ready it returns `400` with body `{ statusCode: 400, error: "MALFORMED", items, bySection }` (same items as S2) and changes nothing. Care family: fresh care attestation built and stored in the receipt as the domain already specifies (`buildFreshCareAttestationV2`).
- **S5 Rules wired.** Fresh admission in `'publish'` mode (title non-blank, media empty, evidence, numeric policy S33, N/A), offered subjects (E), evaluation set with `publicationCheck` always/when_asserted, binding readiness, S89 content-kind agreement per offered subject (no aggregation or inheritance; empty E blocks), toy determination, care readiness. S88 «Es solo equipamiento» stays out of scope (document as pending).
- **S6 Contract docs + FE handoff.** Update the editorial contract docs and add `docs/frontend-handoff/05-editorial-publish-readiness.md` (index in `docs/frontend-handoff/README.md`) with endpoints, examples, errors and every problem code with its message.
- **S7 Proof.** Integration tests against PostgreSQL per family with real V2 drafts (ready and each problem), concurrency publish vs save/discard, replay, stale CAS, vocabulary change; runtime probe over real HTTP on the dev DB with a showcase product made publishable.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 collecting readiness evaluator (domain) | S1 S2 S5 | worker | |
| T2 readiness endpoint | S2 | worker (with T1) | |
| T3 V2 publish writer replacing legacy | S3 S4 S5 | worker | |
| T4 docs + FE handoff | S6 | worker (with T3) | |
| T5 runtime proof | S7 | worker | |

## Log

- L1 (human, 2026-11-05, answer to «D. Publicación editorial … ¿Cómo seguimos?»): «Arrancar con tus recomendaciones» — option text: «El backend dice qué falta (D2); «Solo publicados» con interruptor por sucursal (D3); collares/correas «No es eléctrico» por defecto (D8); evidencia obligatoria en todo dato conocido (D9 estricto). Empiezo por P1+P2.» Recommendations of `docs/editorial-publication-design-proposal.md` §5 apply to the other decisions (D1 a, D4 a, D5 a, D6 a, D7 a, D10 a, D11 a).
- L2 FE readiness contract (FE session, 2026-11-05 08:13Z): «`message` en cada item: texto para humanos, armado por el BE, en español neutro de México con tú… `scope: "definition" | "variant" | "product" | "care"` y permití `definitionCode: null` y `sectionCode: null`… `draftRevision` (o el cycle/revision) con el que se calculó… El `400 MALFORMED` de publish tiene que devolver el MISMO `items[]`… `variantId` null significa nivel producto… Opcional: `bySection: { [sectionCode]: count }`.»
- L3 Code map: Engram `editorial/publication-gaps` (legacy publish `prisma-catalog-editorial.ts:220-381`, V2 discard writer `prisma-editorial-discard-writer.ts:22-126` as pattern, unwired V2 rule modules).
- L4 Deferred: D3 tenant switch and C3.3 projection (P4), D6 unpublish, D8 accessory per-type defaults («collar, arnés, correa → «No»», editable) — next features.
