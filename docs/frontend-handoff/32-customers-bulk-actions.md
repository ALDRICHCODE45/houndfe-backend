# 32 — Customers table bulk actions: «Exportar CSV» and «Estados de cuenta PDF» (ZIP)

**Status:** implemented on branch `feat/customers-bulk-actions` (08795da8 contract v0, 1ab4920b ZIP writer, bafb6c29 selection + CSV export + CORS, 9946d2f5 reserved filter keys / denied-export log / CORS merge, 7047c129 bulk statements); **e55240d0 advisory follow-up** (bulk statements per-run deadline with a new timeout code, quiet client-abort handling). Task: `odd/tasks/customers-bulk-actions.md`. Contract: `docs/proposals/customers-bulk-actions-contract.md` v1 (owner OK 2026-11-27). Route guides with more detail: `docs/customers-bulk-export.md`, `docs/customers-bulk-statements.md`.

**No migration.** The new permission `export:Customer` («Exportar datos de clientes (CSV)») is upserted by the permission seeder on boot, so every environment gets the row with the deploy. It is granted only to Super Admin (`manage:all`). **Roles that hold `manage:Customer` cannot export until `export:Customer` is granted to them in Admin → Roles.**

Owner decisions (2026-11-27): 50 PDFs per download and 10,000 rows per CSV; ZIP with one PDF per customer; customers without movements included (the PDF shows their current debt); Excel es-MX with the `="03100"` CP trick; CSV export is a **new special permission** — owner verbatim: «Nonono, perdon, exportar datos de clientes debe ser un permiso nuevo especial.»; no audit table for now — «Por ahora no, pero dejalo anotado para platicarlo despues» (structured server log only; audit table is a future item).

Frontend decisions (2026-11-27): customer name in each ZIP file, sanitized and disambiguated; in-repo ZIP writer (no new dependency); the 28 CSV columns as proposed; `Content-Disposition` exposed through CORS; strict `404` with the list of missing ids.

Shapes come from the code: `src/customers/bulk/**`, `src/sales/customer-bulk-statements*`, `src/sales/dto/customer-bulk-statements.dto.ts`, `src/shared/zip/**`, `src/catalog-editorial/http/editorial-cors.ts`, `src/auth/authorization/domain/permission.ts`. Money in the CSV is decimal pesos (not cents).

## 1. Routes

| Method | Path | Permissions | Response |
|---|---|---|---|
| POST | `/customers/bulk/export` | `read:Customer` **and** `export:Customer` (+ `read:Sale` for the metric columns) | `200 text/csv` |
| POST | `/customers/bulk/statements` | `read:Sale` **and** `read:Customer` | `200 application/zip` |

- Both are POST with a JSON body (a list of up to 1,000 UUIDs does not fit in a URL). Download the response as a blob: a plain link does not work.
- Both bodies carry the same `selection` object (§2). Unknown body keys → `400`.
- For one customer, keep using `GET /customers/:customerId/statement/pdf` (handoff 29): a PDF, not a one-entry ZIP.

### 1.1 Who sees which button

| `GET /auth/me/permissions` | «Exportar CSV» | «Estados de cuenta» |
|---|---|---|
| `manage:all` (Super Admin) | yes, 28 columns | yes |
| `read:Customer` + `export:Customer` + `read:Sale` | yes, 28 columns | yes |
| `read:Customer` + `export:Customer` | yes, 20 columns (no metrics) | no |
| `read:Customer` + `read:Sale`, or `manage:Customer` without `export:Customer` | **no** | yes |
| `read:Customer` only | no | no |

`manage:Customer` («Full customer management») does **not** include `export:Customer`: the export checks for the explicit permission (or `manage:all`). A `manage:Customer`-only user who calls the export gets `403 INSUFFICIENT_PERMISSIONS`.

## 2. Selection (shared)

### 2.1 Row checkboxes — `ids` mode

```json
{ "selection": { "mode": "ids", "customerIds": ["uuid-1", "uuid-2"] } }
```

