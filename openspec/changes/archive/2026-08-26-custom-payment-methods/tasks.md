# Tasks — Custom Payment Methods (POS catalog)

Change: `custom-payment-methods`
Spec sources: `proposal.md`, `specs/payment-methods/spec.md`, `specs/sales/spec.md`, `specs/sale-payments/spec.md`
Design source: `design.md` (Work Unit Plan at the bottom governs scope; WU1 → WU2, no chaining per session preflight)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,800–2,400 (schema/migration ~50, RBAC/tenant/filter plumbing ~30, new `src/admin/payment-methods/` module ~750, sales threading ~350, DTO/dto/timeline/PDF ~80, co-located unit specs ~800–1,200) |
| 400-line budget risk | High |
| 600-line budget risk (session preflight budget) | High — forecast exceeds 600; size:exception likely required |
| Chained PRs recommended | No (parent preflight chose single-pr; size:exception is the alternative path) |
| Suggested split | Single PR — design's WU1/WU2 split is for revert clarity only; both merge together |
| Delivery strategy | single-pr |
| Chain strategy | single-pr |
| Size exception | **ACCEPTED** — user-approved size:exception on 2026-08-26; proceed as ONE PR (preflight single-pr preserved) |

```text
Decision needed before apply: No (size:exception accepted by user)
Chained PRs recommended: No
Chain strategy: single-pr
400-line budget risk: High
```

> **Gatekeeper decision (2026-08-26):** user approved `size:exception`. The change stays a single PR per the preflight `single-pr` strategy; the WU1/WU2 split is for in-PR commit granularity/revert clarity only, not chained PRs.

**Rationale.** The change spans ~30 files, adds an 11-file admin module, threads a resolver port through `SalesService`, and ships non-trivial idempotency + read-model + PDF specs. The forecast clearly exceeds the preflight's 600-line budget, so the parent gatekeeper should expect a size:exception request before apply; the design's revert boundary (WU1 = schema + admin + plumbing; WU2 = sales threading + read model + PDF) is preserved for in-PR commit splitting but not for chained PRs.

---

## Work Unit 1 — Schema, admin catalog, RBAC, tenant plumbing, error mapping

> Revert boundary: reverse the additive migration; drop the `AdminPaymentMethodModule` import from `AdminModule`; remove the `'PaymentMethod'` allowlist + permission entries.

### 1.1 — Prisma schema + additive migration

- [x] Add `enum PaymentMethodCategory { CASH CARD_CREDIT CARD_DEBIT TRANSFER }` (4 values, no `CREDIT`) and `model PaymentMethod` (id, tenantId, name, category, subtitle?, isActive @default(true), metadataJson Json?, createdAt, updatedAt; `@@unique([tenantId, name])`, `@@index([tenantId])`, `@@map("payment_methods")`, tenant FK `onDelete: Cascade`) to `prisma/schema.prisma`. Add the `paymentMethods PaymentMethod[]` back-reference on `Tenant`. Leave `SalePaymentMethod` untouched. <!-- sdd-owner: implementation -->
- [x] Generate the additive migration `prisma/migrations/<ts>_add_payment_methods/migration.sql` (CREATE TYPE + CREATE TABLE + indices + unique + FK cascade). Confirm `prisma migrate dev --name add_payment_methods` produces only the `payment_methods` table. <!-- sdd-owner: implementation -->
- [x] Verify the generated migration is reversible (`prisma migrate diff` reverse plan = `DROP TABLE payment_methods; DROP TYPE "PaymentMethodCategory";`) and document the reverse path in the migration folder README. <!-- sdd-owner: implementation -->

### 1.2 — Tenant allowlist + RBAC plumbing

- [x] Add `'PaymentMethod'` to `src/shared/tenant/tenant-scoped-models.constant.ts` (immediately after `'PaymentDetail'`). Silent allowlist — omission re-enables cross-tenant access. <!-- sdd-owner: implementation -->
- [x] In `src/auth/authorization/domain/permission.ts`: add `'PaymentMethod'` to `AppSubjects` and add 4 entries to `PERMISSION_REGISTRY` (`read:PaymentMethod` "View payment methods", `create:PaymentMethod`, `update:PaymentMethod`, `delete:PaymentMethod` "Delete (logical) payment methods"). `PermissionSeeder` auto-upserts these on `OnApplicationBootstrap`. <!-- sdd-owner: implementation -->

