# Editorial HTTP transport

This module registers `GET /products/:productId/editorial` (read), `POST /products/:productId/editorial/draft/initialize`, `PUT /products/:productId/editorial/draft`, and `POST /products/:productId/editorial/draft/publish` and `/discard` (see the write sections below and `docs/catalog-editorial-editor-contract-proposal.md`). Source registration does not deploy or restart the shared API; this worktree has not activated API3000.

## Request and authorization

Use the existing Bearer authentication. Product must be a UUID. No query fields are accepted. Read rejects a nonempty decoded request body; writes accept only their closed bodies below.
Actor and concrete tenant come only from the authenticated principal; tenant headers cannot override them. Superadmin is not a tenant or editorial-permission bypass.
The real authority rechecks active user, current membership, tenant-qualified Product and exact `ProductEditorialDraft:read`. Wildcards, Product permissions and update alone do not grant read.

## Responses

Success: HTTP 200 with `Cache-Control: no-store` and the core's `{cycle,draft,published,warnings?}` payload unchanged.
No editorial state: `{cycle:null,draft:null,published:null}`. Read does not recompute warnings or validate persisted documents against current vocabulary.
The localized Nest route/guard error envelope is `{statusCode,error}`: 400/MALFORMED, 401/UNAUTHORIZED, 403/FORBIDDEN, 404/NOT_FOUND, 409/CONFLICT, or sanitized 500/INTERNAL_ERROR. Raw exception messages are not returned.
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

POST `/products/:productId/editorial/draft/publish` and POST
`/products/:productId/editorial/draft/discard` both return `200 EditorialState`,
including replay. Each accepts only `{ expectedCycle, expectedRevision }`, both
positive integers, with no other body keys or query parameters. Both require the
untrimmed 1–200 character `Idempotency-Key` header. Actor and tenant come only
from the principal; JWT and tenant guards, UUID parsing, and
`Cache-Control: no-store` on success and error match initialize/save.

Publish requires exact `ProductEditorialDraft:read` + `:publish`, not update;
discard requires exact `:read` + `:update`. Wildcards and Product permissions do
not grant either operation. Publish revalidates the stored draft, requires a
nonblank commercial title and empty mediaRefs, copies it unchanged to Published
at the next published revision, and clears draft. Discard clears draft without
document validation and leaves Published unchanged. Both retain cycle.

Errors use exactly `{ statusCode, error }`: `400 MALFORMED` for body/header/UUID
or invalid draft on publish; `401 UNAUTHORIZED` for authentication;
`403 FORBIDDEN` for authority failure, including unavailable or foreign Product;
`404 NOT_FOUND` only if Product disappears after authorization;
`409 CONFLICT` for no active draft, stale cycle/revision, or key/body mismatch.
Unexpected errors are sanitized as `500 INTERNAL_ERROR`.

Each operation has its own receipt namespace scoped to tenant, product, actor
and key. Same key and body return the recorded result without restoring old
state or republishing; replay still checks authority and Product existence.
See [the closed contract](catalog-editorial-publish-contract-proposal.md) and
[transaction details](catalog-editorial-write-transactions.md).
