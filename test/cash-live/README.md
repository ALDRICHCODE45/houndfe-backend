# cash-live harness (disposable, opt-in)

Standalone test-support server for the joint frontend/backend cash-register
verification. It boots the REAL backend modules (real controllers, real
`JwtAuthGuard` + `TenantContextGuard` + `PermissionsGuard`, real tenant
CLS, real Prisma) against a dedicated disposable PostgreSQL database,
seeds a small fictional dataset, signs production-shaped JWTs for three
fictional actors, and writes a fixture file the frontend reads.

It is **test support only** — no production code was changed, and it is
NOT part of the normal test suite (it is excluded from `jest.config.js`
roots and never touches the dev database).

## Commands

```bash
# Offline unit checks for the guards (no DB, no server):
npx jest --config jest.config.js --roots test/cash-live

# Type-check the harness (offline):
npx tsc --noEmit -p test/tsconfig.json

# Live run (parent-authorized only; disposable DB must exist) with a
# MINIMAL environment — external credentials are denied (see guards):
env -i \
  PATH="$PATH" HOME="$HOME" \
  CASH_LIVE_DISPOSABLE=1 \
  DATABASE_URL="$CASH_LIVE_DATABASE_URL" \
  CASH_LIVE_DATABASE_URL="$CASH_LIVE_DATABASE_URL" \
  node -r ts-node/register -r tsconfig-paths/register test/cash-live/server.ts

# If full ts-node type-checking is undesirable in the terminal:
TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register -r tsconfig-paths/register \
  test/cash-live/server.ts   # with the same minimal env
```

The harness NEVER loads `.env`. Every required value comes from the run
environment or is generated locally.

## Fail-closed environment guards

The server refuses to start unless ALL of the following hold:

- `CASH_LIVE_DISPOSABLE` is exactly `1` (explicit opt-in);
- `DATABASE_URL` and `CASH_LIVE_DATABASE_URL` are both set and identical;
- the URL is `postgresql://127.0.0.1:<port>/cash_closing_proof_test` with
  user `cash_proof`;
- the port is present and is NOT `5432` / `5433` (the shared dev and
  integration-test ports are always rejected);
- the URL has NO query string and NO fragment — Prisma reads connection
  overrides (`?host=`, `?schema=`, `?sslmode=`, socket paths) from query
  parameters, so any query is rejected outright;
- NO external-service credential is inherited (`RESEND_API_KEY`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
  `INNGEST_EVENT_API_KEY`, `INNGEST_SIGNING_KEY`) — checked BEFORE the
  Nest module graph compiles; rerun with a minimal env (`env -i`);
- `CASH_LIVE_FRONTEND_ORIGIN` (optional, default
  `http://127.0.0.1:4189`) parses as a loopback http(s) origin with an
  explicit numeric port — it is the single CORS allowlist entry;
- `CASH_LIVE_FIXTURE_PATH` (optional, default `.tmp/cash-live/fixture.json`)
  resolves INSIDE the repository root — `..` traversal and absolute paths
  outside the repo are rejected;
- `CASH_LIVE_JWT_SECRET` (optional) is used when it is at least 32
  characters; otherwise a random secret is generated locally. The secret
  is in-memory only: never logged, never written to the fixture.

Rejection reasons describe URL components only; the URL and its password
are never echoed. Runtime failures print FIXED diagnostic texts — error
objects and error messages are never logged (they can carry secret
material).

## Resume mode (restart without reseeding)

Resume restarts the harness against the EXISTING fictional dataset so the
frontend session continues with the same users, permissions and session,
but FRESH access tokens. The T1 peer (`test/cash-live/resume-dataset.ts`)
reads and validates the stored dataset — this branch NEVER calls
`seedFictionalDataset` and NEVER lets the production `PermissionSeeder`
write bootstrap rows.

Invocation (same disposable-DB guards and minimal env as a live run, plus
three resume values):