### 1.3 — Domain layer for `PaymentMethod` (admin)

- [x] Create `src/admin/payment-methods/domain/payment-method.entity.ts` with `PaymentMethodProps`, `CreatePaymentMethodInput`, `UpdatePaymentMethodInput`, and the `PaymentMethod` aggregate exposing `static create(input)` (validates name, category, subtitle; defaults `isActive=true`, `metadataJson=null`), `static fromPersistence(props)` (skips validation), `update(input)` (partial, incl. `isActive` for reactivation, bumps `updatedAt`), `deactivate()` (idempotent), `toResponse()`, `toPersistence()`, plus `sanitizeName` (1..60, trim, non-empty), `sanitizeSubtitle` (null OK, ≤120), and the 4-value category guard that rejects `credit`/`CRYPTO`. <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/domain/payment-method.repository.ts` with `PAYMENT_METHOD_REPOSITORY` symbol and `IPaymentMethodRepository` (`create`, `update`, `findById(id, tenantId)`, `findAll(tenantId)` active+inactive ordered `updatedAt DESC`, `findAllActive(tenantId)` active only). <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/domain/payment-method.resolver.ts` with `PAYMENT_METHOD_RESOLVER` symbol, `PaymentMethodCategory` type alias (`'cash' | 'card_credit' | 'card_debit' | 'transfer'`), `ResolvedPaymentMethod` (`{ category, name, subtitle }`), `ActivePaymentMethodProjection` (`{ id, name, category, subtitle }`), and `IPaymentMethodResolver` interface (`resolveActive({ paymentMethodId, tenantId, expectedCategory })` + `listActive(tenantId)`). <!-- sdd-owner: implementation -->

### 1.4 — Infrastructure layer for `PaymentMethod` (admin)

