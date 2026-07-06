# Design: SAT Catalog Search & Validation

## Technical Approach

New non-tenant hexagonal context `src/sat-catalog/` (mirrors `src/products/`) owns the SAT `c_ClaveProdServ` catalog (~52k) in one `SatProductServiceKey` table on the **base Prisma client**. `SatCatalogService` exposes `search`, `findByKey`, `assertExists` behind a `SAT_KEY_REPOSITORY` port. `ProductsModule` imports it and calls `assertExists` in `create`/`update` **only when `satKey` changes**. Accent-insensitivity = **Option A: normalized `searchText` column** (NFD strip + lowercase) matched via `ILIKE` against the identically-normalized query — no Postgres extension. Slices A→D per proposal.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|----------|--------|----------|-----------|
| Accent-insensitivity | **Option A**: normalized `searchText` column, app-layer `normalize()` (NFD strip + lowercase) at ingest AND on query | Option B: `unaccent`+`pg_trgm` extensions | Zero new operational dependency; no DB privilege / raw-SQL `CREATE EXTENSION`; deterministic in seed + query; sufficient at 52k + `LIMIT`. B is the documented upgrade path if fuzzy/scale ever needed. |
| Client scope | Base Prisma client (non-tenant) via `PrismaService` | `TenantPrismaService`/CLS | Catalog is national reference data, one shared table, not tenant-scoped |
| Validation location | Application layer (`ProductsService`) | Domain entity or DB `FOREIGN KEY` | Keeps `Product` aggregate pure; clean `SAT_KEY_NOT_FOUND` domain error; avoids coupling products migration to reference table |
| `includeIva`/`includeIeps` | Prisma enum `SatInclusion { REQUIRED NONE OPTIONAL }` | Free string | Type-safe; deterministic Sí/No/Opcional mapping |
| Search index | b-tree on `key` (prefix/exact) + b-tree on `searchText` (left-anchored help) | GIN trigram | No extension; `LIMIT` keeps the description `%q%` scan acceptable at 52k |
| Retired-key policy | `search` filters ACTIVE (`validTo IS NULL OR > now()`); `findByKey` returns retired too | Single filtered method | Locked #4: historical keys must resolve on editor load |
| Ingestion | Idempotent seed step, batched `createMany({ skipDuplicates:true })` in `prisma/seed-sat.ts` helper called from `seed.ts` | Embed 52k rows as migration SQL / admin importer | Reproducible, re-runnable, out of migration SQL; importer deferred |

## Data Flow

```
Search:  Controller GET /sat-keys ─> SatCatalogService.search(q,{limit,offset})
                                          │  normalize(q)
                                          ▼
                             SAT_KEY_REPOSITORY.search ─ ILIKE searchText + ACTIVE filter
                                          ▼  { items, limit, offset, total }

Validate: ProductsService.create/update ─ isChange? ─> SatCatalogService.assertExists(key)
                                                             │ repo.exists(key)? no → 400 SAT_KEY_NOT_FOUND
```

## Schema (Slice A)

```prisma
enum SatInclusion { REQUIRED NONE OPTIONAL }

model SatProductServiceKey {
  key         String       @id            // 8-digit c_ClaveProdServ (natural PK)
  description String
  searchText  String                       // normalize(key + ' ' + description): NFD strip + lowercase
  includeIva  SatInclusion @default(NONE)
  includeIeps SatInclusion @default(NONE)
  validFrom   DateTime?
  validTo     DateTime?                     // NULL = open-ended (active)
  @@index([searchText])
}
```
`key` as `@id` gives the b-tree for prefix/exact + guarantees no duplicate `key`. National table: no `tenantId`, no tenant FK. Migration is additive (rollback = drop table + enum).

## Domain (Slice B)

- `domain/sat-key.entity.ts` — pure `SatKey` mirroring `product.entity.ts`: `static create(props)` (ingest; runs `normalize()` → `searchText`), `static fromPersistence(data)` (no revalidation). Fields `key, description, searchText, includeIva, includeIeps, validFrom, validTo`; helper `isActive(now)`.
- `domain/sat-key.repository.ts` — `SAT_KEY_REPOSITORY` token + port:

