# Supplier source verification — A3, D1 and disposable runtime

## Parent delivery evidence (D1–D3)

- Storage commit `ae8e802`; transactional API commit `23bb2fb`. The API unit exceeds the usual review-size target because its atomic behavior and regression tests are kept together; review it separately from storage and harness changes, never as the accumulated feature branch.
- Parent focused regression: 31 suites / 1860 tests, TypeScript and diff checks passed. Full offline regression: 511 suites / 12931 tests passed; one suite / 58 tests skipped. Nest build passed.
- Disposable migration proof: 73 baseline migrations then two forward migrations; exact preservation of two suppliers, three audits and three receipts; 341→339 constraints with only authorized changes. Storage21 + commands21 + queries7 = 49 SQL tests passed. These are historical observations, not a confined no-install run (see incident below).
- Independent D1 verdict passed S2/S3 deletion delta/S5/S6. Installer-path correction independently passed nine setup tests and 86 guard tests. Historical S4 confinement remains failed; the human explicitly accepted retaining current isolated dependencies and the unknown retrospective mutation extent. No cleanup, reinstall or retroactive PASS is claimed.
- Parent D3 runtime: five offline host/probe tests and scoped lint passed; 46 real HTTP checks passed on a separately owned migrated database. Checks include ACTIVE/ARCHIVED DELETE204, empty bodies/no-store/CORS, missing404, replay204, key/version409, reader/noaccess403 with unchanged records, malformed400, retained CREATE/UPDATE replay and case/trailing-slash routes. This is parent functional evidence, not independent D3 approval. Existing database/API3000 were not used.
- FE session reports parent-executed Playwright MCP E2E against API45581 and production entry/router/shell at FE43179: manager97/97, permissions35/35, deletion55/55. Programmatic real-auth-store login, not login-form/OTP coverage or independent verification. Cancellation sends no DELETE in1440/390 light/dark and restores focus; stale DELETE409 leaves detail readable; successful DELETE204 removes the row after refresh and detail returns404, with focus moved to search. Reader/noaccess DELETE403, reader has no delete action. Zero host OUTSIDE_DISPOSABLE_SCOPE responses and browser runtime errors reported. Synthetic FEProbe records remain. FE commits reported: aa5af07e(feature), acf3dd1b(button height); FE independent verdict and final evidence-doc commit remain pending. These are attributed remote results, not backend-executed browser tests.

## D2 S4 installer-confinement correction (not S4 PASS)

Independent verifier `mw0313nq-8-591g` passed D1 S2/S3 deletion delta/S5/S6 but blocked D2 S4. Retained parent proof `.tmp/delete-migration-proof.SyZbUU/105-integration-storage.log` records Corepack downloading pnpm12.16.1, downloading/adding1128 packages and Prisma Client6.19.2 postinstall generation. `npm_config_offline=true` did **not** confine the transitive `pnpm exec prisma migrate deploy` in integration global setup. The earlier no-dependency-change wording below describes D1 writer work, not that later parent proof.

The correction changes only test/proof infrastructure: shared `test/integration/setup/global-setup.ts` now resolves `prisma/build/index.js` and spawns `process.execPath` with `[installedCli, 'migrate', 'deploy']`. Missing/unresolvable CLI fails before spawn/seed, with no package-manager fallback. Nonzero/null exit, signal or spawn error prevents seed/retry. This affects **all integration suites**, not just suppliers; `.env.test` override precedence, explicit shell provenance, URL validation/localhost normalization, inherited child env with explicit normalized DATABASE_URL, baseline tenant upsert and disconnect semantics remain intact. Proof child env additionally disables Corepack network and Prisma autoinstall; these flags are defense in depth, not the fix.

### Correction test-first and checks

The exact offline global-setup command below observed **RED3 failed/6 passed** before the implementation: executable/args were pnpm rather than Node/installed CLI; unavailable CLI still spawned/seeded; a spawn error with status0 still seeded. After the correction: **GREEN9 passed**. Tests invoke actual globalSetup with mocked spawn/fs/dotenv/Prisma/reset-db imports (no real client construction, env-file reads or migrations). They also check explicit child/seed URL binding, env precedence, child failure/no retry, baseline upsert and seed-failure disconnect.

The normal `jest.config.js` excludes `test/integration/` and roots only src/prisma. Therefore use this dedicated inline offline config, **not** `jest.integration.config.js` (which runs DB setup):

