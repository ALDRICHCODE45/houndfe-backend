# Exploration — `custom-payment-methods`

Status: exploration only. No implementation. Preflight decisions are treated as fixed:
- Model = `name` (required) + base category enum (`cash|card_credit|card_debit|transfer|credit`) + optional `subtitle` (+ `isActive`, extensible extra info).
- Persistence = **Option 1**: keep `SalePayment.method` as the canonical `SalePaymentMethod` enum; store catalog reference (`paymentMethodId` + `name` + `subtitle`) in `SalePayment.metadataJson`. Do **not** add `CUSTOM` to the enum.
- Charge DTO accepts `method` (category) + optional `paymentMethodId`; backend resolves the category for `SalePayment.method` and stores name/subtitle in `metadataJson`.

---

## 1. `SalePaymentMethod` enum usage — full inventory

### 1.1 Prisma enum (canonical storage)

`prisma/schema.prisma` (SALES ENUMS block):

```prisma
enum SalePaymentMethod {
  CASH
  CARD_CREDIT
  CARD_DEBIT
  TRANSFER
  CREDIT
}
```

`SalePayment.method` and `SaleRefund.method` both use it (`prisma/schema.prisma`, models `SalePayment` ~line 720s and `SaleRefund` ~line 745s). `SalePayment.metadataJson Json?` already exists on the model. `SalePayment` has index `idx_sale_payments_tenant_method` on `[tenantId, method]`.

### 1.2 DTO `@IsIn([...])` occurrences (4 total)

`src/sales/dto/add-sale-payment.dto.ts`:
- Line ~46 — `AddSalePaymentEntryDto.method`: `@IsIn(['cash', 'card_credit', 'card_debit', 'transfer'])` (no `credit`).
- Line ~63 — `AddSalePaymentDto.method`: same 4-value whitelist.
- Local type `CollectionPaymentMethod` (line ~17) is the same 4-value union.

`src/sales/dto/charge-sale.dto.ts`:
- Line ~15 — `ChargePaymentEntryDto.method`: `@IsIn(['cash', 'card_credit', 'card_debit', 'transfer', 'credit'])` (includes `credit`).
- Line ~23 — `ChargeSaleDto.method`: same 5-value whitelist.
- `ChargeSaleDto` also has `payments?: ChargePaymentEntryDto[]` (array form, max 5) and `dueDate?: string`.

### 1.3 Service-level whitelists (not `@IsIn`, hand-rolled)

`src/sales/sales.service.ts`:
- Line 81–86 — `type SupportedChargeMethod = 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit'`.
- Line 88–92 — `type SupportedPaymentCollectionMethod = 'cash' | 'card_credit' | 'card_debit' | 'transfer'`.
- Line 229 — `isSupportedChargeMethod(method)` returns `['cash','card_credit','card_debit','transfer','credit'].includes(method ?? '')`.
- Line 351 — `isSupportedCollectionMethod(method)` returns `['cash','card_credit','card_debit','transfer'].includes(method)`.
- Line 170 — `normalizeRefundMethod(method)` switches on `method.toUpperCase()` over the 5 enum strings and throws `SALE_REFUND_METHOD_NOT_SUPPORTED` otherwise.
- Line 94–98 — `ChargePaymentEntry` type: `{ method: SupportedChargeMethod; amountCents; reference? }` (note: no `paymentMethodId`, no `metadataJson`).
- Line 90–93 — `CollectionPaymentEntry` type already has optional `metadataJson?: unknown`.

### 1.4 List-filter enum (wire/query)

`src/sales/dto/list-sales-query.dto.ts`:
- Line 59 — `enum ListSalesPaymentMethod { CASH, CARD_CREDIT, CARD_DEBIT, TRANSFER }` — **intentionally excludes `CREDIT`** (comment at line ~52 explains credit-only sales have zero `sale_payments` rows).
- Line 120–121 — `@CsvEnum(ListSalesPaymentMethod, ...) paymentMethod?: MultiValue<ListSalesPaymentMethod>`.

`src/sales/infrastructure/prisma-sale.repository.ts`:
- Line 1356–1366 — `buildExtendedWhere` maps `paymentMethod` → `payments: { some: { method: { in: ... } } }` (and `none: {}` for `paymentMethodIncludeNull`). Filtering is against the **enum** column, not the catalog.
- Line 1416 — `findManyConfirmed` returns `paymentMethods: [...new Set(row.payments.map((p) => p.method))]` (enum strings, e.g. `['CASH','CARD_DEBIT']` — asserted in `prisma-sale.repository.spec.ts:159`).

