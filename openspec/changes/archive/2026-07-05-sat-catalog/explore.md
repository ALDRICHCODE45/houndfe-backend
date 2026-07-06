# Exploration: SAT Product/Service Catalog (`sat-catalog`)

## Goal

The product form (quick create + full editor) exposes a `SAT Key` field that is
currently a FREE-TEXT input. It must become a **server-backed searchable select**.
`satKey` maps to the Mexican SAT fiscal product/service catalog
(`c_ClaveProdServ`, ~52,000 entries). The legacy POS ("pulpos") subset is unknown,
so the backend MUST support the FULL SAT catalog.

Confirmed business decisions (locked, do not re-litigate):

1. Use the FULL SAT catalog (~52k keys), not a legacy subset.
2. Strict validation: a product create/edit request carrying a `satKey` MUST be
   rejected (HTTP 400) when the key does not exist in the catalog.
3. A 52k-entry `<select>` is unacceptable — the UI pattern is server-side
   search/typeahead: the frontend sends a query string, the backend returns a
   small paginated/limited result set.

---

## Current State (verified against real code)

### 1. `satKey` is free text end-to-end — no catalog, no FK, no validation

- Prisma: `prisma/schema.prisma:327` → `satKey String?` on `model Product`.
  Plain nullable string, no relation, no index.
- DTO: `src/products/dto/create-product.dto.ts:170` → `satKey?: string` guarded
  only by `@IsOptional() @IsString()`. No catalog check.
- Domain entity: `src/products/domain/product.entity.ts` → `satKey: string | null`
  throughout (props line 61, field 89, assignment 116, `create` 208,
  `fromPersistence` 267, serialization 370/400). It is a passthrough scalar.
- Service passthrough:
  - Create: `src/products/products.service.ts:290` (entity) and `:327` (Prisma write).
  - Update: `:599` → `if (dto.satKey !== undefined) product.satKey = dto.satKey || null;`
  - Read/serialize: `:327`, `:518`.
  - Repository adapter: `src/products/infrastructure/prisma-product.repository.ts:69,97,285`.
- **No catalog table, no seed data, no lookup exists anywhere.** Confirmed by grep:
  the only `satKey` references are the passthrough sites above plus one test.

### 2. `satKey` is INTERNAL fiscal data — must stay OUT of the public catalog

- `src/public-catalog/http/public-catalog.snapshots.spec.ts:54` asserts
  `expect(result).not.toHaveProperty('satKey')`. This is a hard constraint: the
  public/online catalog serializer must never expose `satKey`. Any design here
  MUST preserve this — the SAT catalog is admin/internal reference data only.

### 3. The repo already has a proven ILIKE search idiom (reuse it)

- `ProductsService.searchForPOS` (`src/products/products.service.ts:1862`) already
  implements typeahead search using Prisma
  `{ contains: q, mode: 'insensitive' }` (compiles to `ILIKE`) across
  `name`/`sku`/`barcode`, with `limit`/`offset` pagination
  (`:1879-1890`). Tests: `products.service-pos-catalog.spec.ts`.
- This is the established, tested pattern for "server-side typeahead over a table"
  in this codebase. A SAT search endpoint should mirror it rather than invent a
  new search mechanism.

### 4. No PostgreSQL extensions are enabled

- Grep across `prisma/schema.prisma` and every file under `prisma/migrations/`
  found NO `CREATE EXTENSION`, no `pg_trgm`, no `unaccent`, no `tsvector`/GIN.
  (The single "gin"/"tsvector" grep hits were false positives on
  `originalPriceCents`.) Enabling an extension would be a NEW operational
  dependency requiring a raw-SQL migration and DB privilege.

### 5. Module layout & wiring precedent

- `products` is a clean hexagonal module: `domain/` (entities + repository ports
  via `PRODUCT_REPOSITORY` token), `infrastructure/` (Prisma adapters), `dto/`,
  controller, service. `products.module.ts` binds the port to the adapter and
  exports `ProductsService`. A new reference-data module can copy this shape and
  be imported by `ProductsModule` for validation.
- Multi-tenancy: products are tenant-scoped via `TenantPrismaService`/CLS. **The
  SAT catalog is national reference data — it is NOT tenant-scoped.** It should
  use the base (non-tenant) Prisma client and be a single shared table.

### 6. RBAC / CASL precedent

- Permissions are `{ subject, action, description }` tuples in
  `src/auth/authorization/domain/permission.ts` (e.g. `Sale` × create/read/
  update/delete/manage at `:149-154`), enforced by `@RequirePermissions([action, Subject])`
  on controllers (see `products.controller.ts` — every route is guarded).
- A read-only SAT search endpoint fits a new `SatKey` subject with a `read`
  action (internal admin data). Seeding permissions is already wired:
  `prisma/seed.ts:15` imports `PERMISSION_REGISTRY`.

