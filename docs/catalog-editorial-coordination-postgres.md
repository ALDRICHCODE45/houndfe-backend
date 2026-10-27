# Editorial PostgreSQL foundation (T4/U5a; S2/S5)

Offline foundation only: no SQL, schema, seeds, target creation, consent proof or
concurrency/rollback proof. U5b/U6/U7 remain separate. Existing core/services and
root guards are unchanged. Rollback boundary: remove these four new harness,
unit-spec, focused-config and documentation files; no production registration exists.

## Operator contract

Parent alone must create a NEW disposable target from the authorized cached image
and freshly inspect/reinspect its full container ID, image ID, name, ownership label,
and actual 127.0.0.1 port publication before each live run. Pin that observation
separately from the requested binding. Matching caller metadata is NOT evidence of
human consent, Docker ownership or continued identity; this API cannot prove those.
Never reuse retired identifiers, endpoints or grants. Parent owns all SQL and cleanup.

`constructEditorialPostgresClient(binding, pinned)` returns `Promise<PrismaClient>`
without connecting. `PinnedPostgresTarget` requires full 64-lowercase-hex container
ID, `sha256:` image ID, name `editorial-coordination-[a-z0-9-]{1,60}`, an owner
identifier, exact host `127.0.0.1`, integer port 1–65535, and database/user matching
`editorial_test_[a-z0-9_]{1,32}`. Binding contains only target, generated schema
`editorial_test_[a-f0-9]{16}`, and an explicit disposable password (1–256 characters,
no controls). All identity fields must match the separate pin. No URL/env fallback.
Do not log bindings, options or clients; their URL necessarily contains credentials.
Failures are generic and never forward dependency error text.

After admission, static installed-client metadata inspection MUST succeed before
client import; the constructor also clears BOTH relativeEnvPaths and
injectableEdgeEnv while preserving other config. Explicit datasource alone is unsafe.
Future live specs MUST dynamically import application code ONLY AFTER awaiting this
safe bootstrap; static application imports can trigger Prisma dotenv before the guard.
The optional generic `HarnessDependencies<T>` seam is for offline fakes only; it still
runs mandatory admission and metadata validation, not a supported live guard bypass.
URL pool limit is 1; connect/pool waits 5s, socket/transaction timeout 10s and
transaction maxWait 5s. This is bounded client configuration, not a process sandbox.

## Audited installed dependency boundary

Current generated client: Prisma 6.19.2, `.prisma/client/index.js` lines1474 and1523:
JSON-shaped relativeEnvPaths has null root and absent schema; warnEnvConflicts runs
before export. Runtime `@prisma/client/runtime/library.js` lines12–16 contains env
loading guarded by truthy existing paths; line130 applies configOverride BEFORE
relativeEnvPaths resolution/env loading and then considers injectableEdgeEnv.
These source bytes were read statically, never evaluated for inspection. Parser
accepts only one bounded JSON object with absent/null root/schema fields; unknown,
duplicate, non-null or malformed metadata fails closed. Source maximum is 2MB.
This is a narrow current-dependency audit, NOT arbitrary JavaScript validation or
protection against malicious installed packages/concurrent package replacement.
Dependency changes require re-audit, not bypassing the check. No generated files
are modified. Unit tests use fake constructors, including one installed metadata
read; they do not establish live SQL correctness. Focused CJS project-service lint
coverage may be limited; syntax check and ts-jest diagnostics remain mandatory.

## Binding file (U5b1)

`loadEditorialPostgresClient()` reads only `EDITORIAL_COORDINATION_PG_BINDING`;
missing/empty values fail, with no dotenv, ambient URL or other-variable fallback.
Parent supplies an absolute path to a regular, non-symlink file outside the real
repository root, owned by the current uid, mode exactly 0600, at most 4096 bytes.
Both paths are realpath-resolved; containment uses path segments, not name prefixes.
The JSON envelope has exactly two object fields, `{binding, pinned}`; U5a retains
all nested admission checks. Parent must independently inspect/pin the fresh target.

The loader opens once with O_NOFOLLOW, matches fstat device/inode to lstat, checks
opened-file metadata, bounds reads to 4097 bytes, rechecks size/metadata and closes
before invoking U5a. Failures expose only a generic message, never paths or contents.
The optional dependency seam is for offline tests, not a live admission bypass.
This does not prove target ownership/consent or prevent same-size concurrent content
changes by the owning uid; parent must keep the binding private and stable.
No connection is opened by this slice. Seeds, SQL observations, live smoke and the
parent-owned container/migration/retirement lifecycle remain U5b2/U5b3 work.

## Seed and observation (U5b2)

`seedEditorialPostgres(client, key)` uses only parameterized SQL tags against the
complete canonical migration history. Each key is single-use; distinct keys coexist.
It returns typed `ids`, derived unique `values`, and resolved `permissionIds`.
Only ProductEditorialDraft read/update permissions are shared: insert on conflict
(subject, action), then SELECT their real IDs before joining the seed-owned role.
The fixture includes qualified membership/Product/Variant/prices, selected and
unrelated private assets/options, archived vocabulary and a foreign-tenant Product.
No auth bootstrap, password hashing, bytes, service-detail rows, catalog publication
bindings or global default price-list singleton are created (the price list is nondefault).

`currentBackendPid`, `waitForLockWait`, `readEditorialRows`, `readVariantMembership`
and `readVariantPrices` accept structural clients/transactions. Use a separate
admitted observer client for lock polling: bounded to 5000ms, generic errors,
Lock wait plus nonempty blocking-pid evidence; a timed-out query is not cancelled.
Readbacks are tenant-qualified, not a cross-query atomic snapshot unless given a tx.
All verification here is offline; no PostgreSQL seed, lock or rollback proof exists.