### 1.5 Persistence coercion points

`src/sales/infrastructure/prisma-sale.repository.ts`:
- Line ~790 (inside `persistCancellation`) — `method: refund.method.toUpperCase() as 'CASH' | ... | 'CREDIT'` for `saleRefund.createMany`.
- Line ~996 (inside `persistChargeConfirmation`) — `method: payment.method.toUpperCase() as 'CASH' | 'CARD_CREDIT' | 'CARD_DEBIT' | 'TRANSFER'` (no CREDIT) for `salePayment.create`.
- Line ~1105 (inside `persistCollectedPayments`) — same 4-value `.toUpperCase()` coercion in `salePayment.createMany`.

### 1.6 Repository port type unions

`src/sales/domain/sale.repository.ts`:
- Line 9–13 — `PersistedChargePayment = { method: 'cash'|'card_credit'|'card_debit'|'transfer'; amountCents; reference? }` — **no `metadataJson`, no `paymentMethodId`**.
- Line 15–20 — `PersistedSalePaymentRecord = { paymentId; method (4 values); amountCents; reference }` — **no metadata**.
- Line 22–27 — `PersistedSaleRefundRecord = { salePaymentId; method (5 values incl credit); amountCents; reason }`.
- `persistChargeConfirmation` input (line ~153) uses `payments: PersistedChargePayment[]`.
- `persistCollectedPayment` / `persistCollectedPayments` inputs (lines ~206, ~214) already accept `metadataJson?: unknown`.

---

## 2. Charge/payment flow — `src/sales/sales.service.ts`

### 2.1 `chargeDraft` (line 2292)

- Line 2298 — `const normalizedPayments = normalizeChargeRequestPayments(dto);`
- Line 2299 — `const hashPayments = sortPaymentsForHash(normalizedPayments);`
- Line 2301–2310 — `requestHash = sha256({ saleId, actorId, payments: hashPayments, dueDate })`.
- Idempotency acquire → `runInTransaction`:
  - line ~2458 — `const canonicalPayments = toCanonicalChargePayments(normalizedPayments);`
  - line ~2477 — `const dueDate = resolveDueDate(dto.dueDate, confirmedAt, paymentStatus);`
  - line ~2490 — `saleRepo.persistChargeConfirmation({ ..., payments: canonicalPayments, ... })`.

### 2.2 `normalizeChargeRequestPayments` (line 250)

Handles legacy (`method`+`amountCents`) vs array (`payments[]`) shapes, rejects ambiguity (`AMBIGUOUS_PAYMENT_SHAPE`), caps array at 5 (`TOO_MANY_PAYMENTS`), rejects `credit` inside multi-payment arrays (`CREDIT_METHOD_NOT_VALID_IN_MULTI`), and validates each entry with `isSupportedChargeMethod`. It returns:

```ts
{ method: entry.method, amountCents: entry.amountCents, reference: entry.reference }
```

**`paymentMethodId` would be dropped here today.** This is the first thread point: add `paymentMethodId?` to the DTO entry type and copy it through in both the array and legacy branches.

### 2.3 `toCanonicalChargePayments` (line 308)

```ts
return payments
  .filter((payment) => payment.method !== 'credit')
  .map((payment) => ({ method: payment.method, amountCents: payment.amountCents, reference: payment.reference }));
```

Filters out `credit` (credit is a sale-status marker, never a persisted `SalePayment`). This is where category resolution must happen for custom methods: for each entry carrying `paymentMethodId`, resolve the catalog row → emit `method: <category>` + `metadataJson: { catalog: { paymentMethodId, name, subtitle } }`; for plain entries, leave `metadataJson` undefined. Also the filter is by `method !== 'credit'` — a custom method whose base category is `credit` would be filtered out and produce no payment row (see risks §10).

### 2.4 `resolveDueDate` (line 333)

Pure date logic (`PAID → null`, else `dueDateIso ?? confirmedAt + 15 days`). Not payment-method-specific — no change, but note `confirmBotSale` calls it with `'CREDIT'`.

### 2.5 Payment collection (`addPayment`, line 2995)

