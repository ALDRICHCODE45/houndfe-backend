# Proposal: SAT Catalog Search & Validation

## Intent

The product form's `SAT Key` field is currently a free-text input. There is no catalog, no FK, and no validation — any string is accepted (`prisma/schema.prisma:327`, `create-product.dto.ts:170`). This lets invalid fiscal keys land on `Product.satKey`, breaking the future CFDI invoicing story and forcing the editor to type 8-digit numbers from memory.

The change introduces a server-backed searchable typeahead over the Mexican SAT `c_ClaveProdServ` catalog (~52,000 entries) and enforces strict validation on product create/update. The catalog is a national reference list, not a tenant-scoped dataset, so it lives in a new bounded context that the `ProductsModule` consumes for validation.

## Scope

### In Scope
- New bounded context `src/sat-catalog/` (hexagonal: domain port + Prisma adapter + DTO + controller + service + module), mirroring `products`' shape
- New national, non-tenant `SatProductServiceKey` table + Prisma migration + plain b-tree index on `key`
- Idempotent seed step in `prisma/seed.ts` loading a committed `prisma/data/sat-clave-prod-serv.{csv|json}` (~52k rows, format supplied during apply)
- `GET /sat-keys?search=<text>&limit=20&offset=0` — ILIKE-based typeahead, active-only by default, JWT + new `SatKey`/`read` CASL permission
- Companion `GET /sat-keys/:key` — single lookup so the editor can resolve a saved (possibly retired) key's label on load
- Persisted columns: `key`, `description`, `includeIva`, `includeIeps`, `validFrom`, `validTo` (terrain ready for later CFDI work)
- Application-layer strict validation in `ProductsService.create/update` — `BadRequestException` (`SAT_KEY_NOT_FOUND`, HTTP 400) on unknown key, **only when `dto.satKey` actually changes**
- CASL: add `SatKey` subject with `read` action to `PERMISSION_REGISTRY`; admin endpoint guarded by `@RequirePermissions(['read','SatKey'])`
- Preserve the existing constraint `satKey` is excluded from the public catalog (`src/public-catalog/http/public-catalog.snapshots.spec.ts:54`)

### Out of Scope
- CFDI 4.0 invoice stamping, tax computation, or any Inngest integration (separate follow-up change)
- Admin upload/re-import endpoint (catalog refresh = replace the committed file + re-run the idempotent seed)
- Hard DB `FOREIGN KEY` from `Product.satKey` → `SatProductServiceKey.key` (kept as optional hardening; v1 uses application-layer check)
- `pg_trgm` / `unaccent` / FTS extensions for v1 (plain ILIKE is sufficient at 52k; documented upgrade path)
- Editing the public catalog serializer beyond preserving the existing snapshot
- Any change to how `satKey` flows outside `create`/`update` (read/serialize paths remain passthrough)

## Capabilities

### New Capabilities
- `sat-catalog`: searchable reference catalog for SAT `c_ClaveProdServ` (~52k) with a strict validation contract — search + single-key lookup endpoints and the rule that an unknown `satKey` on a product create/update must be rejected with HTTP 400 when the value is actually changing.

### Modified Capabilities
- None at the spec level. Products and authorization behavior changes are implementation wiring; no existing OpenSpec capability (`sales`, `sale-payments`, `sale-cancellation`, `receipt-review`, `chatbot-api-foundation`) changes its requirements.

## Approach

```
src/sat-catalog/
  domain/sat-key.entity.ts                # pure entity (static create / fromPersistence)
  domain/sat-key.repository.ts            # SAT_KEY_REPOSITORY token + port
  infrastructure/prisma-sat-key.repository.ts  # base (non-tenant) Prisma client
  dto/                                    # search-query.dto.ts, sat-key.dto.ts
  sat-catalog.controller.ts               # GET /sat-keys, GET /sat-keys/:key
  sat-catalog.service.ts                  # search(), findByKey(), assertExists()
  sat-catalog.module.ts                   # exports service; imports base PrismaModule
```

