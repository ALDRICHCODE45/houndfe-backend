# Proposal — Custom Payment Methods (POS catalog)

Status: proposed

## Intent

Introduce a tenant-scoped, admin-configurable **payment method catalog** for the POS surface (`frontend-houndfe`). Tenants define branded tender methods (e.g. "Mercado Pago", "OXXO Pay") mapped to one of the four base categories `cash | card_credit | card_debit | transfer`. Charging and payment collection reference an active catalog row via an optional `paymentMethodId`; the backend resolves the base category for the canonical `SalePaymentMethod` enum and stores a name/subtitle snapshot in `SalePayment.metadataJson`. The custom name becomes visible on sale detail, timeline, and receipts. The catalog is a new module mirroring the proven `admin/payment-details` shape; `SalePaymentMethod` and the "A Crédito" legacy behavior are untouched.

## Problem (current-state gap)

1. **No catalog exists.** POS clients hard-code the four tender methods from DTO `@IsIn([...])` whitelists; there is no payment-method list endpoint anywhere in the API (`sales-catalog`, `sales-payments`, `sales-query`, and `admin/payment-details` were audited — none expose tender methods).
2. **No display identity.** `SaleDetailPaymentDto.method` returns the uppercase Prisma enum (`CASH`, `TRANSFER`, …); there is no `paymentMethodId`, `name`, or `subtitle` on the wire, so the frontend cannot render a branded label for a charge.
3. **Tenants cannot differentiate channels.** A tenant that accepts "Mercado Pago" vs "OXXO Pay" (both `transfer`) has no way to record *which* channel was used; reporting and receipts collapse everything to the base category.
4. **`PaymentDetail` is the wrong shape for this.** It stores bank transfer instructions (CLABE/account), not a tender-method catalog — it cannot be reused.

## Goal / Outcome

After this change, a tenant can:

- Create, read, update, and logically delete their own catalog of payment methods (`name` + base `category` + optional `subtitle`), admin-only and tenant-scoped.
- See and pick those methods in the POS via a read projection endpoint (active rows only).
- Charge a draft or add a payment to a confirmed sale with an optional `paymentMethodId`; the backend validates active + tenant-scoped, persists the base category as the canonical `SalePayment.method`, and snapshots `{ paymentMethodId, name, subtitle }` under `metadataJson.catalog`.
- See the custom method name on sale detail, the `PAYMENT_RECEIVED` timeline event, and the receipt PDF.

Legacy flows (no `paymentMethodId`), the "A Crédito" built-in, refunds, idempotency, the WhatsApp bot, and all existing `SalePaymentMethod` semantics continue to work unchanged.

## Scope

### In scope