- [x] Create `src/admin/payment-methods/infrastructure/prisma-payment-method.repository.ts`: tenant-scoped via `TenantPrismaService`, explicit `where: { id, tenantId }` defense in depth on `findById` and on `update`/`deactivate`; map Prisma `P2002` on `name` → throw `BusinessRuleViolationError('DUPLICATE_NAME')`; map Prisma `P2025` → throw `EntityNotFoundError('PaymentMethod', id)`; coerce enum case so persisted category matches the 4-value contract. <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/payment-method-catalog.resolver.ts`: thin `@Injectable()` implementing `IPaymentMethodResolver` over `IPaymentMethodRepository`; throw `BusinessRuleViolationError('PAYMENT_METHOD_NOT_FOUND')` on null/cross-tenant, `BusinessRuleViolationError('INACTIVE_PAYMENT_METHOD')` when `isActive === false`, and `BusinessRuleViolationError('PAYMENT_METHOD_CATEGORY_MISMATCH')` on case-insensitive category mismatch (case-insensitive compare against `expectedCategory.toLowerCase()`). <!-- sdd-owner: implementation -->

### 1.5 — DTOs, service, controller, module for admin CRUD

- [x] Create `src/admin/payment-methods/dto/create-payment-method.dto.ts` with `name` (`@IsString`, `@IsNotEmpty`, `@MaxLength(60)`, `\S` match → `NAME_TOO_LONG`/`INVALID_NAME`), `category` (`@IsIn(['cash', 'card_credit', 'card_debit', 'transfer'])` → `INVALID_CATEGORY`), `subtitle?` (`@IsString`, `@MaxLength(120)` → `SUBTITLE_TOO_LONG`). <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/dto/update-payment-method.dto.ts` as partial of create DTO + optional `@IsBoolean() isActive?: boolean`. <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/dto/payment-method-response.dto.ts` exposing `{ id, tenantId, name, category, subtitle, isActive, createdAt, updatedAt }`. <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/admin-payment-method.service.ts`: CLS tenant resolution via `ClsService`/`TenantPrismaService`, `randomUUID` id generation, partial update, logical delete (sets `isActive=false`, returns 204), reactivation on PATCH `{ isActive: true }`. <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/admin-payment-method.controller.ts` (`@Controller('admin/payment-methods')`) with `JwtAuthGuard + TenantContextGuard + PermissionsGuard`, `@RequirePermissions([action, 'PaymentMethod'])` per route; routes: `POST` (201), `GET` list (`updatedAt DESC`, includes inactive), `GET :id` (404 on cross-tenant), `PATCH :id`, `DELETE :id` (204 logical). <!-- sdd-owner: implementation -->
- [x] Create `src/admin/payment-methods/admin-payment-method.module.ts` importing `AuthModule`, providing the controller + service + repository provider + resolver provider under `PAYMENT_METHOD_RESOLVER` and `PAYMENT_METHOD_REPOSITORY`; `exports: [PAYMENT_METHOD_RESOLVER]` (D3 seam for `SalesModule`). <!-- sdd-owner: implementation -->
- [x] Import `AdminPaymentMethodModule` into `src/admin/admin.module.ts`. <!-- sdd-owner: implementation -->

### 1.6 — Domain exception HTTP mapping

- [x] In `src/shared/filters/domain-exception.filter.ts`, extend `getHttpStatus` with: `PAYMENT_METHOD_NOT_FOUND` → 404, `INACTIVE_PAYMENT_METHOD` → 409, `PAYMENT_METHOD_CATEGORY_MISMATCH` → 400, `DUPLICATE_NAME` → 409. Admin cross-tenant continues to use `EntityNotFoundError` (code `ENTITY_NOT_FOUND` → 404). <!-- sdd-owner: implementation -->

### 1.7 — WU1 unit specs (co-located Jest)

- [x] Add `src/admin/payment-methods/domain/payment-method.entity.spec.ts` (table-driven): `sanitizeName` (empty/whitespace/61-char → error), `sanitizeSubtitle` (null ok, 121 → error), category guard (rejects `credit`/`CRYPTO`), `create` defaults, `update` partial incl. `isActive` reactivation, `deactivate` idempotent, `fromPersistence` round-trip + enum-case coercion. <!-- sdd-owner: implementation -->
- [x] Add `src/admin/payment-methods/infrastructure/prisma-payment-method.repository.spec.ts`: tenant scoping on every method, P2002 → `DUPLICATE_NAME` mapping, P2025 → `EntityNotFoundError` mapping; mock `TenantPrismaService`. <!-- sdd-owner: implementation -->
- [x] Add `src/admin/payment-methods/payment-method-catalog.resolver.spec.ts`: `resolveActive` not-found/inactive/mismatch/success; `listActive` active-only projection; mock `IPaymentMethodRepository`. <!-- sdd-owner: implementation -->
- [x] Add `src/admin/payment-methods/admin-payment-method.service.spec.ts` + `admin-payment-method.controller.spec.ts`: CRUD happy paths, cross-tenant 404, logical delete 204, reactivation PATCH, `@RequirePermissions` wiring asserted; mock repo + CLS store. <!-- sdd-owner: implementation -->
- [x] Extend `src/auth/authorization/infrastructure/permission.seeder.spec.ts` to assert four new `PaymentMethod` permissions are present after `PermissionSeeder.onApplicationBootstrap`. <!-- sdd-owner: implementation -->

---

## Work Unit 2 — Sales charge/collection threading, idempotency, read model, POS projection, PDF

> Revert boundary: schema already deployed in WU1. Revert code only — module wiring, DTO fields, sales-service threading, POS endpoint, PDF template change.

### 2.1 — `SalesModule` wiring

- [x] In `src/sales/sales.module.ts`, import `AdminPaymentMethodModule` to resolve the `PAYMENT_METHOD_RESOLVER` symbol; inject the resolver into `SalesService` constructor (mirrors the `PromotionsModule` Symbol-port precedent). <!-- sdd-owner: implementation -->

### 2.2 — DTO additions for `paymentMethodId`

- [x] In `src/sales/dto/charge-sale.dto.ts`, add optional `@IsOptional() @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' }) paymentMethodId?: string` to `ChargePaymentEntryDto` and re-export on `ChargeSaleDto` so the entry list validates. <!-- sdd-owner: implementation -->
- [x] In `src/sales/dto/add-sale-payment.dto.ts`, add the same optional `@IsUUID() paymentMethodId?` to `AddSalePaymentEntryDto` and expose it on `AddSalePaymentDto`. <!-- sdd-owner: implementation -->
- [x] In `src/sales/dto/sale-detail-response.dto.ts`, add optional `paymentMethodId?: string`, `paymentMethodName?: string`, `paymentMethodSubtitle?: string` to `SaleDetailPaymentDto`; extend the `PAYMENT_RECEIVED` event shape with `paymentMethodName?` / `paymentMethodSubtitle?`. <!-- sdd-owner: implementation -->