### 7. Seed infrastructure already exists

- `prisma/seed.ts` is a full seeding script (tenants, users, permission registry,
  etc.). Adding a SAT catalog seed step is idiomatic here. `pnpm` scripts drive
  Prisma. This matters for the ingestion decision below.

---

## The Critical Unknown: where does the SAT catalog data come from?

### Data source (SAT `c_ClaveProdServ`)

- The catalog is published by **SAT (Servicio de Administración Tributaria)** as
  part of the CFDI 4.0 catalog workbook **`catCFDI.xls` / `catCFDI.xlsx`** (an
  Excel file with one sheet per catalog). The relevant sheet is
  **`c_ClaveProdServ`**. SAT also historically distributes it as CSV/TXT.
- Typical columns on the `c_ClaveProdServ` sheet:
  - `c_ClaveProdServ` — the 8-digit numeric key (the value stored in `satKey`).
  - `Descripción` — human description (Spanish).
  - `Incluir IVA trasladado` — Sí/No/Opcional flag.
  - `Incluir IEPS trasladado` — Sí/No/Opcional flag.
  - `Fecha de inicio de vigencia` / `Fecha de fin de vigencia` — validity dates
    (many rows have an end date → the key is retired).
  - `Estímulo franja fronteriza`, `Palabras similares` (synonym search hints) —
    present in some editions.
- Row count: **~52,000** active+historical entries. This is small for Postgres
  (a single table, a few MB), but too large for a client-side `<select>`.
- Shipping into a backend: the standard approach is to convert the SAT Excel
  sheet to CSV/JSON **once, offline**, commit that file (or a compact JSON) to
  the repo under e.g. `prisma/data/sat-clave-prod-serv.<csv|json>`, and import it
  via seed/import. The source Excel is NOT parsed at runtime.

> **This remains a real unknown to close before/during proposal:** we do not yet
> have the actual file in the repo, its exact edition/columns, nor whether the
> product wants retired (expired-vigencia) keys included or filtered. See Open
> Questions.

---

## Affected Areas

- `prisma/schema.prisma` — NEW `SatProductServiceKey` (or `SatKey`) reference
  table (national, non-tenant). NO change to `Product.satKey` type is strictly
  required for strict validation (it stays a validated string); a hard FK is
  optional and discussed below.
- `prisma/migrations/…` — new migration for the table (+ search index; possibly a
  raw-SQL `CREATE EXTENSION` if a trigram/FTS approach is chosen).
- `prisma/data/sat-clave-prod-serv.*` — NEW committed data file (CSV or JSON).
- `prisma/seed.ts` (or a dedicated import script) — ingestion step.
- NEW module `src/sat-catalog/` (recommended): `domain/` (entity + repository
  port), `infrastructure/` (Prisma adapter), `dto/`, controller, service, module.
- `src/products/products.module.ts` — import the SAT module to consume validation.
- `src/products/products.service.ts` — call SAT validation in create (`~:281/290`)
  and update (`~:599`) paths before persisting `satKey`.
- `src/auth/authorization/domain/permission.ts` + `prisma/seed.ts` — add a
  `SatKey`/`read` permission for the search endpoint.
- Tests: preserve `public-catalog.snapshots.spec.ts:54` (satKey stays hidden);
  new specs for search + validation.

---

## Approaches — Ingestion

### Ingestion A: One-off Prisma seed of a committed data file — **recommended**

Convert the SAT `c_ClaveProdServ` sheet to CSV/JSON once (offline), commit it to
`prisma/data/`, and load it in `prisma/seed.ts` (or a small dedicated
`prisma/seed-sat.ts`) using batched `createMany({ skipDuplicates: true })`.
Re-import on SAT updates = replace the file + re-run the idempotent seed.

- Pros: Uses existing seed infrastructure (`seed.ts` already imports registries);
  deterministic and reproducible across environments; data is versioned in git so
  every deploy has the same catalog; no runtime file parsing; idempotent with
  `skipDuplicates` / upsert. Simplest fit for "fixed national list that changes a
  few times a year."
- Cons: Updating the catalog requires a code change + redeploy (acceptable for a
  slow-moving national catalog); the committed data file adds a few MB to the repo.
- Effort: Low–Medium.

### Ingestion B: Dedicated admin import endpoint (upload CSV → import)

A guarded `POST /sat-keys/import` (super-admin) that accepts an uploaded file and
bulk-upserts. `FilesModule` already exists for uploads.

- Pros: Non-developers can refresh the catalog without a deploy; no large file in
  git.
- Cons: More surface area (auth, validation, partial-failure handling, progress);
  the catalog is national and rarely changes, so an interactive admin importer is
  over-engineered for the actual update cadence; environments can drift (each must
  be imported separately). Higher risk for a first slice.