1. **Schema + migration.** New Prisma `enum PaymentMethodCategory { CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER }` (four values — **no `CREDIT`**) and `model PaymentMethod` mapped to `payment_methods`, with `@@unique([tenantId, name])` (assumption, see Open product questions), tenant FK `onDelete: Cascade`, `isActive Boolean @default(true)`, optional `subtitle`, optional extensible metadata JSON. Additive migration only — `SalePaymentMethod` is **not** modified.
2. **Tenant + authorization plumbing.** Add `'PaymentMethod'` to `TENANT_SCOPED_MODELS` (auto tenant injection) and to `AppSubjects` + `PERMISSION_REGISTRY` (4 CRUD entries; auto-seeded idempotently at bootstrap).
3. **Admin module** `src/admin/payment-methods/` mirroring `admin/payment-details/`: domain entity (`static create` / `fromPersistence`, sanitizers, `toResponse`/`toPersistence`), repository port + `PAYMENT_METHOD_REPOSITORY` symbol, tenant-scoped Prisma adapter (P2002 → duplicate-name error, P2025 → 404), create/update/response DTOs, controller with `@RequirePermissions([action, 'PaymentMethod'])`, service with CLS tenant resolution, leaf module wired into `AdminModule`. DELETE is logical (`isActive = false`, 204), mirroring `PaymentDetail`.
4. **POS read projection.** `GET /sales/payment-methods` returning active catalog rows as `{ id, name, category, subtitle }`, guarded by `@RequirePermissions(['read', 'Sale'])` (or equivalent POS-scope guard consistent with `GET /sales/pos-catalog`). The frontend derives the icon from `category`; no icon field is stored or returned.
5. **Charge flow.** `ChargePaymentEntryDto` and `ChargeSaleDto` accept optional `@IsUUID() paymentMethodId`. `sales.service.ts` threads it through `ChargePaymentEntry`, `normalizeChargeRequestPayments` (both legacy and array branches), `sortPaymentsForHash`, and `toCanonicalChargePayments`. `PersistedChargePayment` gains optional `metadataJson`; `persistChargeConfirmation` writes `metadataJson` (undefined → `Prisma.JsonNull`, matching `persistCollectedPayments`).
6. **Collection flow.** `AddSalePaymentDto` / `AddSalePaymentEntryDto` accept optional `paymentMethodId`; the confirmed-sale "add payment" path resolves and snapshots identically (`persistCollectedPayments` already writes `metadataJson`).
7. **Idempotency.** The charge hash and the payment-collection hash MUST include `paymentMethodId`, so two custom methods sharing a base category produce distinct hashes (no silent collision/replay).
8. **Read model.** `SaleDetailPaymentDto` gains optional `paymentMethodId?`, `paymentMethodName?`, `paymentMethodSubtitle?`; the `findOneWithRelations` payments mapper surfaces them from `metadataJson.catalog`; `build-sale-timeline.ts` `PAYMENT_RECEIVED` carries the name.
9. **Receipt PDF.** `pdf-generation/templates/shared/payments-list.tsx` label resolution prefers `metadataJson.catalog.name` (with `subtitle` if present) and falls back to the existing base-category label map.
10. **Tests.** Co-located Jest unit specs for the new module and the sales-service threading; optional database-backed `*.integration.spec.ts` for the Prisma adapter following the existing integration config. `pnpm test` and `pnpm build` must pass.

### Out of scope

- No `CUSTOM` value in `SalePaymentMethod`; no enum change at all. `SalePayment.method` and `SaleRefund.method` stay base categories.
- No `credit` category in the catalog. The legacy "A Crédito" remains a native built-in fixed method (sale-status marker, never a configurable catalog row, never persisted as a `SalePayment`).
- WhatsApp bot (`src/chatbot-api/**`) keeps its fixed credit + receipt-driven transfer flow; no catalog integration, no new bot endpoint.
- No per-custom-method sales-list filtering or reporting. `ListSalesPaymentMethod` and `buildExtendedWhere` continue filtering the canonical enum column; custom methods report as their base category.
- No live foreign key from `sale_payments` to the catalog; the `metadataJson.catalog` snapshot is the only reference.
- No changes to `Customer.preferredPaymentMethod`.
- No changes to `PaymentDetail`, outbox payload consumers, or webhooks.

### Non-goals (explicit)

- Making "A Crédito" configurable; adding credit to the catalog.
- Letting custom method *names* drive reporting, aggregation, or the sales-list filter.
- Editing historical payments when a catalog row is renamed or deactivated.
- Bot-side method selection.

## Affected areas

