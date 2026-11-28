# Customers table bulk actions (statement PDFs + CSV export) — contract v1

Status: **v1 APPROVED (owner OK 2026-11-27) and IMPLEMENTED on `feat/customers-bulk-actions`.** Commits: 08795da8 (contract v0), 1ab4920b (in-repo ZIP writer and safe file names), bafb6c29 (selection + CSV export behind `export:Customer` + CORS `Content-Disposition`), 9946d2f5 (reserved filter keys → 400, denied-export log line, CORS `exposedHeaders` merge), 7047c129 (bulk statements ZIP); **e55240d0 advisory follow-up** for the T3 fixes (per-run deadline with a new timeout error code, quiet client-abort handling). Task: `odd/tasks/customers-bulk-actions.md`. Frontend handoff: `docs/frontend-handoff/32-customers-bulk-actions.md`. Route guides: `docs/customers-bulk-export.md`, `docs/customers-bulk-statements.md`.

The owner / frontend answers (§0.1) override the v0 text. The sections below were corrected to match the committed code; where the code and this document differ, **the code wins**. §1 and the Evidence appendix still describe `main` 34b209a9, before the implementation (for example «there is no `export` action» and «CORS exposes no headers» are no longer true).

- Requested by the frontend on 2026-11-27, relaying the owner: «acciones masivas en la tabla de clientes». The user selects customers with a checkbox per row or with «todos los del filtro». Two actions then appear: **Estados de cuenta PDF** and **Exportar CSV**.
- Builds on `docs/proposals/customers-list-contract.md` (v1, implemented) and `docs/frontend-handoff/31-customers-module.md`, and on the single statement PDF of `docs/frontend-handoff/29-customer-statement-pdf.md`.
- Same process as the previous contracts: the owner and the frontend answer the numbered questions in §12, then v1 applies the answers.
- Facts cite `main` 34b209a9. Every existing behavior has a `path:line` in the **Evidence** appendix (E1, E2, …).

Legend:

- **EXISTS** = in the code today.
- **NEW** = proposed here.

Every change is additive. No existing route, shape or error changes. **No migration**: the new `export:Customer` permission row is upserted by the permission seeder on boot.

## 0.1 v0 → v1 changes / resolved decisions

Answers to §12 (owner relayed by the frontend, 2026-11-27, task log L2–L5):

| Q | Answer | v1 effect |
|---|---|---|
| Q1 | Owner: «Los topes alcanzan: 50 PDFs por descarga y 10.000 filas por CSV.» | Caps unchanged: 50 statements, 10,000 CSV rows. No async job, no streaming |
| Q2 | Owner: «ZIP con un PDF por cliente.» | ZIP (§3.2) |
| Q3 | Frontend: «sí, nombre del cliente en cada archivo del ZIP, saneado para nombres de archivo y con desambiguación si dos clientes se llaman igual.» | Entry name = customer name, UTF-8, disambiguated (§3.2, replaces the v0 `estado-de-cuenta-<nombre>-<id8>-…` ASCII pattern) |
| Q4 (permission) | Owner first answered «El CSV sale con read:Customer, sin permiso propio…», then **corrected it verbatim: «Nonono, perdon, exportar datos de clientes debe ser un permiso nuevo especial.»** | NEW permission `export:Customer` («Exportar datos de clientes (CSV)»), seeded, assignable in Admin → Roles. Checked as an **explicit** row: `manage:Customer` does **not** imply it; `manage:all` (Super Admin) does. Without it → `403`. Metric columns still need `read:Sale`. Bulk statements unchanged (`read:Sale` + `read:Customer`) |
| Q4 (audit) | Owner: «Por ahora no, pero dejalo anotado para platicarlo despues» | **No audit table.** One structured log line per request (§5.1). **FUTURE item:** persisted export audit table, to discuss with the owner later |
| Q5 | Owner: «Sí, incluí a los clientes sin movimientos, porque el PDF muestra su deuda actual.» | Included; no `skipInactive` flag |
| Q6 | Owner: «Asumimos Excel en es-MX y mantenemos el truco `="03100"` para el CP.» | Comma separator, `="03100"` CP kept |
| Q7 | Frontend: «tu decisión técnica. Si el ZIP propio queda bien testeado, va sin dependencia nueva.» | In-repo ZIP writer, no dependency (§3.6), with DEFLATE + store fallback |
| Q8 | Frontend: «las columnas están bien.» | 28 columns of §4.3 unchanged |
| Q9 | Frontend: «exponé `Content-Disposition` en CORS (`exposedHeaders`).» | `Content-Disposition` and `Retry-After` are in `Access-Control-Expose-Headers` on every route (editorial routes keep their own list; caller-configured `exposedHeaders` are merged), so a cross-origin client can read the filename and the 429 back-off (`details.retryAfterSeconds` of the 429 body carries the same value) |
| Q10 | Frontend: «404 estricto con la lista de ids faltantes.» | Strict 404, ids in **`details.missingIds`** (v0 said `details.customerIds`) |

Other changes found during implementation:

- **Reserved filter keys:** an own `__proto__` / `constructor` / `prototype` key inside `selection.filter` → `400` (same body as any unknown param), on both routes. The same keys anywhere else in the body (top level, `selection`, nested objects) → `400` with the body an unknown property gets at that path (rejected before the global validation pipe, which would otherwise strip them silently).
- **Bulk statements guard order:** the one-run-per-process check happens **before** the selection is resolved, so during another run even a request with a bad `filter` value gets `429`, not the `400`.
- **One run per replica, across tenants:** the busy slot is an in-memory singleton, by design.
- **Measured:** 10,000 CSV rows with metrics ≈ 1.1 s, ≈ 1.1 MB. Statements: ≈ 50 ms for an empty statement, ≈ 180 ms median / ≈ 210 ms p95 for 20 sales + 10 payments (≈ 35 KB each); a run of 50 full statements ≈ 9–10 s. Below the 400 ms p95 gate of §3.3, so the cap stays 50 in-process.
- **Shipped in e55240d0 (advisory follow-up):** a 120 s per-run deadline for bulk statements (`503 BULK_EXPORT_TIMEOUT`, slot freed at once) and quiet handling of client aborts (no 500). Known limit: on timeout or abort the stalled read/render is abandoned, not cancelled, and may finish in the background holding its DB connection; a later run can start meanwhile.

## 0. Requests and disposition

