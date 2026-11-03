# Disposable purchase-order runtime — O3b T5

Scripts are authored/offline-tested only. **No SQL, integration Jest, Docker, host or HTTP probe execution is claimed.** The parent owns every command below, review and delivery. Never use API3000, an existing/shared database, old supplier proof resources, inherited credentials or env files. No installer, package manager, Prisma generation, pull, cleanup, resume or automatic retry exists.

## Required parent inputs

- Run from this registered worktree, branch `feat/procurement-po-drafts-o3b`, containing the committed PO migration `20261104010000_procurement_purchase_order_drafts`. The complete migration tree must match HEAD byte-for-byte; unexpected directories fail closed.
- Installed Node with fetch/Headers/AbortSignal.timeout, Prisma CLI6, matching generated Prisma client (including PO delegates), pg, Jest/ts-jest, bcrypt, Nest testing and compiler tooling. Missing/stale tools are a stop condition, **not permission to install or regenerate**.
- Local Docker socket `/var/run/docker.sock`, permission to create a **new** internal network and uniquely named `postgres:17` container, and an already-cached postgres17 image. No pull, published ports, host/bind/named-volume mounts or old-resource adoption. Both Postgres data and socket directories use tmpfs; rootfs is read-only.
- This worktree's real, current-user-owned `.tmp` directory. No `.env`, `.env.test` or `prisma/.env` may exist; scripts check existence without reading contents. Do not move/delete existing env files to bypass this check.
- A successful new proof directory (`PROOF`) for launch; configurable FE origin, default `http://127.0.0.1:43179`. No secret goes into terminal output. Parent communicates the printed fresh `RUN` path privately to FE.

## 1. Parent SQL proof (run once)

```sh
node scripts/po-runtime/verify-po-migration.cjs
```

The script creates `.tmp/po-migration-proof.<unique>` mode0700; every script-written evidence file is exclusive mode0600. It never reads inherited DATABASE_URL. A clean child environment disables Corepack network/Prisma autoinstall, uses proof-local HOME/TMPDIR/DOCKER_CONFIG and explicitly binds only the newly generated target URL. Every child has a sanitized numbered log and status JSON. `results.json` is written exclusively on completion/failure, never overwritten. Passwords and database URLs are redacted even from Docker inspection logs. Ownership snapshots, private `target.json` and `target-identity.json` remain private; never paste their contents.

There is one five-second startup pause and exactly one readiness check: no readiness polling or resume. Any failure is final; all resources/evidence remain. Do not retry, clean up or recreate without an explicit parent decision.

Before migrations or any fixture seed, fresh Docker observations must prove exact owned container/image/network identity, sole internal-network membership, no published ports, tmpfs-only mounts and read-only rootfs. SQL must match **current_database(), current_user, host(inet_server_addr())** to the owned manifest. The public schema/ledger must initially be empty.

Execution order:

1. Apply every committed migration except the PO migration using a private copied migration tree and installed Prisma CLI via **process.execPath**, never a package manager.
2. Seed one unique tenant, supplier and product on the baseline. Hash all pre-existing public-table rows (excluding Prisma's ledger), and record every old table's columns, constraints and indexes.
3. Add/deploy the PO migration. Assert exact old-table schema/data equality and full successful ledger/checksum equality, including baseline entries.
4. Direct SQL rejects USD, zero/noncanonical/overprecision quantities, noncanonical/negative/overprecision costs and absent-cost objects with nonnull cost fields. It accepts `12.5`/`10.2500`/MXN, proves both cross-tenant supplier selection and supplier deletion fail with SQL23503 **po_supplier_fk**, and observes Prisma **P2003 meta.constraint** (`po_supplier_fk` on Prisma 6.19.2; `field_name` is absent) through a real direct supplier delete. `prisma-fk-observation.json` retains only the bounded constraint name; an unexpected/missing field fails closed instead of assuming the defensive application mapping works.
5. Prove one line exists, delete its owned order, assert line CASCADE and exact preservation of its two audit/receipt rows. Remove only that proof's supplier; tenant deletion must still fail on a PO audit/receipt tenant FK (RESTRICT).
6. Re-pin Docker/SQL identity before each of five integration Jest children. Each gets the guarded explicit DATABASE_URL and `HOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1`; shared globalSetup uses installed Prisma/Node only. Stop on the first failure; no retry.

The five suites are PO commands/queries and supplier storage/commands/queries (`src/procurement/{purchase-orders,suppliers}/*.integration.spec.ts`). Their own random fixtures stay in this disposable target. Command/query integration tests sample zero stock/catalog/sales/payment/outbox effects and transactional rollback; HTTP alone does not prove those invariants.

**Pass gate:** process exit0 AND `results.json.state === "passed"`, preservation true, all named SQL checks and all five integration statuses successful. No offline test substitutes for this gate.

## 2. Parent build and fresh FE host

After reviewing a successful proof, compile current source without a package manager, generation or cleanup:

```sh
node node_modules/typescript/bin/tsc --project tsconfig.build.json --incremental false
# Set PROOF to the exact successful path printed by step1 (not an old run).
node scripts/po-runtime/launch.cjs "$PROOF"
# Optional explicit origin:
# node scripts/po-runtime/launch.cjs "$PROOF" http://127.0.0.1:43179
```

`launch.cjs` validates private successful-proof metadata, refreshes Docker ownership checks, and explicitly passes the private URL to the host. It sources no env file and never prints the URL/password. It creates a **fresh** `.tmp/po-runtime.<unique>` mode0700, writes the identity manifest exclusively mode0600, and prints its path. The host stays in the foreground; parent stops only this owned process with Ctrl-C, not an arbitrary port/process. Network/container/DB remain retained.

The host is also directly callable when the parent independently prepares a fresh private RUN/manifest and explicitly binds its ownership-guarded DATABASE_URL:

```sh
node scripts/po-runtime/host.cjs "$RUN" http://127.0.0.1:43179
```

`RUN/target-identity.json` must contain exactly `{ "database": "nest-practice-test", "username": "<generated user>", "ip": "<owned172.16–31IPv4>" }`, current uid, mode0600, real nonsymlink path, with RUN mode0700. User/IP/database/port5432 must exactly match DATABASE_URL (no query override; only absent query or `?schema=public`). SQL identity is pinned again **before seeding**. This does not replace the Docker guard.

The opt-in wrapper reuses `scripts/supplier-runtime/host.cjs`; its original supplier-only invocation and grants stay unchanged. PO mode imports real AuthModule, SuppliersModule, PurchaseOrdersModule and ProductsModule, not AppModule. It ignores env-file/config-env inheritance and uses fresh JWT secrets. PO mode registers EventEmitterModule.forRoot() so FilesService can receive its EventEmitter2 dependency. It still disables both the transitive outbox poller and dispatcher, plus Auth's PermissionSeeder bootstrap hook. This prevents bootstrap permission/global-role writes before the SQL identity pin; only explicit fixture grants are seeded afterwards. Nest compile-time logging is muted as well as application logging. Supplier-only invocation keeps its existing providers. Files-module configuration uses inert loopback-port1 storage values, never real credentials; no file routes are admitted. Only real product-selector reads are reachable. Production parser/filter/CORS order is retained.

### Bounded startup failure diagnostic

Once a private RUN is trusted, startup failures attempt an exclusive mode0600 `RUN/host-error.json` **before shutdown**. The first failure is retained; no append/overwrite/retry or raw-error fallback is allowed. An invalid RUN or unwritable/existing diagnostic may prevent recording; stderr remains generic.

Only these keys can appear: `stage`, `errorName`, optional `prismaCode`/`pgCode`/`nodeCode`, optional `constraint`/`modelName`, and `diMessage` **only for UnknownDependenciesException**. The DI summary contains only allowlisted class/token names from the host graph, capped at256 characters and restricted to `[A-Za-z0-9_ ,.?()'\-:]`. It examines at most4096 message characters, never copies free-form prose, and uses UnknownProvider when no known token appears. Stages are fixed step names (e.g. `build-module`, `compile-module`, `initialize-application`, `identity-pin`, `seed-catalog-products`, `listen`, `credentials-record`). Error/constraint/model names are allowlisted; unfamiliar names become fixed UnknownError/UnknownConstraint/UnknownModel labels. Code fields accept only bounded Prisma codes or known PG/Node codes. No message, stack, URL, credential, SQL, cause, request values or arbitrary metadata is copied, and getters/toJSON are never invoked.

Offline reproduction of the remaining compile failure: **FilesService cannot resolve EventEmitter at constructor index2 in FilesModule**. ProductsModule also imports FilesModule; disabling the outbox dispatcher did not satisfy this second consumer. PO mode now imports the same EventEmitterModule.forRoot() registration normally supplied by the root application. No src/dist, fixture, identity or bind changes were needed. All host-targeted compiled files remain under `dist/<module>`, not `dist/src`.

`compile.test.cjs` calls the **shared host builder** with real dist imports for both modes, but replaces every PrismaService registration with a fail-closed stub. It clears inherited credentials, refuses present env files, forbids Prisma/lifecycle access and Socket.connect, and stops after Nest compile (never app.init/listen). Both supplier-only and PO compiles pass with **zero Prisma/lifecycle calls and zero socket calls**. The initial PO compile observed the FilesService/EventEmitter failure before the registration fix. This proves DI composition only; actual initialized startup remains parent-owned.

Reinvoke the launcher only when parent-authorized, using the existing **successful** PROOF. It refreshes ownership checks and creates a new RUN; never overwrite/reuse the failed RUN or rerun the SQL proof to diagnose host startup. No recompilation is required for script-only changes when dist is already current.

Host route boundary is case-insensitive with one optional trailing slash:

- Existing supplier/auth routes only.
- Exactly GET/POST PO collection, GET/DELETE PO detail and PUT `/:orderId/draft` (plus automatic HEAD/read and CORS OPTIONS behavior).
- GET `/products` with only scalar search/type/page/limit; GET `/products/:id/variants` with no query. No product detail, writes, prices, files, history, confirm/cancel or adjacent routes.

It listens on ephemeral **127.0.0.1 only**, never3000. Exclusive private `ready.json` contains origins/pid; `credentials.json` contains password, generated users/tenant IDs and `catalog` IDs/names. Share only the exact private path with FE, not credentials in logs/chat.

| Fixture role | Exact grants in PO mode                                                 |
| ------------ | ----------------------------------------------------------------------- |
| manager      | CRUD ProcurementSupplier + CRUD ProcurementPurchaseOrder + read Product |
| reader       | **Only read ProcurementPurchaseOrder**; supplier/Product reads denied   |
| noaccess     | None                                                                    |

Every fixture name is uniquely prefixed in the newly generated tenant: PRODUCT UNIDAD without variants, PRODUCT KILOGRAMO without variants, PRODUCT UNIDAD with two variants, PRODUCT CAJA with two variants, PRODUCT useStock=false, SERVICE, ACTIVE and ARCHIVED suppliers. An additional foreign-tenant PRODUCT ID is available privately for the negative HTTP check. No human/default role is changed.

## 3. Parent real HTTP probe (run once)

After `RUN/ready.json` exists, in another parent terminal:

```sh
node scripts/po-runtime/probe.cjs "$RUN"
```

The probe verifies private inputs and the exact ephemeral loopback origin, reserves `probe-result.json` using mode0600/**wx before any network request**, logs in real manager/reader/noaccess actors, and sends requests only to that origin with configured FE Origin. Redirects fail; requests time out after10s. There is no retry/refresh, DB client, server launch, installer, env-file read or normal API access.

Its17 feature checks cover S2–S13: incomplete201 and diagnostics, replay/key conflict, GET detail/snapshots, exact KILOGRAMO `12.5 × 10.25 = 128.125`, PUT CAS200/stale409, pending variant/quantity and no-stock product, SERVICE400, actual foreign/random product404, UNIDAD fraction400, USD400, new ARCHIVED selection409 versus retained archived diagnostic, summary/supplier filter/current-name and note search/cursor binding and pagination, reader PO200 with supplier403 and mutation403, noaccess403/anonymous401, supplier DELETE409 with a draft, discard204/replay204/absence404 then supplier DELETE204. All feature responses check no-store, exact CORS/credentials, exact closed errors and zero-byte204. Auth login uses its existing200/token/CORS contract; it is not a PO envelope/no-store assertion.

Output contains only static check names, S# tags, PASS/FAIL and statuses; results contain only booleans/names/tags/statuses. The probe creates two uniquely noted drafts and its own supplier, discards the referenced draft and deletes **only its own probe supplier**. The incomplete-reference draft and host catalog fixtures remain for evidence/FE use. It never deletes the FE host's ACTIVE/ARCHIVED fixtures. A failure stays visible; prerequisite failures stop downstream work. Do not overwrite/delete results to replay. API defects belong to the parent, not probe workarounds.

## Offline gates (no main execution)

```sh
node --test scripts/po-runtime/compile.test.cjs
node --test scripts/po-runtime/verify-po-migration.test.cjs
node --test scripts/po-runtime/host.test.cjs
node --test scripts/po-runtime/probe.test.cjs
node --test scripts/po-runtime/launch.test.cjs
node --test scripts/supplier-runtime/host.test.cjs scripts/supplier-runtime/probe.test.cjs scripts/supplier-runtime/verify-delete-migration.test.cjs
for file in scripts/po-runtime/*.cjs scripts/supplier-runtime/host.cjs; do node --check "$file" || exit 1; done
node --check eslint.config.mjs
node node_modules/eslint/bin/eslint.js scripts/po-runtime/*.cjs scripts/supplier-runtime/host.cjs
node node_modules/prettier/bin/prettier.cjs --check scripts/po-runtime/*.cjs scripts/po-runtime/README.md scripts/supplier-runtime/host.cjs scripts/supplier-runtime/README.md eslint.config.mjs
git diff --check -- scripts/po-runtime scripts/supplier-runtime/host.cjs scripts/supplier-runtime/README.md eslint.config.mjs
```

Imports of executable host/proof/probe modules are inert. Most offline tests use fake DB/HTTP adapters; the compile test requires existing dist artifacts and compiles real Nest modules with the database provider replaced and sockets blocked, without initialization or listeners. They protect guards, exact constraint-code assertions, sanitized output, fixture grants, route/query boundaries, and the complete probe sequence (including deliberate rounded-subtotal rejection). They do **not** establish real PostgreSQL, routing/authorization or FE visual readiness. The ESLint semantic delta only extends the existing standalone CJS override to `scripts/po-runtime/*.cjs`; the affected config also receives Prettier-only formatting.