```bash
env -i \
  PATH="$PATH" HOME="$HOME" \
  CASH_LIVE_DISPOSABLE=1 \
  DATABASE_URL="$CASH_LIVE_DATABASE_URL" \
  CASH_LIVE_DATABASE_URL="$CASH_LIVE_DATABASE_URL" \
  CASH_LIVE_RESUME_RUN_ID="<existing-run-id>" \
  CASH_LIVE_RESUME_SESSION_ID="<existing-open-session-uuid>" \
  CASH_LIVE_FIXTURE_PATH=".tmp/cash-live/fixture.resume.json" \
  node -r ts-node/register -r tsconfig-paths/register test/cash-live/server.ts
```

Resume constraints (fail-closed, validated BEFORE module init, token
signing or listen):

- Resume mode is active when EITHER `CASH_LIVE_RESUME_RUN_ID` or
  `CASH_LIVE_RESUME_SESSION_ID` is present. A partial request is an ERROR
  — the harness never silently falls back to a fresh reseed.
- `CASH_LIVE_RESUME_RUN_ID` must match the shared seeded-slug charset
  (`^[a-z0-9]{1,128}$`, same constant the dataset peer uses).
- `CASH_LIVE_RESUME_SESSION_ID` must be a canonical UUID (the existing
  OPEN session).
- `CASH_LIVE_FIXTURE_PATH` must be set EXPLICITLY and resolve to a path
  DIFFERENT from the default `.tmp/cash-live/fixture.json`. The previous
  fixture is never reused; the exclusive 0600 writer also refuses to
  overwrite any pre-existing file. The new fixture is written only to the
  new path.
- Rejection reasons are FIXED texts — the provided run id, session id and
  path are never echoed.
- Resume replaces ONLY the `PermissionSeeder` bootstrap writer with a
  no-op (`applyResumeModuleOverrides`); the real `JwtStrategy`,
  `JwtAuthGuard`, `PermissionsGuard`, tenant CLS and Prisma are unchanged.
  Fresh runs keep the production seeder exactly as before.
- Tokens are freshly signed with a new in-memory secret, so previously
  issued tokens expire with their TTL; no refresh token or OTP is issued.

## Module boundary (exact)

- The harness graph is ConfigModule + ClsModule + DatabaseModule +
  AuthModule + CashRegisterModule. No `AppModule`, no Schedule/Inngest
  modules, no human-decision body parsers.
- AuthModule is FULLY REAL and transitively includes MailerModule /
  ResendMailer and the AuthController routes (login/refresh/OTP).
  JwtStrategy, JwtAuthGuard, PermissionsGuard, CaslAbilityFactory and
  the PermissionSeeder are the production implementations.
- External email is impossible through three independent layers:
  1. ConfigModule runs with `ignoreEnvFile` + `skipProcessEnv: true` and
     ONLY explicit fictional config — no API key is visible to the graph;
  2. the pre-compile environment guard refuses inherited external keys;
  3. a narrow test-only MAILER override (`OfflineNoSendMailer`) throws a
     fixed message on every send.
  This MAILER override is the ONLY provider replacement in the harness;
  auth guards, tenant CLS, Prisma and the cash application are real.
- CashRegisterModule is imported directly — the same instance production
  loads (transitively via Sales/PDF in AppModule). Its wiring is NOT
  changed here.

## Auth model

- Tokens are signed by the module's REAL `JwtService` with the production
  final payload shape: `{ sub, email, tenantId, tenantSlug, isSuperAdmin: false }`
  (validated by the real `JwtStrategy`).
- Authorization is enforced by the REAL `PermissionsGuard` + CASL, using
  role-permission rows composed dynamically from the real
  `PERMISSION_REGISTRY` — no `manage:all`, no Super Admin role, no
  default role assignment.
- Access-only: no refresh token, no OTP is ever issued; the frontend does
  not exercise the full auth flow. TTL default is 2h (override with
  `CASH_LIVE_ACCESS_TTL_SECONDS`, 60–86400).
