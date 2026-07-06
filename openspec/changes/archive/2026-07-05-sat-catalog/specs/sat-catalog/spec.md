# Delta for sat-catalog

## ADDED Requirements

### Requirement: SAT Catalog Typeahead Search

`GET /sat-keys?search=<text>&limit=20&offset=0` returns active rows where `key` starts with `search` (case-insensitive) OR `description` contains `search` as a substring (case-insensitive AND accent-insensitive). ACTIVE = `validTo` IS NULL OR > now. `limit` defaults to 20, capped at 50. Response: `{ items, limit, offset, total }`. Empty/missing `search` returns no items.

#### Scenario: Substring, prefix, and case-insensitive matching
- GIVEN an active row `key="01010101"`, `description="Aspirina..."`; another `description="Medicamento genérico"`; active keys prefixed `0101`
- WHEN `GET /sat-keys?search=aspirina`, then `search=0101`, then `search=MEDICAMENTO`
- THEN all three return the matching active row

#### Scenario: Retired excluded; limit capped at 50
- GIVEN a retired row matching the search and >50 active matches
- WHEN `GET /sat-keys?search=<match>&limit=200`
- THEN the retired row is NOT in `items` and `items.length <= 50`

### Requirement: SAT Catalog Single-Key Lookup

`GET /sat-keys/:key` returns the exact row regardless of `validTo`. Returns HTTP 404 when no row exists.

#### Scenario: Active, retired, and missing key
- GIVEN rows `key="01010101"` (active) and `key="99999999"` (retired); no row for `key="00000000"`
- WHEN `GET /sat-keys/01010101`, `/sat-keys/99999999`, `/sat-keys/00000000`
- THEN the first two return 200; the last returns 404

### Requirement: Strict SAT Key Validation on Product Create/Update

A create/update request with a non-empty `satKey` not in the catalog MUST be rejected with HTTP 400 and `error: "SAT_KEY_NOT_FOUND"`. Empty/absent `satKey` is accepted.

#### Scenario: Known succeeds; unknown fails 400; absent accepted
- GIVEN a catalog row for `key="01010101"`; no row for `key="99999999"`
- WHEN `POST /products` with `satKey="01010101"`, then `satKey="99999999"`, then `satKey` omitted
- THEN the first creates; the second returns 400 with `error: "SAT_KEY_NOT_FOUND"`; the third creates with `satKey=null`

### Requirement: Validate-Only-On-Change

The catalog MUST be consulted only when the inbound `satKey` differs from the persisted value. Editing other fields of a product whose stored `satKey` is a legacy value not in the catalog MUST NOT be blocked.

#### Scenario: Unchanged satKey and non-satKey edits never block
- GIVEN a product with persisted `satKey="LEGACY_NOT_IN_CATALOG"`
- WHEN `PATCH /products/:id` with `satKey="LEGACY_NOT_IN_CATALOG"`, then with `{ name: "new" }` only
- THEN both return 200; the second preserves `satKey`; no catalog lookup runs

#### Scenario: Change to unknown fails 400; change to valid succeeds
- GIVEN a product `satKey="01010101"`; catalog rows for `01010101` and `01010102`
- WHEN `PATCH /products/:id` with `satKey="99999999"`, then `satKey="01010102"`
- THEN the first returns 400 with `error: "SAT_KEY_NOT_FOUND"`; the second returns 200 with `satKey="01010102"`

### Requirement: RBAC for SAT Catalog Endpoints

`GET /sat-keys` and `GET /sat-keys/:key` MUST be guarded by `read:SatKey`; callers without it receive HTTP 403.

#### Scenario: With permission allowed; without permission rejected
- GIVEN caller A with `read:SatKey` and caller B without it
- WHEN both request `GET /sat-keys?search=aspirina`
- THEN A receives 200; B receives 403

### Requirement: Public Catalog Excludes satKey

The public catalog serializer MUST NOT expose `Product.satKey`. The snapshot at `src/public-catalog/http/public-catalog.snapshots.spec.ts:54` (`not.toHaveProperty('satKey')`) MUST continue to pass.

#### Scenario: Public payload omits satKey
- GIVEN a product with `satKey="01010101"`
- WHEN the public catalog endpoint serializes it
- THEN the payload does NOT contain `satKey`

### Requirement: Seed Idempotency for SAT Catalog

The seed step ingesting `prisma/data/sat-clave-prod-serv.{csv|json}` into `SatProductServiceKey` MUST be idempotent: re-running leaves row count stable with no duplicate `key` rows.

#### Scenario: Re-run is stable
- GIVEN the catalog seeded once with N rows
- WHEN the seed step runs again against the same file
- THEN `COUNT(*)` from `SatProductServiceKey` is still N and no row has NULL/empty `key`

### Requirement: SAT Data File Header Contract

The ingestion script parses by header name (not position). Required header-to-column mapping:

- `c_ClaveProdServ` → `key` (8 digits)
- `Descripción` → `description`
- `Incluir IVA trasladado` → `includeIva` (Sí/No/Opcional → REQUIRED/NONE/OPTIONAL enum)
- `Incluir IEPS trasladado` → `includeIeps` (same mapping)
- `Fecha de inicio de vigencia` → `validFrom` (ISO date)
- `Fecha de fin de vigencia` → `validTo` (ISO date; NULL if open-ended)

CSV/JSON both accepted; missing headers MUST be tolerated as NULL/empty.

#### Scenario: Enum mapping and open-ended validity
- GIVEN CSV rows with `Incluir IVA trasladado` in `{Sí, No, Opcional}` and one row with empty `Fecha de fin de vigencia`
- WHEN the ingestion script processes them
- THEN the three IVA values map to `REQUIRED`/`NONE`/`OPTIONAL` and the open-ended row persists `validTo=NULL`

### Requirement: Accent-Insensitive Search in v1

Typeahead search MUST be accent-insensitive in v1: `medicacion` MUST match `Medicación`. The implementation approach (a normalized lowercased+unaccented search column populated at ingestion time, vs. a Postgres `unaccent`/`pg_trgm` extension) is a design decision; the observable behavior is that accents in the query or the stored description do not prevent a match.

#### Scenario: Accent-insensitive matching provided
- GIVEN an active row `description="Medicación"`
- WHEN `GET /sat-keys?search=medicacion`, then `search=MEDICACIÓN`
- THEN both requests return the row