Search mirrors the proven `ProductsService.searchForPOS` idiom (`src/products/products.service.ts:1862`) — Prisma `{ contains: q, mode: 'insensitive' }` with `limit`/`offset`. Query:

```
WHERE (key ILIKE q% OR description ILIKE %q%)
  AND (validTo IS NULL OR validTo > now())
ORDER BY length(key), key
LIMIT 20 OFFSET 0
```

Validation lives in the application layer (keeps the `Product` aggregate pure), inside `ProductsService.create/update`:

```
if (dto.satKey !== undefined && dto.satKey !== null && dto.satKey !== '') {
  const effective = dto.satKey ?? null;
  const isChange  = !updateCtx || updateCtx.currentSatKey !== effective;
  if (isChange && effective !== null) {
    await satCatalog.assertExists(effective);   // throws 400 SAT_KEY_NOT_FOUND
  }
}
```

The single-key lookup uses the SAME repo method but **bypasses the active-only filter** so a product saved with a now-retired key can still display its label.

## Locked Requirements

| # | Decision | Rule |
|---|----------|------|
| 1 | Catalog scope | FULL `c_ClaveProdServ` (~52k), not a legacy subset |
| 2 | Validation strictness | Product create/edit carrying a `satKey` not in the catalog → HTTP 400 (`SAT_KEY_NOT_FOUND`) |
| 3 | UX pattern | Server-side typeahead `GET /sat-keys?search=…`, never a 52k client-side select |
| 4 | Retired keys | Seed INCLUDES retired rows (so historical keys resolve); search filters to ACTIVE by default; single-key lookup returns retired rows too |
| 5 | Persisted columns | `key`, `description`, `includeIva`, `includeIeps`, `validFrom`, `validTo` |
| 6 | Legacy products | Strict 400 fires ONLY when the request changes `satKey`; editing other fields of a product whose stored key is not in the catalog is NOT blocked |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | `SatProductServiceKey` model (national, no tenant FK), b-tree index on `key` |
| `prisma/migrations/<ts>_sat_catalog/` | New | Migration for the table + index |
| `prisma/data/sat-clave-prod-serv.{csv\|json}` | New | Committed SAT file (user-supplied during apply) |
| `prisma/seed.ts` | Modified | Idempotent SAT seed step, batched `createMany({ skipDuplicates: true })` |
| `src/sat-catalog/` | New | Full bounded context (domain + adapter + DTO + controller + service + module) |
| `src/products/products.module.ts` | Modified | Import `SatCatalogModule` |
| `src/products/products.service.ts` | Modified | Call `satCatalog.assertExists()` in `create` (~:281) and `update` (~:599); change-detection only |
| `src/auth/authorization/domain/permission.ts` | Modified | Add `SatKey` subject with `read` action |
| `src/public-catalog/http/public-catalog.snapshots.spec.ts` | Untouched | Snapshot test at :54 must continue to pass |
| Tests | New | `sat-catalog.controller.spec.ts`, `sat-catalog.service.spec.ts`, products validation specs (success + 400 + change-only) |

## Chained Delivery Slices

| Slice | Scope | Budget Est. |
|-------|-------|-------------|
| A | Prisma model + migration + seed step + committed data file (table only, no API yet) | ~80 lines |
| B | `src/sat-catalog/` module: domain entity, repo port, Prisma adapter, service (`search`, `findByKey`, `assertExists`) | ~150 lines |
| C | HTTP surface: controller + DTOs + CASL `SatKey`/`read` permission + JWT/CASL guards | ~80 lines |
| D | Products integration: import `SatCatalogModule`, wire `assertExists` into `create`/`update` with change-detection, update specs | ~90 lines |

