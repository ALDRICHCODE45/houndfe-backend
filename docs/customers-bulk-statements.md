# Customers bulk statements (ZIP of PDFs) — frontend guide

Status: implemented on branch `feat/customers-bulk-actions` (task `odd/tasks/customers-bulk-actions.md`, T3 / S5). Contract: `docs/proposals/customers-bulk-actions-contract.md` v0 §3, plus the owner / frontend answers L2–L5, which override v0 where they differ (entry names = customer name, L3.3).

The **selection object** is the same one as the CSV export: see `docs/customers-bulk-export.md` §3. The single statement stays `GET /customers/:customerId/statement/pdf` (handoff 29). For one customer, keep using it: you get a PDF, not a one-entry ZIP.

## 1. Route

| Method | Path | Permissions | Response |
|---|---|---|---|
| POST | `/customers/bulk/statements` | `read:Sale` **and** `read:Customer` | `200 application/zip` |

- `read:Sale` is the single statement's permission. `read:Customer` is needed because the selection reads the customer table (contract §5). Because `read:Sale` is always present here, metric filters inside `filter` (`hasDebt`, `openDebtMin`, …) are always allowed.
- Hide «Estados de cuenta» when `GET /auth/me/permissions` lacks either one (and the user is not Super Admin, `manage:all`).

## 2. Request body

```json
{
  "selection": { "mode": "filter", "filter": { "hasDebt": "true" }, "excludeIds": ["uuid-9"] },
  "from": "2026-11-01",
  "to": "2026-12-01"
}
```

| Field | Type | Notes |
|---|---|---|
| `selection` | object, required | `ids` mode or `filter` + `excludeIds` mode, exactly as in `docs/customers-bulk-export.md` §3 (same limits, same validation, same strict 404 in ids mode). Reserved keys (`__proto__`, `constructor`, `prototype`) inside `filter` → `400`, like any unknown param; anywhere else in the body (top level, `selection`, nested objects) → `400` like an unknown property there |
| `from` | `YYYY-MM-DD`, required | Same rules as the single statement: exact local date in the business timezone (`America/Mexico_City` by default), inclusive |
| `to` | `YYYY-MM-DD`, required | Exclusive (`[from, to)`), `from < to`, at most **366 days** |

There is no `sortBy`: files are always in name order (§3). Unknown body keys → `400`.

Period presets stay in the frontend, as for the single statement: «Este mes» = `from=<1st of this month>`, `to=<1st of next month>`; «Mes anterior»; «Últimos 3 meses»; chosen dates.

## 3. Response `200`

| Header | Value |
|---|---|
| `Content-Type` | `application/zip` |
| `Content-Disposition` | `attachment; filename="estados-de-cuenta-<from>-<to>.zip"` |
| `Content-Length` | ZIP size in bytes |
| `Cache-Control` | `no-store` |

- `Content-Disposition` and `Retry-After` are exposed through CORS (`Access-Control-Expose-Headers`), so a cross-origin frontend can read the filename and the `429` back-off. Download as a blob (POST: a plain link does not work).
- The whole ZIP is built before the first byte is sent: an error never arrives as half a ZIP.

### 3.1 ZIP contents

- **One PDF per selected customer**, in the customers table «name» order (first name, then last name, case-insensitive; ties by id).
- **Customers without movements in the period are included** (owner L2.3): their PDF shows the empty states and the current open debt.
- **Each PDF is exactly the single statement** for that customer and period — the same reader, template and numbers as `GET /customers/:customerId/statement/pdf` (owner L2.2). It is byte-identical to a single download made at the same moment (the «generado» timestamp is per statement).
- **Entry names** (frontend L3.3): the customer's name, `«Nombre Apellido».pdf` — e.g. `Ana López.pdf`, `Bruno.pdf`.
  - Accents and `ñ` are kept. Characters invalid in Windows/macOS/Linux file names (`< > : " / \ | ? *`) become `-`; control and invisible characters are removed; leading/trailing dots and spaces are trimmed; at most 100 characters.
  - Equal names (case-insensitive) are disambiguated in ZIP order: `Ana López.pdf`, `Ana López (2).pdf`, `Ana López (3).pdf`.
  - A name with nothing usable left → `cliente-<first 8 characters of the customer id>.pdf`.
  - Names are UTF-8 (ZIP flag set); Windows 10+ Explorer, macOS and `unzip` show them correctly.
- File dates inside the ZIP are the business local time of the download, whatever the server time zone is. Known limit: the ZIP format stores a local wall time and the in-repo writer encodes it from the server's local clock, so a download whose business time falls in the **server's** spring-forward hour (only possible on a server whose `TZ` observes DST; never with `TZ=UTC`) gets file dates one hour later. The PDFs are not affected.
- Entries are deflate-compressed when that makes them smaller.

## 4. Limits and timing

| Limit | Value |
|---|---|
| `customerIds`, `excludeIds` | ≤ 1,000 each |
| Customers per ZIP | **1–50** (owner L2.1) |
| Period | 1–366 days |
| Concurrent bulk statement downloads | **1 per server process**: a second one → `429` (§5) |
| Run time | **120 s** per download (server deadline): after that → `503 BULK_EXPORT_TIMEOUT` (§5) |