| Area | Change |
|---|---|
| `prisma/schema.prisma` | New `PaymentMethodCategory` enum + `PaymentMethod` model |
| `prisma/migrations/<ts>_add_payment_methods/migration.sql` | Create `payment_methods` table (additive) |
| `src/shared/tenant/tenant-scoped-models.constant.ts` | Add `'PaymentMethod'` |
| `src/auth/authorization/domain/permission.ts` | Add `'PaymentMethod'` to `AppSubjects` + `PERMISSION_REGISTRY` (auto-seeded) |
| `src/admin/payment-methods/**` (new) | Entity, repository port, Prisma adapter, DTOs, controller, service, module (mirror `admin/payment-details/`) |
| `src/admin/admin.module.ts` | Import new module |
| `src/sales/dto/charge-sale.dto.ts` | Optional `paymentMethodId` on `ChargePaymentEntryDto` + `ChargeSaleDto` |
| `src/sales/dto/add-sale-payment.dto.ts` | Optional `paymentMethodId` on entry DTOs |
| `src/sales/sales.service.ts` | Thread `paymentMethodId` (types, normalize, hash, canonicalize); resolve + validate + snapshot; POS read projection service method |
| `src/sales/domain/sale.repository.ts` | `PersistedChargePayment.metadataJson?` (port contract) |
| `src/sales/infrastructure/prisma-sale.repository.ts` | Write `metadataJson` in `persistChargeConfirmation`; surface catalog fields in `findOneWithRelations` mapper |
| `src/sales/dto/sale-detail-response.dto.ts` | Optional `paymentMethodId/paymentMethodName/paymentMethodSubtitle` |
| `src/sales/domain/build-sale-timeline.ts` | `PAYMENT_RECEIVED` carries custom name |
| `src/sales/*controller*` (POS projection) | `GET /sales/payment-methods` |
| `pdf-generation/templates/shared/payments-list.tsx` | Prefer catalog name for labels |
| Resolution port wiring | `SalesModule` imports the catalog repository symbol (or a dedicated resolver use-case port) so the sales service resolves `paymentMethodId → { category, name, subtitle }` without owning catalog persistence |

## Business rules

- **Catalog model.** `name` MUST be required, trimmed/sanitized, and unique per tenant; `category` MUST be one of `cash | card_credit | card_debit | transfer` (never `credit`); `subtitle` MAY be omitted; `isActive` MUST default to `true`; an extensible metadata JSON field MAY be stored on the row. The icon is derived from `category` by the client — never stored.
- **Charge/collection resolution.** When `paymentMethodId` is present: the backend MUST resolve the row scoped to the calling tenant, MUST reject if not found or `isActive = false`; the persisted `SalePayment.method` MUST be the catalog row's `category`; if a `method` is also supplied and mismatches the row's `category`, the request MUST be rejected (defensive; prevents category/label ambiguity). The snapshot written to `metadataJson` MUST be `{ "catalog": { "paymentMethodId", "name", "subtitle" } }`, under a dedicated key so it cannot collide with the existing `reference` (legacy) or `origin` (bot) writers.
- **Idempotency.** Both the charge hash and the collection hash MUST include `paymentMethodId` when present. Identical payloads MUST remain idempotent; same `method`/amount with different `paymentMethodId` MUST NOT collide.
- **Snapshot semantics.** Historical `SalePayment` rows MUST NOT be rewritten when a catalog row is later renamed, deactivated, or deleted. New charges snapshot the current name/subtitle at write time.
- **Refunds.** Because `SalePayment.method` remains a base enum category (never `CUSTOM`), `cancelSale` → `normalizeRefundMethod` MUST keep working for custom-method payments without any catalog awareness.
- **Tenant isolation.** All catalog reads/writes MUST be tenant-scoped via the allowlist injection AND explicit `where: { id, tenantId }` (defense in depth, per `PaymentDetail` precedent).
- **Authorization.** Admin CRUD MUST require the seeded `['create'|'read'|'update'|'delete', 'PaymentMethod']` permissions; the POS projection MUST require the read-Sale scope used by POS endpoints.
- **Deactivation/deletion.** Deactivating a method MUST prevent new charges referencing it but MUST NOT affect existing payments. DELETE is logical only.
- **Legacy parity.** Requests without `paymentMethodId` MUST behave exactly as today (no `catalog` key in `metadataJson`).

## Risks & tradeoffs