- `normalizeCollectionRequestPayments` (line 357) — same legacy/array shape handling; whitelist is the 4 tender methods via `isSupportedCollectionMethod`.
- Reviewer mode (line ~3061–3068) hard-codes `method: 'transfer'` and stamps `metadataJson: { origin: { kind: 'bot', channel: sale.channel } }`.
- `persistCollectedPayments` already writes `metadataJson` (see §3.2), so the collection path is the *easiest* place to attach a catalog reference for POS "add payment to a confirmed sale" flows.

### 2.6 `updatePaymentReference` (line 3133)

Delegates to `saleRepo.updatePaymentReference` (repo line 1157). Only mutates `reference`, returns `{ paymentId, method, amountCents, reference, paidAt }`. Does not touch `metadataJson` — safe, but if catalog name/subtitle are ever edited the historical payment snapshot should not change (snapshot semantics, see §10).

---

## 3. SalePayment persistence & domain

`src/sales/infrastructure/prisma-sale.repository.ts`:

- **`persistChargeConfirmation`** (line 821) — updates the `Sale` row then `Promise.all` of `salePayment.create` with `{ saleId, method: method.toUpperCase(), amountCents, reference: reference ?? null, userId, tenantId }`. **Does not write `metadataJson` today** — a catalog reference at charge time requires adding a `metadataJson` field to `PersistedChargePayment` and to this `create` call.
- **`persistCollectedPayment`** (line 1023) — thin wrapper delegating to `persistCollectedPayments`.
- **`persistCollectedPayments`** (line 1059) — pre-computes `paymentIds = input.payments.map(() => randomUUID())`, validates debt (`NO_OUTSTANDING_DEBT`, `PAYMENT_EXCEEDS_DEBT`), then `salePayment.createMany` with `metadataJson: payment.metadataJson === undefined ? Prisma.JsonNull : (payment.metadataJson as Prisma.InputJsonValue)`. **This is the reference implementation for writing `metadataJson`** — copy it for charge.
- **`persistCancellation`** (line 762) — writes `saleRefund` rows with `method.toUpperCase()` incl `CREDIT`.
- **`findOneWithRelations`** (line 1456) — `payments.select` already includes `metadataJson: true`; the mapper (line ~1570) does:

```ts
reference: payment.reference ?? extractLegacyReference(payment.metadataJson),
```

and maps `method: payment.method` (uppercase enum string).

`src/sales/domain/sale.repository.ts` — port signatures as listed in §1.6. New fields (`paymentMethodId`, `metadataJson` on charge/record types) must be mirrored in the interface so the service and adapter stay type-compatible.

---

## 4. Sale detail response / timeline

`src/sales/dto/sale-detail-response.dto.ts`:

```ts
export interface SaleDetailPaymentDto {
  paymentId: string;
  method: string;          // <-- free-form string on the wire
  amountCents: number;
  tenderedCents: number;
  changeCents: number;
  reference: string | null;
  paidAt: string;
}
```

- Timeline `PAYMENT_RECEIVED` (same file, `SaleDetailTimelineEventDto`) carries `method: string` + `amountCents` + `reference` + actor/register.
- `SalesService.getSaleDetail` (sales.service.ts ~1290) maps `payments` from `findOneWithRelations` and `timeline` via `buildSaleTimeline`.
- `src/sales/domain/build-sale-timeline.ts` — `PAYMENT_RECEIVED` event uses `method: payment.method` verbatim (uppercase enum from the repo).
- **What the frontend currently receives**: `method` is the uppercase Prisma enum (`CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`) — there is no `paymentMethodId`, `name`, or `subtitle` on the wire today. To render custom method names, add optional fields (`paymentMethodId?`, `paymentMethodName?`, `paymentMethodSubtitle?`) to `SaleDetailPaymentDto` + the repo mapper + timeline if desired.

---

## 5. Bot integration — `src/chatbot-api/**`

