# Customers bulk export (CSV) — frontend guide

Status: implemented on branch `feat/customers-bulk-actions` (task `odd/tasks/customers-bulk-actions.md`, T1). Contract: `docs/proposals/customers-bulk-actions-contract.md` v0 plus the owner / frontend answers L2–L5, which override v0 where they differ (new permission `export:Customer`; no audit table).

This page covers the **selection object** (shared with the bulk statement PDFs) and **`POST /customers/bulk/export`**. The bulk statements route is documented separately when it ships.

## 1. Route

| Method | Path | Permissions | Response |
|---|---|---|---|
| POST | `/customers/bulk/export` | `read:Customer` **and** `export:Customer` (+ `read:Sale` for the metric columns) | `200 text/csv` |

## 2. Request body

```json
{
  "selection": { "mode": "filter", "filter": { "hasDebt": "true", "city": "Zapopan" }, "excludeIds": ["uuid-9"] },
  "sortBy": "openDebt",
  "sortOrder": "desc"
}
```

| Field | Type | Notes |
|---|---|---|
| `selection` | object, required | §3 |
| `sortBy` | listing `sortBy` value, optional | Default `createdAt`. Same values and permission rule as `GET /customers/listing` (metric sorts need `read:Sale`). Send the table's current sort so the file matches the screen |
| `sortOrder` | `asc` \| `desc`, optional | Default `desc` |

Unknown body keys → `400`.

## 3. Selection

### 3.1 Row checkboxes — `ids` mode

```json
{ "selection": { "mode": "ids", "customerIds": ["uuid-1", "uuid-2"] } }
```

- `customerIds`: 1–1,000 UUIDs. Duplicates are removed (the 1,000 limit counts the array as sent).
- **Strict:** if any id is unknown, belongs to another branch, or was deleted, the request fails with `404 BULK_CUSTOMERS_NOT_FOUND` and lists every missing id in `details.missingIds`. Nothing is exported. Drop those ids from the selection, tell the user («N clientes ya no existen y se quitaron de la selección»), and resend.
- `filter` and `excludeIds` are rejected in this mode (`400`).

### 3.2 «Todos los del filtro» — `filter` mode

```json
{ "selection": { "mode": "filter", "filter": { "hasDebt": "true" }, "excludeIds": ["uuid-9"] } }
```

- `filter` (required, object): the `GET /customers/listing` params **exactly as you put them in the URL** — string values, CSV lists as one comma-separated string (`"city": "Zapopan,León"`). A string array is also accepted (repeated URL param). You can build it from the same `URLSearchParams` you send to the listing.
  - Every listing filter and `search` is allowed, with the listing meaning (handoff 31 §2.3–§2.4).
  - `page`, `limit`, `sortBy`, `sortOrder` inside `filter` → `400` (order is top-level, §2).
  - Values must be strings (or string arrays): a JSON number / boolean / object → `400`.
  - `__proto__`, `constructor` and `prototype` keys are unknown params → `400` (same body as any unknown param).
  - `filter: {}` = every customer of the branch.