- `customerIds`: required, 1–1,000 UUIDs (the 1,000 counts the array as sent). Duplicates are removed.
- **Strict:** any id that is unknown, belongs to another branch, or was deleted → `404 BULK_CUSTOMERS_NOT_FOUND` with every missing id in `details.missingIds`. Nothing is generated.
- `filter` / `excludeIds` in this mode → `400`.

### 2.2 «Todos los del filtro» — `filter` mode

```json
{
  "selection": {
    "mode": "filter",
    "filter": { "hasDebt": "true", "city": "Ciudad de México,Zapopan", "search": "ana" },
    "excludeIds": ["uuid-9"]
  }
}
```

- `filter`: required object with the `GET /customers/listing` params **exactly as in the URL** (handoff 31 §2.3–§2.4): string values, CSV lists as one comma-separated string; a string array (repeated param) is also accepted. Build it from the same `URLSearchParams` you send to the listing.
  - Same meaning, validation, error codes and `field` names as the listing (`field` is the plain name: `"openDebtMin"`, never `"filter.openDebtMin"`).
  - `page`, `limit`, `sortBy`, `sortOrder` inside `filter` → `400` (the CSV sort is top-level, §3.1).
  - A non-string value (number, boolean, object) → `400`.
  - `__proto__`, `constructor`, `prototype` → `400`, like any unknown param.
  - `filter: {}` = every customer of the branch.
- `excludeIds`: optional, 0–1,000 UUIDs never included. Ids that do not match or do not exist are ignored.
- `customerIds` in this mode → `400`.
- The filter is evaluated when the request arrives: a customer deleted since the table loaded just does not match (no 404).

### 2.3 Limits

| Item | Limit |
|---|---|
| `customerIds`, `excludeIds` | ≤ 1,000 each |
| Resolved customers, CSV | 0–**10,000** |
| Resolved customers, statements | 1–**50** |

Over the cap → `400 BULK_SELECTION_TOO_LARGE` with `details: { count, max }`, checked before anything is generated (never a truncated file). N for the UI = selected rows, or `filterSummary.count − unticked rows` for «todos los del filtro».

## 3. `POST /customers/bulk/export` — «Exportar CSV»

### 3.1 Request

```json
{
  "selection": { "mode": "filter", "filter": { "hasDebt": "true" }, "excludeIds": [] },
  "sortBy": "openDebt",
  "sortOrder": "desc"
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `selection` | object, required | — | §2 |
| `sortBy` | `name` \| `openDebt` \| `oldestOverdue` \| `lastPurchaseAt` \| `totalSold` \| `salesCount` \| `averageTicket` \| `createdAt` | `createdAt` | Listing values; every key except `name` / `createdAt` needs `read:Sale`. Applies in both modes. Send the table's current sort |
| `sortOrder` | `asc` \| `desc` | `desc` | |

### 3.2 Response `200`

| Header | Value |
|---|---|
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="clientes-<YYYY-MM-DD>.csv"` (local business date, `America/Mexico_City` by default) |
| `Cache-Control` | `no-store` |

- `Content-Disposition` is in `Access-Control-Expose-Headers` on every route, so a cross-origin frontend can read it.
- The file is built completely before the first byte: an error never arrives as half a file.
- A selection matching nothing → `200` with the header row only (no `BULK_SELECTION_EMPTY` on this route).

### 3.3 Format (Excel, Spanish – Mexico)

| Item | Value |
|---|---|
| Encoding | UTF-8 **with BOM** (`EF BB BF`); no `sep=` line |
| Separator | comma `,` |
| Line endings | CRLF after every record, the header included |
| Quoting | RFC 4180: a field with `,`, `"`, CR or LF is wrapped in `"…"`, inner `"` doubled |
| Money | decimal pesos, `.` point, 2 decimals, no `$`, no thousands separator: `78500` cents → `785.00` |
| Instants (`Alta`, `Última compra`) | local `YYYY-MM-DD HH:mm`, 24 h, business timezone |
| `Vencido desde` | `YYYY-MM-DD` (the POS due day) |
| Booleans | `Sí` / `No` |
| `null` / missing | empty cell |
| `Especies` | `Perro, Gato, Otro` in one (quoted) cell |
| `CP` | digits-only value → Excel text formula `="03100"` (CSV text `"=""03100"""`) so the leading zero survives; any other value is plain (guarded) text |
| Formula-injection guard | in user-text cells (names, business name, country code, phone, email, price list, RFC, regime, payment method, address fields, non-digit CP), a value starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'` |