- **`registerBotSale`** (`application/chatbot-api.service.ts` line ~270) → `salesService.confirmBotSale(...)`. The bot **never sends a payment method** — it creates an ONLINE sale with `payments: []` and `paymentStatus: 'CREDIT'` (see `confirmBotSale`, sales.service.ts line 2705, which calls `persistChargeConfirmation({ payments: [], paymentStatus: 'CREDIT', channel: 'ONLINE', ... })`).
- **`RegisterBotSaleRequestDto`** (`presentation/dto/register-bot-sale.request.ts`) has no `method` field.
- **Transfer flow is receipt-driven**: bot calls `attachReceipt` (`declaredAmountCents`, `declaredReference`) → human reviewer confirms via `ReceiptReviewService.confirm` (`review/receipt-review.service.ts`) which calls `salesService.addPayment(..., { method: 'transfer', amountCents, reference }, ..., 'reviewer')` — hard-coded `transfer` and `metadataJson.origin = { kind:'bot', channel }` (sales.service.ts ~3065).
- **`getActivePaymentDetail`** (chatbot-api.service.ts line ~449) is the read-only bot projection: it queries `prisma.paymentDetail.findFirst({ where: { tenantId, isActive: true }, orderBy: { updatedAt: 'desc' } })` directly (no repo/module), and the controller method-level `@RequiredScopes('payment-details:read')` overrides the class default.
- **Where a custom method might surface for the bot**: only if the bot ever starts choosing tenders. Today the bot is credit+receipt only, so the catalog is POS/admin-facing; a future bot read-only endpoint would mirror `getActivePaymentDetail` (`@RequiredScopes` + tenantPrisma direct read of active catalog rows).

---

## 6. Existing `PaymentDetail` (Q1) — confirmed DISTINCT, and the template

Confirmed: `PaymentDetail` is **bank transfer instructions** (CLABE / account number / beneficiary / bank name), **not** a sale-payment method catalog. Schema comment + entity header are explicit. It is the architectural template to mirror.

Template shape (`src/admin/payment-details/`):
- `domain/payment-detail.entity.ts` — pure entity, `static create` + `fromPersistence`, mutators, `toResponse`/`toPersistence`, exported sanitizers.
- `domain/payment-detail.repository.ts` — `IPaymentDetailRepository` port + `PAYMENT_DETAIL_REPOSITORY = Symbol(...)`.
- `infrastructure/prisma-payment-detail.repository.ts` — Prisma adapter, tenant-scoped via `TenantPrismaService`, P2002 → `DUPLICATE_CLABE`, P2025 → `EntityNotFoundError`.
- `dto/create-payment-detail.dto.ts`, `update-payment-detail.dto.ts` (partial), `payment-detail-response.dto.ts`.
- `admin-payment-detail.controller.ts` — `@Controller('admin/payment-details')`, `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)`, `@RequirePermissions([action, 'PaymentDetail'])` per route; DELETE is logical (204).
- `admin-payment-detail.service.ts` — `ClsService<TenantClsStore>` tenant resolution, `randomUUID`, logical delete.
- `admin-payment-detail.module.ts` — leaf module importing `AuthModule`, wiring symbol → adapter; imported by `AdminModule` (`src/admin/admin.module.ts` line ~13).

Read-only bot projection is a separate pattern: inline `tenantPrisma` read in `ChatbotApiService` + `@RequiredScopes` on the controller (no module/repo). This is the shape to reuse if the catalog needs a public/read endpoint.

---

## 7. RBAC / admin patterns

- **Admin controller guards**: class-level `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` + per-route `@RequirePermissions([action, subject])` (`require-permissions.decorator.ts`).
- **Bot service-auth**: `ServiceAuthGuard` + `@RequiredScopes('scope:action')` (class default + method override via `getAllAndOverride`) — `chatbot-api/presentation/decorators/required-scopes.decorator.ts`.
- **Subjects/registry**: `src/auth/authorization/domain/permission.ts` — `AppSubjects` union (line ~27; `'PaymentDetail'` at line ~49) and `PERMISSION_REGISTRY` (PaymentDetail 4 CRUD entries at lines ~479–501, no `manage`/`batch_delete`).
- **Seeding**: `src/auth/authorization/infrastructure/permission.seeder.ts` — `PermissionSeeder.onApplicationBootstrap` upserts `PERMISSION_REGISTRY` into `permission` on boot (idempotent). Adding `'PaymentMethod'` to `AppSubjects` + registry automatically seeds.
- **Tenant scoping**: `src/shared/tenant/tenant-scoped-models.constant.ts` — `TENANT_SCOPED_MODELS` allowlist; `'PaymentDetail'` is present (line ~67). The new catalog model (`'PaymentMethod'`) **must be added here** so `TenantPrismaService` auto-injects `tenantId` on every read/write and cross-tenant access auto-fails to 404/`null`.
- Defense-in-depth: repos also pass explicit `where: { id, tenantId }` (see `prisma-payment-detail.repository.ts`).