1. **Idempotency collision** (silent replay when two custom methods share a category) — mitigated by including `paymentMethodId` in both hashes. Test explicitly.
2. **Credit trap** — avoided structurally: the catalog enum has four values and excludes `credit`, so `toCanonicalChargePayments` can never drop a custom row's name by filtering on `method === 'credit'`.
3. **Reporting gap** — custom methods aggregate under their base category in the sales list; per-custom-method reporting requires metadata-aware aggregation and is deliberately deferred. Accepted tradeoff for this iteration.
4. **Receipt rendering** — if the PDF template change is missed, receipts fall back to the base-category label; the change is small and covered by the visible-name success criteria.
5. **Snapshot vs live reference** — snapshots keep history stable but a rename is not backfilled into past payments; customers see the old name on historical receipts. Matches the order-discount snapshot precedent; accepted.
6. **Tenant allowlist omission** — forgetting `'PaymentMethod'` in `TENANT_SCOPED_MODELS` re-enables cross-tenant access (the documented `PaymentDetail` failure mode). Checklist item in specs/tasks.
7. **Deletion semantics** — no FK from `sale_payments` to the catalog, so catalog deactivation/deletion can never cascade into sales data. `metadataJson.catalog.paymentMethodId` is a plain UUID string.
8. **Outbox/consumers** — `sale.payment.received` MAY gain an additive catalog field; existing consumers ignore unknown keys per convention. No consumer change required.
9. **Historical rows** — old payments lack the `catalog` key and render as their base enum; graceful degradation, no backfill needed.
10. **Module proliferation** — a new admin module plus a small POS projection endpoint duplicates some plumbing; this follows the established `PaymentDetail`/`getActivePaymentDetail` patterns and keeps bounded contexts decoupled (sales service never owns catalog persistence).

## Rollback plan

The change is additive: a new table, a new module, optional DTO fields, and no destructive deltas (no `SalePaymentMethod` change, no column alterations).

1. **Code rollback.** Revert the module wiring, DTO fields, sales-service threading, and POS endpoint in one revert commit. Old clients are unaffected; the previous backend rejects `paymentMethodId` payloads via `forbidNonWhitelisted` (clients can fall back to `method`-only during the deploy window), and the new backend accepts old payloads unchanged.
2. **Migration rollback.** The `payment_methods` table is purely additive. If full removal is required, drop it via a follow-up additive migration (`DROP TABLE payment_methods`) after confirming no tenant relies on it; no data migration is needed because there is no FK from `sale_payments`.
3. **Data cleanup (optional).** Rows already written with `metadataJson.catalog` remain harmless; old code ignores the key, and `extractLegacyReference` only reads `.reference`. A later additive cleanup migration can strip the key if desired.
4. **Verification.** After rollback, run `pnpm test` and `pnpm build`, then smoke-test a charge without `paymentMethodId` and a refund of a previously custom-method payment.

## Success criteria

- Admin can create, list, update, and logically delete catalog methods; duplicate `name` per tenant returns a 4xx; cross-tenant access fails (404/null); CRUD routes require `[action, 'PaymentMethod']` permissions.
- `GET /sales/payment-methods` returns only active, tenant-scoped rows with `{ id, name, category, subtitle }`.
- Charging with `paymentMethodId` persists `SalePayment.method` = the row's category and `metadataJson.catalog = { paymentMethodId, name, subtitle }`; `method`-mismatch, inactive, and foreign-tenant `paymentMethodId` are rejected.
- The custom name (and subtitle, when present) appears on sale detail, the `PAYMENT_RECEIVED` timeline event, and the receipt PDF; the base-category label remains the fallback.
- Idempotency holds: identical payloads replay once; identical category/amount with different `paymentMethodId` hash differently.
- Legacy charges and collections without `paymentMethodId` produce byte-identical behavior to today (no `catalog` key).
- Refunding a custom-method payment succeeds via its base category; `SaleRefund.method` never sees a non-enum value.
- `pnpm test` (unit suites, including new specs) and `pnpm build` pass.

## Resolved product decisions

1. **Name uniqueness scope.** Confirmed: unique per tenant regardless of category — `@@unique([tenantId, name])` in the Prisma schema. Two methods may NOT share a display name inside the same tenant.
2. **Deactivated-method lifecycle.** Confirmed: DELETE is logical (`isActive=false`); the admin MAY edit and re-activate a deactivated method. While inactive, it is NOT selectable for new charges.
3. **Per-custom-method reporting priority.** Confirmed: deferred for the first release. Management reporting/aggregation groups by the base category enum only; metadata-aware aggregation per custom method is future work and out of scope now.
