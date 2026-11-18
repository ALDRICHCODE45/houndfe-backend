# editorial-live harness (disposable, opt-in)

Standalone test-support server for the frontend's editorial e2e
(`frontend-houndfe` `e2e/editorial-live`). It follows the cash-live pattern:
it boots the REAL editorial + products modules (real controllers, real
`JwtAuthGuard` + `TenantContextGuard` + `EditorialHttpScope` +
`PrismaEditorialAuthority`, real `PermissionsGuard`/CASL, real tenant CLS,
real Prisma) against a dedicated disposable PostgreSQL database, seeds a
fictional dataset per run, signs production-shaped JWTs for four actors and
writes a fixture file the frontend reads.

Test support only: no production code is changed, and it is NOT part of the
normal suite (`jest.config.js` roots are `src` + `prisma`).

## Reuse of cash-live (no copied security code)

| Concern | Source |
| --- | --- |
| Credential denylist (`RESEND_API_KEY`, `AWS_*`, `INNGEST_*`) | `../cash-live/disposable-env` `checkDeniedExternalEnv` |
| Disposable-DB guard | `../cash-live/disposable-env` `checkDisposableDatabaseUrl(input, EDITORIAL_LIVE_DATABASE_PROFILE)` |
| Origin / fixture-path / JWT secret / TTL config | `../cash-live/live-config` `loadLiveHarnessConfig(env, EDITORIAL_LIVE_CONFIG_PROFILE)` |
| Prisma dotenv block + fail-closed post-check | `../cash-live/dotenv-isolation` `loadWithPrismaDotenvBlock` |
| Offline MAILER | `../cash-live/offline-mailer` `OfflineNoSendMailer` |
| Exclusive 0600 fixture write, backend HEAD | `../cash-live/secure-fixture-write`, `../cash-live/fixture` |

The cash-live modules gained optional profile parameters whose defaults are
cash-live's exact previous behavior (5432/5433 stay forbidden for EVERY
profile — a profile can only add ports).

## Commands

```bash
# Offline checks (no DB, no listening server). startup.spec.ts spawns child
# `node -r ts-node/register` processes under a minimal env that only import
# the graph / compile the Nest module, or that must be REFUSED by the guards.
pnpm exec jest --config jest.config.js --roots test/editorial-live

# Type-check (offline):
pnpm exec tsc --noEmit -p test/tsconfig.json

# Positive global-mode HTTP specs (S3, offline, mocked Prisma):
pnpm test src/catalog-editorial/http/editorial-readiness.http.spec.ts \
  src/catalog-editorial/http/editorial-unpublish.http.spec.ts
```

Live run (parent-authorized only; the disposable database must already
exist and be migrated) with a MINIMAL environment:

```bash
env -i \
  PATH="$PATH" HOME="$HOME" \
  EDITORIAL_LIVE_DISPOSABLE=1 \
  DATABASE_URL="$EDITORIAL_LIVE_DATABASE_URL" \
  EDITORIAL_LIVE_DATABASE_URL="$EDITORIAL_LIVE_DATABASE_URL" \
  node -r ts-node/register -r tsconfig-paths/register test/editorial-live/server.ts
# optionally TS_NODE_TRANSPILE_ONLY=1 in the same env -i list
```

The harness NEVER loads `.env`.

## Environment