### 3.4 Columns

Base columns (always), in this order:

`ID cliente`, `Nombre`, `Apellido`, `Razón social`, `Lada`, `Teléfono`, `Correo`, `Lista de precios`, `RFC`, `Régimen fiscal` (SAT code), `Forma de pago preferida`, `Cliente de confianza`, `Alta`, `Colonia`, `Municipio`, `Ciudad`, `Estado`, `CP`, `Mascotas activas`, `Especies`.

Metric columns (**only with `read:Sale`**, appended after `Especies`; without it they are absent from the header and every row, not empty):

`Deuda`, `Deuda vencida`, `Ventas vencidas`, `Vencido desde`, `Compras`, `Total comprado`, `Ticket promedio` (empty without sales), `Última compra` (empty without sales).

The values are the listing row's (same SQL, same overdue cut-off; handoff 31 §2.2). `matchedPetName`, `matchedAddressId`, the full address list, `comments` and billing data are not exported. The primary address is the listing's (the oldest one).

Measured on the test database: 10,000 rows with metrics ≈ 1.1 s, ≈ 1.1 MB.

### 3.5 Errors

Checks run in this order: route permissions → reserved `filter` keys → body shape → `filter` values → metric-param permission → ids existence → size.

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body `{ statusCode, message: [ValidationError…], error: "Bad Request" }` | `selection` missing / not an object; `mode` not `ids` / `filter`; a key of the other mode; `customerIds` empty, > 1,000 or not UUIDs; `excludeIds` > 1,000 or not UUIDs; unknown body or selection key; bad `sortBy` / `sortOrder`; inside `filter`: `page` / `limit` / `sortBy` / `sortOrder`, an unknown param (incl. `__proto__` / `constructor` / `prototype`), a non-string value, a bad boolean or day value |
| 400 | `LISTING_INVALID_NUMBER`, `LISTING_INVERTED_RANGE`, `LISTING_INVALID_DATE`, `LISTING_INVALID_ENUM_VALUE`, `LISTING_TOO_MANY_VALUES`, `LISTING_INVALID_UUID` | a bad value inside `filter`; same rules, `field` and `details` as the listing |
| 400 | `LISTING_PARAM_REQUIRES_PERMISSION` (`details.required: "read:Sale"`) | without `read:Sale`: a metric filter in `filter` or a metric `sortBy`; `field` = first offending filter in listing order, then `sortBy` |
| 400 | `BULK_SELECTION_TOO_LARGE` (`details: { count, max: 10000 }`) | more than 10,000 customers |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` (`{ statusCode, error: "INSUFFICIENT_PERMISSIONS", message, timestamp }`) | no `read:Customer`, no `export:Customer`, or only `manage:Customer` |
| 404 | `BULK_CUSTOMERS_NOT_FOUND` (`details: { missingIds }`) | ids mode: an id is unknown, foreign or deleted |

```json
{ "statusCode": 400, "code": "BULK_SELECTION_TOO_LARGE", "message": "selection resolves to 10001 customers; max 10000", "field": "selection", "details": { "count": 10001, "max": 10000 } }
```

```json
{ "statusCode": 404, "code": "BULK_CUSTOMERS_NOT_FOUND", "message": "2 customers not found", "field": "customerIds", "details": { "missingIds": ["uuid-a", "uuid-b"] } }
```

## 4. `POST /customers/bulk/statements` — «Estados de cuenta PDF»

### 4.1 Request

```json
{
  "selection": { "mode": "ids", "customerIds": ["uuid-1", "uuid-2"] },
  "from": "2026-11-01",
  "to": "2026-12-01"
}
```

| Field | Type | Notes |
|---|---|---|
| `selection` | object, required | §2. Because `read:Sale` is required, metric filters in `filter` are always allowed here |
| `from` | `YYYY-MM-DD`, required | Same rules as the single statement (handoff 29): exact local date, inclusive |
| `to` | `YYYY-MM-DD`, required | Exclusive (`[from, to)`), `from < to`, at most **366 days** |

No `sortBy`: files are always in the table's «name» order. Period presets stay in the frontend: «Este mes» = `from=<1st of this month>`, `to=<1st of next month>`; «Mes anterior»; «Últimos 3 meses»; chosen dates.

### 4.2 Response `200`

| Header | Value |
|---|---|
| `Content-Type` | `application/zip` |
| `Content-Disposition` | `attachment; filename="estados-de-cuenta-<from>-<to>.zip"` (CORS-exposed) |
| `Content-Length` | ZIP size in bytes |
| `Cache-Control` | `no-store` |

The whole ZIP is built before the first byte: an error never arrives as half a ZIP.

### 4.3 ZIP contents

- **One PDF per selected customer**, ordered by first name, then last name (case-insensitive), ties by id.
- **Customers without movements are included**: their PDF shows the empty states and the current open debt.
- **Each PDF is the single statement** for that customer and period (same reader, template and numbers as `GET /customers/:customerId/statement/pdf`); only the «generado» timestamp differs per statement.
- **Entry names:** `«Nombre Apellido».pdf` (`firstName lastName`; `businessName` is not used), e.g. `Ana López.pdf`, `Bruno.pdf`.
  - Accents and `ñ` kept. `< > : " / \ | ? *` → `-`; control and invisible characters removed; whitespace collapsed; leading/trailing dots and spaces trimmed; Windows reserved names (`CON`, `NUL`, …) get `_`; at most 100 characters.
  - Equal names (case-insensitive) are numbered in ZIP order: `Ana López.pdf`, `Ana López (2).pdf`, `Ana López (3).pdf`.
  - Nothing usable left → `cliente-<first 8 characters of the customer id>.pdf`.
  - UTF-8 names (ZIP UTF-8 flag): Windows 10+ Explorer, macOS and `unzip` show them correctly.
