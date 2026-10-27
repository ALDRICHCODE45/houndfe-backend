# Editorial read HTTP transport

This slice registers only `GET /products/:productId/editorial`. Source registration does not deploy or restart the shared API; this worktree has not activated API3000.

## Request and authorization
Use the existing Bearer authentication. Product must be a UUID. No query fields or nonempty decoded request body are accepted.
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
No initialize/save/create/definitions endpoint, publication, media access, new grant, migration or database is enabled. Write transport awaits real qualified DocumentAuthority and separate implementation; definitions awaits its concrete payload/auth contract.
