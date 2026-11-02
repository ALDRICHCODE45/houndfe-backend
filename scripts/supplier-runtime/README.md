# Disposable supplier HTTP probe

Run against the **already running, parent-owned** supplier host only:

```sh
node --check scripts/supplier-runtime/probe.cjs
node scripts/supplier-runtime/probe.cjs .tmp/supplier-runtime.zZxMpc
```

Requires Node with global `fetch`, `Headers` and `AbortSignal.timeout`; uses only built-ins. Does not start/stop the host, invoke a database client, read env files, install dependencies or touch the normal API. The owner-only RUN directory must contain private mode-0600 `credentials.json` and `ready.json` written by `host.cjs`. The only network origin is `ready.json.apiOrigin`, required to match credentials and be HTTP IPv4 loopback on an explicit port other than 3000. Redirects are rejected. Requests send the fixed FE Origin `http://127.0.0.1:43179`.

The probe consumes private login inputs in memory, authenticates all three actors via real `/auth/login`, and never logs response bodies, exception messages, passwords, tokens, identities, URLs or private file contents. Output is limited to named PASS/FAIL lines, S# coverage and observed HTTP statuses. Exit 0 means all checks passed; exit 1 means a check/setup/result-write failed. Expected negative HTTP statuses are passes when the closed envelope matches.

`RUN/probe-result.json` contains only a boolean summary and check names, S# tags, boolean outcomes and status codes. It is created with mode 0600 and exclusive `wx`; existing results are never replaced. Do not delete/overwrite it to rerun. A parent-authorized correction rerun requires a separately agreed result-file disposition; never silently replay a completed run. The probe creates four uniquely named suppliers in the disposable tenant and leaves them as evidence; no cleanup/deletion is performed.

## Coverage

| Checks | Spec |
| --- | --- |
| Real manager/reader/noaccess login; scoped disposable origin and private outputs | S1, S2, S4 |
| Manager create, exact original replay before/after mutations, key/body conflict | S1, S2, S3 |
| ACTIVE/ARCHIVED/ALL, trimmed case-insensitive search, limit/cursor/order/no duplicates | S2, S3 |
| Detail, PATCH CAS/stale conflict, null clearing/omission preservation, archive/reactivate | S1, S2, S3 |
| Two concurrent PATCHes with distinct keys and one expectedVersion: exactly one winner | S2, S3, S4 |
| Reader reads and write denials, noaccess denial, anonymous 401 | S2, S3 |
| Initially empty own-tenant list; all subsequent list items are probe-created; foreign-name search empty; random UUID 404 | S2, S3, S4 |
| Nonempty text/plain GET (using node:http), invalid JSON, unknown field, blank name, invalid limits, changed-search cursor | S3 |
| Every supplier response: no-store and exact allowed CORS origin/credentials; every expected error: exact closed envelope | S3 |
| Final item set and detail unchanged by rejected writes | S2, S3, S4 |

Tenant-isolation proof is intentionally bounded: the probe does not know/discover the foreign supplier ID. Random UUID 404 is **not** a direct foreign-ID detail test. HTTP evidence does not prove database audit/receipt atomicity, rollback, absence of stock/money side effects or FE visual behavior; those remain parent-owned checks. S1 labels trace authorized supplier behavior, not new human approval.

## Failure discipline

Run once after syntax validation. For any failed check, inspect the relevant source to distinguish probe mistakes from suspected API defects. Fix only this probe, never `src/` or the running host. At most one parent-authorized correction rerun per failing check; API defects are reported with source path:line evidence rather than retried or worked around. A failed prerequisite aborts downstream checks; an ordinary check failure remains visible while later checks continue. No hidden retry/refresh is implemented.

The repository ESLint project service does not include `scripts/*.cjs` (also true for the parent host); do not alter TypeScript/ESLint configuration to hide that tooling limitation. `node --check` is the scoped syntax gate.