---

## 8. Migration conventions

- Schema placement: `prisma/schema.prisma`; new model + (recommended) new category enum go in the relevant section (or near `PaymentDetail`). Models use `@@map("snake_case")`, tenant FK `@relation(fields:[tenantId], references:[id], onDelete: Cascade)`.
- Migrations: `prisma/migrations/YYYYMMDDHHMMSS_snake_description/migration.sql`. Existing examples: `20260824225358_add_payment_detail`, `20260719080258_add_sale_price_list_assign`, `20260623205337_add_sale_cancellation`.
- `payment_detail` migration is the closest template (create table + `@@unique([tenantId, clabe])` + tenant index + cascade FK). A `payment_methods` table should mirror it but uniqueness is per-tenant by name/category, e.g. `@@unique([tenantId, name])` (or `[tenantId, name, category]` if duplicates across categories are allowed).
- Additive migrations are the norm (`prisma migrate dev` / `migrate deploy`). No `CUSTOM` enum value is added per preflight — the catalog is a table, `SalePaymentMethod` stays untouched, so no destructive enum change.

---

## 9. Catalog list endpoint gap — where the frontend gets methods today

There is **no** payment-method list endpoint. Confirmed by grep across `src`:
- `sales-catalog.controller.ts` only exposes `GET /sales/pos-catalog` and `GET /sales/pos-catalog/:productId` (product catalog only; `pos-catalog-response.dto.ts` has no payment methods).
- `sales-payments.controller.ts` only exposes `POST /sales/:id/payments` and `PATCH /sales/:saleId/payments/:paymentId/reference`.
- `sales.controller.ts` exposes `POST /sales/drafts/:id/charge`.
- `sales-query.controller.ts` exposes `GET /sales` (list, `paymentMethod` *filter* only) and `GET /sales/:id`.
- `admin/payment-details` is bank data, not tender methods.
- `chatbot-api/payment-details` is active bank data.

**Conclusion**: the POS frontend must currently hard-code `cash|card_credit|card_debit|transfer` (and `credit`) from the DTO contracts. The catalog needs a new read endpoint (recommended `GET /sales/payment-methods` guarded by `@RequirePermissions(['read','Sale'])`, or `GET /admin/payment-methods` + a POS projection). This is a genuine gap, not an existing surface to extend.

---

## 10. `metadataJson` contract (collision avoidance)

Current writers of `SalePayment.metadataJson`:
- `addPayment` reviewer mode (sales.service.ts ~3065): `{ origin: { kind: 'bot', channel: sale.channel } }`.
- `persistCollectedPayments` (repo ~1110): generic `payment.metadataJson`.
- Reader: `extractLegacyReference` (repo line 29) reads `metadataJson.reference` (string, non-empty) as a fallback for `reference`.

Charge path (`persistChargeConfirmation`) currently writes **no** `metadataJson`.

**Recommendation**: store the catalog snapshot under a dedicated key to avoid colliding with `reference`/`origin`:

```json
{ "catalog": { "paymentMethodId": "<uuid>", "name": "Mercado Pago", "subtitle": "Link" } }
```

This keeps `extractLegacyReference` (which only reads `.reference`) and the bot `origin` key unaffected. Any future extensibility (extra info) should be nested inside `catalog` (or a sibling versioned key), not at top level.

---

## (a) Full touchpoint list for adding the catalog

**New module (mirror `admin/payment-details/`):**
1. `prisma/schema.prisma` — new enum `PaymentMethodCategory` (5 values mirroring `SalePaymentMethod`) + `model PaymentMethod` (`@@map("payment_methods")`, tenant cascade, `@@unique([tenantId, name])` or similar, `isActive`, optional `subtitle`, optional `extra`/`metadata Json?` for extensibility).
2. New migration `prisma/migrations/<ts>_add_payment_methods/migration.sql`.
3. `src/shared/tenant/tenant-scoped-models.constant.ts` — add `'PaymentMethod'`.
4. `src/auth/authorization/domain/permission.ts` — add `'PaymentMethod'` to `AppSubjects` + 4 CRUD registry entries.
5. New `src/admin/payment-methods/` (or `src/payment-methods/`) with `domain/entity`, `domain/repository`, `infrastructure/prisma-*.repository`, `dto/create|update|response`, `controller`, `service`, `module`; import module into `src/admin/admin.module.ts`.
6. Optional POS read projection: `GET /sales/payment-methods` (SalesModule controller/service) filtered to `isActive` + base categories; optionally a bot read projection via `@RequiredScopes`.