- SCOPE: cash closing and PDF generation are OUT OF SCOPE — no actor
  receives any `CashClosing` permission, so close routes 403 by design.

## Seeded fictional dataset

- 2 uniquely named tenants (`cash-live-a-<runId>`, `cash-live-b-<runId>`);
- 3 active users:
  - `cashier` in tenant A — register create/read, session create/read,
    count create, cash-in/out create, handover create/read/update;
  - `verifier` in tenant A — session read + `CashSessionAudit` read
    (wider visibility of other users' sessions), verification create,
    handover read/update;
  - `foreign` in tenant B — the same cashier-scoped rights, scoped to its
    own tenant;
- one dynamic role per actor + membership, named with the run id so
  repeated runs never collide.

## Fixture contract (frontend-agreed, schemaVersion 1)

The `accessToken` is a BEARER CREDENTIAL. The fixture is written with
mode `0600` set AT CREATION through an exclusive `O_EXCL | O_NOFOLLOW`
handle: a pre-existing file is never truncated or overwritten, symlinked
parent directories are rejected, and no chmod runs after the token bytes
exist. Top level:

- `schemaVersion`, `backend { url, basePath: '', resourceId }`,
  `frontendOrigin`, `tenants [{ id, name, slug }]`;
- `actors { cashier, verifier, foreign }`, each with:
  - flat fields: `userId`, `tenantId`, `email`, `permissionCodes`
    (`action:Subject` strings), `accessToken`;
  - frontend-agreed nested summaries: `user { id, email, name, isActive,
    createdAt }`, `tenant { id, name, slug }`, `memberships` (tenant
    summaries with role name);
  - session fields: `functionalRole` (`cashier` | `verifier` |
    `foreign`), `expiresAt`, `ttlSeconds`;
- `metadata` — `owner`, `backendHEAD`, `resourceId`, `generatedAt`,
  `readiness` counters, `cleanup` instructions, `accessOnly: true`,
  `refreshTokenIssued: false`, `otpIssued: false`.

stdout contract: exactly one ready line (JSON) with `baseURL`,
`resourceId` and `fixturePath`. Tokens and bearer credentials never
appear in logs.

Frontend access (agreed): the frontend host is approved to READ/COPY the
fixture at the EXACT backend path
`/home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend/.tmp/cash-register-closing/.tmp/cash-live/fixture.json`
(repository-contained, mode 0600, written exclusively) — no other path,
and never JWT material or chat logs. The file exists only after a
parent-authorized live run writes it; keep waiting for the ready line.
The fixture keeps extra fields (functional role, memberships, TTL) so the
contract can be adapted without breaking the baseline shape.

## Limits

- Listens on `127.0.0.1` with port `0` (random port; printed as
  `baseURL`).
- The AuthModule `PermissionSeeder` runs on bootstrap (as in production)
  and upserts the registry; the harness additionally upserts exactly the
  permission rows the actors need before composing roles. In RESUME mode
  the harness replaces `PermissionSeeder` with a no-op for that run only,
  so a restart never writes authorization rows.
- Offline test evidence (guard unit checks + type-check) is NOT proof of
  a correct live run; the parent-authorized live run remains the
  definitive verification.

## Cleanup

- SIGTERM / SIGINT close the Nest app and disconnect Prisma. The harness
  NEVER deletes anything — not the database, not the container, not the
  fixture. The parent/operator owns server shutdown, fixture removal, and
  disposable container/database teardown.
- Re-running the harness seeds a NEW uniquely-named dataset; old rows
  stay in place (never deleted) until the parent tears the disposable
  database down. There are no manual DB drop commands in this workflow.

## Test discipline note

New guard rules added in this hardening round were written test-first:
the focused offline run was executed BEFORE implementation and the new
cases were observed failing (RED: 9 failed / 15 passed), then the
implementations were added and the same run observed green. The original
14 guard checks predate this round and have no RED claim — history is not
rewritten.