```ts
export interface ISatKeyRepository {
  search(q: string, opts: { limit: number; offset: number }):
    Promise<{ items: SatKey[]; total: number }>;   // ACTIVE-only, normalized ILIKE
  findByKey(key: string): Promise<SatKey | null>;   // returns retired too
  exists(key: string): Promise<boolean>;            // any row (active or retired)
}
```
- `normalize(s)` — accent-strip that **PRESERVES `ñ/Ñ`** (ñ is a distinct Spanish letter, NOT an accented n; naive `NFD + strip \p{Diacritic}` corrupts `niño→nino`, `Muñoz→munoz`). Protect ñ before decomposition, then strip other diacritics, then lowercase:
  ```ts
  function normalize(s: string): string {
    return s
      .replace(/ñ/g, '\u0001').replace(/Ñ/g, '\u0002')   // shield ñ/Ñ from NFD strip
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')     // strip á é í ó ú ü diacritics
      .replace(/\u0001/g, 'ñ').replace(/\u0002/g, 'ñ')     // restore (lowercased target)
      .toLowerCase()
      .trim();
  }
  ```
  Accent-insensitive for `á/é/í/ó/ú/ü` while keeping `ñ` intact and case-folded. SAME fn at ingest (stored `searchText`) and on query before `ILIKE '%q%'`. Entity/repo tests MUST assert `niño` stays searchable as `niño` (not collapsed to `nino`).
- Adapter `infrastructure/prisma-sat-key.repository.ts` on base `PrismaService.satProductServiceKey`. `search` honors the spec's two match modes: `where: { AND: [ activeClause, { OR: [ { key: { startsWith: n } }, { searchText: { contains: n } } ] } ] }` where `n = normalize(q)` — key by **prefix**, description substring via `searchText`. `orderBy: [{ key: 'asc' }]`, `take/skip`, `+ count` for `total`. `activeClause = { OR: [{ validTo: null }, { validTo: { gt: now } }] }`. (`searchText` stores description only or `key+' '+description` per Open Question 2; prefix on raw `key` guarantees the numeric-prefix scenario regardless.)

## Ingestion (Slice A)

`prisma/seed-sat.ts` helper called from `prisma/seed.ts`:
1. Read `prisma/data/sat-clave-prod-serv.{csv|json}`, parse **by header name**: `c_ClaveProdServ→key`, `Descripción→description`, `Incluir IVA trasladado→includeIva`, `Incluir IEPS trasladado→includeIeps`, `Fecha de inicio de vigencia→validFrom`, `Fecha de fin de vigencia→validTo`. Missing headers → NULL/empty.
2. Enum map `{ Sí→REQUIRED, No→NONE, Opcional→OPTIONAL }` (trim/case-fold).
3. Dates ISO→`Date`; empty `validTo`→`null` (open-ended).
4. `searchText = normalize(key + ' ' + description)`.
5. Batched `createMany({ skipDuplicates: true })` (~1–2k/batch). `key` PK + `skipDuplicates` ⇒ idempotent (stable COUNT, no dupes/NULL key).

## Change-Detection Predicate (Slice D)

**Update path** — `products.service.ts:569` already loads the persisted entity: `const product = await this.productRepo.findById(id)` (`:570`), so `product.satKey` holds the CURRENT stored value **before** the assignment at `:599`. Insert the guard immediately before `:599`:

```ts
if (dto.satKey !== undefined) {
  const next = dto.satKey || null;
  if (next !== null && next !== product.satKey) {   // change-detection
    await this.satCatalog.assertExists(next);        // throws 400 SAT_KEY_NOT_FOUND
  }
  product.satKey = next;
}
```
No lookup runs when `satKey` is unchanged or when other fields change (legacy keys never block). **Create path** — before `Product.create(...)` at `:281`: `if (dto.satKey) await this.satCatalog.assertExists(dto.satKey);` (no prior value ⇒ always validate a non-empty key). `assertExists` throws `BadRequestException({ error: 'SAT_KEY_NOT_FOUND', message })`.

## HTTP Layer (Slice C)

| Route | Guards | Decorator |
|-------|--------|-----------|
| `GET /sat-keys?search=&limit=&offset=` | `JwtAuthGuard, TenantContextGuard, PermissionsGuard` | `@RequirePermissions(['read','SatKey'])` |
| `GET /sat-keys/:key` | same | `@RequirePermissions(['read','SatKey'])` |