| # | Request (owner, via frontend) | Proposal | Where |
|---|---|---|---|
| R1 | Select customers by row checkbox or «todos los del filtro» | **NEW** selection object, shared by both actions: `ids` mode or `filter` + `excludeIds` mode, in a POST body | §2 |
| R2 | Statement PDFs for the selected customers and a period (this month, last month, last 3 months or custom dates, up to 366 days) | **NEW** `POST /customers/bulk/statements` → **ZIP, one PDF per customer**, **synchronous, at most 50 customers** | §3 |
| R3 | ZIP of per-customer PDFs or one PDF with a section per customer? | **ZIP** (§3.2) | §3.2 |
| R4 | Sync with a limit (for example 50) or an async job? | **Sync, cap 50**, with a busy guard. The async design is written down for later, not built (§3.7) | §3.3, §3.7 |
| R5 | CSV of the selected customers or of the **whole current filter**, same params as `GET /customers/listing` | **NEW** `POST /customers/bulk/export` → `text/csv`, every matching row, not just the page | §4 |
| R6 | Columns = the listing row, with metrics when the caller has `read:Sale` | Accepted: 20 base columns + 8 metric columns (§4.3) | §4.3 |
| R7 | Encoding for Excel in Spanish: UTF-8 BOM, separator, date and money format | UTF-8 **with BOM**, **comma**, CRLF, RFC 4180 quoting, CSV-injection guard, money as decimal pesos `1234.50`, dates `YYYY-MM-DD` / `YYYY-MM-DD HH:mm` local | §4.2 |
| R8 | Large results: streaming or a limit? | **A limit (10,000 rows)**, one SQL statement, no streaming in v0 | §4.5 |
| R9 | Permissions, limits, errors by code | | §5–§7 |

## 1. What exists today

| Today | Evidence | Used here |
|---|---|---|
| `GET /customers/:customerId/statement/pdf?from=&to=` needs `read:Sale`. `from`/`to` are exact local `YYYY-MM-DD` dates, half-open `[from, to)`, 1–366 days, validated by `CustomerStatementQueryDto`. There is no preset param: the frontend computes the dates of «este mes», «mes anterior», etc. | E1, E2, E3 | §3.1 reuses the same DTO rules |
| The statement is read in **one RepeatableRead transaction per customer** (4 raw SQL statements: customer, period sales, open-debt sales, period payments), then shaped in memory | E4, E5 | §3.4 calls it once per customer |
| Unknown or foreign customer → `404 CUSTOMER_NOT_FOUND` (code-only). Render failure → `500 PDF_GENERATION_FAILED`. Nothing is written before the PDF is ready | E1, E5, E6 | §3.5, §7 |
| Filename: `estado-de-cuenta-<customerId>-<from>-<to>.pdf`, deliberately free of user data, every part re-sanitized | E7 | §3.2 (entry names) |
| PDFs are rendered **in-process** with `@react-pdf/renderer` `renderToBuffer` into a `Buffer`. There is no render queue, concurrency limit or worker. The statement document is one `<Document>` whose footer prints `Página X de Y`, with empty states «Sin ventas confirmadas en el periodo.», «Sin pagos recibidos en el periodo.» and «Sin deuda abierta.» | E6, E8 | §3.2, §3.3 |
| The statement controller is **registered in `PdfGenerationModule`**, because that module already imports `SalesModule`; registering it in `SalesModule` would create a module cycle | E1, E9 | §3 lives there too |
| The only heavy PDF work moved out of the API process is the pdfium receipt preview, which is **forked into a child process** with a timeout | E10 | §3.3 fallback |
| **Inngest** is installed and wired: 10+ functions registered through `InngestService.registerFunctions`, served by the API itself at `/api/inngest`. Inngest functions therefore run **inside the same Node process** as the API | E11, E12 | §3.7 (deferred) |
| `@nestjs/schedule` is used (outbox poller `@Interval`) | E13 | §3.7 (retention purge) |
| Private object storage: receipts go to DigitalOcean Spaces with `ACL: 'private'` and are read back **through the backend**, never with a signed URL. `src/files` uploads are `public-read` (catalog images). `src/private-media` accepts images only | E14, E15, E16 | §3.7 |
| There is **no generic job/export table** and no export audit table. Audit tables exist only for the bot and procurement | E17 | §3.7, §5.1 |
| There is **no CSV export** anywhere in `src`, and no ZIP library in `package.json`. Node in the image is 24, which ships `zlib.crc32` | E18, E19 | §3.6, §4 |
| `GET /customers/listing`: `read:Customer` route guard; the service checks `ability.can('read', 'Sale')`. Without it, `metrics` is omitted and metric filters/sorts → `400 LISTING_PARAM_REQUIRES_PERMISSION` (`field` = first offending param, `details.required`) | E20, E21, E22 | §4.4, §5 |
| Listing query: `CustomersListingQueryDto` (§4 filters, `page`, `limit` 1–100, `sortBy`, `sortOrder`, `search`); CSV params accept a string or a string array; the reader runs one page statement + one summary statement; `buildListingPageSql` already computes metrics for every candidate before `LIMIT` when a metric filter or sort is active; `ORDER BY … NULLS LAST, id` | E23, E24, E25, E26 | §2.3, §4.5 |
| Listing row shape (`CustomerListingRow`) and metric definitions | E27 | §4.3 |
| Global validation pipe: `whitelist`, `forbidNonWhitelisted`, `transform`, listing exception factory. Listing error codes: `LISTING_INVERTED_RANGE`, `LISTING_INVALID_ENUM_VALUE`, `LISTING_TOO_MANY_VALUES`, `LISTING_INVALID_DATE`, `LISTING_INVALID_UUID`, `LISTING_INVALID_NUMBER` | E28, E29 | §7 |
| `@RequirePermissions` needs every listed pair (`403 INSUFFICIENT_PERMISSIONS`) and attaches `request.ability` | E30 | §5 |
| Permission actions are `create`, `read`, `update`, `publish`, `delete`, `batch_delete`, `validate`, `manage`. There is **no `export` action** | E31 | §5, Q4 |
| Customers are **hard-deleted** (`DELETE /customers/:id`, `tx.customer.delete`) | E32 | §2.4 |
| Throttling exists only on the public catalog. No request timeout is configured in `main.ts`; `main.ts` installs route-scoped body parsers only for a few modules, so `/customers` uses Nest's default JSON parser | E33, E34 | §2.2, §6 |
| CORS: the general config exposes **no response headers**; only the editorial routes set `exposedHeaders`. A cross-origin frontend cannot read `Content-Disposition` or custom headers today | E35 | §3.2, §4.6, Q9 |
| Business timezone: `PROMOTIONS_BUSINESS_TIMEZONE`, default `America/Mexico_City` | E5, E21 | §4.2 |
| Deploy: Dokploy builds `main` into one Docker image (`node dist/main`) | E36 | §3.3 (single-process assumption, not verified) |

## 2. Selection (NEW, shared by both actions)

### 2.1 Shape

Both actions take a JSON **POST** body with a `selection` object. POST rather than GET because a list of up to 1,000 UUIDs does not fit in a URL, and a body keeps the filter and the ids in one validated object.

**Row checkboxes:**

```json
{ "selection": { "mode": "ids", "customerIds": ["uuid-1", "uuid-2"] } }
```

**«Todos los del filtro»** (optionally minus unticked rows):

```json
{
  "selection": {
    "mode": "filter",
    "filter": { "hasDebt": "true", "city": "Ciudad de México,Zapopan", "search": "ana" },
    "excludeIds": ["uuid-9"]
  }
}
```

