# Disposable supplier HTTP probe

## Parent-only runtime invocation (D3)

No runtime was executed for this source change. The parent must first refresh its Docker ownership guard for the **new owned migrated disposable target**, supply the guarded `DATABASE_URL` explicitly (never source `.env` or reuse inherited credentials), and prepare a fresh owner-only `.tmp/supplier-runtime.<unique>` RUN. Do not reuse the old A4 runtime/database or its credentials.

Before starting, the parent writes `RUN/target-identity.json`, owned by the current uid, mode **0600**, containing exactly:

```json
{
  "database": "nest-practice-test",
  "username": "<generated target user>",
  "ip": "<guarded container IPv4>"
}
```

RUN must be current-uid owned, mode **0700**, a direct child of this worktree's `.tmp`, and neither RUN nor the manifest may resolve through symlinks. Missing/invalid manifest fails closed before Nest application creation/connection. The URL must be postgres/postgresql with a password, exact manifest user/IP/database, explicit port5432, and no fragment; only absent query or `?schema=public` is accepted. The IP must be private172.16–31 IPv4. No URL or credential values are logged. After app initialization and **before any seeding**, `current_database()`, `current_user`, and `host(inet_server_addr())` must match the manifest exactly. This pin is **not** a replacement for the parent's Docker ownership guard.

With the parent-provided URL already explicitly set in the command environment:

```sh
node scripts/supplier-runtime/host.cjs "$RUN" http://127.0.0.1:43179
# In a separate parent terminal, after ready.json exists:
node scripts/supplier-runtime/probe.cjs "$RUN"
```