- `excludeIds` (optional): 0–1,000 UUIDs never exported. Ids that do not match the filter or do not exist are ignored.
- `customerIds` is rejected in this mode (`400`).
- Reserved keys outside `filter`: an own `__proto__` / `constructor` / `prototype` key anywhere else in the body (top level, inside `selection`, or in a nested object) → `400` too, with the body an unknown property gets at that path (`property` names the key; nested keys appear under their parents' `children`).
- The filter is evaluated when the request arrives: a customer deleted since the table loaded just does not match.

## 4. Response `200`

| Header | Value |
|---|---|
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="clientes-<YYYY-MM-DD>.csv"` (local business date, `America/Mexico_City` by default) |
| `Cache-Control` | `no-store` |

- **CORS:** `Content-Disposition` and `Retry-After` are now listed in `Access-Control-Expose-Headers` for every route (editorial routes keep their own list), so a cross-origin frontend can read the filename (`response.headers.get('Content-Disposition')`) and the `429` back-off. Origins and credentials are unchanged; any `exposedHeaders` configured server-side is merged with it, not replaced.
- Download it as a blob (POST, so a plain link does not work), as you do for the PDFs.
- The file is built completely before the first byte: an error never arrives as half a file.
- A selection matching nothing → `200` with the header row only.

### 4.1 Format (Excel, Spanish – Mexico)

| Item | Value |
|---|---|
| Encoding | UTF-8 **with BOM** (`EF BB BF`); no `sep=` line |
| Separator | comma `,` |
| Line endings | CRLF after every record, the header included |
| Quoting | RFC 4180: a field with `,`, `"`, CR or LF is wrapped in `"…"`, inner `"` doubled |
| Money | decimal pesos, `.` decimal point, 2 decimals, no `$`, no thousands separator: `78500` cents → `785.00` |
| Instants (`Alta`, `Última compra`) | local `YYYY-MM-DD HH:mm`, 24 h, business timezone |
| `Vencido desde` | `YYYY-MM-DD` (the POS due day) |
| Booleans | `Sí` / `No` |
| `null` / missing | empty cell |
| `Especies` | `Perro, Gato, Otro` in one cell |
| `CP` | a digits-only value is written as the Excel text formula `="03100"` (CSV text `"=""03100"""`) so Excel keeps the leading zero; any other value is plain text |
| Formula-injection guard | in user-text cells (names, business name, phone, country code, email, RFC, regime, price list, payment method, address fields, non-digit CP), a value starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'` |

### 4.2 Columns

Base columns (always):

| # | Header | Listing row field |
|---|---|---|
| 1 | `ID cliente` | `id` |
| 2 | `Nombre` | `firstName` |
| 3 | `Apellido` | `lastName` |
| 4 | `Razón social` | `businessName` |
| 5 | `Lada` | `phoneCountryCode` |
| 6 | `Teléfono` | `phone` |
| 7 | `Correo` | `email` |
| 8 | `Lista de precios` | `globalPriceList.name` |
| 9 | `RFC` | `rfc` |
| 10 | `Régimen fiscal` | `fiscalRegime` (SAT code) |
| 11 | `Forma de pago preferida` | `preferredPaymentMethod` |
| 12 | `Cliente de confianza` | `isTrusted` |
| 13 | `Alta` | `createdAt` |
| 14 | `Colonia` | `primaryAddress.neighborhood` |
| 15 | `Municipio` | `primaryAddress.municipality` |
| 16 | `Ciudad` | `primaryAddress.city` |
| 17 | `Estado` | `primaryAddress.state` |
| 18 | `CP` | `primaryAddress.zipCode` |
| 19 | `Mascotas activas` | `activePetsCount` |
| 20 | `Especies` | `petSpecies` |

Metric columns (**only with `read:Sale`**, after column 20; absent from the header and every row otherwise):

| # | Header | `metrics.*` |
|---|---|---|
| 21 | `Deuda` | `openDebtCents` |
| 22 | `Deuda vencida` | `overdueDebtCents` |
| 23 | `Ventas vencidas` | `overdueCount` |
| 24 | `Vencido desde` | `oldestOverdueDueDate` |
| 25 | `Compras` | `salesCount` |
| 26 | `Total comprado` | `totalSoldCents` |
| 27 | `Ticket promedio` | `averageTicketCents` (empty without sales) |
| 28 | `Última compra` | `lastPurchaseAt` (empty without sales) |

The numbers are the listing's: same SQL, same overdue cut-off. `matchedPetName`, `matchedAddressId`, the full address list, `comments` and billing data are not exported.

## 5. Permissions

| Caller | Result |
|---|---|
| no `read:Customer`, or no `export:Customer` | `403 INSUFFICIENT_PERMISSIONS` (standard body) |
| `read:Customer` + `export:Customer` | `200`, 20 columns. A metric filter in `filter` or a metric `sortBy` → `400 LISTING_PARAM_REQUIRES_PERMISSION` |
| `read:Customer` + `export:Customer` + `read:Sale` | `200`, 28 columns, metric filters / sorts allowed |
| Super Admin (`manage:all`) | allowed |

- `export:Customer` («Exportar datos de clientes (CSV)») is a **special permission**: it must be granted explicitly in Admin → Roles. `manage:Customer` («Full customer management») does **not** include it.
- It is not granted to the seeded Manager / Cashier roles. Existing environments get the permission row automatically on deploy (the app upserts the permission registry on boot); assign it to the roles that need it.
- Hide «Exportar CSV» when `GET /auth/me/permissions` has neither `export:Customer` nor `manage:all`.

## 6. Limits

| Limit | Value |
|---|---|
| `customerIds`, `excludeIds` | ≤ 1,000 each |
| Rows per CSV | ≤ **10,000** (0 allowed) |

Above 10,000 resolved customers the request fails with `400 BULK_SELECTION_TOO_LARGE` (`details: { count, max }`) **before anything is written** — never a truncated file. Disable the action when `filterSummary.count − excluded > 10,000` («Máximo 10,000 clientes por archivo»), and suggest narrowing the filter. Measured on the test database: 10,000 rows with metrics ≈ 1.1 s, ≈ 1.1 MB.

## 7. Errors

Checks run in this order: body / `filter` validation → permission params → selection (ids existence) → size.

Reserved keys (`__proto__`, `constructor`, `prototype`) are checked in the top level, `selection` and nested objects up to 4 levels deep (arrays are not walked; deeper paths still get a `400`, as an unknown property of their parent). If `selection.filter` holds one, only that error is reported.

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body `{ statusCode, message: [ValidationError…], error }` | `selection` missing or not an object; `mode` not `ids` / `filter`; a key of the other mode; `customerIds` empty, > 1,000 or not UUIDs; `excludeIds` > 1,000 or not UUIDs; unknown body or selection key (including `__proto__` / `constructor` / `prototype` anywhere in the body); bad `sortBy` / `sortOrder`; inside `filter`: `page` / `limit` / `sortBy` / `sortOrder`, an unknown param (including `__proto__` / `constructor` / `prototype`), a non-string value, a bad boolean or `N`-day value (listing rules) |
| 400 | `LISTING_INVALID_NUMBER`, `LISTING_INVERTED_RANGE`, `LISTING_INVALID_DATE`, `LISTING_INVALID_ENUM_VALUE`, `LISTING_TOO_MANY_VALUES`, `LISTING_INVALID_UUID` | a bad value inside `filter`; same rules, `field` names and `details` as the listing — `field` is the plain param name (`"openDebtMin"`, never `"filter.openDebtMin"`) |
| 400 | `LISTING_PARAM_REQUIRES_PERMISSION` (`details.required: "read:Sale"`) | metric filter in `filter` or metric `sortBy` without `read:Sale`; `field` = first offending filter in the listing order, then `sortBy` |
| 400 | `BULK_SELECTION_TOO_LARGE` (`details: { count, max }`) | more than 10,000 customers |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Customer` or no `export:Customer` |
| 404 | `BULK_CUSTOMERS_NOT_FOUND` (`details: { missingIds }`) | ids mode: an id is unknown, foreign or deleted |

New codes use the listing envelope `{ statusCode, code, message, field, details? }`:

```json
{ "statusCode": 400, "code": "BULK_SELECTION_TOO_LARGE", "message": "selection resolves to 10001 customers; max 10000", "field": "selection", "details": { "count": 10001, "max": 10000 } }
```

```json
{ "statusCode": 404, "code": "BULK_CUSTOMERS_NOT_FOUND", "message": "2 customers not found", "field": "customerIds", "details": { "missingIds": ["uuid-a", "uuid-b"] } }
```

## 8. Audit

No audit table for now (owner L5: noted for a later conversation). Every export that reaches the route handler writes one structured server log line (`customers.bulk.export`): user id, branch id, selection mode, row count, sort, whether metrics were included, size, duration and outcome `ok` (or outcome `rejected` with the error code). A caller who passes the route guard but lacks the explicit `export:Customer` permission (for example `manage:Customer` only) gets a line with outcome `forbidden`, code `INSUFFICIENT_PERMISSIONS` and reason `EXPORT_PERMISSION_NOT_EXPLICIT`. Requests rejected earlier (401, the route guard's 403 for a missing `read:Customer` / `export:Customer` row, body-shape 400) are not logged by this route. No customer data and no customer ids are logged.
