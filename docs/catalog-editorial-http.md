# Editorial HTTP transport

This module registers `GET /products/:productId/editorial` (read), `POST /products/:productId/editorial/draft/initialize`, `PUT /products/:productId/editorial/draft`, and `POST /products/:productId/editorial/draft/publish` and `/discard` (see the write sections below and `docs/catalog-editorial-editor-contract-proposal.md`). Source registration does not deploy or restart the shared API; this worktree has not activated API3000.

## Request and authorization

Use the existing Bearer authentication. Product must be a UUID. No query fields are accepted. Read rejects a nonempty decoded request body; writes accept only their closed bodies below.
Actor and concrete tenant come only from the authenticated principal; tenant headers cannot override them. Superadmin is not a tenant or editorial-permission bypass.
The real authority rechecks active user, current membership, tenant-qualified Product and exact `ProductEditorialDraft:read`. Wildcards, Product permissions and update alone do not grant read.

## Responses

Success: HTTP 200 with `Cache-Control: no-store` and the core's `{cycle,draft,published,warnings?}` payload unchanged.
No editorial state: `{cycle:null,draft:null,published:null}`. Read does not recompute warnings or validate persisted documents against current vocabulary.
The localized Nest route/guard error envelope is `{statusCode,error}`: 400/MALFORMED, 401/UNAUTHORIZED, 403/FORBIDDEN, 404/NOT_FOUND, 409/CONFLICT, 409/EDITORIAL_STATE_UNREADABLE (a stored Draft or Published slot that does not decode as V2, for example a legacy document; never 500), or sanitized 500/INTERNAL_ERROR. Raw exception messages and stored document contents are not returned.
An unavailable or foreign Product normally fails authority with 403; 404 can occur after authority if the Product disappears. No universal 404 promise. Framework parser/unmatched-route errors are outside this localized envelope.

## Wiring and proof

The root registers `CatalogEditorialReadModule`; existing root Prisma/CLS providers and Passport JWT strategy supply dependencies. Tests import the read module, never AppModule/AuthModule or Prisma lifecycle.
Run `node_modules/jest/bin/jest.js --config src/catalog-editorial/http/editorial-read.config.cjs --runInBand` with the resolved Node under `env -i PATH=/usr/bin:/bin NODE_ENV=test FORCE_COLOR=0`.
The isolated HTTP suite uses real core/authority with synthetic authenticated principals and Prisma responses. It proves neither JWT cryptography, SQL execution, atomic revocation nor shared-runtime availability.

## Phase A implemented

POST `/products/:productId/editorial/draft/initialize` returns 201; PUT `/products/:productId/editorial/draft` returns 200, including replay.
Both require an untrimmed 1–200 character `Idempotency-Key` and the closed v3.1 bodies. Principal scope, guards, no-store and errors follow H1.
The fifth constructor argument supplies transaction-scoped coordinated create/save and document authorities; legacy arguments 3/4 stay undefined. Writes require exact `ProductEditorialDraft:read` plus `:update`, never `manage:all`.
Documents pass unchanged to core validation; HTTP adds no document limits.
Create(document) and media remain unexposed. No deployment or DB execution is implied. Tests use synthetic auth and mocked persistence, not live SQL or JWT proof.

## Publish and discard implemented

Both routes run V2 writers (`PrismaEditorialPublishWriter`,
`PrismaEditorialDiscardWriter`); the legacy v1 publish/discard path is removed.
POST `/products/:productId/editorial/draft/publish` and
`/draft/discard` accept only `{ expectedCycle, expectedRevision }` (positive
integers), require `Idempotency-Key` (1–200, untrimmed) and exactly one
`Editorial-Vocabulary-Revision`, and return `200 StateResponse` (V2 envelope,
also on replay). Publish additionally accepts at most one
`Editorial-Care-Confirmation: review-v1`; obsolete `Editorial-Contract-Version`
and `Editorial-Adoption` request headers are `400 MALFORMED`.

Publish requires `ProductEditorialDraft:read` + `:publish` (not update);
discard requires `:read` + `:update`. Publish runs the saved-draft readiness
(the same evaluation as `GET …/draft/readiness`) and copies the stored Draft
unchanged to Published at the next revision. An unready draft is
`400 { statusCode, error: "MALFORMED", items, bySection }`, the only editorial
error with a body beyond `{ statusCode, error }` (decision D2).

Errors: `400 MALFORMED` (wire/headers, not-ready draft, care confirmation
missing on a ready care draft or present on another family); `401`; `403`;
`404` (Product lost after authorization); `409 CONFLICT` (stale/absent draft,
same key with another intent); `409 VOCABULARY_CHANGED`; sanitized `500`.
See [publication readiness](catalog-editorial-publication-readiness-v2.md),
[the single contract](catalog-editorial-single-contract.md) and the FE handoff
[05-editorial-publish-readiness.md](frontend-handoff/05-editorial-publish-readiness.md).