- `mode` is required: `"ids"` or `"filter"`. The other mode's keys are rejected (`customerIds` with `mode: "filter"` → 400).
- **`filter`** holds the `GET /customers/listing` params **exactly as the frontend puts them in the URL** (string values, CSV lists as one comma-separated string). The backend validates it with the listing DTO rules, so every filter means exactly what it means in the table (E23). The frontend can build it from the same `URLSearchParams` it sends to the listing.
  - Allowed keys: every listing filter and `search` (handoff 31 §2.3–§2.4).
  - Rejected keys: `page`, `limit`, `sortBy`, `sortOrder`. Pagination does not apply, and order is a top-level field of the CSV request (§4.1). Unknown keys → 400 (`forbidNonWhitelisted`, E28).
  - `filter: {}` means every customer of the branch.
- **`excludeIds`**: optional, 0–1,000 UUIDs. Ids that do not match the filter (or do not exist) are ignored. This lets the user tick «todos los del filtro» and then untick a few rows.

### 2.2 Limits

| Item | Limit | Why |
|---|---|---|
| `customerIds` | 1–1,000 unique UUIDs; duplicates are removed | 1,000 UUIDs ≈ 39 KB of JSON, inside the default 100 KB JSON body limit (`/customers` has no custom parser, E34). The UI can tick at most 20 pages of 50 rows |
| `excludeIds` | 0–1,000 UUIDs | same |
| Resolved customers, statements | 1–**50** | §3.3 |
| Resolved customers, CSV | 0–**10,000** | §4.5 |

The resolved count (after the filter and the exclusions) is checked against the action's cap: over the cap → `400 BULK_SELECTION_TOO_LARGE` with `details: { count, max }` (§7). The frontend already knows `filterSummary.count` from the table, so it can disable the action before sending (§9).

### 2.3 How the backend resolves it

- The resolution **reuses the listing SQL** (E25): the same `customerFilterConditions`, `search` rules and metric conditions. Two internal-only conditions are added to the candidates CTE: `c."id" = ANY(:customerIds)` (ids mode) and `c."id" <> ALL(:excludeIds)` (filter mode). They are not new public listing params.
- `"tenantId" = :tenantId` is on every statement, as in every listing query (E25).
- Metric filters in `filter` follow the listing permission rule (§5): without `read:Sale` they are rejected with `400 LISTING_PARAM_REQUIRES_PERMISSION`, never silently dropped.

### 2.4 Unknown, foreign or deleted ids (ids mode)

**Decision: strict.** If any id in `customerIds` is not a customer of the caller's branch, the request fails with `404 BULK_CUSTOMERS_NOT_FOUND` and `details.missingIds` lists the missing ids (all of them, at most 1,000). Nothing is generated.

- A foreign id and a deleted id look the same (tenant isolation, and customers are hard-deleted, E32). This reveals nothing beyond what `GET /customers/:id` already answers with 404 (E1).
- Why not skip silently: the user asked for 30 statements and would receive 29 without noticing. That is worse than one retry. The frontend removes the listed ids from the selection, tells the user («N clientes ya no existen y se quitaron de la selección»), and resends.
- In **filter mode** there is no such error: the filter is evaluated when the request arrives, so a customer deleted since the table loaded simply does not match.

## 3. Bulk statement PDFs (NEW)

### 3.1 Route

`POST /customers/bulk/statements`, permissions `read:Sale` **and** `read:Customer` (§5).

```json
{
  "selection": { "mode": "ids", "customerIds": ["uuid-1", "uuid-2"] },
  "from": "2026-11-01",
  "to": "2026-12-01"
}
```

- `from` / `to`: the exact rules of the single statement (E2): local `YYYY-MM-DD` in the business timezone, half-open `[from, to)`, `from < to`, at most 366 days. The validator constraints are shared, not copied.
- The period presets stay in the frontend, as for the single statement (E3): «Este mes» = `from=<1st of this month>&to=<1st of next month>`, «Mes anterior», «Últimos 3 meses», or chosen dates.

**Response `200`:**

| Header | Value |
|---|---|
| `Content-Type` | `application/zip` |
| `Content-Disposition` | `attachment; filename="estados-de-cuenta-<from>-<to>.zip"` |
| `Cache-Control` | `no-store` |
| `Content-Length` | the ZIP size |

The whole ZIP is built in memory before the first byte is sent, like every PDF route today (E1, E6). An error therefore never arrives as half a ZIP. 50 statements are a few MB (estimate, see §3.4).

### 3.2 ZIP of per-customer PDFs, not one merged PDF

**Recommendation: ZIP.**

1. **Zero change to the PDF.** Each entry is byte-for-byte what `GET /customers/:customerId/statement/pdf` returns for that customer and period: same reader, same template, same numbers (E4, E6, E8). One merged PDF would need a new template, because `Página X de Y` counts pages of the whole `<Document>`. With 50 customers it would read «Página 37 de 112» instead of restarting per customer.
2. **The usual next step is sending each customer their own statement** (WhatsApp, email). Separate files do that directly. A merged PDF would have to be split again.
3. **Printing everything at once** still works: unzip, select all, print. If the owner mainly prints, Q2 offers a merged PDF as a later option.

**Entries:**

- One entry per resolved customer, sorted by name (`lower(firstName)`, `lower(lastName)`, `id`), the listing `name` order.
- **v1 (frontend Q3):** entry name = the customer name `«firstName lastName».pdf` (trimmed; `businessName` is **not** used), e.g. `Ana López.pdf`. Implemented in `src/sales/customer-bulk-statements.naming.ts` + `src/shared/zip/safe-file-name.ts`:
  - NFC-normalized; accents and `ñ` kept; `< > : " / \ | ? *` → `-`; tabs/newlines → space, runs of whitespace collapsed; C0/C1 controls, zero-width and bidi characters removed; leading/trailing dots and spaces trimmed; Windows reserved stems (`CON`, `NUL`, `COM1`, …) get `_`; at most 100 code points.
  - Equal names (case-insensitive, on the final file name) are disambiguated in ZIP order: `Ana López.pdf`, `Ana López (2).pdf`, `Ana López (3).pdf`.
  - Nothing usable left → `cliente-<first 8 characters of the id>.pdf`.
  - Names are UTF-8 with the ZIP UTF-8 flag (general-purpose bit 11).
  - The ZIP file name stays user-data-free because it goes into a response header (E7): `estados-de-cuenta-<from>-<to>.zip`.
- Entry timestamps: the business-timezone wall time of the download.
- No manifest or index file.

### 3.3 Synchronous, at most 50 customers

**Recommendation: synchronous with a hard cap of 50, the owner's example.** The async job is designed in §3.7 but not built in v0.

Why sync is enough:

- **The async option does not take CPU off the API.** Inngest functions are served by the API process itself (E12), so a job renders on the same event loop as a sync request. Async would only remove the HTTP wait and add retries.
- **Async costs a lot more:** a job table and migration, private storage writes and reads, an Inngest function, status polling, a download route and a retention purge (§3.7). That is roughly double the code, for the same CPU.
- **50 per request matches a real use:** «todos los que deben» on one or two table pages. Larger runs can be split by the user (Q1 asks how many customers usually owe).

**Cost (unmeasured estimate, to be measured in the implementation):**