- `SearchSatKeyDto`: `search?` `@IsOptional @IsString`; `limit?` `@Type(() => Number) @IsInt @Min(1) @Max(50)` default 20; `offset?` `@Type(() => Number) @IsInt @Min(0)` default 0. NOTE: the global `ValidationPipe` (`main.ts:22-27`) has `transform:true` but does NOT set `enableImplicitConversion`, so query-string coercion requires EXPLICIT `@Type(() => Number)` (the repo's established pattern — see `search-pos-catalog.dto.ts:19`, `list-sales-query.dto.ts:83`). Empty/missing `search` ⇒ `{ items: [], ... }`.
- Response `{ items: SatKeyDto[]; limit; offset; total }`; `SatKeyDto` = `{ key, description, includeIva, includeIeps, validFrom, validTo }`.
- `GET /:key`: `findByKey` → `NotFoundException` (404) when null; returns retired rows.
- CASL (TWO edits required in `permission.ts`, not one):
  1. Add `'SatKey'` to the `AppSubjects` string-literal union (`permission.ts:19-41`) — it is a CLOSED union; without this, `{ subject: 'SatKey' }` and `@RequirePermissions(['read','SatKey'])` are TypeScript compile errors and `pnpm build` fails.
  2. Add `{ subject: 'SatKey', action: 'read', description: 'View SAT catalog keys' }` to `PERMISSION_REGISTRY` (after the Sale block ~`:154`).
- Seeding/grants (`prisma/seed.ts`): the registry upsert (`~:1196`) seeds the permission and superAdmin gets all (`~:1282`), BUT the **Manager** role uses an EXPLICIT allowlist (`~:1298-1349`). The product editor is realistically a Manager, so `SatKey/read` MUST be ADDED to the Manager grant list (and any other editor role) or the Manager gets 403 on `GET /sat-keys`. Missing permission ⇒ 403.
- `SatCatalogModule` provides service + binds `SAT_KEY_REPOSITORY`→adapter, imports base `PrismaModule`, **exports `SatCatalogService`**; `ProductsModule` imports it.

## Testing Strategy (Strict TDD, Jest, `pnpm run test`)

| Layer | Spec | Proves |
|-------|------|--------|
| Entity | `sat-key.entity.spec.ts` | `create` builds `searchText` (accent-stripped, lowercased); **`ñ` PRESERVED** (`niño`→`niño`, NOT `nino`); `isActive` on `validTo` NULL/past/future |
| Repository | `prisma-sat-key.repository.spec.ts` | `search` accent-insensitive (`medicacion`↔`Medicación`), **`piña`↔`pina` do NOT collide (ñ preserved)**, ACTIVE-only, `LIMIT` cap; `findByKey` returns retired; `exists` true/false |
| Service | `sat-catalog.service.spec.ts` | `search` shape `{items,limit,offset,total}`; `assertExists` throws `SAT_KEY_NOT_FOUND` on miss, passes on hit |
| Controller | `sat-catalog.controller.spec.ts` | `read:SatKey` guard (200 vs 403), **Manager role gets 200 (not just superAdmin)** — proves the Manager grant (W1), limit≤50 coerced via `@Type` (W2), `/:key` 200 active/retired + 404 missing |
| Products integration | `products.service` specs | create unknown→400, absent→ok; update unchanged legacy key→no lookup/no 400, change→unknown 400 / valid 200 |
| Public catalog | existing `public-catalog.snapshots.spec.ts:54` | `not.toHaveProperty('satKey')` still passes (untouched) |

## Slice Boundaries (confirmed with accent-insensitive addition)

A/B/C/D from the proposal **hold**. The normalized `searchText` column is owned by **Slice A** (schema column + `@@index`, and the ingest-time `normalize()` in `seed-sat.ts`); the query-time `normalize()` + `ILIKE` lives in **Slice B** (repository `search`). No new slice needed; only Slice A/B scope notes gain the `searchText` responsibility. Total remains ≈ 400 lines.

## Migration / Rollout

Additive migration (table + enum + indexes), runs before code deploy. Seed step is additive + `skipDuplicates`-safe. No change to `Product.satKey` (stays `String?`). Rollback = revert branch + drop table; stored product `satKey` values (in-catalog or legacy) survive.

## Open Questions

- [ ] Confirm actual SAT data file edition/columns/encoding committed under `prisma/data/` before Slice A ingest (user-supplied during apply).
- [ ] Confirm `searchText` combines `key + description` (assumed) vs description-only — affects whether numeric-prefix search also flows through `searchText` or a separate `key` `startsWith`.