- Effort: Medium–High.

**Recommendation: Ingestion A.** The catalog is a slow-moving, environment-agnostic
national reference list; a committed file + idempotent seed is the simplest thing
that is correct, reproducible, and re-runnable on SAT updates. A future admin
importer (B) can be added later if update cadence ever justifies it. Avoid
embedding 52k rows as literal SQL in a migration (huge, unreviewable, hard to
re-import) — keep data OUT of migration SQL and IN a seed-loaded file.

---

## Approaches — Storage & Search (~52k rows)

Search must match on BOTH the numeric key (prefix, e.g. "0101") AND the human
description (substring/word, e.g. "aspirina"), returning a small limited set.

### Search A: Plain `ILIKE` via Prisma `contains`/`mode:'insensitive'` + b-tree index — **recommended for v1**

Mirror the existing, tested `searchForPOS` idiom:
`WHERE key ILIKE q% OR description ILIKE %q% LIMIT 20`. Add a plain b-tree index on
`key` (helps prefix/exact on the numeric key). No extension required.

- Pros: Zero new infra/extensions; reuses a proven in-repo pattern; trivial to
  test; at 52k rows a `LIMIT 20` ILIKE scan is well within acceptable latency,
  especially with the key prefix indexed and a leading-anchored key match.
- Cons: `description ILIKE %q%` is a sequential scan on description (not index-
  assisted); acceptable at 52k but would not scale to millions; no fuzzy/accent-
  insensitive matching out of the box (SAT descriptions contain accents).
- Effort: Low.

### Search B: `pg_trgm` trigram GIN index (optionally + `unaccent`)

Enable `pg_trgm` (and optionally `unaccent`), add a GIN trigram index on
`description` (and/or key) so `ILIKE '%q%'` and similarity search are index-
accelerated and accent-tolerant. Requires a raw-SQL migration
(`CREATE EXTENSION`, `CREATE INDEX … USING gin (… gin_trgm_ops)`).

- Pros: Fast substring/fuzzy search that scales; accent-insensitive with
  `unaccent`; better UX for description typeahead.
- Cons: Introduces the project's FIRST pg extension → new operational dependency
  and DB privilege requirement; Prisma can't express the index natively (raw SQL +
  possibly `$queryRaw` for similarity ordering); more moving parts than the actual
  52k-row workload needs.
- Effort: Medium.

**Recommendation: Search A for v1, with B as a documented, cheap upgrade path.**
At 52k rows with `LIMIT 20`, plain ILIKE (reusing `searchForPOS`) meets the
requirement with zero new infrastructure. If real-world latency or accent-matching
proves insufficient, add `pg_trgm` + `unaccent` (Search B) as an isolated
follow-up migration — the endpoint contract does not change. Note: normalizing an
`unaccented`/lowercased search column at ingestion time is a middle-ground that
improves A without an extension.

---

## Module Boundary — recommendation

**Create a NEW bounded context `sat-catalog` (module `src/sat-catalog/`), not
folded into `products`.** Justification:

- **Different data ownership**: the SAT catalog is national, read-mostly, non-
  tenant reference data with its own lifecycle (SAT publishes updates). Products
  are tenant-scoped transactional data. Mixing them violates the screaming/
  hexagonal separation the repo already follows.
- **Reuse**: other future contexts (CFDI invoicing, reporting) will also need to
  validate/look up SAT keys. A shared module prevents duplication.
- **Clean dependency direction**: `ProductsModule` imports `SatCatalogModule` and
  calls a narrow `SatKeyValidator`/repository port for validation. SAT knows
  nothing about products.
- Follow the products layout: `domain/` (`SatKey` entity + `SAT_KEY_REPOSITORY`
  port), `infrastructure/` (Prisma adapter using the base client, not tenant-
  scoped), `dto/`, `sat-catalog.controller.ts`, `sat-catalog.service.ts`,
  `sat-catalog.module.ts` (exports the service/validator).

---

## Validation Integration Point

- **Application layer, in `ProductsService`** (not the domain entity). The
  `Product` aggregate should stay pure and not depend on an external catalog
  repository. `ProductsService.create` (`~:281`) and `.update` (`~:599`) should,
  when `dto.satKey` is present and non-empty, call
  `SatCatalogService.assertExists(satKey)` BEFORE constructing/persisting the
  entity, throwing a 400 (`SAT_KEY_NOT_FOUND` / `BadRequestException`) on miss.
- Keep it strict per business decision #2: unknown key → 400. Empty/absent
  `satKey` → allowed (field is optional).
- **FK vs application check**: a hard DB FK from `Product.satKey` →
  `SatProductServiceKey.key` would enforce integrity at the DB level, but (a)
  requires `satKey` to be a real column reference and complicates the existing
  passthrough + nullable semantics, and (b) couples the products table to the
  reference table's presence at migration time. **Recommend application-layer
  validation for v1** (matches the "reject with 400" business ask and gives a
  clean domain error message), leaving a DB FK as an optional hardening decision.

