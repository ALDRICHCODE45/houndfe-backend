# Disposable purchase-order runtime — O3b T5, extended in O3c T4

Scripts are authored/offline-tested only. **No SQL, integration Jest, Docker, host or HTTP probe execution is claimed for the O3c extension** (O3b was proven earlier; O3c is not until the parent runs the commands below). The parent owns every command below, review and delivery. Never use API3000, an existing/shared database, old supplier proof resources, inherited credentials or env files. No installer, package manager, Prisma generation, pull, cleanup, resume or automatic retry exists.

## Required parent inputs

- Run from this registered worktree, branch `feat/procurement-po-confirm-o3c`, containing the committed PO migrations `20261104010000_procurement_purchase_order_drafts` (O3b), `20261104010100_procurement_po_confirm_cancel_enums` and `20261104010200_procurement_po_confirm_cancel_storage` (O3c). The complete migration tree must match HEAD byte-for-byte; unexpected directories, or anything sorting after the O3c migrations, fail closed.
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

1. Apply every committed migration before the O3b PO migration using a private copied migration tree and installed Prisma CLI via **process.execPath**, never a package manager.
2. Seed one unique tenant, supplier and product on the baseline. Hash all pre-existing public-table rows (excluding Prisma's ledger), and record every old table's columns, constraints and indexes.
3. Add/deploy the O3b PO migration. Assert exact old-table schema/data equality and full successful ledger/checksum equality, including baseline entries.
4. **O3c preservation (state `o3c-seed` → `o3c-forward` → `o3c-preservation`).** Under the O3b schema, seed realistic readable DRAFT-era data: tenant «Mascotas y Alimentos El Roble», suppliers «Distribuidora Veterinaria del Norte» and «Alimentos Balanceados del Bajío (archivado)», product «Croquetas Adulto 15 kg», 3 orders (complete, empty/no supplier, retained archived supplier) with 3 lines, 4 audits (CREATE/REPLACE and a discarded order's CREATE/DELETE) and 3 receipts (including the 204 `null` DELETE body). Capture catalog + row hashes of every public table, then deploy `…010100` + `…010200` and require the **exact** additive delta (`verifyO3cDelta`): every pre-existing row hash/count unchanged; old columns unchanged and exactly the five new nullable, default-less columns appended to the orders table (`confirmedAt`, `confirmedByDisplayName`, `cancelledAt`, `cancelledByDisplayName`, `lineSubtotalsSnapshot`); all indexes unchanged; exactly two new orders CHECKs (`po_status_transition_check`, `po_frozen_subtotals_check`), exactly three widened CHECKs (`po_audit_snapshots_check`, `po_receipt_namespace_check`, `po_receipt_http_check`: same names, different definitions), every constraint validated; enum labels grow only by `CONFIRMED`/`CANCELLED` (status) and `CONFIRM`/`CANCEL` (operation), appended in that order; every seeded order is still DRAFT with all new columns NULL. Then the ledger must be the O3b ledger plus the two finished O3c entries with matching checksums.
5. Direct SQL (O3b rules, unchanged, still enforced): rejects USD, zero/noncanonical/overprecision quantities, noncanonical/negative/overprecision costs and absent-cost objects with nonnull cost fields. It accepts `12.5`/`10.2500`/MXN, proves both cross-tenant supplier selection and supplier deletion fail with SQL23503 **po_supplier_fk**, and observes Prisma **P2003 meta.constraint** (`po_supplier_fk` on Prisma 6.19.2; `field_name` is absent) through a real direct supplier delete. `prisma-fk-observation.json` retains only the bounded constraint name; an unexpected/missing field fails closed instead of assuming the defensive application mapping works. One line is deleted with its order to assert CASCADE, its two audit/receipt rows are preserved exactly, and tenant deletion must still fail on a PO audit/receipt tenant FK (RESTRICT).
6. **O3c SQL constraints (`o3c-sql-constraints`, `o3cProof`).** Accepts DRAFT, CONFIRMED (empty and non-empty subtotals array), CANCELLED-from-DRAFT (NULL and array subtotals) and CANCELLED-from-CONFIRMED orders; CONFIRM/CANCEL audits (object before **and** after) and CONFIRM/CANCEL receipts (200, `target = orderId`). Rejects with SQL23514 and the **named** constraint: 13 `po_status_transition_check` combinations (half or misplaced confirmed/cancelled pairs, DRAFT with a transition, CONFIRMED without/with the wrong pair, CANCELLED without its pair or with half a confirmed pair), 6 `po_frozen_subtotals_check` combinations (DRAFT with subtotals, CONFIRMED NULL/object/scalar, CANCELLED object/scalar), 8 `po_audit_snapshots_check` combinations (CONFIRM/CANCEL missing or non-object snapshots plus the retained CREATE/REPLACE/DELETE rules), 3 `po_receipt_namespace_check` and 4 `po_receipt_http_check` combinations. Each rejected row is valid for every constraint that PostgreSQL evaluates earlier (alphabetical), so a named error cannot come from the wrong rule.
7. Re-pin Docker/SQL identity before each of five integration Jest children. Each gets the guarded explicit DATABASE_URL and `HOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1`; shared globalSetup uses installed Prisma/Node only. Stop on the first failure; no retry.

The five suites are PO commands/queries and supplier storage/commands/queries (`src/procurement/{purchase-orders,suppliers}/*.integration.spec.ts`), run against the **final O3c schema**; the PO suites now include the confirm/cancel happy paths, S4 check order, confirm-vs-supplier-PATCH/product-update concurrency, cancel with the supplier locked and closed-order search. Their own random fixtures stay in this disposable target. Command/query integration tests sample zero stock/catalog/sales/payment/outbox effects and transactional rollback; HTTP alone does not prove those invariants.

**Pass gate:** process exit0 AND `results.json.state === "passed"`, `preservation` and `o3cPreservation` true, all named SQL checks (`constraints` and `o3cConstraints`) and all five integration statuses successful. Evidence files also include `o3c-before.json` / `o3c-after.json` (hashes and catalog only, no row contents). No offline test substitutes for this gate.

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

The opt-in wrapper reuses `scripts/supplier-runtime/host.cjs`; its original supplier-only invocation, routes and grants stay unchanged (supplier-only mode still answers 403 `OUTSIDE_DISPOSABLE_SCOPE` to confirm/cancel; a test pins it). O3c adds exactly two things to that host: the PO-only confirm/cancel routes and a `fixture` hook that only PO mode honors. `po-runtime/host.cjs` passes `po-fixture.cjs` through the hook, which replaces the generic PO seed (`seed`) and, once the server listens, creates the showcase orders through the real HTTP commands (`afterListen`, failure stage `seed-purchase-orders`). Any unexpected status while seeding aborts host start (no half-made showcase). PO mode imports real AuthModule, SuppliersModule, PurchaseOrdersModule and ProductsModule, not AppModule. It ignores env-file/config-env inheritance and uses fresh JWT secrets. PO mode registers EventEmitterModule.forRoot() so FilesService can receive its EventEmitter2 dependency. It still disables both the transitive outbox poller and dispatcher, plus Auth's PermissionSeeder bootstrap hook. This prevents bootstrap permission/global-role writes before the SQL identity pin; only explicit fixture grants are seeded afterwards. Nest compile-time logging is muted as well as application logging. Supplier-only invocation keeps its existing providers. Files-module configuration uses inert loopback-port1 storage values, never real credentials; no file routes are admitted. Only real product-selector reads are reachable. Production parser/filter/CORS order is retained.

### Bounded startup failure diagnostic

Once a private RUN is trusted, startup failures attempt an exclusive mode0600 `RUN/host-error.json` **before shutdown**. The first failure is retained; no append/overwrite/retry or raw-error fallback is allowed. An invalid RUN or unwritable/existing diagnostic may prevent recording; stderr remains generic.

Only these keys can appear: `stage`, `errorName`, optional `prismaCode`/`pgCode`/`nodeCode`, optional `constraint`/`modelName`, and `diMessage` **only for UnknownDependenciesException**. The DI summary contains only allowlisted class/token names from the host graph, capped at256 characters and restricted to `[A-Za-z0-9_ ,.?()'\-:]`. It examines at most4096 message characters, never copies free-form prose, and uses UnknownProvider when no known token appears. Stages are fixed step names (e.g. `build-module`, `compile-module`, `initialize-application`, `identity-pin`, `seed-catalog-products`, `listen`, `credentials-record`). Error/constraint/model names are allowlisted; unfamiliar names become fixed UnknownError/UnknownConstraint/UnknownModel labels. Code fields accept only bounded Prisma codes or known PG/Node codes. No message, stack, URL, credential, SQL, cause, request values or arbitrary metadata is copied, and getters/toJSON are never invoked.

Offline reproduction of the remaining compile failure: **FilesService cannot resolve EventEmitter at constructor index2 in FilesModule**. ProductsModule also imports FilesModule; disabling the outbox dispatcher did not satisfy this second consumer. PO mode now imports the same EventEmitterModule.forRoot() registration normally supplied by the root application. No src/dist, fixture, identity or bind changes were needed. All host-targeted compiled files remain under `dist/<module>`, not `dist/src`.

`compile.test.cjs` calls the **shared host builder** with real dist imports for both modes, but replaces every PrismaService registration with a fail-closed stub. It clears inherited credentials, refuses present env files, forbids Prisma/lifecycle access and Socket.connect, and stops after Nest compile (never app.init/listen). Both supplier-only and PO compiles pass with **zero Prisma/lifecycle calls and zero socket calls**. The initial PO compile observed the FilesService/EventEmitter failure before the registration fix. This proves DI composition only; actual initialized startup remains parent-owned.

Reinvoke the launcher only when parent-authorized, using the existing **successful** PROOF. It refreshes ownership checks and creates a new RUN; never overwrite/reuse the failed RUN or rerun the SQL proof to diagnose host startup. No recompilation is required for script-only changes when dist is already current.

Host route boundary is case-insensitive with one optional trailing slash:

- Existing supplier/auth routes only.
- Exactly GET/POST PO collection, GET/DELETE PO detail, PUT `/:orderId/draft`, and (O3c) POST `/:orderId/confirm` and POST `/:orderId/cancel` (plus automatic HEAD/read and CORS OPTIONS behavior).
- GET `/products` with only scalar search/type/page/limit; GET `/products/:id/variants` with no query. No product detail, writes, prices, files, history or adjacent routes.

It listens on ephemeral **127.0.0.1 only**, never3000. Exclusive private `ready.json` contains origins/pid; `credentials.json` contains password, generated users (email, id, display name)/tenant IDs, `catalog` IDs/names, and (O3c) `orders` / `suppliers` (IDs, statuses, notes of what the host created). Credentials stay only in the private `RUN` (mode 0600, never in the repo, docs, logs or chat); share only the exact private path with FE, whose human must authorize reading it.

All names are realistic Spanish business names (human rule: disposable runtime seed data must use realistic, readable names). Six users share the generated password; each holds exactly these grants (`create`/`read`/`update`/`delete` per subject):

| User (display name = actor snapshot) | `credentials.users` key | Exact grants in PO mode                                                                                                                                 |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| María González                       | `manager`               | CRUD ProcurementSupplier + CRUD ProcurementPurchaseOrder + read Product + **create ProcurementOrderConfirmation + create ProcurementOrderCancellation** |
| Luis Hernández                       | `editor`                | CRUD ProcurementPurchaseOrder + read ProcurementSupplier + read Product; **no confirm, no cancel**                                                      |
| Sofía Ramírez                        | `confirmer`             | read ProcurementPurchaseOrder + **create ProcurementOrderConfirmation** only                                                                            |
| Jorge Martínez                       | `canceller`             | read ProcurementPurchaseOrder + **create ProcurementOrderCancellation** only                                                                            |
| Ana Torres                           | `reader`                | **Only read ProcurementPurchaseOrder**; supplier/Product reads denied                                                                                   |
| Carlos Mendoza                       | `noaccess`              | None                                                                                                                                                    |

Roles: «Gerente de compras», «Capturista de compras», «Autorizadora de órdenes», «Responsable de cancelaciones», «Consulta de compras», «Sin acceso a compras». Tenant «Mascotas y Alimentos El Roble»; foreign tenant «Veterinaria Central del Sur (otro negocio)» with supplier «Proveedor de otro negocio» and one foreign product.

Catalog (tenant-scoped; keys are the probe/FE contract in `credentials.catalog`):

| Key              | Name                                | Unit      | Notes                                    |
| ---------------- | ----------------------------------- | --------- | ---------------------------------------- |
| `croquetas`      | Croquetas Adulto 15 kg              | BOLSA     | no variants                              |
| `unidad`         | Juguete mordedera de hule           | UNIDAD    | no variants                              |
| `kilogramo`      | Croquetas a granel                  | KILOGRAMO | decimals allowed                         |
| `caja`           | Latas de alimento húmedo (caja)     | CAJA      | variants «Pollo 400 g», «Res 400 g»      |
| `unidadVariants` | Collar ajustable                    | UNIDAD    | variants «Chico · Azul», «Grande · Rojo» |
| `noStock`        | Pecera personalizada (sobre pedido) | UNIDAD    | `useStock=false`                         |
| `service`        | Servicio de baño y corte            | HORA      | SERVICE type                             |
| `foreign`        | Producto exclusivo de otro negocio  | UNIDAD    | other tenant                             |

Suppliers: `active` «Distribuidora Veterinaria del Norte» and `archived` «Alimentos Balanceados del Bajío (archivado)» (created directly), plus, through the real API, «Mayorista de Accesorios Pet Center» (active) and «Distribuidora Canina Hidalgo (archivado)» (saved on a draft while active, then archived).

Showcase orders (`credentials.orders`, made by real commands, so audits, receipts and frozen snapshots are genuine; the host never edits or deletes them afterwards):

| Key                                       | Status / what it shows                                                                    | Made by                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `readyToConfirm`                          | DRAFT, `canConfirm: true`, three lines (bolsa, collar «Chico · Azul», granel)             | María González                                          |
| `readyToConfirm2` / `readyToConfirm3`     | DRAFT, `canConfirm: true` (spares for more confirm/cancel demos)                          | María González                                          |
| `incompleteCost`                          | DRAFT, missing cost → issues, `canConfirm: false` (confirm would be `ORDER_NOT_READY`)    | María González                                          |
| `archivedSupplierDraft`                   | DRAFT whose supplier was archived after saving → `SUPPLIER_ARCHIVED`, `canConfirm: false` | María González                                          |
| `confirmed` / `confirmed2` / `confirmed3` | CONFIRMED (spares to demo cancel-from-confirmed)                                          | María González; `confirmed3` by Sofía Ramírez           |
| `cancelledFromDraft`                      | CANCELLED, never confirmed                                                                | cancelled by Jorge Martínez                             |
| `cancelledFromConfirmed`                  | CANCELLED after CONFIRMED (both actor snapshots)                                          | confirmed by Sofía Ramírez, cancelled by Jorge Martínez |

No human/default role is changed.

## 3. Parent real HTTP probe (run once)

After `RUN/ready.json` exists, in another parent terminal:

```sh
node scripts/po-runtime/probe.cjs "$RUN"
```

The probe verifies private inputs and the exact ephemeral loopback origin, reserves `probe-result.json` using mode0600/**wx before any network request**, logs in the six real actors (manager, editor, confirmer, canceller, reader, noaccess; six logins, far below the source/email login limits), and sends requests only to that origin with configured FE Origin. Redirects fail; requests time out after10s. There is no retry/refresh, DB client, server launch, installer, env-file read or normal API access.

**O3b part (17 checks, S2–S13):** incomplete201 and diagnostics, replay/key conflict, GET detail/snapshots, exact KILOGRAMO `12.5 × 10.25 = 128.125`, PUT CAS200/stale409, pending variant/quantity and no-stock product, SERVICE400, actual foreign/random product404, UNIDAD fraction400, USD400, new ARCHIVED selection409 versus retained archived diagnostic, summary/supplier filter/current-name and note search/cursor binding and pagination, reader PO200 with supplier403 and mutation403, noaccess403/anonymous401, supplier DELETE409 with a draft, discard204/replay204/absence404 then supplier DELETE204. Every `PurchaseOrder` is now checked for the O3c shape (`status`, `supplierCurrentVersion`, `referenceToken`, `canConfirm`, `confirmedAt/By`, `cancelledAt/By`, no ids, `canConfirm` implies DRAFT + token + supplier version + no issues + ACTIVE supplier).

**O3c part (11 checks, S2–S10, S12):** `closure-setup-and-readiness-fields` (S2,S3); `confirm-not-ready-and-check-order` (S4,S8: no supplier and missing cost → `ORDER_NOT_READY`; `ORDER_VERSION_CONFLICT` beats `SUPPLIER_VERSION_CONFLICT`, then `ELIGIBILITY_CHANGED` for a wrong or null token; closed body → 400); `confirm-cancel-need-own-permission` (S10,S12: editor/reader/noaccess 403 on both, canceller 403 on confirm, confirmer 403 on cancel, anonymous 401; state unchanged); `confirm-by-confirm-only-user-and-replay` (S2,S4,S9: 200 CONFIRMED, version+1, `confirmedBy` = display name, frozen subtotals, replay returns the original, same key + other body → `IDEMPOTENCY_KEY_CONFLICT`); `closed-order-guards-version-first` (S5,S6,S8: PUT/DELETE/confirm on CONFIRMED → `ORDER_STATE_CONFLICT`, stale version → `ORDER_VERSION_CONFLICT` first); `archived-supplier-blocks-confirm` (S3,S4: `canConfirm` false + `SUPPLIER_ARCHIVED` issue; stale supplier version → `SUPPLIER_VERSION_CONFLICT`, fresh → `SUPPLIER_ARCHIVED`); `cancel-from-draft-by-cancel-only-user` (S5,S9: cancel needs no reason, extra `reason` → 400, second cancel → `ORDER_STATE_CONFLICT`); `cancel-from-confirmed-keeps-frozen-data` (S2,S5); `frozen-names-survive-rename-archive-and-search` (S2,S7: after renaming and archiving the supplier, the CONFIRMED order keeps name, ACTIVE status, line names and subtotals; search by the old name finds closed orders, by the new name only live drafts); `status-filter-and-cursor-binding` (S7,S12: `status=DRAFT|CONFIRMED|CANCELLED`, invalid/lowercase/comma/repeated → 400, cursor bound to status); `discard-empty-draft-still-allowed` (S6). S1's invariant (zero stock, reservations, payments, debt or events) is a command/integration-level property and is **not** claimable from HTTP.

All feature responses check no-store, exact CORS/credentials, exact closed errors and zero-byte204. Auth login uses its existing200/token/CORS contract; it is not a PO envelope/no-store assertion.

Output contains only static check names, S# tags, PASS/FAIL and statuses; results contain only booleans/names/tags/statuses. The probe creates its **own** data with realistic business names and never reads or mutates the seeded showcase orders (searches use phrases only the probe uses). Closed orders cannot be deleted (S6), so the probe necessarily leaves in the runtime, after the O3b part has deleted its own supplier «Comercializadora Agropecuaria de Occidente»: suppliers «Agroinsumos Peninsulares del Golfo» (originally «Forrajes y Granos del Pacífico», archived) and «Suministros Pecuarios de Jalisco» (archived); and five orders whose notes start with «Pedido semanal de croquetas Occidente» (O3b part: one draft with pending references) and «Pedido de cierre de temporada» (one CONFIRMED, two CANCELLED, one incomplete DRAFT). **Run the probe before handing the runtime to FE** and tell FE these extra rows exist. A failure stays visible; prerequisite failures stop downstream work. Do not overwrite/delete results to replay. API defects belong to the parent, not probe workarounds.

## Offline gates (no main execution)

```sh
node --test scripts/po-runtime/compile.test.cjs
node --test scripts/po-runtime/verify-po-migration.test.cjs
node --test scripts/po-runtime/host.test.cjs
node --test scripts/po-runtime/probe.test.cjs
node --test scripts/po-runtime/po-fixture.test.cjs
node --test scripts/po-runtime/launch.test.cjs
node --test scripts/supplier-runtime/host.test.cjs scripts/supplier-runtime/probe.test.cjs scripts/supplier-runtime/verify-delete-migration.test.cjs
for file in scripts/po-runtime/*.cjs scripts/supplier-runtime/host.cjs; do node --check "$file" || exit 1; done
node --check eslint.config.mjs
node node_modules/eslint/bin/eslint.js scripts/po-runtime/*.cjs scripts/supplier-runtime/host.cjs
node node_modules/prettier/bin/prettier.cjs --check scripts/po-runtime/*.cjs scripts/po-runtime/README.md scripts/supplier-runtime/host.cjs scripts/supplier-runtime/README.md eslint.config.mjs
git diff --check -- scripts/po-runtime scripts/supplier-runtime/host.cjs scripts/supplier-runtime/README.md eslint.config.mjs
```

Imports of executable host/proof/probe modules are inert. Most offline tests use fake DB/HTTP adapters; the compile test requires existing dist artifacts and compiles real Nest modules with the database provider replaced and sockets blocked, without initialization or listeners. They protect guards, exact constraint-code assertions, the exact O3c migration delta, sanitized output, fixture grants and readable names, route/query boundaries, the real-command seeding sequence and actors, and the complete probe sequence (including deliberate rounded-subtotal rejection and deliberate server defects the O3c checks must notice). They do **not** establish real PostgreSQL, routing/authorization or FE visual readiness. The ESLint semantic delta only extends the existing standalone CJS override to `scripts/po-runtime/*.cjs`; the affected config also receives Prettier-only formatting.
