# Tasks: SAT Catalog Search & Validation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~400 (A:80, B:150, C:80, D:90) |
| 400-line budget risk | **Low** (at budget; single branch) |
| Chained PRs recommended | **No** |
| Suggested split | Sequential work-unit commits A→B→C→D on one branch |
| Delivery strategy | single-pr (solo dev, work-unit commits, merge to main at end) |
| Chain strategy | N/A (single branch, work-unit commits) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: sequential work units on same branch
400-line budget risk: Low

**Note**: total sits AT the 400-line ceiling. Do not expand scope (no extra tests beyond spec coverage; keep DTOs/mappers terse; do not add dedicated unit specs for trivial type aliases).

### Delivery Context

Solo dev on a dedicated branch. One commit per slice (A→B→C→D, in order — Slice A blocks B; B blocks C; C blocks D). Each commit is shippable, test-covered, and reversible. Review budget monitored via `git diff --stat` per commit.

### Slices hold from proposal + design

| Slice | Scope | Δ est. |
|-------|-------|--------|
| A | Prisma model + migration + `seed-sat.ts` ingest helper called from `seed.ts` | ~80 |
| B | `src/sat-catalog/` domain + port + Prisma adapter + service | ~150 |
| C | Controller + DTOs + CASL (`SatKey` subject + registry + Manager grant) + module wiring | ~80 |
| D | `ProductsModule` integration: `assertExists` in `create`/`update` with change-detection | ~90 |

### External file note (Slice A)

`prisma/data/sat-clave-prod-serv.{csv|json}` is **user-supplied during apply**. To keep the slice testable WITHOUT the full 52k file, ingest code + unit tests run against a small fixture (`prisma/data/sat-clave-prod-serv.fixture.csv`, ~10 representative rows including: one retired row, one description with `ñ`, one `Incluir IVA trasladado = Opcional`). Treat the live file as data, not fixture.

---

## Slice A: Schema + Seed Ingest

### Phase A.1: Prisma Model + Migration

- [x] A.1.1 Add `enum SatInclusion { REQUIRED NONE OPTIONAL }` to `prisma/schema.prisma`
- [x] A.1.2 Add model `SatProductServiceKey { key String @id; description String; searchText String; includeIva SatInclusion @default(NONE); includeIeps SatInclusion @default(NONE); validFrom DateTime?; validTo DateTime?; @@index([searchText]) }` to `prisma/schema.prisma`
- [x] A.1.3 Generate migration: `pnpm prisma migrate dev --name add_sat_product_service_key` (hand-written because of pre-existing unrelated drift on `employee_emergency_contacts.updatedAt`; applied via `prisma migrate deploy`)
- [x] A.1.4 Confirm rollback = drop table + enum (no destructive change to `Product.satKey`)

### Phase A.2: Ingest Helper (TDD)

- [x] A.2.1 Commit fixture `prisma/data/sat-clave-prod-serv.fixture.csv` with 10 rows: 8-digit keys, mixed IVA values, one retired (`validTo` past), one `ñ` description, one empty `validTo`
- [x] A.2.2 RED: `prisma/seed-sat.spec.ts` — parses by header name (missing headers → null), enum map `{Sí→REQUIRED, No→NONE, Opcional→OPTIONAL}` (case/trim-insensitive), date ISO parse, empty `validTo→null`
- [x] A.2.3 GREEN: `prisma/seed-sat.ts` — exports `ingestSatCatalog(prisma)` that reads fixture when full file absent, builds `searchText = normalize(key + ' ' + description)`, batched `createMany({ skipDuplicates: true })` (~1k/batch)
- [x] A.2.4 RED: spec asserts `normalize()` keeps `ñ`: `niño → niño` (NOT `nino`); `piña` and `pina` do NOT collapse (ñ preserved); `MEDICACIÓN → medicacion` (other diacritics stripped + lowered) — **ñ-preservation anchor (W1)**
- [x] A.2.5 RED: idempotency spec — run ingest twice, assert `COUNT(*)` stable, no NULL/empty `key`
- [x] A.2.6 Wire `ingestSatCatalog(tx)` call from `prisma/seed.ts` after the existing role/user block