- **Data:** 4 small indexed queries per customer in its own RepeatableRead transaction (E4). 50 customers ≈ 200 queries, sequential, well under 2 s.
- **Rendering:** `renderToBuffer` lays the document out in JavaScript and **blocks the event loop** while it runs (E6). A 1–2 page statement is estimated at 100–300 ms. For 50 that is ≈ 5–15 s of mostly CPU work.
- **Memory:** an estimated 50–150 KB per PDF, so ≈ 2.5–7.5 MB per ZIP.

**Guards (all NEW):**

1. **Sequential rendering, yielding between customers** (`await new Promise(setImmediate)`). Other API requests run between two renders, so the worst latency they see is one render, not fifteen seconds.
2. **One bulk statement run at a time per process.** A second request while one runs → `429 BULK_EXPORT_BUSY` with `Retry-After: 10`. This keeps two users from stacking 30 s of CPU. It assumes one API process (Dokploy, one container; **not verified**, see §11). With several replicas the guard is per replica, which is still safe.
3. **A measurement gate before shipping.** The implementation adds a benchmark spec that renders 50 statements with realistic data (for example 20 sales and 10 payments each) and records p95 per document. If p95 > 400 ms, the cap goes down to 25, or rendering moves to a forked child process like the pdfium preview (E10). Either change keeps this contract.

The single statement route is unchanged. For one customer, the frontend keeps using it (a PDF, not a one-entry ZIP).

### 3.4 Customers with no movements in the period

**Decision: include them.** Every selected customer gets a PDF.

- The single statement already renders a valid document with empty states (E8). It still shows **«Deuda abierta actual»**, the open debt across every confirmed sale, also older than the period (E5). For a customer who bought months ago and still owes, that page is the reason to send the statement.
- Skipping would make the count of files differ from the selection with no explanation.
- If the owner wants «solo los que tuvieron movimientos o deben», that is an optional `skipInactive: true` flag in v1 (Q5).

### 3.5 Failures

- A customer deleted between resolving the selection and reading its statement → the reader returns nothing (E5). The run stops with `404 BULK_CUSTOMERS_NOT_FOUND` listing that id, the same as §2.4. This race is a matter of seconds.
- Any render failure → `500 PDF_GENERATION_FAILED` for the whole request (the existing code, E6). Nothing is sent. The log line names the customer id.
- Each statement takes its own `now`. A run that crosses local midnight could date two statements differently. That is accepted, and is the same as two single downloads.

### 3.6 ZIP writer

**v1 (implemented, `src/shared/zip/zip-writer.ts`, commit 1ab4920b):** an in-repo in-memory ZIP writer, no new dependency (frontend Q7):

- local file headers, central directory and end-of-central-directory record; no data descriptors, comments or extra fields;
- CRC-32 from Node's built-in `zlib.crc32` (Node 24 in the image, E19);
- **DEFLATE** (`zlib.deflateRawSync`) per entry when requested, **falling back to STORE** for an entry when deflate does not make it smaller; the bulk statements request DEFLATE;
- **UTF-8 entry names** (flag bit 11), NFC-normalized; duplicate or unsafe names are rejected (`ZipBuildError`);
- no Zip64: at most 65,535 entries and 32-bit sizes/offsets, far above 50 entries and a few MB.

### 3.7 Deferred: async job design (not in v0)

Written down so the owner can compare. Build it only if 50 per request turns out too small (Q1).

- `POST /customers/bulk/statement-jobs` (same body + optional `Idempotency-Key` header) → `202 { jobId, status: "QUEUED" }`. The same key + same body within 10 minutes returns the same job.
- `GET /customers/bulk/statement-jobs/:jobId` → `{ status: QUEUED|RUNNING|READY|FAILED, progress: { done, total }, expiresAt, error? }`. Only the creating user, in their branch.
- `GET /customers/bulk/statement-jobs/:jobId/file` → the ZIP, **streamed through the backend** from private Spaces, like receipt files (E14). No signed URL.
- New table `customer_export_jobs` (tenant, user, kind, params JSON, status, progress, storage key, size, error, timestamps, `expiresAt`) and a migration.
- Inngest function `customers/statements.bulk.requested`: one `step.run` per batch of 10 customers, writing partial PDFs to storage, then a final step that writes the ZIP. Cap 500 customers.
- Retention: 24 h, purged by an `@Interval` job (E13), plus a storage lifecycle rule.
- CPU stays in the API process (E12). The same yield and one-at-a-time guard apply.
- Estimate: +1,200 lines and one migration.

## 4. CSV export (NEW)

### 4.1 Route

`POST /customers/bulk/export`, permissions `read:Customer` **and** `export:Customer` (v1, owner correction). `read:Sale` adds the metric columns (§5).

```json
{
  "selection": { "mode": "filter", "filter": { "hasDebt": "true" }, "excludeIds": [] },
  "sortBy": "openDebt",
  "sortOrder": "desc"
}
```

- `selection`: §2. In ids mode it exports exactly those customers. In filter mode it exports every customer matching the filter (minus `excludeIds`), not just the visible page.
- `sortBy` / `sortOrder`: optional, same values, defaults and permission rule as the listing (E23, E21). Default `createdAt desc`. The frontend sends the table's current sort, so the file matches the screen. A metric `sortBy` without `read:Sale` → `400 LISTING_PARAM_REQUIRES_PERMISSION`, `field: "sortBy"`.
- POST rather than `GET /customers/listing.csv?…`: one route covers both selection modes, and ids do not fit in a URL. The trade-off is that the browser cannot download it with a plain link. The frontend downloads it as a blob, as it already does for the PDFs (E3).

**Response `200`:**