**Charge/payment thread (no new module):**
7. `charge-sale.dto.ts` — `ChargePaymentEntryDto` + `ChargeSaleDto`: optional `@IsOptional() @IsUUID() paymentMethodId?: string`.
8. `sales.service.ts` — `ChargePaymentEntry` type + `normalizeChargeRequestPayments` (copy `paymentMethodId` through) + `sortPaymentsForHash` (include in idempotency hash) + `toCanonicalChargePayments` (resolve category via a catalog port; emit `metadataJson.catalog`).
9. `sale.repository.ts` — extend `PersistedChargePayment` (+`metadataJson?`) and possibly `PersistedSalePaymentRecord` (+catalog fields) for outbox fidelity.
10. `prisma-sale.repository.ts` — `persistChargeConfirmation` write `metadataJson`; `findOneWithRelations` payments mapper surface `paymentMethodId/name/subtitle` from `metadataJson.catalog`.
11. `add-sale-payment.dto.ts` + `sales.service.ts` collection types — optional `paymentMethodId` mirror for confirmed-sale "add payment".
12. `sale-detail-response.dto.ts` + `build-sale-timeline.ts` — optional catalog fields if the frontend/timeline must render the custom name.

---

## (b) Exact places `paymentMethodId` threads through charge

1. `ChargeSaleDto` + `ChargePaymentEntryDto` (`charge-sale.dto.ts`) — accept the field (UUID).
2. `ChargePaymentEntry` (`sales.service.ts:94`) — carry `paymentMethodId?`.
3. `normalizeChargeRequestPayments` (`sales.service.ts:250`) — pass `paymentMethodId` in both array and legacy branches (currently dropped).
4. `sortPaymentsForHash` (`sales.service.ts:322`) — add `paymentMethodId` to the sort/hash tuple so two custom methods with the same category produce different idempotency hashes.
5. `toCanonicalChargePayments` (`sales.service.ts:308`) — resolve `paymentMethodId` → catalog row → `method: category` + `metadataJson.catalog`; keep the `method !== 'credit'` filter.
6. `PersistedChargePayment` (`sale.repository.ts:9`) — add `metadataJson?`.
7. `persistChargeConfirmation` (`prisma-sale.repository.ts:821`, `create` at ~996) — write `metadataJson` (undefined → `Prisma.JsonNull`, matching `persistCollectedPayments`).
8. `publishPaymentReceivedEvents` (`sales.service.ts:858`) — optionally carry catalog name in outbox (requires `PersistedSalePaymentRecord` extension).
9. `findOneWithRelations` payments mapper (`prisma-sale.repository.ts` ~1570) — expose `paymentMethodId`/`name`/`subtitle`.
10. `SaleDetailPaymentDto` (`sale-detail-response.dto.ts`) — optional wire fields.

---

## (c) Risks / compatibility concerns