**Work-unit commit A**: `feat(sat-catalog): add SatProductServiceKey model, migration, and idempotent seed ingest`

**Verify green before B**: `pnpm run test prisma/seed-sat.spec.ts` PASS; `pnpm prisma migrate status` clean; `pnpm prisma db seed` idempotent (re-run stable row count).

---

## Slice B: Domain + Repository + Service

### Phase B.1: Pure Domain (TDD)

- [x] B.1.1 RED: `sat-key.entity.spec.ts` — `SatKey.create({...})` builds `searchText` via `normalize()`: `description="Medicación"` → `searchText` starts with the 8-digit key + lowercased+accent-stripped description
- [x] B.1.2 RED (same spec): `ñ` preserved end-to-end: `SatKey.create({ key:'01010101', description:'Diseño niño piña' })` → `searchText` contains `niño` and `piña` (NOT `nino`/`pina`); `piña` and `pina` are distinct substrings — **ñ-preservation anchor (W1)**
- [x] B.1.3 GREEN: `src/sat-catalog/domain/sat-key.entity.ts` — `static create()` runs `normalize(key + ' ' + description)`; `static fromPersistence(data)` skips normalize; `isActive(now)` helper
- [x] B.1.4 RED: `isActive()` — `validTo === null` → true; `validTo < now` → false; `validTo > now` → true
- [x] B.1.5 GREEN: implement `isActive`

### Phase B.2: Repository Port + Adapter (TDD)

- [x] B.2.1 Define `SAT_KEY_REPOSITORY` token + `ISatKeyRepository` interface in `src/sat-catalog/domain/sat-key.repository.ts`
- [x] B.2.2 RED: `prisma-sat-key.repository.spec.ts` — `search(q, {limit, offset})` calls `normalize(q)` before ILIKE; match = `(key.startsWith(n) OR searchText.contains(n)) AND active`; returns `{items, total}`; honors limit cap
- [x] B.2.3 RED (same spec): accent-insensitive match — store row with `description="Medicación"`, query `medicacion` AND `MEDICACIÓN` both return it; `piña` query does NOT return a row whose description is `pina` and vice versa — **ñ-preservation anchor (W1)**
- [x] B.2.4 RED: retired row excluded from `search`, included in `findByKey`
- [x] B.2.5 GREEN: `src/sat-catalog/infrastructure/prisma-sat-key.repository.ts` — uses base `PrismaService.satProductServiceKey` (non-tenant); `orderBy: [{ key: 'asc' }]`

### Phase B.3: Service (TDD)

- [x] B.3.1 RED: `sat-catalog.service.spec.ts` — `search(q, opts)` returns `{items, limit, offset, total}` shape; empty/missing `q` returns `{items:[], ...}` (no DB throw)
- [x] B.3.2 RED: `assertExists(key)` throws `BadRequestException({error:'SAT_KEY_NOT_FOUND', message})` on miss; passes on hit; hit on retired row still passes (retired products resolve)
- [x] B.3.3 GREEN: `src/sat-catalog/sat-catalog.service.ts` with constructor `(repo: ISatKeyRepository)`

**Work-unit commit B**: `feat(sat-catalog): add domain entity, repository port/adapter, and catalog service`

**Verify green before C**: `pnpm run test src/sat-catalog/` PASS (entity, repo, service specs). Repo's `normalize()` is the same fn as the entity (extract to `src/sat-catalog/domain/normalize.ts` if duplicate).

---

## Slice C: HTTP + CASL + Module Wiring

### Phase C.1: DTOs (TDD)