---

## Search Endpoint Shape (frontend contract)

```
GET /sat-keys?search=<text>&limit=20&offset=0
```

- **Auth/RBAC**: internal admin data → guarded like other product-admin routes
  (`JwtAuthGuard` + `TenantContextGuard` + `PermissionsGuard`) with
  `@RequirePermissions(['read', 'SatKey'])` (new `SatKey` subject). NOT exposed on
  the public catalog. (Since the catalog is national, `TenantContextGuard` is only
  for auth context — the query itself is not tenant-filtered.)
- **Request**:
  - `search` (string, required for results; matches key prefix OR description
    substring, case-insensitive).
  - `limit` (int, default 20, max e.g. 50).
  - `offset` (int, default 0) — mirrors `searchForPOS` pagination.
- **Response** (small, limited set):

```json
{
  "items": [
    { "key": "01010101", "description": "No existe en el catálogo" }
  ],
  "limit": 20,
  "offset": 0,
  "total": 1
}
```

- Optional extra fields per row if ingested: `includeIva`, `includeIeps`,
  `validFrom`, `validTo`. Keep the payload minimal for typeahead; the FE only
  needs `key` + `description` to render the option label.
- A companion single-key lookup (`GET /sat-keys/:key`) MAY be added so the editor
  can resolve+display an existing product's saved `satKey` label on load.

---

## Risks

- **DATA-SOURCE UNKNOWN (highest)**: the actual SAT `c_ClaveProdServ` file is NOT
  in the repo. Its exact edition, column set (vigencia dates? IVA/IEPS flags?
  "palabras similares"?), and encoding must be obtained and converted to a
  committed CSV/JSON before ingestion can be built. Also undecided: include
  retired (expired-vigencia) keys or filter to active only. **This blocks the
  ingestion slice and must be resolved during proposal/spec.**
- **52k-scale search performance**: plain ILIKE `%q%` on `description` is a seq
  scan. Acceptable at 52k + `LIMIT 20`, but must be benchmarked; if slow or if
  accent-insensitive matching is required, escalate to `pg_trgm`+`unaccent`
  (introduces the project's first pg extension — operational risk).
- **Public catalog leak**: `satKey` must remain excluded from the public catalog
  (`public-catalog.snapshots.spec.ts:54`). Any serializer/DTO change must not
  regress this.
- **Validation scope creep**: strict 400 on unknown key changes behavior for any
  existing product that already has a free-text `satKey` not in the catalog.
  Editing such a product could now fail. Need a rule for legacy/invalid stored
  keys (validate only on change? backfill/report? — see Open Questions).
- **Catalog freshness**: seed-based ingestion (Approach A) ties updates to
  deploys; if SAT updates mid-cycle, the catalog is stale until redeploy.

---

## Open Questions (resolve before/within proposal)

1. Where is the actual SAT catalog file, and which edition/columns? (Excel sheet
   `c_ClaveProdServ` from `catCFDI` → convert to committed CSV/JSON.)
2. Include retired keys (expired `Fecha de fin de vigencia`) or active-only? If
   included, should the search endpoint filter/flag them?
3. Which columns do we persist — just `key` + `description`, or also
   `includeIva`/`includeIeps`/`validFrom`/`validTo` for future CFDI use?
4. Strict validation on legacy products: only validate when `satKey` changes, or
   also on any edit? What about existing free-text keys not in the catalog?
5. Search accent-sensitivity: is accent-insensitive matching a v1 requirement
   (forces `unaccent`/normalized column) or acceptable to defer?
6. Do we need the single-key lookup endpoint (`GET /sat-keys/:key`) so the editor
   can display the saved key's label on load?
7. RBAC: new `SatKey`/`read` subject, or reuse `read:Product`? (Recommend a
   dedicated `SatKey` subject.)

---

## Ready for Proposal

**Yes.** The codebase side is fully mapped and low-risk: `satKey` is a plain
passthrough string with no catalog today; the repo already has a proven ILIKE
typeahead pattern (`searchForPOS`) to mirror, clean hexagonal module scaffolding
to copy, existing seed + RBAC infrastructure, and a hard constraint (keep `satKey`
out of the public catalog) that is easy to preserve. Recommended shape: a new
`sat-catalog` module, seed-based ingestion of a committed SAT data file, plain
ILIKE search behind `GET /sat-keys`, and application-layer strict (400) validation
in `ProductsService`. The one blocking item for the proposal is **obtaining the
actual SAT catalog file and deciding which columns/retired-key policy to persist**
(Open Questions 1–3). Everything else is a straightforward build on existing
patterns.
