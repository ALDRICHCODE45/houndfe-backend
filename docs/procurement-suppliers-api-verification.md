# Supplier A3 — source verification, not API readiness

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