- [ ] C.1.1 RED: `search-sat-key.dto.spec.ts` — `?limit=200` is REJECTED (or capped to 50 via `class-transformer` coerce-then-validate); without explicit `@Type(()=>Number)` query string arrives as string and `@IsInt` fails — **@Type-anchor (W2)**
- [ ] C.1.2 RED: `?offset=-1` rejected by `@Min(0)`; missing `limit` defaults to 20
- [ ] C.1.3 GREEN: `src/sat-catalog/dto/search-sat-key.dto.ts` — `search? @IsOptional @IsString`; `limit? @Type(()=>Number) @IsInt @Min(1) @Max(50)` default 20; `offset? @Type(()=>Number) @IsInt @Min(0)` default 0
- [ ] C.1.4 `src/sat-catalog/dto/sat-key.dto.ts` — `{ key, description, includeIva, includeIeps, validFrom, validTo }`

### Phase C.2: CASL Wiring (typecheck anchor)

- [ ] C.2.1 Edit `src/auth/authorization/domain/permission.ts:19-41` — add `'SatKey'` to `AppSubjects` union (BEFORE registry entry — else `pnpm build` fails with closed-union error) — **AppSubjects anchor (W3)**
- [ ] C.2.2 Add `{ subject: 'SatKey', action: 'read', description: 'View SAT catalog keys' }` to `PERMISSION_REGISTRY` (after the Sale block ~`:154`)
- [ ] C.2.3 RED: `pnpm build` / `pnpm tsc --noEmit` MUST pass — add a `typecheck` task that runs in CI for this slice — **typecheck anchor (W3)**

### Phase C.3: Controller (TDD)

- [ ] C.3.1 RED: `sat-catalog.controller.spec.ts` — `GET /sat-keys` returns 403 without `read:SatKey`, 200 with it; `/:key` 404 on miss, 200 active AND retired
- [ ] C.3.2 RED: Manager-role caller (not just superAdmin) gets 200 on `GET /sat-keys?search=aspirina` — **Manager-grant anchor (W4)**
- [ ] C.3.3 RED: `?limit=200` request → 400 (validation rejects beyond cap)
- [ ] C.3.4 GREEN: `src/sat-catalog/sat-catalog.controller.ts` — `@Controller('sat-keys')`, `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)`, `@RequirePermissions(['read','SatKey'])`; DTO mapped to service `search`; `/:key` via `findByKey`; response shape `{items, limit, offset, total}`
- [ ] C.3.5 Module wiring: `src/sat-catalog/sat-catalog.module.ts` imports base `PrismaModule`; providers bind `SAT_KEY_REPOSITORY`→`PrismaSatKeyRepository`; **exports `SatCatalogService`**

### Phase C.4: Manager Grant in Seed

- [ ] C.4.1 Edit `prisma/seed.ts:1298-1350` — append `permissionKey('SatKey', 'read')` to the Manager `managerPermissionKeys` allowlist — **Manager-grant anchor (W4)**
- [ ] C.4.2 Re-run seed; assert `managerPermissionKeys.find(k => k.subject === 'SatKey' && k.action === 'read')` is present (smoke test in `prisma/seed-sat.spec.ts` or a new `prisma/seed.spec.ts` extension)

**Work-unit commit C**: `feat(sat-catalog): add HTTP endpoints, CASL SatKey/read, and Manager grant`

**Verify green before D**: `pnpm run test src/sat-catalog/` AND `pnpm build` PASS; full `pnpm run test` green; controller spec proves Manager gets 200.

---

## Slice D: Products Integration

### Phase D.1: Wire into ProductsModule

- [ ] D.1.1 Edit `src/products/products.module.ts` — import `SatCatalogModule`; `ProductsModule` already exports `ProductsService`, no new exports needed
- [ ] D.1.2 Inject `SatCatalogService` into `ProductsService` (constructor)

### Phase D.2: Create Path (TDD)

- [ ] D.2.1 RED: extend `products.service.spec.ts` — `create()` with `satKey` present in catalog → resolves; with unknown `satKey` → throws `BadRequestException` with `error:'SAT_KEY_NOT_FOUND'`; with `satKey` omitted → succeeds with `null`
- [ ] D.2.2 GREEN: insert `if (dto.satKey) await this.satCatalog.assertExists(dto.satKey);` immediately before `Product.create({...})` at `src/products/products.service.ts:281`

### Phase D.3: Update Path with Change-Detection (TDD)