- Entries are DEFLATE-compressed when that makes them smaller, otherwise stored. File dates are the business local time of the download.

### 4.4 Timing

Synchronous; PDFs are rendered one at a time on the API process. Measured with the real PDF engine: ≈ 50 ms for a statement with no movements, ≈ 180 ms median / ≈ 210 ms p95 for 20 sales + 10 payments (≈ 35 KB each). **50 full statements ≈ 9–10 s** (benchmark). Show a spinner and do not set a client timeout under ~30 s.

### 4.5 Errors

Checks run in this order: route permissions → reserved `filter` keys → body shape → **busy check** → `filter` values → ids existence → size / empty → rendering. The busy check comes before the `filter` is validated, so during another run even an invalid request gets `429`.

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body | `selection` invalid (as in §3.5); `from` / `to` missing, not an exact `YYYY-MM-DD`, `to <= from`, or more than 366 days; unknown body key |
| 400 | `LISTING_*` codes (as in §3.5) | a bad value inside `filter` |
| 400 | `BULK_SELECTION_TOO_LARGE` (`details: { count, max: 50 }`) | more than 50 customers |
| 400 | `BULK_SELECTION_EMPTY` (`field: "selection"`) | the selection resolves to 0 customers (e.g. a filter that matches nobody) |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Sale` or no `read:Customer` |
| 404 | `BULK_CUSTOMERS_NOT_FOUND` (`details: { missingIds }`) | ids mode: an id is unknown, foreign or deleted; also a customer deleted while the ZIP is built (`missingIds` = that id) |
| 429 | `BULK_EXPORT_BUSY` (`details: { retryAfterSeconds: 10 }`) + header `Retry-After: 10` | another bulk statements run is in progress on this server process |
| 500 | `PDF_GENERATION_FAILED` (Nest body `{ statusCode: 500, message: "PDF_GENERATION_FAILED", error }`) | a statement failed to render; nothing is sent |
| 503 | `BULK_EXPORT_TIMEOUT` `{ deadlineSeconds: 120 }` | the run exceeded its 120 s deadline; the server stopped it and freed the slot. Retry with fewer customers |

```json
{ "statusCode": 429, "code": "BULK_EXPORT_BUSY", "message": "another bulk statements download is in progress; retry later", "details": { "retryAfterSeconds": 10 } }
```

```json
{ "statusCode": 400, "code": "BULK_SELECTION_EMPTY", "message": "selection resolves to 0 customers", "field": "selection" }
```

## 5. Known limits

- **One bulk statements run per server replica, across all tenants, by design.** The busy slot is in memory; a second download anywhere on the same process gets `429`. With several replicas the guard is per replica.
- **`Retry-After` is not CORS-exposed** (only `Content-Disposition` is). A cross-origin frontend must read `details.retryAfterSeconds` from the 429 body.
- **Reserved keys outside `selection.filter` are silently stripped.** `__proto__` / `constructor` / `prototype` at the top level of the body or inside `selection` (not in `filter`) are removed by the global validation pipe instead of returning `400`. Inside `filter` they are rejected.
- **Statements are synchronous**: ≈ 9–10 s for 50 full statements; rendering blocks the event loop one PDF at a time (it yields between PDFs). Each run is bounded by a 120 s deadline (`503 BULK_EXPORT_TIMEOUT`). If the user cancels the download, the server frees the slot at once (even mid-PDF) and answers nothing (no 500). There is one bulk statements run per API process at a time, shared by every branch (by design, to protect the CPU): plan for `429 BULK_EXPORT_BUSY`.
- On a timeout or a client disconnect the stalled read/render is abandoned, not cancelled: it may finish in the background, and a retry can start meanwhile.
- No audit table: every request writes one structured server log line (`customers.bulk.export` / `customers.bulk.statements`) with user, branch, mode, count, outcome and durations; no customer data or ids.
- No async job and no streaming: 50 PDFs and 10,000 rows per request are hard caps.

## 6. What did not change

`GET /customers/listing` and its options, `GET /customers/:customerId/statement/pdf`, and every other customer route are unchanged. The only cross-cutting change is CORS: `Content-Disposition` is now exposed on every route (editorial routes keep their own exposed headers).

## 7. Recommended UI flow

1. **Selection bar:** «N seleccionados». N = ticked rows, or `filterSummary.count − unticked` for «todos los del filtro». Show the buttons per §1.1.
2. **Download helper** (both actions):

   ```ts
   const res = await fetch(`${API}/customers/bulk/${action}`, {
     method: 'POST',
     headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
     body: JSON.stringify(body),
   });
   if (!res.ok) throw await res.json(); // handle by code, steps 5–7
   const blob = await res.blob();
   const cd = res.headers.get('Content-Disposition') ?? '';
   const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName; // clientes-<fecha>.csv / estados-de-cuenta-<from>-<to>.zip
   const url = URL.createObjectURL(blob);
   Object.assign(document.createElement('a'), { href: url, download: filename }).click();
   URL.revokeObjectURL(url);
   ```

3. **CSV:** send the current filter (as `selection.filter`) and the table's `sortBy` / `sortOrder`. Disable when N > 10,000 («Máximo 10,000 clientes por archivo»). Without `read:Sale`, the file has no metric columns; do not send metric filters / sorts (they get `400 LISTING_PARAM_REQUIRES_PERMISSION`).
4. **Statements:** disable when N > 50 («Máximo 50 clientes por descarga») or N = 0. Ask for the period (presets → `from` / `to`). Show a spinner (expect up to ~10 s for 50).
5. **`404 BULK_CUSTOMERS_NOT_FOUND`:** remove `details.missingIds` from the selection, tell the user («N clientes ya no existen y se quitaron de la selección»), and offer to retry with the remaining ids (if none remain, close the action).
6. **`429 BULK_EXPORT_BUSY`:** show «Otra descarga de estados de cuenta está en curso» and retry after `details.retryAfterSeconds` (10) — or `Retry-After` when same-origin — or let the user retry.
7. **`503 BULK_EXPORT_TIMEOUT`:** «La descarga tardó demasiado; probá con menos clientes». Suggest splitting the selection.
8. **`400 BULK_SELECTION_TOO_LARGE` / `BULK_SELECTION_EMPTY`:** the count changed since the table loaded; refresh the table and show `details.max`.