```sh
node node_modules/jest/bin/jest.js --config '{"rootDir":".","roots":["test/integration/setup"],"testRegex":"global-setup\\.spec\\.ts$","transform":{"^.+\\.tsx?$":"ts-jest"},"testEnvironment":"node"}' --runInBand --no-cache --runTestsByPath test/integration/setup/global-setup.spec.ts
node node_modules/jest/bin/jest.js --config jest.config.js --runInBand --no-cache --testPathPatterns src/procurement/suppliers --silent
# 8 suites / 339 supplier tests PASS.
node --test scripts/supplier-runtime/verify-delete-migration.test.cjs
# 86 PASS, including actual proof env construction; no main() execution.
node node_modules/typescript/bin/tsc --project tsconfig.build.json --noEmit --incremental false
# PASS; focused compiler-API noEmit check of global-setup.ts + .spec.ts: 0 diagnostics.
node node_modules/eslint/bin/eslint.js test/integration/setup/global-setup.ts test/integration/setup/global-setup.spec.ts scripts/supplier-runtime/verify-delete-migration.cjs scripts/supplier-runtime/verify-delete-migration.test.cjs
node --check scripts/supplier-runtime/verify-delete-migration.cjs
```

Initial scoped lint found three formatting issues and one unsafe matcher assignment in the new setup tests/change; corrected without modifying lint configuration. Final lint passed. No product code edits, package-manager commands, install/generate, Docker/DB/network execution, proof retry/recreation, cleanup or git mutation occurred in this correction. Parent checks and **one targeted verifier recheck remain pending**; retained SQL observations do not retroactively satisfy confinement.

### Read-only dependency provenance: known versus unknown

Inspection was confined to this worktree's installed metadata and proof-owned directories, without credentials/env files or external symlink traversal. Known observations:

- Retained `99-migrate-deploy.log` applied73 baseline migrations; `102-migrate-deploy.log` applied the two authorized forward migrations (75 total). `105-integration-storage.log` independently records the installer/client-generation incident and21 passing storage tests. Parent/verifier49 SQL assertions and preservation remain historical observations, **not** a clean confined run.
- `node_modules/.modules.yaml`: `packageManager=pnpm@12.16.1`, layout5, mtime `2026-11-03T02:41:14.656Z`; `node_modules/.pnpm/lock.yaml` mtime `2026-11-03T02:41:14.670Z` (parent's Nov2 20:41 local time). Proof-local `.cache/pnpm` and `.local/share/pnpm` exist, mtimes `02:41:07.376Z` and `02:41:01.418Z` respectively. These are retained installer artifacts, not pre-run baseline evidence.
- Installed versions used for correction checks: Prisma/client6.19.2, Jest30.3.0, ts-jest29.4.6, TypeScript5.9.3, pg8.20.0. Direct package symlinks resolve within this worktree's `node_modules/.pnpm/`; Prisma targets `prisma@6.19.2_typescript@5.9.3/node_modules/prisma`, client targets `@prisma+client@6.19.2_prisma@6.19.2_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client`. No dependency upgrades are authorized or performed by this correction.
- Generated schema `node_modules/.pnpm/@prisma+client@6.19.2_prisma@6.19.2_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/schema.prisma`: mtime `2026-11-03T02:41:14.291Z`, SHA256 `e6342ba94e416bdac29d617076a2f87f1124873c8bb97f127dd32a7d3fda3fcc`, generated package6.19.2 and operation enum CREATE/UPDATE/DELETE. Source `prisma/schema.prisma` SHA256 `a1be47ae5e6bbe23e90819fb44f3f5771ab926bee0edc3ff91975cd4fabb5c04`; bytes differ (formatting/index ordering observed), so exact schema-byte equality is **not** claimed. Correction unit/type checks pass with the installed client; no new SQL compatibility proof is claimed.
- Installed `.pnpm/lock.yaml` and tracked `pnpm-lock.yaml` currently share SHA256 `d128eed2f3d9654fad4a0b1320847d572fffd890befaa93a13641d26cbc831fb`. `git diff --exit-code -- package.json pnpm-lock.yaml` passes. This establishes current lockfile agreement/tracked non-change only.

**Unknown:** no pre-run installed-dependency manifest/hash inventory exists. Exact before/after package, symlink, engine/native build, generated-client and cache mutation extent cannot be reconstructed from current metadata/logs. Same version/lock hash does not imply identical installed bytes or a clean dependency tree. No deletion, restoration or reinstall was attempted. S4 disposition and any further proof remain parent/human-owned.

## D1 hard deletion — writer evidence, parent D2/D3 still pending

Baseline `26c282c`. S2–S6 only: DELETE route, closed JSON `{expectedVersion}`, read+delete with no default grants, permanent operational-row removal, retained prior evidence, CAS/INTEGER ceiling, audit deletion event and durable204 replay after current persisted authority. No order table/query, stock, money, CxP, outbox, runtime fixture or dependency/role changes. `409 SUPPLIER_HAS_PURCHASE_ORDERS` is reserved for O3b, whose future order→supplier FK must be tenant-qualified and restrictive.

### Observed test-first evidence

Before implementation, runnable existing Jest observed:

```sh
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-commands.spec.ts src/procurement/suppliers/supplier-http.spec.ts src/procurement/suppliers/supplier-permissions.spec.ts --silent
# RED: 39 failed / 112 passed. Missing delete command/route; default unclosed malformed-body errors; missing registry permission.
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-contract.spec.ts src/procurement/suppliers/supplier-storage.spec.ts --silent
# RED: 13 failed / 121 passed. Missing deletion parser/hash and live-supplier relation still present.
```

No SQL RED/GREEN is claimed: the worker was explicitly forbidden DB/network/migration execution. Tests were authored for parent-only execution. After implementation, the first whole focused run passed320/failed2: two prior HTTP tests still asserted DELETE was unsupported. Those expectations were updated to unsupported **collection** deletion, preserving history/sibling/other-route parser isolation rather than weakening the new route contract. GREEN322 followed; triangulation added escaped duplicate members, media admission, equivalent routes, invalid paths, shared CREATE/UPDATE/READ/DELETE authority, forward-DDL drift and ceiling-edge cases. Final focused result is recorded below.

### Final local validation

```sh
./node_modules/.bin/jest --config jest.config.js --runInBand --testPathPatterns src/procurement/suppliers --silent
# 8 suites / 339 tests PASS; integration files excluded, no global setup.
./node_modules/.bin/tsc --project tsconfig.build.json --noEmit --incremental false
# PASS, no emitted artifacts.
./node_modules/.bin/eslint src/procurement/suppliers/supplier-contract.ts src/procurement/suppliers/supplier-contract.spec.ts src/procurement/suppliers/supplier-commands.ts src/procurement/suppliers/supplier-commands.spec.ts src/procurement/suppliers/supplier-commands.integration.spec.ts src/procurement/suppliers/supplier-authority.ts src/procurement/suppliers/supplier-permissions.spec.ts src/procurement/suppliers/supplier-storage.spec.ts src/procurement/suppliers/supplier-storage.integration.spec.ts src/procurement/suppliers/suppliers.controller.ts src/procurement/suppliers/supplier-http.filter.ts src/procurement/suppliers/supplier-http.spec.ts src/auth/authorization/domain/permission.ts
# PASS, no warnings/errors.
git diff --check
# PASS.
DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic ./node_modules/.bin/prisma validate --schema prisma/schema.prisma
# Installed Prisma6.19.2: generation/validation PASS, no database connection.
```

An explicit compiler-API no-emit program using parsed `tsconfig.json` options covered both changed integration specs plus contract/HTTP/command/permission/storage unit specs: **0 diagnostics**. Runtime inspection of the isolated generated client confirmed `{CREATE,UPDATE,DELETE}`. Editor Prisma7 rejects the repository's existing datasource.url, and editor LSP continued reporting a pre-generation enum without DELETE. These are incompatible/stale editor diagnostics, not represented as clean editor results or authority to upgrade Prisma. Markdown/opengrep diagnostic runners were silent/deferred; no clean result is claimed for those unavailable checks. Scoped CLI ESLint/TypeScript/Prisma outcomes above are observed.

HTTP tests use ephemeral Supertest listeners and the existing JWT/CLS/RBAC stack with mocked feature boundaries, not a live backend or SQL. They assert actual empty204 (no JSON-null wire/content-type), no-store/CORS, closed400/401/403/404/409/500 outcomes, no calls on rejected admission, read+delete requirements, duplicate raw headers/members (including escaped names), query rejection, invalid paths and unsupported media. Existing CREATE/PATCH/read/GET-body/cursor/permissions tests remain green. No automatic replay/retry is introduced.

### Parent-only SQL proof authored, not executed

- Both ACTIVE/ARCHIVED deletion after an update; exact prior audit/receipt equality, scalar IDs and DELETE version/prior-field snapshot/event timestamp; absent operational row; CREATE/UPDATE/DELETE original replay after removal, new-key404 and changed-body409; zero sampled business effects.
- Revoked persisted read or delete grant denies deleted replay. Foreign-tenant root404, stale/overflow409, no failed-write evidence.
- Real concurrent different-key delete/delete and update/delete: one committed event, loser404 after removal or409 after update; exactly one version increment/event and receipt. Same-key advisory lock contention yields IN_FLIGHT, then deliberate recovery and replay without duplicates.
- Injected audit/receipt errors after observing the actual row deletion inside the real transaction; operational row and prior evidence are restored atomically.
- Storage scalar/evidence preservation after deletion, retained restrictive tenant FKs even without live supplier, missing-tenant rejection, JSON-null DELETE receipt and wrong target/status/nonempty-response rejection. Earlier key/hash/name/terms/version/namespace checks retained.

Parent D2 must independently establish disposable ownership, verify pre-migration rows survive forward migration, and execute SQL/regression/independent checks. These specs run after integration global setup and do **not** themselves prove pre/post migration preservation. Parent D3 owns host DELETE allowlist/fixture/probe/runtime/FE handoff. No DB, Docker, runtime requests, credentials/.env, existing database/API3000, migration execution, full suite, emitted build, independent review or git delivery was performed by this writer.

### Coherent review slices and rollback

1. **Evidence-retaining storage:** schema + the two forward migrations + storage specs/docs. Inspect enum commit boundary, exact two live-supplier FK removals, unchanged tenant/key/hash/audit constraints and DELETE JSON-null CHECK. Existing migration stays byte-identical.
2. **Transactional permanent removal and transport:** contract/commands/authority/registry/controller/scoped parser + unit/SQL/HTTP tests and command/HTTP/evidence docs. Inspect authority-before-replay, unchanged lock order, tenant-qualified conditional deletion, version ceiling, retained historical replay and genuine empty204. These are review focuses within one coherent D1 delivery, not independent approval claims.

Source rollback boundary is the D1 deletion delta only, including its tests/docs and forward artifacts before deployment; retain the A1–A4 create/update/read code. No destructive down migration or operational rollback is supplied. Only authorized edit surfaces changed; the unrelated untracked inventory proposal is preserved.

## A3 historical verification record

## Delivery boundary

Implements S1–S4 supplier-only list/detail/search/cursor and normal Nest HTTP/module wiring after the approved command baseline `64b44d0`. No history route, default grants, purchase orders, inventory/money/CxP effects, dependency changes or command public-contract changes. `supplier-authority.ts` adds only READ support; CREATE remains create-only and UPDATE remains read+update.

The parent explicitly authorized the narrow `src/main.ts` parser import/install call after the initial scope question. Existing CORS, global parsers/filters, guards and human-decisions helper were not edited. The root API3000/database were not accessed. No environment files were read/copied, no DB/integration/global setup, services, migrations, installers, commits or publication ran.

**Remaining gates:** parent-owned fresh disposable PostgreSQL execution, isolated normal runtime, FE E2E/visual coordination, independent verification and native review. The seven new SQL cases are authored, semantically checked, **not executed**. Prior A2 SQL/full-suite evidence is parent-provided baseline evidence, not an A3 SQL result.

## Strict TDD evidence

Minimal exported scaffolds were used to observe intended missing-behavior failures before implementing each boundary. No RED is inferred from a later green run.

| Focus | Observed RED | Observed GREEN / triangulation |
| --- | --- | --- |
| Cursor | 14 failed: unimplemented encode/decode, scope/tamper/date validation | 14 passed; final 15 passed including correctly signed invalid version/resource/tuple/order fields |
| Reads | 19 failed: unimplemented list/detail, persisted authority, SQL bounds/search/order, error closure | 19 passed |
| Shared authority | 2 failed / 110 passed: READ denied read-only and admitted update-only | 112 passed; CREATE/UPDATE matrix plus all 28 existing command tests passed |
| HTTP | 48 failed / 2 passed: missing routes, default malformed/primitive/413 responses not closed | 50 passed; final 58 passed with invalid JWT, trusted CLS, equivalent routes, actual CORS preflight and unsupported-route parser regressions |
| Composition | 2 failed / 1 passed: feature provider and root registration absent | 3 passed |

RED commands (each command executed separately):

```sh
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-cursor.spec.ts
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-queries.spec.ts
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-contract.spec.ts
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-http.spec.ts --silent
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/suppliers.controller.spec.ts --silent
```

Final focused offline command: **8 suites / 246 tests passed**, including existing storage, permissions, command and wire tests. Integration specs are excluded by this config; there is no migration/global-setup execution.

```sh
./node_modules/.bin/jest --config jest.config.js --runInBand --testPathPatterns src/procurement/suppliers --silent
```

HTTP tests use only the existing Supertest ephemeral-listener mechanism, actual JWT strategy, JWT/tenant/permissions guards, CLS, production validation pipe/global filters, feature filter and scoped parser. Query/command boundaries and ability loading are mocks; these tests are not real DB/runtime proof. Rejected admission and denied guards assert no feature-boundary calls, exact status/envelope/no-store and CORS preservation. The direct controller test proves exact observed raw whitespace/key preservation independently of transport trimming. No backend retry is present.

## Static checks

Nest build-config TypeScript checking passed without emitting files:

```sh
./node_modules/.bin/tsc --project tsconfig.build.json --noEmit --incremental false
```

Focused semantic checking (including the unexecuted SQL spec) reported **0 diagnostics**:

```sh
node <<'NODE'
const ts = require('typescript');
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const roots = [
  'src/procurement/suppliers/supplier-contract.spec.ts',
  'src/procurement/suppliers/supplier-cursor.spec.ts',
  'src/procurement/suppliers/supplier-queries.spec.ts',
  'src/procurement/suppliers/supplier-queries.integration.spec.ts',
  'src/procurement/suppliers/suppliers.controller.spec.ts',
  'src/procurement/suppliers/supplier-http.spec.ts',
];
const program = ts.createProgram(roots, { ...parsed.options, noEmit: true, incremental: false });
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
}));
console.log(`Focused semantic TypeScript: ${diagnostics.length} diagnostics`);
process.exitCode = diagnostics.length ? 1 : 0;
NODE
```

Focused ESLint passed with **0 errors**, one pre-existing `src/main.ts` floating-bootstrap-promise warning. Only newly authored supplier files/test additions were formatting-fixed; unrelated source was not reformatted. `git diff --check` passed.

```sh
./node_modules/.bin/eslint src/procurement/suppliers/supplier-authority.ts src/procurement/suppliers/supplier-contract.spec.ts src/procurement/suppliers/supplier-cursor.ts src/procurement/suppliers/supplier-cursor.spec.ts src/procurement/suppliers/supplier-queries.ts src/procurement/suppliers/supplier-queries.spec.ts src/procurement/suppliers/supplier-queries.integration.spec.ts src/procurement/suppliers/suppliers.controller.ts src/procurement/suppliers/suppliers.controller.spec.ts src/procurement/suppliers/suppliers.module.ts src/procurement/suppliers/supplier-http.filter.ts src/procurement/suppliers/supplier-http.spec.ts src/app.module.ts src/main.ts
git diff --check
```

## Parent-only SQL proof to execute

Use the existing ownership-guarded disposable-target harness and integration setup; never a developer/existing database. `supplier-queries.integration.spec.ts` adds seven cases:

- Real SQL tied-timestamp pagination, last-returned cursor, no duplicate/missing items, exact page/wire keys and zero read-induced supplier/audit/receipt/product/sale/payment/outbox changes.
- Timestamp precedence and millisecond continuation across pages.
- Unicode case-insensitive literal `%`, `_`, backslash search, trim/blank search, explicit ACTIVE/ARCHIVED/ALL, injection treated as text.
- Tenant-qualified detail, archived detail, signed scope/tamper rejection including another legitimately authorized tenant.
- Persisted user, tenant and membership/grant-role revocation after a successful read (three cases).

Grant-edge locking still uses the same shared authority helper and lock order already exercised by A2; independent read concurrency proof is not claimed. PostgreSQL Unicode case behavior follows the configured database collation. Pagination is not a cross-page snapshot. JWT secret rotation invalidates cursors and requires an explicit fresh list; no new secret is required.

## Reviewable work units / rollback boundaries

The A3 source/test delta exceeds 400 authored lines, mainly readable test evidence. Keep both review focuses explicit rather than compressing tests; the parent owns any eventual commit/review slicing.

1. **Read boundary:** cursor + queries + their unit/SQL specs, the minimal READ authority extension and its CREATE/UPDATE regression table. Review tenant-qualified SQL, actual escape/order behavior, scope signing and persisted authority locks. Removing these files/READ extension leaves the original command implementation unchanged, provided HTTP wiring is removed first.
2. **HTTP boundary:** controller/module/filter/parser, HTTP/composition tests, AppModule import, narrow main installer and contract/evidence docs. Review raw headers, closed filter precedence, early CORS-preserving parser and exact route gates. Removing registration/parser and these new HTTP files removes supplier routes without altering existing controllers, global policy or the A2 command boundary.

S1: only the agreed supplier management capabilities are wired. S2: granular permissions, current authority, tenant isolation and unchanged command CAS/replay/audit semantics. S3: exact wire/input/error/no-store/pagination contract, with the runtime limits above. S4: existing root runtime/database, unrelated untracked proposal, private artifacts and all out-of-scope files preserved.

## Bounded S3 correction — unparsed GET bodies

Independent verifier `mvzosqmi-j-7eww` reported this source-derived blocker after its first-pass 246 tests/type checks passed; it was not an unavailable review. The parent subsequently reported pre-correction full-suite 12838 passed/58 skipped, build passed and SQL36 passed. Those are parent-provided baseline results, not correction revalidation or writer-executed SQL. Earlier sections retain the original writer evidence snapshot.

**Reproduced cause:** JSON/form parsing leaves nonempty `text/plain` and `application/octet-stream` requests with `request.body === undefined`. The old helper accepted them. Public HTTP RED demonstrated HTTP200 plus exactly one list/detail boundary call in all eight combinations of list/detail × plain/binary × positive Content-Length/valid chunked framing. The initial chunked fixture used Superagent `send()`, which added Content-Length alongside Transfer-Encoding and caused Node-level bare400; it was corrected to `write()` before implementation. The subsequent eight failures all demonstrated actual HTTP200/boundary admission.

Bodyless controls also reproduced four false rejections: JSON/form with explicit Content-Length0 became parsed `{}` and returned400. Final pre-implementation RED was **12 failed/71 passed** in the 83-case HTTP suite.

**Minimal correction:** only `noBody()` in `suppliers.controller.ts` changed. Node-validated positive Content-Length or Transfer-Encoding declares a prohibited GET body stream, independently of parser/content type; chunked framing is rejected without consuming the stream, including before its length is known. Absent framing or zero Content-Length remains bodyless, even when JSON/form parsers synthesize `{}`. No parser, route, guard, CORS, command/query or global policy changes were needed. The existing automatic HEAD-to-GET handler uses the same helper; no route was added.

**Observed GREEN:** HTTP83 passed; focused supplier8 suites/271 tests passed, retaining the original246 and adding25 cases. The new matrix covers eight rejected nonempty plain/binary requests, sixteen accepted bodyless content-type/framing combinations and JSON detail rejection; the existing JSON list rejection remains. Rejections assert exact `400 {statusCode:400,error:'MALFORMED'}`, no-store, preserved CORS and zero query/command boundary calls. Bodyless controls return their ordinary persisted wire/page mock acknowledgments.

Commands (RED and GREEN used the same HTTP command):

```sh
./node_modules/.bin/jest --config jest.config.js --runInBand --runTestsByPath src/procurement/suppliers/supplier-http.spec.ts --silent
./node_modules/.bin/jest --config jest.config.js --runInBand --testPathPatterns src/procurement/suppliers --silent
./node_modules/.bin/tsc --project tsconfig.build.json --noEmit --incremental false
./node_modules/.bin/eslint src/procurement/suppliers/suppliers.controller.ts src/procurement/suppliers/supplier-http.spec.ts
git diff --check
```

Build-config semantic checking passed without emission; focused two-root semantic TypeScript checking (same compiler-API method above, roots `suppliers.controller.ts` and `supplier-http.spec.ts`) reported0 diagnostics. Focused lint passed with0 warnings/errors; diff-check passed. No DB/runtime, broad suite/build emission, dependency changes or git delivery actions ran in this correction. Parent checking/re-review remains pending; no verified completion or API-ready claim.

Correction rollback boundary: the framing helper replacement, the25 added HTTP cases and this evidence section only. All unrelated A3 source/tests and advisories were preserved.