- [ ] D.3.1 RED: extend `products.service.spec.ts` — update with `satKey === product.satKey` (unchanged) → NO catalog lookup (verify with `satCatalog.assertExists` spy never called), 200 even if stored key is legacy/unknown
- [ ] D.3.2 RED: update of non-`satKey` fields only → NO catalog lookup (spy never called), 200; `satKey` preserved
- [ ] D.3.3 RED: update with `satKey` changed to unknown → 400 `SAT_KEY_NOT_FOUND`; changed to valid known key → 200
- [ ] D.3.4 GREEN: insert change-detection block before line 599 in `src/products/products.service.ts`:

      if (dto.satKey !== undefined) {
        const next = dto.satKey || null;
        if (next !== null && next !== product.satKey) {
          await this.satCatalog.assertExists(next);
        }
        product.satKey = next;
      }

      (replaces the current `if (dto.satKey !== undefined) product.satKey = dto.satKey || null;`)

### Phase D.4: Preserve Public Catalog Contract

- [ ] D.4.1 Re-run `src/public-catalog/http/public-catalog.snapshots.spec.ts` — confirm line 54 `not.toHaveProperty('satKey')` still passes (**public-catalog anchor (W5)**); no edit to public-catalog serializer

**Work-unit commit D**: `feat(products): validate satKey against SAT catalog on create/update, change-only`

**Verify green before merge**: `pnpm run test` fully green; `pnpm build` passes; controller spec proves Manager→200, superAdmin→200, no permission→403, `limit=200`→400, `/:key` 200 active/retired + 404 missing; products spec covers all four Spec scenarios; public-catalog snapshot still green.

---

## Verification Alignment

| Spec Scenario (from `specs/sat-catalog/spec.md`) | Task Coverage |
|--------------------------------------------------|---------------|
| Substring/prefix/case-insensitive matching | B.2.2, B.2.3, C.3.1 |
| Retired excluded + `limit` capped at 50 | B.2.4, C.1.1, C.3.3 |
| Active/retired/missing single-key lookup | B.2.4, C.3.1 |
| Known/Unknown/Absent on create | D.2.1 |
| Unchanged `satKey` + non-`satKey` edits never block | D.3.1, D.3.2 |
| Change to unknown → 400; valid → 200 | D.3.3 |
| RBAC: `read:SatKey` 200 vs 403 | C.3.1, C.3.2 |
| Public payload omits `satKey` | D.4.1 |
| Seed re-run stable count, no dupes | A.2.5, A.2.6 |
| Enum mapping (Sí/No/Opcional) + open-ended `validTo` | A.2.2 |
| Accent-insensitive matching | A.2.4, B.1.1, B.2.3 |

## Anchor Checklist (mapped to design-gate corrections)

| # | Anchor | Tasks |
|---|--------|-------|
| W1 | ñ-preservation | A.2.4, B.1.2, B.2.3 |
| W2 | `@Type(()=>Number)` rejects `?limit=200` | C.1.1, C.3.3 |
| W3 | `AppSubjects` union before registry + typecheck | C.2.1, C.2.2, C.2.3 |
| W4 | Manager grant | C.3.2, C.4.1 |
| W5 | Public-catalog snapshot preserved | D.4.1 |
| W6 | External file is user-supplied; fixture keeps slice testable | A.2.1 + header note |

## Dependencies

- Slice A blocks B (entity reads `searchText` column populated by seed).
- Slice B blocks C (controller calls service which calls repo).
- Slice C blocks D (`SatCatalogService` must export & wire before ProductsService can inject).
- Manager grant in seed.ts must ship with Slice C — re-running seed post-merge grants it.
- Migration (A.1.3) MUST run locally before B's repo spec.

## Rollback Safety

- A: drop table + enum (no `Product.satKey` change).
- B: revert module under `src/sat-catalog/`; no DB impact.
- C: revert controller + permission entry; seed grant no-ops after cleanup.
- D: revert two call sites in `products.service.ts` (lines 281, 599); stored `satKey` values (in-catalog or legacy) survive.