### 2.3 — Sale repository port + Prisma adapter

- [x] In `src/sales/domain/sale.repository.ts`, add `metadataJson?: unknown` to `PersistedChargePayment`; extend the `findOneWithRelations` payments array element type with `paymentMethodId: string | null; paymentMethodName: string | null; paymentMethodSubtitle: string | null`. <!-- sdd-owner: implementation -->
- [x] In `src/sales/infrastructure/prisma-sale.repository.ts`: (a) `persistChargeConfirmation` writes `metadataJson: payment.metadataJson === undefined ? Prisma.JsonNull : (payment.metadataJson as Prisma.InputJsonValue)` in `salePayment.create`, mirroring `persistCollectedPayments`; (b) add `extractCatalogSnapshot(metadataJson)` sibling to `extractLegacyReference` (returns `{ paymentMethodId, name, subtitle } | null`); (c) `findOneWithRelations` payments mapper surfaces `paymentMethodId/paymentMethodName/paymentMethodSubtitle` from `metadataJson.catalog` and leaves them `null` for legacy rows. Do NOT modify `extractLegacyReference`. <!-- sdd-owner: implementation -->

### 2.4 — Sales service threading

- [x] In `src/sales/sales.service.ts`: widen `ChargePaymentEntry` and `CollectionPaymentEntry` types with `paymentMethodId?: string`; make `normalizeChargeRequestPayments` and `normalizeCollectionRequestPayments` copy `paymentMethodId` in **both** the legacy `method` branch and the array branch. <!-- sdd-owner: implementation -->
- [x] In `src/sales/sales.service.ts`: widen `sortPaymentsForHash`'s input type to include `paymentMethodId?`; change the key function to append `|<uuid>` only when `paymentMethodId` is truthy so legacy payloads hash byte-identically (`JSON.stringify` drops `undefined`); change the `addPayment` hash map from `.map(({ method, amountCents, reference }) => ...)` to passing `normalizedPayments` directly so `paymentMethodId` survives into the hash. <!-- sdd-owner: implementation -->
- [x] In `src/sales/sales.service.ts`: convert `toCanonicalChargePayments` to async; for each non-credit entry with `paymentMethodId`, call `paymentMethodResolver.resolveActive({ paymentMethodId, tenantId, expectedCategory: entry.method })`; on success, attach `metadataJson: { catalog: { paymentMethodId, name, subtitle? } }` (omit `subtitle` when null). Reviewer/bot path remains untouched. <!-- sdd-owner: implementation -->
- [x] In `src/sales/sales.service.ts`: in `addPayment` (owner mode), before `persistCollectedPayments`, resolve each entry's `paymentMethodId` via `paymentMethodResolver.resolveActive` and attach the catalog snapshot to `metadataJson`. Reviewer mode keeps `metadataJson: { origin: ... }` and is unchanged. <!-- sdd-owner: implementation -->
- [x] In `src/sales/sales.service.ts`: add `listActivePaymentMethods()` that reads `tenantId` from `TenantPrismaService` and delegates to `paymentMethodResolver.listActive(tenantId)`. <!-- sdd-owner: implementation -->
- [x] In `src/sales/sales.service.ts` `getSaleDetail`: spread `paymentMethodId/paymentMethodName/paymentMethodSubtitle` onto each `SaleDetailPaymentDto` only when non-null; pass `paymentMethodName/paymentMethodSubtitle` through to the `PAYMENT_RECEIVED` timeline event input. <!-- sdd-owner: implementation -->

### 2.5 — POS projection controller

- [x] In `src/sales/sales-catalog.controller.ts`, add `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` is already present on the controller — add `@Get('payment-methods')` with `@RequirePermissions(['read', 'Sale'])` and delegate to `salesService.listActivePaymentMethods()`. <!-- sdd-owner: implementation -->

### 2.6 — Timeline event shape

- [x] In `src/sales/domain/build-sale-timeline.ts`, widen the `PAYMENT_RECEIVED` event input and event shape with `paymentMethodName?: string` and `paymentMethodSubtitle?: string`; keep the base-category label as the fallback when these fields are absent. <!-- sdd-owner: implementation -->

### 2.7 — Receipt PDF label