| Header | Value |
|---|---|
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="clientes-<YYYY-MM-DD>.csv"` (local business date of the export) |
| `Cache-Control` | `no-store` |

A filter that matches nothing returns **200 with the header row only**. That is a valid export of an empty result. Statements answer 400 instead, because an empty ZIP is useless.

### 4.2 Format (for Excel in Spanish, Mexico)

| Item | Decision | Why |
|---|---|---|
| Encoding | UTF-8 **with BOM** (`EF BB BF`) | Without the BOM, Excel on Windows opens a CSV as ANSI/Windows-1252, and «López» shows as «LÃ³pez». The BOM makes Excel detect UTF-8 on double click |
| Separator | **comma** `,` | Excel uses the Windows *list separator* of the regional settings. For **Spanish (Mexico)** it is `,`, because the decimal symbol is `.`. The semicolon is the list separator where the decimal symbol is `,` (Spain, Argentina). `,` is also RFC 4180, so Google Sheets, Numbers and LibreOffice read it without questions. A PC set to Spain or Argentina would show everything in column A; Q6 covers that |
| No `sep=` line | — | A `sep=,` first line makes Excel **ignore the BOM**, which breaks the accents again |
| Line endings | CRLF | RFC 4180; Excel handles it |
| Quoting | RFC 4180: a field is wrapped in `"…"` when it contains `,`, `"`, CR or LF; inner `"` doubled | Names and addresses can contain commas |
| Header | first row, Spanish (§4.3) | |
| Money | **decimal pesos**, `.` decimal point, 2 decimals, no thousands separator, no `$`: `78500` cents → `785.00` | Excel es-MX reads it as a number, so sums and filters work. Cents would confuse the reader, and `$1,234.50` would be read as text or split at the comma |
| Dates | local `YYYY-MM-DD` | Excel recognizes ISO dates as dates and shows them in the regional format (`20/11/2026`) |
| Instants | local `YYYY-MM-DD HH:mm`, 24 h, in `PROMOTIONS_BUSINESS_TIMEZONE` | The table shows local times. UTC ISO strings would be off by 6 h and are not read as dates by Excel |
| Booleans | `Sí` / `No` | |
| `null` / absent | empty cell | |
| Lists | `Perro, Gato` inside one quoted cell | |

**CSV injection guard (OWASP):** in **text columns that hold user-entered data** (names, business name, email, RFC, phone, price list name, preferred payment method, address fields), a value whose first character is `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`. Otherwise a value like `=HYPERLINK(…)` typed into a customer name would run as a formula when the file is opened. Numeric and date columns are generated by the backend, are never negative, and are not touched.

**ZIP codes (CP):** CDMX codes start with `0` (`03100`). Excel turns `03100` into the number `3100` on open. **Recommendation:** write a CP that is **only digits** as the Excel text formula `="03100"`, which is CSV-quoted as `"=""03100"""`. Excel, Google Sheets and LibreOffice all show `03100`. This is safe even with the injection guard: the backend writes the formula only around a value that matched `^\d+$`, so no user text can get in. The downside is that a system re-importing the file sees `="03100"`. Q6 lets the owner choose plain `03100` instead.

Phones are stored as digits without the country code (`5512345678`). Excel shows 10 digits as a number without loss, so phones are left plain. The country code is its own column.

### 4.3 Columns

Base columns (always present):

| # | Header | Source (listing row, E27) | Format |
|---|---|---|---|
| 1 | `ID cliente` | `id` | UUID |
| 2 | `Nombre` | `firstName` | text |
| 3 | `Apellido` | `lastName` | text |
| 4 | `Razón social` | `businessName` | text |
| 5 | `Lada` | `phoneCountryCode` | text |
| 6 | `Teléfono` | `phone` | text |
| 7 | `Correo` | `email` | text |
| 8 | `Lista de precios` | `globalPriceList.name` | text |
| 9 | `RFC` | `rfc` | text |
| 10 | `Régimen fiscal` | `fiscalRegime` | SAT code (`612`) |
| 11 | `Forma de pago preferida` | `preferredPaymentMethod` | text |
| 12 | `Cliente de confianza` | `isTrusted` | `Sí` / `No` |
| 13 | `Alta` | `createdAt` | local `YYYY-MM-DD HH:mm` |
| 14 | `Colonia` | `primaryAddress.neighborhood` | text |
| 15 | `Municipio` | `primaryAddress.municipality` | text |
| 16 | `Ciudad` | `primaryAddress.city` | text |
| 17 | `Estado` | `primaryAddress.state` | text |
| 18 | `CP` | `primaryAddress.zipCode` | §4.2 |
| 19 | `Mascotas activas` | `activePetsCount` | integer |
| 20 | `Especies` | `petSpecies` | `Perro`, `Gato`, `Otro`, comma-joined |

Metric columns (**only with `read:Sale`**, appended after column 20):

| # | Header | Source (`metrics.*`) | Format |
|---|---|---|---|
| 21 | `Deuda` | `openDebtCents` | pesos |
| 22 | `Deuda vencida` | `overdueDebtCents` | pesos |
| 23 | `Ventas vencidas` | `overdueCount` | integer |
| 24 | `Vencido desde` | `oldestOverdueDueDate` | `YYYY-MM-DD` (already the POS due day) |
| 25 | `Compras` | `salesCount` | integer |
| 26 | `Total comprado` | `totalSoldCents` | pesos |
| 27 | `Ticket promedio` | `averageTicketCents` | pesos, empty without sales |
| 28 | `Última compra` | `lastPurchaseAt` | local `YYYY-MM-DD HH:mm`, empty without sales |

- The metric definitions are exactly the listing's (customers-list contract §2.1). The same SQL fragment computes them (E25), so the file matches the table.
- Without `read:Sale`, columns 21–28 are **absent from the header and every row**, not empty. This mirrors the omitted `metrics` key.
- **Left out:** `matchedPetName` and `matchedAddressId`. They explain a search or location match on screen and are not customer data. The full address list, `comments` and the billing address are left out too, as in the table row (Q8).
- The regime is exported as its code: the repo has no label list, only code comments (E37).

### 4.4 Permission behavior

- Route guard: `read:Customer` + `export:Customer` (the latter as an explicit row or `manage:all`, §5).
- The service branches on `request.ability.can('read', 'Sale')` like the listing (E20, E21):
  - with it: metric columns, metric filters and metric sorts allowed;
  - without it: no metric columns. A metric param in `filter`, or a metric `sortBy` → `400 LISTING_PARAM_REQUIRES_PERMISSION`, the same body as the listing, `field` = the listing param name (no `filter.` prefix). A stale «todos los del filtro» selection fails visibly, as a stale saved view does in the table.

### 4.5 Size: a cap, not streaming

**Decision: one SQL statement with a hard cap of 10,000 rows, the file built in memory, no streaming in v0.**

- **Streaming would not save memory here.** `$queryRaw` returns all rows at once; Prisma has no cursor. A streamed HTTP response would still hold every row in memory first.
- **Chunked reads would break consistency.** Pages read with `LIMIT/OFFSET` in separate statements can skip or repeat rows when a customer is added in between. Wrapping them in one RepeatableRead transaction runs into Prisma's default 5 s interactive transaction timeout; the repo sets no override (E38). One statement is one consistent snapshot by itself.
- **The SQL already exists.** The rows are `buildListingPageSql` with `page = 1`, `limit = 10,001`, plus the §2.3 id conditions (E25). The 10,001st row tells the backend the cap was passed, and then the request fails with `400 BULK_SELECTION_TOO_LARGE` instead of sending a cut file. The count is checked first with the existing summary statement, so an oversized request fails before the rows are read.
- **Cost (unmeasured estimate):** with metrics, this is the listing's metric-sort query (metrics for every candidate, E25) without the `LIMIT`, plus the primary address and pet laterals for every row instead of 50. 10,000 rows × ~400 bytes ≈ 4 MB. The estimate is 1–3 s on a branch of 10,000 customers. The implementation measures it on a seeded branch, as the listing contract asked (customers-list contract §12.4).
- **If 10,000 is too small** (Q1): stream with keyset pages over `(sort key, id)` in v1. That is not needed for v0.

### 4.6 Filename and headers

`clientes-2026-11-27.csv`, using the local business date of the export. Today's CORS config exposes no response headers (E35). If the frontend is on another origin, it cannot read `Content-Disposition`, so it should name the blob itself with the same pattern. Q9 asks whether to expose `Content-Disposition` instead (a one-line `exposedHeaders` change in `main.ts`, outside this contract).

## 5. Permissions

| Route | Route guard (all pairs required, E30) | Data branch |
|---|---|---|
| `POST /customers/bulk/statements` | `read:Sale` + `read:Customer` | — |
| `POST /customers/bulk/export` | `read:Customer` + **`export:Customer`** (v1) | `read:Sale` adds the metric columns and allows metric params (§4.4) |

- **Statements need both.** `read:Sale` is the single statement's permission (E1). `read:Customer` is needed because the selection comes from the customer table, and filter mode evaluates the customer listing (`read:Customer`, E20). Since `read:Sale` is always present here, metric filters never raise `LISTING_PARAM_REQUIRES_PERMISSION` on this route.
- **v1: new special permission `export:Customer`** (owner: «Nonono, perdon, exportar datos de clientes debe ser un permiso nuevo especial.»). New action `export` in `AppActions`; registry row `export:Customer` «Exportar datos de clientes (CSV)» (`src/auth/authorization/domain/permission.ts`), upserted by the permission seeder on boot (no migration). Not granted to the seeded Manager / Cashier roles.
  - CASL `manage` is a wildcard, so the route guard alone would let `manage:Customer` through. The controller additionally requires an **explicit** `export:Customer` rule or `manage:all` (`src/customers/bulk/customer-export.permission.ts`). So **`manage:Customer` does NOT imply export; `manage:all` (Super Admin) does.** A `manage:Customer`-only caller gets the standard `403 INSUFFICIENT_PERMISSIONS` and a `forbidden` log line.
  - Roles that hold `manage:Customer` today cannot export until `export:Customer` is granted in Admin → Roles.

### 5.1 Audit

The repo has no audit pattern for exports or reads (E17). v1 writes **one structured log line per request** (`customers.bulk.export` / `customers.bulk.statements`): tenant id, user id, selection mode, count, sort or `from`/`to`, size, durations and outcome (`ok`, `rejected`, `forbidden`; statements also `busy`, `aborted`, `failed`, `timeout`) with the error code. No customer data and no ids are logged.

**FUTURE item (owner: «Por ahora no, pero dejalo anotado para platicarlo despues»):** a persisted export audit table (who exported what, when). Not built; to discuss with the owner later.

## 6. Limits summary

| Limit | Value |
|---|---|
| `customerIds`, `excludeIds` | ≤ 1,000 each |
| Statement customers per request | 1–50 |
| Statement period | 1–366 days, `[from, to)` |
| Concurrent bulk statement runs | 1 per process / replica, across all tenants (`429` otherwise) |
| CSV rows per request | ≤ 10,000 (0 allowed) |
| Request body | Nest's default JSON limit (100 KB per the framework default; not set in the repo, E34) |
| Rate limit | none beyond the busy guard (no app-wide throttler, E33) |

## 7. Errors

The checks run in this order: route permissions → reserved keys (anywhere in the body) → body shape → (statements: busy check) → `filter` validation → permission params → selection resolution → size → generation. (v1: the statements busy check runs before the `filter` is validated.)

Reserved keys (`__proto__`, `constructor`, `prototype`) are checked in the top level, `selection` and nested objects up to 4 levels deep (arrays are not walked; deeper paths still get a `400`, as an unknown property of their parent). If `selection.filter` holds one, only that error is reported.

| HTTP | Body / code | When | Route |
|---|---|---|---|
| 400 | standard per-field validation body `{ statusCode, message: [ValidationError…], error }` | `selection` missing; `mode` not `ids`/`filter`; keys of the other mode; `customerIds` empty, > 1,000 or non-UUID; `excludeIds` > 1,000 or non-UUID; unknown body key (incl. `__proto__`/`constructor`/`prototype` anywhere in the body); `page`/`limit`/`sortBy`/`sortOrder`, an unknown param (incl. `__proto__`/`constructor`/`prototype`) or a non-string value inside `filter`; `from`/`to` missing, malformed, `to <= from` or > 366 days; bad `sortBy`/`sortOrder` | both |
| 400 | `LISTING_INVALID_ENUM_VALUE`, `LISTING_TOO_MANY_VALUES`, `LISTING_INVALID_UUID`, `LISTING_INVALID_NUMBER`, `LISTING_INVALID_DATE`, `LISTING_INVERTED_RANGE` (EXISTS, E29) | a bad value inside `filter`, same rules and `field` names as the listing | both |
| 400 | `LISTING_PARAM_REQUIRES_PERMISSION` (EXISTS, E22) | metric filter in `filter` or metric `sortBy` without `read:Sale` | export |
| 400 | **NEW** `BULK_SELECTION_TOO_LARGE`, `details: { count, max }` | resolved customers > 50 (statements) or > 10,000 (export) | both |
| 400 | **NEW** `BULK_SELECTION_EMPTY` | the selection resolves to 0 customers | statements |
| 403 | `INSUFFICIENT_PERMISSIONS` (domain body, code in `error`) | a route permission missing (§5); export: `manage:Customer` without the explicit `export:Customer` | both |
| 404 | **NEW** `BULK_CUSTOMERS_NOT_FOUND`, `details: { missingIds: [...] }` | ids mode: an id is unknown, foreign or deleted (§2.4); or deleted mid-run (§3.5) | both |
| 413 | framework body | body over the JSON limit (not reachable within the caps) | both |
| 429 | **NEW** `BULK_EXPORT_BUSY`, `details: { retryAfterSeconds: 10 }`, header `Retry-After: 10` (CORS-exposed) | another bulk statement run is in progress on this process (§3.3) | statements |
| 500 | `PDF_GENERATION_FAILED` (EXISTS, E6; Nest body, code in `message`) | any statement failed to render; nothing sent | statements |
| 503 | `BULK_EXPORT_TIMEOUT` `{deadlineSeconds: 120}` | a bulk statements run exceeds its 120 s deadline (slot freed at once) | statements |

The new `BULK_*` selection codes use the listing envelope `{ statusCode, code, message, field, details? }` (E29), with `field: "selection"` (or `"customerIds"` for the 404). `BULK_EXPORT_BUSY` has no `field`.

```json
{ "statusCode": 400, "code": "BULK_SELECTION_TOO_LARGE", "message": "selection resolves to 73 customers; max 50", "field": "selection", "details": { "count": 73, "max": 50 } }
```

```json
{ "statusCode": 404, "code": "BULK_CUSTOMERS_NOT_FOUND", "message": "2 customers not found", "field": "customerIds", "details": { "missingIds": ["uuid-a", "uuid-b"] } }
```

## 8. Module placement

- **Selection resolver + CSV export:** customers module, in `src/customers/bulk/` (v1), next to the listing. It reuses `CustomersListingQueryDto` rules, the SQL builder and the reader (E23–E25). A new controller is registered before `CustomersController`, as the listing controller is (E20). `bulk` is not a UUID, so the `:id` routes would reject it anyway.
- **Bulk statements:** controller and service in `src/sales/customer-bulk-statements*` (v1), registered in `PdfGenerationModule`, like the single statement (E1, E9). `CustomersModule` exports the selection resolver, and `PdfGenerationModule` imports `CustomersModule`. `CustomersModule` imports only `AuthModule` and nothing imports it except `AppModule` (E39), so this adds no cycle.

## 9. Recommended UI flow

1. **Selection bar:** show «N seleccionados». With «todos los del filtro», N = `filterSummary.count` − unticked rows.
2. **Statements:** disable the button when N > 50, with «Máximo 50 clientes por descarga». Ask for the period (presets → `from`/`to`). Show a spinner (expect up to ~15 s). On `429`, retry after `Retry-After` and show «Otra descarga en curso». On `404 BULK_CUSTOMERS_NOT_FOUND`, drop the ids and offer to retry.
3. **CSV:** send the current filter and sort. Disable when N > 10,000. Save the blob as `clientes-<fecha>.csv`.
4. Without `read:Sale`: hide «Estados de cuenta». The CSV omits the metric columns; tell the user if useful.
5. v1: hide «Exportar CSV» unless the user holds `export:Customer` (or `manage:all`); `manage:Customer` alone is not enough. Read the file name from `Content-Disposition` (CORS-exposed). On `429` use `details.retryAfterSeconds` or the `Retry-After` header (both CORS-readable). Full flow: handoff 32.

## 10. Size and risk

Read-only. No money moves, no migration, no dependency in the recommended option.

**Risks:**

- event-loop blocking while rendering (mitigated by the yield, the busy guard and the measurement gate, §3.3);
- the CSV query cost on large branches (cap + measurement, §4.5);
- the hand-written ZIP writer (small, tested against `unzip -t` and a real extraction in tests);
- Excel quirks on non-Mexico regional settings (Q6).

**Work units** (estimate ≈ 1,100 authored lines, tests included):

| WU | Content | Tests |
|---|---|---|
| WU1 | Selection DTO and resolver: `ids` / `filter` + `excludeIds`, listing DTO validation of `filter`, the internal id conditions in the listing SQL, `BULK_*` errors | unit per branch; PostgreSQL integration: tenant isolation, exclusions, foreign ids → 404, the same results as `GET /customers/listing` for the same filter |
| WU2 | CSV serializer: BOM, CRLF, RFC 4180 quoting, injection guard, CP rule, money and date formats in the business timezone | pure unit tests, including accents, commas, quotes, newlines and `=cmd` values |
| WU3 | `POST /customers/bulk/export`: controller, permission branch (columns, `LISTING_PARAM_REQUIRES_PERMISSION`), cap, summary-first count | unit + integration (with and without `read:Sale`, cap + 1) |
| WU4 | Store-only ZIP writer (`zlib.crc32`) | unit: structure, CRC, round trip through an unzip |
| WU5 | `POST /customers/bulk/statements`: sequential render with yield, busy guard, entry names, empty-period customers, mid-run deletion, render failure → 500 | unit + integration + the benchmark spec (§3.3) |
| WU6 | Frontend handoff doc | — |

WU1 comes first. WU2 → WU3 and WU4 → WU5 are independent of each other after WU1.

## 11. Not verified

v1 status: render time and size were **measured** (§0.1); the ZIP writer deflates with a store fallback, so PDF compression no longer matters; nested `filter` errors keep the plain listing param names (`parseCustomerBulkFilter`). Still not verified: replicas / proxy timeouts, Excel on a real es-MX Windows PC, real branch sizes. The v0 list follows.

- **Render time and size per statement:** no measurement exists in the repo. The 100–300 ms and 50–150 KB figures are estimates; §3.3 makes measuring them a gate.
- **Whether `@react-pdf/renderer` output is already compressed** (affects the store-only ZIP, §3.6).
- **Number of API replicas** in Dokploy, and any reverse-proxy timeout. The deploy checklist mentions Dokploy but not replicas or timeouts. A proxy timeout under ~30 s would break the statements request.
- **Nested validation error mapping:** that the listing exception factory reports errors inside `filter` with the plain listing param name. The implementation may need to validate `filter` explicitly with the listing DTO to get that.
- **Excel behavior** (BOM, comma, ISO dates, the `="…"` CP formula) comes from general knowledge of Excel, not tests in this repo. WU2 should be checked once on a Windows PC set to Spanish (Mexico).
- **Branch size:** the 10,000-row cap assumes branches well under that. The real customer count is unknown here (Q1).

## 12. Open questions

**All answered (2026-11-27), see §0.1.** Kept for the record.

1. **[OWNER]** How many customers do you usually want at once? Is **50 statements per download** enough (for example, «todos los que deben»)? Is **10,000 rows** per CSV enough? Above that, the async job of §3.7 (statements) or streaming (CSV) would be needed.
2. **[OWNER]** **ZIP with one PDF per customer** (proposed), or do you mainly print them all, so that **one merged PDF** is worth a later extra?
3. **[OWNER]** Is it OK that the files inside the ZIP carry the customer's name (`estado-de-cuenta-ana-lopez-3f2a9c1e-….pdf`), or should they carry only the id like today's single download?
4. **[OWNER]** Should «Exportar CSV» be allowed to everyone who can see the customer table (`read:Customer`, proposed), or should it need its **own permission**? Do you want a **record of who exported what** inside the system (an audit table), or is a server log enough?
5. **[OWNER]** Include customers **without movements in the period** (proposed: yes, their PDF still shows the current open debt), or add an option «solo con movimientos o deuda»?
6. **[OWNER]** Excel: do all the PCs that will open the file use **Spanish (Mexico)** regional settings (comma works)? Should the **CP** keep its leading zero with the `="03100"` trick (proposed), or stay plain (Excel shows `3100`)?
7. **[OWNER]** OK with a small in-repo ZIP writer (proposed, no new dependency), or prefer adding a library such as `archiver`?
8. **[FRONTEND]** Are the 28 columns of §4.3 the right set and order? Should `matchedPetName` or all addresses be included?
9. **[FRONTEND]** Is the frontend on another origin than the API? If so, will you name the downloaded files yourself (proposed), or should the backend expose `Content-Disposition` in CORS?
10. **[FRONTEND]** Does strict ids handling (`404 BULK_CUSTOMERS_NOT_FOUND` with the missing ids, then you drop them and retry) work for the UI, or do you prefer the backend to skip them and report the count?

## Evidence

Paths are relative to the repository root, at `main` 34b209a9.

- **E1** `src/sales/sales-customer-statement.controller.ts:22-33` (registered in `PdfGenerationModule`, 404/500 behavior), `:34-67` (route, `read:Sale`, `no-store`, render before headers, `res.send(pdf)`).
- **E2** `src/sales/dto/customer-statement.dto.ts:1-10` (local dates, half-open, 366 days), `:19` (`MAX_CUSTOMER_STATEMENT_RANGE_DAYS = 366`), `:59-63` (range rule), `:67-70` (`CustomerStatementQueryDto`); `src/sales/dto/customer-statement.dto.spec.ts:20-65`.
- **E3** `docs/frontend-handoff/29-customer-statement-pdf.md:9-19` (only `from`/`to`; download as a blob), `:21-28` (errors).
- **E4** `src/sales/infrastructure/prisma-customer-statement.reader.ts:1-13`, `:33-41` (one RepeatableRead transaction), `:50-98` (4 statements, explicit `tenantId`).
- **E5** `src/sales/customer-statement.service.ts:1-20`, `:125-149` (timezone, `now`, 404 code-only), `:150-192` (shaping, `currentDebt` over every open-debt sale); `src/sales/dto/customer-statement.dto.ts` `CustomerStatementDto` (`currentDebt`: «Every CONFIRMED sale with open debt, also older than the period»).
- **E6** `src/pdf-generation/pdf-generation.service.ts:24-33` (error table), `:49` (`@react-pdf/renderer` import), `:495-511` (`renderCustomerStatementPdf`: `renderToBuffer`, `500 PDF_GENERATION_FAILED`).
- **E7** `src/sales/sales-customer-statement.controller.ts:70-77` (`buildCustomerStatementPdfFilename`, user-data-free).
- **E8** `src/pdf-generation/templates/report/customer-statement-a4.document.tsx:2-10` (one document, `Página X de Y`), `:124` («Sin ventas confirmadas en el periodo.»), `:167` («Sin pagos recibidos en el periodo.»), `:303` («Sin deuda abierta.»); `docs/frontend-handoff/29-customer-statement-pdf.md:41-45`.
- **E9** `src/pdf-generation/pdf-generation.module.ts:36-66` (imports `AuthModule`, `SalesModule`, `TenantsModule`, `CashRegisterModule`; statement controller registered here).
- **E10** `src/receipts/infrastructure/pdf-preview.child.ts:1-7` (forked child process); `src/receipts/infrastructure/pdfium-preview-rasterizer.ts:95-110` (timeout).
- **E11** `src/inngest/inngest.service.ts:45-105` (client, `send` with idempotency key), `:153` (`registerFunctions`); registrars such as `src/receipts/inngest/receipt-review-inngest-registrar.ts:59`, `src/promotions/inngest/promotion-expiry-inngest-registrar.ts:70`.
- **E12** `src/inngest/inngest.controller.ts:1-44`, `:61` (`@Controller('api/inngest')`, `serve()` inside the API process).
- **E13** `src/stock-alerts/outbox/low-stock-outbox.module.ts:21`; `src/stock-alerts/outbox/low-stock-outbox.poller.ts:24-26`.
- **E14** `src/receipts/infrastructure/spaces-receipt-storage.adapter.ts:15-19` (private ACL, no public URL), `:28-58` (`putPrivate`, `getPrivate` stream); `src/receipts/receipts.module.ts:26-27`, `:47-50` (bucket config, read through the backend).
- **E15** `src/files/infrastructure/spaces-storage.adapter.ts:29-38` (`ACL: 'public-read'`).
- **E16** `src/private-media/domain/private-media.ts:1-5` (image MIME types only); `src/private-media/infrastructure/private-s3-storage.ts:64-78`.
- **E17** `prisma/schema.prisma:601` (`BotAuditLog`), `:796` (`ProcurementPurchaseOrderAudit`), `:864` (`ProcurementSupplierAudit`), `:1897` (`OutboxEvent`); no job/export model.
- **E18** No `text/csv` or BOM output in `src` (the only BOM reference strips it on input: `src/sat-catalog/ingest/parse-sat-rows.ts:96`).
- **E19** `package.json` `dependencies` (no `archiver`/`jszip`/`yazl`; `inngest`, `@aws-sdk/client-s3`, `@react-pdf/renderer`, `@nestjs/schedule` present); `Dockerfile:1-3` (`node:24-slim`); local `node -e` check: `v24.14.1`, `typeof zlib.crc32 === 'function'`.
- **E20** `src/customers/listing/customers-listing.controller.ts:14-41` (`read:Customer`, `request.ability`, registered before `CustomersController`); `src/customers/customers.module.ts:17-19`.
- **E21** `src/customers/listing/customers-listing.service.ts:43-87` (`ability.can('read', 'Sale')`, metrics only with it, two parallel statements), `:109-115` (business timezone).
- **E22** `src/customers/listing/customers-listing.permissions.ts:8-35` (metric params and sorts), `:37-64` (`LISTING_PARAM_REQUIRES_PERMISSION` body).
- **E23** `src/customers/listing/customers-listing-query.dto.ts:23-38` (`sortBy`, `sortOrder`), `:68-73` (boolean strings), `:154-174` (`page`, `limit` ≤ 100, defaults, `search`).
- **E24** `src/shared/listing/parsers/csv-multi-value.parser.ts:12-28` (string or string array, cap → `LISTING_TOO_MANY_VALUES`).
- **E25** `src/customers/listing/customers-listing.sql.ts:256` (`customerFilterConditions`), `:297` (`metricFilterConditions`), `:414-434` (sort columns, `NULLS LAST`, `id` tie-breaker), `:457-481` (`buildListingPageSql`: metrics before `LIMIT` for a metric sort or filter), `:567` (`buildListingSummarySql`); `src/customers/listing/customer-sales-metrics.sql.ts:24` (`overdueCutoff`), `:51` (`customerSalesMetricsSql`).
- **E26** `src/customers/listing/prisma-customers-listing.reader.ts:70-80` (`findPage`), `:96-113` (`summarize`).
- **E27** `src/customers/listing/customer-listing.types.ts:8-57` (`CustomerSalesMetrics`, `CustomerListingRow`); `docs/proposals/customers-list-contract.md` §2.1.
- **E28** `src/shared/listing/app-validation.pipe.ts:4-12`; `src/main.ts:35`.
- **E29** `src/shared/listing/listing.exceptions.ts:3-42` (codes, envelope).
- **E30** `src/auth/authorization/guards/permissions.guard.ts:90-105` (`request.ability`, every pair required, `403`).
- **E31** `src/auth/authorization/domain/permission.ts:17-26` (`AppActions`), `:283-305` (`Customer` permissions), `:307-309` (`Sale` permissions).
- **E32** `src/customers/customers.controller.ts:59-64` (`DELETE /customers/:id`); `src/customers/infrastructure/prisma-customer.repository.ts:123`, `:155` (`tx.customer.delete`).
- **E33** `src/public-catalog/public-catalog.module.ts:26` (the only `ThrottlerModule`).
- **E34** `src/main.ts:25-80` (no timeout setting; route-scoped body parsers only for human decisions, suppliers, purchase orders, inventory and conversation batches).
- **E35** `src/main.ts:43-59` (`enableCors`); `src/catalog-editorial/http/editorial-cors.ts:31-51` (`exposedHeaders` only on editorial routes).
- **E36** `Dockerfile:35` (`CMD ["node", "dist/main"]`); `docs/deploy/production-launch-checklist.md:5` (Dokploy builds from `main`).
- **E37** `src/customers/domain/constants.ts:40-66` (`FISCAL_REGIMES`: codes only, labels in comments).
- **E38** `src/shared/prisma/tenant-prisma.service.ts:97-128` (`runInTransaction` → `$transaction` with no `timeout` option, so Prisma's 5 s default applies).
- **E39** `src/customers/customers.module.ts:15-35` (imports only `AuthModule`; exports `CustomersService`); `src/app.module.ts:27`, `:149` (the only importer).