- More than 50 resolved customers → `400 BULK_SELECTION_TOO_LARGE` before anything is rendered. Disable the button when `N > 50` («Máximo 50 clientes por descarga»), where N = selected rows, or `filterSummary.count − unticked` for «todos los del filtro».
- The request is **synchronous**: PDFs are rendered one at a time. Measured with the real PDF engine: ≈ 50 ms for a statement with no movements, ≈ 180 ms median / ≈ 210 ms p95 for one with 20 sales and 10 payments (≈ 35 KB each). 50 full statements ≈ 9–10 s (benchmark). Show a spinner and do not set a client timeout under ~30 s (the server gives up at 120 s anyway).

### 4.1 Known limits (by design)

- **The run slot is process-wide** (review R1): one bulk statements download per server process (per replica), shared by **all branches / tenants** of that process. It protects the API's CPU (rendering runs on the event loop), not a tenant: a run in one branch makes a concurrent request from another branch get `429`. With several replicas, each one runs one download at a time.
- **Per-run deadline** (`BULK_STATEMENTS_RUN_DEADLINE_MS` = 120 s, review R4-001): the slot can never stay held by a stuck run (a stalled database read, a renderer waiting on a remote resource). When the deadline passes, the request fails with `503 BULK_EXPORT_TIMEOUT` and the slot is freed at once, without waiting for the stuck statement; the run stops before its next step and a late result is discarded. A client disconnect frees the slot the same way, even in the middle of a render. Because a stuck render is not killed, its work may still finish in the background after the slot has been given to the next run; that work never touches the slot again.

## 5. Errors

Checks run in this order: route permissions → reserved keys (anywhere in the body) → body shape → busy check → `filter` values → ids existence → size / empty → rendering. Because the busy check comes before the `filter` values, a request with an invalid filter gets `429` (not `400`) while another run is in progress.

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body | `selection` invalid (see the export guide §7); `from` / `to` missing, not an exact `YYYY-MM-DD`, `to <= from`, or more than 366 days; unknown body key |
| 400 | `LISTING_*` codes | a bad value inside `filter` (same rules and `field` names as the listing) |
| 400 | `BULK_SELECTION_TOO_LARGE` (`details: { count, max: 50 }`) | more than 50 customers |
| 400 | `BULK_SELECTION_EMPTY` | the selection resolves to 0 customers (e.g. a filter that matches nobody) |
| 401 | standard | missing or invalid token |
| 403 | `{ statusCode: 403, error: "INSUFFICIENT_PERMISSIONS", message: "Insufficient permissions", timestamp }` (code in `error`) | no `read:Sale` or no `read:Customer` |
| 404 | `BULK_CUSTOMERS_NOT_FOUND` (`details: { missingIds }`) | ids mode: an id is unknown, from another branch, or deleted. Also if a customer is deleted while the ZIP is being built (`missingIds` = that id). Nothing is sent |
| 429 | `BULK_EXPORT_BUSY` (`details: { retryAfterSeconds: 10 }`) + header `Retry-After: 10` | another bulk statements download is running on the server |
| 500 | `PDF_GENERATION_FAILED` | a statement failed to render; nothing is sent |
| 503 | `BULK_EXPORT_TIMEOUT` (`details: { deadlineSeconds: 120 }`) | the download did not finish within the 120 s server deadline (§4.1); nothing is sent |

```json
{ "statusCode": 429, "code": "BULK_EXPORT_BUSY", "message": "another bulk statements download is in progress; retry later", "details": { "retryAfterSeconds": 10 } }
```

```json
{ "statusCode": 400, "code": "BULK_SELECTION_TOO_LARGE", "message": "selection resolves to 73 customers; max 50", "field": "selection", "details": { "count": 73, "max": 50 } }
```

```json
{ "statusCode": 503, "code": "BULK_EXPORT_TIMEOUT", "message": "the bulk statements download took too long and was stopped; retry with fewer customers", "details": { "deadlineSeconds": 120 } }
```

UI suggestions: on `503 BULK_EXPORT_TIMEOUT`, show «La descarga tardó demasiado; inténtalo con menos clientes» (it should not happen with ≤ 50 customers unless the server is in trouble). On `429`, show «Otra descarga de estados de cuenta está en curso» and retry after `Retry-After` seconds (or let the user retry). On `404 BULK_CUSTOMERS_NOT_FOUND`, drop `missingIds` from the selection, tell the user («N clientes ya no existen y se quitaron de la selección»), and resend.

## 6. Audit

No audit table for now (owner L5). Every run writes one structured server log line (`customers.bulk.statements`): user id, branch id, selection mode, period, customer count, ZIP size, render and total durations, and the outcome (`ok`, `rejected`, `busy`, `aborted`, `timeout`, `failed`) with the error code (warn level for every non-`ok` outcome). No customer data and no customer ids are logged. If the client disconnects mid-run, the run stops at once (no further PDF is rendered, the slot is freed) and the request ends quietly: no response is written (the client is gone) and no error-level log or `500` is produced, only the `aborted` line.