- [x] In `src/pdf-generation/pdf-generation.service.ts`, extend `buildReceiptProps` so each `Payment` passed to the template carries `paymentMethodName?` / `paymentMethodSubtitle?` from the persisted snapshot. <!-- sdd-owner: implementation -->
- [x] In `pdf-generation/templates/shared/payments-list.tsx`, extend the `Payment` interface with optional `paymentMethodName?` / `paymentMethodSubtitle?`; render `paymentMethodName ?? formatMethod(method)` and a gray `subtitle` sub-line when `paymentMethodSubtitle` is present; keep `formatMethod` as the fallback for legacy rows. <!-- sdd-owner: implementation -->

### 2.8 — WU2 unit specs (co-located Jest)

- [x] Extend `src/sales/sales.service.spec.ts` — charge threading: `normalizeChargeRequestPayments` copies `paymentMethodId` in both branches; `toCanonicalChargePayments` resolves + snapshots under `metadataJson.catalog`; mismatch → `PAYMENT_METHOD_CATEGORY_MISMATCH`, inactive → `INACTIVE_PAYMENT_METHOD`, foreign-tenant/unknown → `PAYMENT_METHOD_NOT_FOUND`; legacy entry has no `catalog` key. Mock the resolver + repo. <!-- sdd-owner: implementation -->
- [x] **REQUIRED idempotency spec (in `sales.service.spec.ts` or new `idempotency.spec.ts`)**: assert (a) identical `{ method, amountCents, paymentMethodId }` produces the same hash and replays; (b) same `{ method, amountCents }` with **different** `paymentMethodId` produces **distinct** hashes (the idempotency-collision test); (c) legacy `{ method, amountCents }` with no `paymentMethodId` produces a hash byte-identical to the pre-change implementation. Assert against `sha256` input / sort output. <!-- sdd-owner: implementation -->
- [x] Extend `src/sales/sales.service.spec.ts` — collection threading: owner mode resolves + snapshots; reviewer mode unaffected (origin only, no `catalog` key); add-payment hash includes `paymentMethodId`. <!-- sdd-owner: implementation -->
- [x] Extend `src/sales/infrastructure/prisma-sale.repository.spec.ts` — `persistChargeConfirmation` writes `metadataJson` (`undefined → Prisma.JsonNull`); `findOneWithRelations` mapper surfaces catalog fields; legacy row returns `null` for all three new fields; `extractLegacyReference` continues to read only `.reference`. <!-- sdd-owner: implementation -->
- [x] Extend `src/sales/sales.service.spec.ts` (or `get-sale-detail.spec.ts`): `getSaleDetail` omits absent catalog fields on the wire; timeline `PAYMENT_RECEIVED` carries the name when present. <!-- sdd-owner: implementation -->
- [x] Add `src/sales/domain/build-sale-timeline.spec.ts` (or extend): `PAYMENT_RECEIVED` carries `paymentMethodName/paymentMethodSubtitle`; base-category label remains the fallback when absent. <!-- sdd-owner: implementation -->
- [x] Extend `pdf-generation/templates/shared/payments-list.spec.tsx`: snapshot test that `PaymentsList` prefers `paymentMethodName`, renders subtitle as a gray sub-line when present, and falls back to `formatMethod(method)` for legacy rows. <!-- sdd-owner: implementation -->

---

## Parent / lifecycle gate (post-implementation)

These tasks are not implementation work — they are post-apply review + lifecycle actions owned by the parent.

- [ ] After the implementation PR is merged, run `pnpm test` at the repo root and confirm all unit specs (including the new co-located specs under `src/admin/payment-methods/**` and the extended `sales.service.spec.ts` / `prisma-sale.repository.spec.ts` / `permission.seeder.spec.ts` / `payments-list.spec.tsx` / `build-sale-timeline.spec.ts`) pass green. <!-- sdd-owner: parent -->
- [ ] Run `pnpm build` and confirm a clean compile (no TypeScript errors introduced by the new module wiring or threaded types). <!-- sdd-owner: parent -->
- [ ] Perform a bounded review against the design's WU1/WU2 revert boundaries: confirm WU1 revert (drop `AdminPaymentMethodModule` import + reverse migration + remove allowlist/permission entries) restores pre-change behavior, and WU2 revert (sales-thread code only) leaves the catalog CRUD operational but the legacy `method`-only charge/collection path byte-identical to today. <!-- sdd-owner: parent -->
- [ ] Apply the change lifecycle: archive `openspec/changes/custom-payment-methods/` per the OpenSpec archive rule, then close the SDD change. <!-- sdd-owner: parent -->