Host imports real AuthModule + SuppliersModule only (not AppModule), ignores env files/config env inheritance, generates its own JWT secrets and fixture credentials, and retains main.ts filter/CORS/parser order. It listens only on ephemeral IPv4 loopback, never3000. Only its newly generated manager fixture role receives read/create/update/**delete**:ProcurementSupplier; reader remains read-only and noaccess has no supplier grants. No default/human role is changed. Auth login/logout/refresh/me/permissions and the actual supplier collection/detail verbs alone are allowlisted, with Express-equivalent case-insensitivity and one optional trailing slash; adjacent routes/extra segments/other verbs are denied.

DELETE accepts `Content-Type: application/json` with closed body `{ "expectedVersion": <positive integer> }` and one `Idempotency-Key`; success is204 with zero bytes, no-store and allowed CORS headers.

The probe requires Node with global `fetch`, `Headers` and `AbortSignal.timeout`; it uses only built-ins. It does not start/stop the host, invoke a database client, read env files, install dependencies or touch the normal API. The owner-only RUN directory must contain private mode-0600 `credentials.json` and `ready.json` written by `host.cjs`. The only network origin is `ready.json.apiOrigin`, required to match credentials and be HTTP IPv4 loopback on an explicit port other than 3000. Redirects are rejected. Requests send the fixed FE Origin `http://127.0.0.1:43179`.

The probe consumes private login inputs in memory, authenticates all three actors via real `/auth/login`, and never logs response bodies, exception messages, passwords, tokens, identities, URLs or private file contents. Output is limited to named PASS/FAIL lines, S# coverage and observed HTTP statuses. Exit 0 means all checks passed; exit 1 means a check/setup/result-write failed. Expected negative HTTP statuses are passes when the closed envelope matches.

`RUN/probe-result.json` contains only a boolean summary and check names, S# tags, boolean outcomes and status codes. It is created with mode 0600 and exclusive `wx`; existing results are never replaced. Do not delete/overwrite it to rerun. Each invocation requires a fresh RUN/result destination with parent-prepared private host inputs; never silently replay a completed run. The probe creates four uniquely prefixed suppliers, deliberately deletes only its own ACTIVE and ARCHIVED fixtures, and leaves the other two as evidence. It never cleans up arbitrary/shared tenant rows.

## Coverage

| Checks                                                                                                                                                 | Spec               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Real manager/reader/noaccess login; scoped disposable origin and private outputs                                                                       | S1, S2, S4         |
| Manager create, exact original replay before/after mutations, key/body conflict                                                                        | S1, S2, S3         |
| ACTIVE/ARCHIVED/ALL, trimmed case-insensitive search, limit/cursor/order/no duplicates                                                                 | S2, S3             |
| Detail, PATCH CAS/stale conflict, null clearing/omission preservation, archive/reactivate                                                              | S1, S2, S3         |
| Two concurrent PATCHes with distinct keys and one expectedVersion: exactly one winner                                                                  | S2, S3, S4         |
| Reader reads and write denials, noaccess denial, anonymous 401                                                                                         | S2, S3             |
| Initially empty unique-prefix search; only that prefix is ownership-scoped (shared tenant may be nonempty); foreign-name search empty; random UUID 404 | S2, S3, S4         |
| Nonempty text/plain GET (using node:http), invalid JSON, unknown field, blank name, invalid limits, changed-search cursor                              | S3                 |
| Every supplier response: no-store and exact allowed CORS origin/credentials; every expected error: exact closed envelope                               | S3                 |
| Detail and scoped item set unchanged after rejected writes/deletes                                                                                     | S2, S3, S4, S6     |
| ACTIVE/ARCHIVED DELETE204 empty, fresh missing key404, original replay204, changed-body key409, stale409; list/detail gone                             | S2, S3, S5, S6, S7 |
| Reader/noaccess DELETE403; missing key/version, unknown field, invalid version/JSON/media400 without writes                                            | S2, S3, S6, S7     |
| CREATE and UPDATE historical original responses replay after deletion, without recreating live detail/list                                             | S2, S6             |
| Actual mixed-case/trailing-slash list/detail/DELETE and malformed DELETE through runtime                                                               | S3, S7             |

Tenant-isolation proof is intentionally bounded: the probe does not know/discover the foreign supplier ID. Random UUID 404 is **not** a direct foreign-ID detail test. Offline helper tests do not establish actual HTTP routing, authorization or deletion behavior. The prior A4 route-variant correction still needs actual runtime proof; the new probe exercises it but has not been run here. HTTP evidence does not prove database audit/receipt atomicity, rollback, absence of stock/money side effects or FE visual behavior; those remain parent-owned checks. D1's independent source PASS and historical D2 SQL evidence are separate; L39 accepted retaining isolated dependencies after the historical installer incident, not S4 PASS or retroactive confinement. S1 labels trace authorized supplier behavior, not new human approval.

## Failure discipline

Run once after syntax validation. For any failed check, inspect the relevant source to distinguish probe mistakes from suspected API defects. Fix only this probe, never `src/` or the running host. At most one parent-authorized correction rerun per failing check; API defects are reported with source path:line evidence rather than retried or worked around. A failed prerequisite aborts downstream checks; an ordinary check failure remains visible while later checks continue. No hidden retry/refresh is implemented.

The original A4 ESLint project-service limitation was historical. The parent D2 scoped `scripts/supplier-runtime/*.cjs` override now permits direct offline ESLint checks without TypeScript project-service parsing; this correction does not change that config. Keep `node --check` as the syntax gate.

## D2 migration proof: retained incident, no replay

`verify-delete-migration.cjs` is **parent-executed only**. Importing it for `node --test scripts/supplier-runtime/verify-delete-migration.test.cjs` does not invoke main, Docker, a DB or a child. The script's direct deploy already uses installed Prisma via Node; its integration Jest children also run shared `test/integration/setup/global-setup.ts`. That transitive setup formerly invoked `pnpm exec`, defeating confinement: retained `.tmp/delete-migration-proof.SyZbUU/105-integration-storage.log` records Corepack/pnpm12.16.1 download,1128 packages added and Prisma Client6.19.2 postinstall regeneration despite npm_config_offline.

Shared setup now uses only `process.execPath` + `require.resolve('prisma/build/index.js')` + `migrate deploy`, fails closed before spawn/seed if CLI is unavailable, and has no package-manager fallback. All integration suites inherit this narrow invocation change; existing env precedence, target validation/normalization and explicit seed datasource/upsert remain unchanged. The proof env also sets `COREPACK_ENABLE_NETWORK=0` and `PRISMA_GENERATE_SKIP_AUTOINSTALL=true` as defense in depth, **not** as a substitute for the direct invocation fix.

Do not run/retry/recreate the existing proof, remove artifacts, restore or reinstall dependencies. Current metadata/client hashes and the known installer artifacts versus unknown before/after mutation extent are recorded in [D2 correction provenance](../../docs/procurement-suppliers-api-verification.md#d2-s4-installer-confinement-correction-not-s4-pass). There is no pre-run installed-dependency inventory; unchanged tracked package/lock files do not prove installed-byte equality. SQL assertions remain historical evidence, not S4 PASS. The single targeted correction recheck completed at L38; L39 accepted retaining current isolated dependencies with unknown retrospective impact. No further verifier, restoration, reinstall, cleanup or SQL-proof replay is authorized.

D3 offline gates (installed Node tooling only; imports are inert, no DB/server/network):

```sh
node --test scripts/supplier-runtime/host.test.cjs scripts/supplier-runtime/probe.test.cjs
node --check scripts/supplier-runtime/host.cjs
node --check scripts/supplier-runtime/host.test.cjs
node --check scripts/supplier-runtime/probe.cjs
node --check scripts/supplier-runtime/probe.test.cjs
node node_modules/eslint/bin/eslint.js scripts/supplier-runtime/host.cjs scripts/supplier-runtime/host.test.cjs scripts/supplier-runtime/probe.cjs scripts/supplier-runtime/probe.test.cjs
node node_modules/prettier/bin/prettier.cjs --check scripts/supplier-runtime/host.cjs scripts/supplier-runtime/host.test.cjs scripts/supplier-runtime/probe.cjs scripts/supplier-runtime/probe.test.cjs scripts/supplier-runtime/README.md
git diff --check -- scripts/supplier-runtime/host.cjs scripts/supplier-runtime/host.test.cjs scripts/supplier-runtime/probe.cjs scripts/supplier-runtime/probe.test.cjs scripts/supplier-runtime/README.md
```

Historical D2 offline correction gates (do not replay the proof):

```sh
node --test scripts/supplier-runtime/verify-delete-migration.test.cjs
node --check scripts/supplier-runtime/verify-delete-migration.cjs
node node_modules/eslint/bin/eslint.js test/integration/setup/global-setup.ts test/integration/setup/global-setup.spec.ts scripts/supplier-runtime/verify-delete-migration.cjs scripts/supplier-runtime/verify-delete-migration.test.cjs
```

For the runnable globalSetup mocked unit command, see the verification document: ordinary Jest excludes `test/integration/`, while the integration config would execute real DB setup and must **not** be used for offline validation.