1. **`SaleRefund.method` is the same enum.** `cancelSale` → `buildCancellationRefunds` reads `payment.method` (uppercase enum from `findOneWithRelations`) and `normalizeRefundMethod` maps only the 5 enum values. Because `SalePayment.method` stays a base category (never `CUSTOM`), refunds remain valid. Do **not** let custom resolution produce a non-enum `method`.
2. **`credit` as a base category is a trap.** `toCanonicalChargePayments` drops `method === 'credit'` (it never persists a `SalePayment`). A custom method whose base category is `credit` would be filtered out and lose its name/subtitle entirely. Recommend either restricting the catalog's selectable base category to the 4 tender values in the charge flow, or explicitly documenting that `credit`-category custom methods behave as credit markers with no persisted payment row.
3. **Idempotency.** Charge hash (`sales.service.ts:2301`) and payment hash (`~3021`) only cover `method|amount|reference`. Omitting `paymentMethodId` means "Mercado Pago" and "OXXO Pay" (both maybe `transfer` or `cash`) would hash identically → silent replay/conflict. Include `paymentMethodId` in both hashes.
4. **Reporting/list filter.** `findManyConfirmed.paymentMethods` and `buildExtendedWhere` filter against the **enum** column. A custom method reports as its base category, not its name. If per-custom-method reporting is required, it needs a `metadataJson`-aware aggregation (raw SQL or post-filter) — a non-trivial follow-up.
5. **Historical data.** Existing `metadataJson` values are `{ reference }` (legacy) and `{ origin: {...} }` (bot). New `catalog` key is additive and does not collide; `extractLegacyReference` stays correct. Old rows simply lack `catalog` and render as their base enum (graceful).
6. **Receipt/PDF.** `pdf-generation/templates/shared/payments-list.tsx` renders `method` enum with a fixed label map (`CASH → Efectivo`, `TRANSFER → Transferencia`, etc.). Custom names in `metadataJson` will not appear on receipts unless the PDF pipeline is extended to read `paymentMethodId/name`.
7. **Snapshot vs live reference.** Store name/subtitle (not just id) in `metadataJson` so editing/deactivating a catalog row later does not rewrite historical sale records (`paymentMethodId` alone would require a join and can be nulled/deleted). This mirrors the order-discount snapshot precedent.
8. **Tenant allowlist omission.** Forgetting `'PaymentMethod'` in `TENANT_SCOPED_MODELS` re-enables cross-tenant reads/writes (same failure mode documented for `PaymentDetail`).
9. **Deletion semantics.** `PaymentDetail` uses logical delete (isActive=false) so history stays intact. A catalog that is later deleted/deactivated must not cascade into `sale_payments` (there should be no FK from `SalePayment` to the catalog; only the snapshot in `metadataJson`).
10. **Outbox.** `sale.payment.received` payload currently carries `method` (lowercase) + `reference`. If downstream consumers need the custom name, extend the payload additively (consumers ignore unknown keys per existing convention).

---

## (d) Recommended module shape (mirror `PaymentDetail`)

```
src/admin/payment-methods/
  domain/payment-method.entity.ts            # create/fromPersistence, sanitizeName, category guard, toResponse/toPersistence
  domain/payment-method.repository.ts        # IPaymentMethodRepository + PAYMENT_METHOD_REPOSITORY Symbol
  infrastructure/prisma-payment-method.repository.ts  # tenant-scoped adapter, P2002→DUPLICATE_NAME, P2025→404
  dto/create-payment-method.dto.ts
  dto/update-payment-method.dto.ts
  dto/payment-method-response.dto.ts
  admin-payment-method.controller.ts         # @RequirePermissions([action,'PaymentMethod'])
  admin-payment-method.service.ts            # ClsService tenant resolve, randomUUID, logical delete
  admin-payment-method.module.ts             # imports AuthModule, wires symbol→adapter
```

Wire into `src/admin/admin.module.ts` (like `AdminPaymentDetailModule`). Add `'PaymentMethod'` to `AppSubjects` + `PERMISSION_REGISTRY` + `TENANT_SCOPED_MODELS`.

For the POS read surface, either:
- a small read-only controller/service in `SalesModule` (`GET /sales/payment-methods`, `@RequirePermissions(['read','Sale'])`) that returns active catalog rows mapped to `{ id, name, category, subtitle }`, or
- reuse the admin list with a POS projection method.

Resolution port: the sales service needs a way to resolve `paymentMethodId → { category, name, subtitle }`. Options: inject `IPaymentMethodRepository.findActiveById(id, tenantId)` into `SalesService`, or a dedicated `PaymentMethodCatalogResolver` use-case port (cleaner, keeps Sales decoupled). `SalesModule` would import the new module's exported repository symbol.

---

## (e) Gaps in current payment-method availability for the frontend

- No list endpoint exists; POS clients hard-code the 4 tender methods (+ `credit`) from the `@IsIn` DTO contracts.
- The wire detail (`SaleDetailPaymentDto.method`) returns the uppercase **enum**, not a display label; there is no `paymentMethodId`/`name`/`subtitle` to render a custom label.
- `ListSalesPaymentMethod` filter enum (list query) would also need to remain enum-based (it filters the canonical column) — custom methods cannot be individually filtered today.
- Bot surface has no method selection at all (credit + receipt-driven transfer only), so the catalog is POS/admin-facing in this iteration.