| Name | Required | Rule |
| --- | --- | --- |
| `EDITORIAL_LIVE_DISPOSABLE` | yes | exactly `1` |
| `DATABASE_URL` | yes | identical to `EDITORIAL_LIVE_DATABASE_URL` |
| `EDITORIAL_LIVE_DATABASE_URL` | yes | `postgresql://editorial_live:<pw>@127.0.0.1:<port>/editorial_live_test`; port not 5432/5433/5434; no query string, no fragment |
| `EDITORIAL_LIVE_FRONTEND_ORIGIN` | no | loopback http(s) origin with explicit port; default `http://127.0.0.1:4191`; the single CORS entry (production `editorialCors` delegate) |
| `EDITORIAL_LIVE_FIXTURE_PATH` | no | inside the repo; default `.tmp/editorial-live/fixture.json` |
| `EDITORIAL_LIVE_JWT_SECRET` | no | used when >= 32 chars, else generated in memory (never logged/written) |
| `EDITORIAL_LIVE_ACCESS_TTL_SECONDS` | no | integer 60..86400, default 7200 |
| `RESEND_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `INNGEST_EVENT_API_KEY`, `INNGEST_SIGNING_KEY` | must be ABSENT | refused before the graph import and re-checked after it |

`CASH_LIVE_*` variables are ignored. Rejection reasons name variables and URL
components only — never values.

## Startup order

1. `server.ts` statically imports only `node:crypto`, `./editorial-env`,
   `./editorial-graph` and `../cash-live/disposable-env` (enforced by
   `startup.spec.ts`).
2. Credential denylist, then the disposable-DB guard, then config.
3. `loadEditorialGraph()` installs cash-live's Prisma dotenv block and only
   then dynamically imports Nest + Prisma; fails closed if the block was not
   applied.
4. Tripwire: credential denylist again.
5. Module compile + `init` (production `PermissionSeeder` upserts the
   registry and the system `Super Admin` role), seed (one transaction),
   tokens, `listen(0, '127.0.0.1')`, fixture, ready line.

## Module boundary

ConfigModule (`ignoreEnvFile` + `skipProcessEnv`, only JWT secret + TTL),
ClsModule, `EventEmitterModule.forRoot()` (needed by ProductsModule's
OutboxModule; no ScheduleModule, so pollers never tick), DatabaseModule,
AuthModule, `CatalogEditorialReadModule` + `CatalogEditorialVocabularyModule`
(the 9 editorial routes), `ProductsModule` (`GET /products/:id`).
Offline overrides only: `MAILER` (OfflineNoSendMailer), `'S3_CLIENT'` and
`STORAGE_PORT` (refuse every call; FilesModule would otherwise demand
`SPACES_*` credentials). Global pipe/filters match `src/main.ts`.

## Seed (per run id, one transaction)

- `seedEditorialPostgres` (`src/catalog-editorial/infrastructure/editorial-coordination-postgres-fixture.ts`)
  reused as-is: tenant A, foreign tenant, the editorial-only user + tenant-A
  role with exactly `ProductEditorialDraft` read + update, the product
  (variant, price list, private media) in tenant A, a foreign product, one
  editorial family/definition/binding/options.
- S4 enablement, mirroring `scripts/editorial-draft-runtime/host.cjs`:
  `UPDATE editorial_bindings SET "publicationCheck"='when_asserted',
  policy='{"route":"pending"}'` for the run's family (the V2 family shape
  rejects null `publicationCheck`/`policy`, which would make the vocabulary
  unreadable), and `editorial_vocabulary_metadata ('global',
  'editorial-production-1')` inserted only when absent (fails closed if a
  different version is stored).
- Tenants renamed `Editorial Live Tenant A <runId>` /
  `Editorial Live Foreign Tenant <runId>`; product renamed
  `Editorial Live Product <runId>`.
- Global `Super Admin` role exactly as PermissionSeeder/prisma/seed.ts shape
  it (find `{name:'Super Admin', tenantId:null}` or create `isSystem:true`,
  link `manage:all`), with one membership per seeded tenant for each Super
  Admin user — the membership `hasGlobalEditorialAdministrator` requires.

## Actors (four distinct users)

| Key | Token claims | DB authority |
| --- | --- | --- |
| `superadmin-global` | `tenantId: null`, `tenantSlug: null`, `isSuperAdmin: true` | system Super Admin role (tenantId null) + memberships in both tenants |
| `superadmin-tenant` | tenant A, `isSuperAdmin: true` | another user with the same Super Admin role/memberships |
| `manage-all` | tenant A, `isSuperAdmin: false` | tenant-A role with `manage:all` |
| `editorial-only` | tenant A, `isSuperAdmin: false` | tenant-A role with `read:ProductEditorialDraft` + `update:ProductEditorialDraft` only |

Tokens: production final payload `{ sub, email, tenantId, tenantSlug,
isSuperAdmin }`, signed by the module's real `JwtService`; access-only (no
refresh token, no OTP).

`editorial-only` has no `read:Product`, so `GET /products/:id` returns 403
for it by design (only editorial permissions were requested).

## Fixture (frontend contract, schemaVersion 1)

Written 0600 via an exclusive `O_EXCL | O_NOFOLLOW` handle (never
overwritten); the parent copies it to the frontend.

```text
{ schemaVersion: 1,
  backend: { url, basePath: "", resourceId },
  frontendOrigin: "http://127.0.0.1:4191",
  tenants: [{ id, name, slug }, ...],                 // A, foreign
  product: { id, tenantId: <A>, name, disposable: true },
  actors: {
    "superadmin-global": { isSuperAdmin: true, tenantId: null, tenant: null, permissionCodes: [], memberships: [], ... },
    "superadmin-tenant": { isSuperAdmin: true, tenantId: <A>, tenant: <A>, ... },
    "manage-all":        { isSuperAdmin: false, permissionCodes: ["manage:all"], tenant: <A>, ... },
    "editorial-only":    { isSuperAdmin: false, permissionCodes: ["read:ProductEditorialDraft", "update:ProductEditorialDraft"], tenant: <A>, ... } },
  metadata: { owner, backendHEAD, resourceId, generatedAt,
              cleanup: { runId, owner: "parent/operator", deletesAnything: false, instructions },
              accessOnly: true, refreshTokenIssued: false, otpIssued: false } }
```

Every actor: `userId, email, tenantId (= tenant.id; null for global),
isSuperAdmin, permissionCodes, accessToken, tenant {id,name,slug} | null,
user {id,email,name,isActive,createdAt}, memberships
[{tenantId,tenantName,tenantSlug,roleName}], expiresAt, ttlSeconds`.
`superadmin-global` shows empty codes/memberships as frontend display data;
its database memberships still exist. `superadmin-tenant` lists its real
`manage:all` code and Super Admin memberships.

stdout: exactly one ready line
`{"ready":true,"baseURL":"http://127.0.0.1:<port>","resourceId":"<uuid>","fixturePath":"<abs path>"}`.
Tokens never appear in logs.

## Flow supported (S4)

`GET /catalog-editorial/vocabulary` (revision) → `GET /products/:id/editorial`
→ `POST /products/:id/editorial/draft/initialize` `{expectedCycle:null}` (201)
→ `PUT /products/:id/editorial/draft` (title change, 200)
→ `POST /products/:id/editorial/draft/discard` (200). No publish.

## Cleanup

SIGTERM / SIGINT close Nest and Prisma. The harness never deletes anything
(database, container or fixture); the parent/operator owns teardown. Each
run seeds new run-id-named rows.

## Limits

Offline evidence (guards, compile, seed shape with a recording fake, token
claims, fixture schema) is not proof of a correct live run; T2 (parent-run
live session on a disposable DB) remains the definitive verification.