Total ≈ 400 lines, fits the review budget for a single branch → merge to main.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| External SAT file not yet in repo (edition, columns, encoding) | Med | Data file is a user-supplied input during apply; ingestion script reads CSV/JSON by header, not positional. Document the expected schema in `prisma/data/README.md` |
| Plain ILIKE `%q%` on `description` is a seq scan at 52k | Low | `LIMIT 20` + b-tree on `key` keeps it fast for v1. Documented upgrade path: `pg_trgm` + `unaccent` GIN index in an isolated follow-up migration |
| Accent-insensitive search not provided in v1 | Low | Acceptable for v1; the ingestion script may store a lowercased, accent-stripped `searchHaystack` column if FE requests it during spec |
| Legacy products with a stored `satKey` not in the catalog | Med | Locked decision #6: validate ONLY on change. Editing other fields never blocks. Snapshot test guards this path |
| Public catalog accidentally leaks `satKey` | Low | `public-catalog.snapshots.spec.ts:54` snapshot test stays as-is; the new module exposes no public-catalog serializer. Run the snapshot in CI |
| Catalog freshness tied to deploy cadence | Low | National catalog changes a few times a year; committed file + idempotent seed is the simplest reproducible choice. Admin importer deferred to a later change |
| 400 error UX must be actionable for the operator | Low | DTO error payload includes `error: 'SAT_KEY_NOT_FOUND'` + `message` hinting to use the typeahead |

## Rollback Plan

- **Schema**: down-migration drops `SatProductServiceKey`. No data loss to other modules.
- **Code**: revert the feature branch. The `ProductsService` changes are confined to two call sites; reverting restores the free-text passthrough with no migration of stored data needed.
- **Seed**: the seed step is additive and `skipDuplicates`-safe. Re-running without it is a no-op.
- **No destructive changes** to `Product.satKey`: the column stays `String?`. Products already saved with any value (in-catalog or legacy) keep their data through rollback.

## Dependencies

- **External input (user-supplied during apply):** the SAT `c_ClaveProdServ` data file, converted offline from SAT's `catCFDI` workbook (sheet `c_ClaveProdServ`) into a CSV or JSON committed under `prisma/data/`. Expected columns: `c_ClaveProdServ`, `Descripción`, `Incluir IVA trasladado`, `Incluir IEPS trasladado`, `Fecha de inicio de vigencia`, `Fecha de fin de vigencia`. Headers, not positional.
- **Internal ordering:** Prisma migration (slice A) → module skeleton (slice B) → HTTP + CASL (slice C) → Products integration (slice D). Slice A blocks B; B blocks C; C blocks D.
- **No DB extensions** required for v1. `pg_trgm` / `unaccent` are NOT enabled by this change.

## Success Criteria

- [ ] `GET /sat-keys?search=aspirina&limit=20` returns ≤20 active rows, ILIKE-matched on key prefix or description substring, JSON shape `{ items: [...], limit, offset, total }`
- [ ] `GET /sat-keys/01010101` returns the catalog row for that key regardless of `validTo` (so saved retired keys can be displayed)
- [ ] `POST /products` with a `satKey` not in the catalog → HTTP 400 with `error: 'SAT_KEY_NOT_FOUND'`
- [ ] `PATCH /products/:id` with `satKey` unchanged from current value → no catalog lookup, no 400 even if the stored key is not in the catalog (legacy product)
- [ ] `PATCH /products/:id` with `satKey` changed to an unknown value → HTTP 400
- [ ] Empty/absent `satKey` on create/update → allowed (field stays optional)
- [ ] `SatKey`/`read` CASL permission is seeded via `PERMISSION_REGISTRY`; endpoint returns 403 without it
- [ ] Re-running `prisma/seed.ts` is idempotent: row count for `SatProductServiceKey` is stable, no duplicates
- [ ] `public-catalog.snapshots.spec.ts:54` still passes (`result.not.toHaveProperty('satKey')`)
- [ ] `pnpm test` is green; `pnpm build` succeeds; review budget ≤ 400 changed lines on the branch