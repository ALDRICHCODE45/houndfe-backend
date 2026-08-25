# Tasks: Chatbot Sale-Flow Blockers (Q1–Q3)

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,500–2,000 added total (WU1 ~600 + WU2 ~400 + WU3 ~700) |
| 400-line budget risk | High |
| Chained PRs recommended | No |
| Suggested split | Three sequential work-unit commits on main: WU1 → WU2 → WU3 (no PRs, solo-dev) |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception — owner grants the size exception; each WU ships as its own individually revertible commit on main, NOT an auto-chain of PRs |

> **Delivery (owner decision — do not override):** THREE work units as separate commits on main,
> in the order WU1 → WU2 → WU3. Each work unit must be individually revertible and independently
> reviewable. This is not an auto-chain of PRs; it is work-unit commits.
>
> **Slicing note (flagged):** the design's Work Unit Plan (authoritative) places the bot read
> endpoint (`GET /chatbot-api/payment-details`, `getActivePaymentDetail`,
> `payment-detail.response.ts`) in **WU1** alongside the rest of Q1. The parent's WU3 summary
> mentioned that endpoint; per the design, it is built and committed in WU1, and only its
> `PROGRAM-CONTEXT.md` documentation lands in WU3.

## WU1 — Q1: PaymentDetail schema, admin CRUD, RBAC, bot read (~600 LOC)

**Revert boundary:** `prisma migrate resolve --rolled-back` on `add_payment_detail`; remove the
`AdminPaymentDetailModule` import from `admin.module.ts`; remove the bot route; leave seeded
`Permission` rows in place.

### GREEN

- [x] WU1-01. Add the `PaymentDetail` model to `prisma/schema.prisma` — fields per design (id uuid, tenantId, bankName, beneficiary, clabe, accountNumber, isActive default true, createdAt, updatedAt), `@@unique([tenantId, clabe])`, `@@index([tenantId])`, `@@map("payment_detail")`, FK `tenant` with `onDelete: Cascade`; add `paymentDetails PaymentDetail[]` reverse relation on `Tenant`. (Req: PaymentDetail Model; D1) <!-- sdd-owner: implementation -->
- [x] WU1-02. Generate and apply the migration with `pnpm exec prisma migrate dev --name add_payment_detail`; verify forward SQL creates `payment_detail` + unique index `payment_detail_tenantId_clabe_key` + FK, and reverse SQL drops the table. (Req: PaymentDetail Model) <!-- sdd-owner: implementation -->
- [x] WU1-03. Add optional `details?: Record<string, unknown>` (third constructor arg) to `BusinessRuleViolationError` in `src/shared/domain/domain-error.ts`; keep default `message`/`code` behavior unchanged. (D7) <!-- sdd-owner: implementation -->
- [x] WU1-04. Extend `DomainExceptionFilter` in `src/shared/filters/domain-exception.filter.ts`: spread `exception.details` into the response body when present, and add `getHttpStatus` mappings `NO_ACTIVE_PAYMENT_DETAIL → 404` and `DUPLICATE_CLABE → 409`. (Req: Bot Reads Active Tenant Payment Detail; D7) <!-- sdd-owner: implementation -->
- [x] WU1-05. Add `'PaymentDetail'` to the `AppSubjects` union and append four `PERMISSION_REGISTRY` entries (`read/create/update/delete` with descriptions) in `src/auth/authorization/domain/permission.ts`; no other seed code needed — `PermissionSeeder` auto-upserts on boot. (Req: PaymentDetail RBAC Permissions) <!-- sdd-owner: implementation -->
- [x] WU1-06. Create `src/admin/payment-details/domain/payment-detail.entity.ts` — domain entity with `static create()`, `fromPersistence()`, `update()`, `deactivate()`; enforce CLABE exactly 18 digits, `accountNumber` ≥ 10 digits, trimmed non-empty `bankName`/`beneficiary`. (Req: PaymentDetail Field Validation; D1) <!-- sdd-owner: implementation -->
- [x] WU1-07. Create `src/admin/payment-details/domain/payment-detail.repository.ts` — `IPaymentDetailRepository` port (`create`, `update`, `findById`, `findAll`, `findActive`) + `PAYMENT_DETAIL_REPOSITORY` symbol. (D1) <!-- sdd-owner: implementation -->
- [x] WU1-08. Create `src/admin/payment-details/infrastructure/prisma-payment-detail.repository.ts` — tenant-scoped Prisma adapter via `TenantPrismaService`; map P2002 on `tenantId_clabe` to `DUPLICATE_CLABE`. (Req: PaymentDetail Model duplicate-CLABE scenario) <!-- sdd-owner: implementation -->
- [x] WU1-09. Create DTOs `src/admin/payment-details/dto/create-payment-detail.dto.ts`, `update-payment-detail.dto.ts` (partial optional), `payment-detail-response.dto.ts` (id, tenantId, isActive, timestamps) with class-validator (CLABE 18 digits, accountNumber ≥ 10, non-empty bankName/beneficiary). (Req: PaymentDetail Field Validation + Admin CRUD) <!-- sdd-owner: implementation -->
- [x] WU1-10. Create `src/admin/payment-details/admin-payment-detail.service.ts` — CRUD orchestration with `IPaymentDetailRepository` + `ClsService<TenantClsStore>`; cross-tenant access → 404; delete is logical (`isActive=false`); `findActive` orders `updatedAt DESC`. (Req: PaymentDetail Admin CRUD Endpoints + Tenant Isolation; D2) <!-- sdd-owner: implementation -->
- [x] WU1-11. Create `src/admin/payment-details/admin-payment-detail.controller.ts` — `@Controller('admin/payment-details')` with `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` and `@RequirePermissions(['<action>', 'PaymentDetail'])` per route (POST/GET/GET:id/PATCH/DELETE). (Req: PaymentDetail Admin CRUD Endpoints) <!-- sdd-owner: implementation -->
- [x] WU1-12. Create `src/admin/payment-details/admin-payment-detail.module.ts` (`imports: [AuthModule]`, controller + service + repo provider) and import it from `src/admin/admin.module.ts`. (D1) <!-- sdd-owner: implementation -->
- [x] WU1-13. Bot read endpoint: create `src/chatbot-api/presentation/dto/payment-detail.response.ts` (id, bankName, beneficiary, clabe, accountNumber, isActive, updatedAt); add `getActivePaymentDetail()` to `src/chatbot-api/application/chatbot-api.service.ts` (`paymentDetail.findFirst({ where: { tenantId, isActive: true }, orderBy: { updatedAt: 'desc' } })`, else `NO_ACTIVE_PAYMENT_DETAIL`); add `GET /chatbot-api/payment-details` in `src/chatbot-api/presentation/chatbot-api.controller.ts` with method-level `@RequiredScopes('payment-details:read')` (overrides class `catalog:read`). (Req: Bot Reads Active Tenant Payment Detail; D3) <!-- sdd-owner: implementation -->

### TESTS

- [x] WU1-14. Table-driven entity spec `src/admin/payment-details/domain/payment-detail.entity.spec.ts` — CLABE 18 digits, non-digit rejection, accountNumber ≥ 10, trimmed non-empty fields, `deactivate()`, `update()`, `fromPersistence` round-trip. Run `pnpm test`. (Req: PaymentDetail Field Validation) <!-- sdd-owner: implementation -->
- [x] WU1-15. Repo spec `src/admin/payment-details/infrastructure/prisma-payment-detail.repository.spec.ts` — tenant scoping, P2002 → `DUPLICATE_CLABE`, `findActive` ordering, cross-tenant isolation. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU1-16. Service spec `src/admin/payment-details/admin-payment-detail.service.spec.ts` — CRUD, cross-tenant 404, logical delete, active-record selection, multi-active → newest. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU1-17. Controller spec `src/admin/payment-details/admin-payment-detail.controller.spec.ts` — guard + `@RequirePermissions` wiring, 201 create, 204 delete, 400/409 validation paths. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU1-18. Extend `src/shared/filters/domain-exception.filter.spec.ts` — details spread + `NO_ACTIVE_PAYMENT_DETAIL → 404` + `DUPLICATE_CLABE → 409`; extend `src/auth/authorization/infrastructure/permission.seeder.spec.ts` — four `*:PaymentDetail` rows after boot. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU1-19. Extend chatbot-api specs — `getActivePaymentDetail` 200 (active account), 404 `NO_ACTIVE_PAYMENT_DETAIL`, multi-active → newest, 403 on missing scope (service + controller spec in `src/chatbot-api/application/` and `src/chatbot-api/presentation/`). Run `pnpm test`. <!-- sdd-owner: implementation -->

### REFACTOR & VERIFY

- [x] WU1-20. Run full suite `pnpm test` + `pnpm build`; confirm `prisma migrate status` clean and boot smoke seeds the four new permissions; run scoped lint `pnpm exec eslint src/admin/payment-details src/chatbot-api src/auth/authorization src/shared`. (Global success criteria) <!-- sdd-owner: implementation -->

### Review gate

- [ ] Start or reuse bounded review of the WU1 commit (schema + migration + admin module + RBAC + filter mappings + bot read endpoint). <!-- sdd-owner: parent -->

## WU2 — Q3: Atomic sale-registration idempotency (~400 LOC)

**Revert boundary:** pure code revert — `registerBotSale` returns to the old `upsert`; no schema
change (`SaleIdempotency.requestHash` + `@@unique([tenantId, operation, key])` already exist).

### GREEN

- [x] WU2-01. Add to `ISaleRepository` in `src/sales/domain/sale.repository.ts`: `acquireSaleRegistrationIdempotency(key: string, requestHash: string)` returning `{ kind: 'acquired', token } | { kind: 'replay', payload } | { kind: 'conflict' } | { kind: 'in_flight' }`, and `markSaleRegistrationIdempotencySucceeded(token, saleId, payload)`. (Req: Atomic Sale Registration Idempotency; D8) <!-- sdd-owner: implementation -->
- [x] WU2-02. In `src/sales/infrastructure/prisma-sale.repository.ts`: widen the private `acquireIdempotency` helper to accept `operation: 'sale_charge' | 'sale_payment' | 'sale_cancel' | 'bot_sale_register'` and `saleId: string | null`; add two thin public delegating methods (`acquireSaleRegistrationIdempotency` → `acquireIdempotency('bot_sale_register', null, key, requestHash)`; `markSaleRegistrationIdempotencySucceeded` → `markIdempotencySucceeded`). Reuse, don't duplicate, the P2002 logic. (D8) <!-- sdd-owner: implementation -->
- [x] WU2-03. Implement idempotency-key validation (resolves design open question): create `src/chatbot-api/presentation/pipes/parse-idempotency-key.pipe.ts` that rejects missing/empty/`>200` chars with `InvalidArgumentError('...', 'INVALID_IDEMPOTENCY_KEY')` (→ 400 via existing filter); wire it on the `@Headers('x-idempotency-key')` param in `src/chatbot-api/presentation/chatbot-api.controller.ts` so validation runs before any DB read. (Req: Atomic Sale Registration Idempotency empty-key scenario) <!-- sdd-owner: implementation -->
- [x] WU2-04. Refactor `registerBotSale` in `src/chatbot-api/application/chatbot-api.service.ts`: build canonical payload `{ cashierUserId, customerId, shippingAddressId, items: [{ productId, variantId, quantity, unitPriceCents }] }` with items sorted by `(productId, variantId)`; `requestHash = sha256(JSON.stringify(canonicalPayload))`; call `acquireSaleRegistrationIdempotency` and branch: `replay` → return cached response, `conflict` → `BusinessRuleViolationError('IDEMPOTENCY_KEY_CONFLICT', ...)`, `in_flight` → `BusinessRuleViolationError('IDEMPOTENCY_KEY_IN_FLIGHT', ...)`, `acquired` → `confirmBotSale(...)` then `markSaleRegistrationIdempotencySucceeded(token, saleId, response)`; never write `FAILED` (D10). (Req: Atomic Sale Registration Idempotency; D8, D9, D10) <!-- sdd-owner: implementation -->

### TESTS

- [x] WU2-05. Extend `src/sales/infrastructure/prisma-sale.repository.spec.ts` — `acquireSaleRegistrationIdempotency` four outcomes (acquired / replay / conflict / in_flight), `saleId: null` at acquire and filled at succeed. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU2-06. Extend `src/chatbot-api/application/chatbot-api.service.spec.ts` — existing replay tests (line ~799+) stay green; add conflict, in_flight, requestHash mismatch, retry-after-in-flight, order-independent hash, empty-key 400 before DB. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU2-07. Extend `src/chatbot-api/presentation/chatbot-api.controller.spec.ts` — idempotency-key pipe rejects empty/missing/oversized with 400 `INVALID_IDEMPOTENCY_KEY`. Run `pnpm test`. <!-- sdd-owner: implementation -->

### REFACTOR & VERIFY

- [x] WU2-08. Run full suite `pnpm test` + `pnpm build`; confirm no schema/migration change and no `FAILED` writes introduced; run scoped lint `pnpm exec eslint src/sales src/chatbot-api`. (Global success criteria) <!-- sdd-owner: implementation -->

### Review gate

- [ ] Start or reuse bounded review of the WU2 commit (idempotency port + `registerBotSale` refactor + key validation). <!-- sdd-owner: parent -->

## WU3 — Q2: Promo re-evaluation + discountCents + docs (~700 LOC)

**Revert boundary:** pure code + docs revert — `discountCents` returns to hardcoded 0,
`expectedTotalCents` is ignored, `PROMO_RE_QUOTE` mapping removed, `PROGRAM-CONTEXT.md` drift
reopened as a known issue.

### GREEN

- [x] WU3-01. Add `discountCents: number` to `ConfirmBotSaleResult` (`src/sales/sales.service.ts:125`) and to `BotSaleResponse` in `src/chatbot-api/presentation/dto/bot-sale.response.ts` (additive, backward-compatible). (Req: Bot Sale Response Exposes Discount) <!-- sdd-owner: implementation -->
- [x] WU3-02. Add optional `expectedTotalCents?: number` (`@IsOptional() @IsInt() @Min(0)`) to `RegisterBotSaleRequestDto` in `src/chatbot-api/presentation/dto/register-bot-sale.request.ts`; add `expectedTotalCents?` to `RegisterBotSaleInput`; pass it through `src/chatbot-api/presentation/chatbot-api.controller.ts` → `chatbot-api.service.ts` → `confirmBotSale`. (Req: Bot Sale Optional Re-quote Check) <!-- sdd-owner: implementation -->
- [x] WU3-03. Refactor `confirmBotSale` in `src/sales/sales.service.ts` (~2678): keep the `PRICE_OUT_OF_DATE` guard against `getApplicablePrices` (unchanged, stays 409 — D6); after `Sale.create` + `assignCustomer`, bind the customer's default list via `sale.setGlobalPriceList(customer.globalPriceListId ?? null, false)` (D5); call `recomputePricingAndPromotions(sale)` (D4 engine, NOT evaluate-cart); derive `{ subtotalCents, discountCents, totalCents }` from `sale.previewTotals()` (D4); if `expectedTotalCents` set and ≠ `totalCents` → `BusinessRuleViolationError('PROMO_RE_QUOTE', 'PROMO_RE_QUOTE', { recomputedTotalCents, expectedTotalCents, discountCents })` (D7); persist real `discountCents` + items + applied order promotion via `persistChargeConfirmation`; return `discountCents` in `ConfirmBotSaleResult`. (Req: Bot Sale Server-Side Promotion Re-evaluation + Optional Re-quote Check; D4, D5, D6, D7) <!-- sdd-owner: implementation -->
- [x] WU3-04. Extend `publishSaleConfirmedEvent` in `src/sales/sales.service.ts` (~868) to include `subtotalCents` and `discountCents` in the `sale.confirmed` outbox payload. (Req: Bot Sale Response Exposes Discount — sale.confirmed scenario) <!-- sdd-owner: implementation -->
- [x] WU3-05. Add `PROMO_RE_QUOTE → 409` mapping to `getHttpStatus` in `src/shared/filters/domain-exception.filter.ts`. (D7) <!-- sdd-owner: implementation -->
- [x] WU3-06. Normalize replay responses in `registerBotSale` (`src/chatbot-api/application/chatbot-api.service.ts`): return `{ ...cached, discountCents: cached.discountCents ?? 0 }` so legacy cached rows predating `discountCents` replay additively. (Design risk: legacy cached BotSaleResponse) <!-- sdd-owner: implementation -->
- [x] WU3-07. Fix docs drift in `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md`: endpoint summary table → **11 rows** + "Total: 11 endpoints" (D11); add the missing `POST /chatbot-api/sales/:saleId/cancel` section (4.4.x, scope `sales:write`); add `GET /chatbot-api/payment-details` section (4.4.x, scope `payment-details:read`); rewrite §4.3 idempotency as the atomic `acquire → replay | conflict | in_flight` pattern with `requestHash` matching and 409 codes; document `discountCents` on `BotSaleResponse`. (Req: Chatbot API Endpoint Documentation Drift Fix; D11) <!-- sdd-owner: implementation -->

### TESTS

- [x] WU3-08. Extend `src/sales/sales.service.spec.ts` — no-promo (`discountCents=0`), AUTOMATIC 10% PRODUCT_DISCOUNT (discountCents=100, totalCents=900 persisted), ORDER_DISCOUNT, BXGY/ADVANCED, `expectedTotalCents` match vs mismatch (409 `PROMO_RE_QUOTE` body `{ recomputedTotalCents, expectedTotalCents, discountCents }`), `PRICE_OUT_OF_DATE` before engine, outbox payload includes `discountCents`. Run `pnpm test`. (Req: Bot Sale Server-Side Promotion Re-evaluation + Optional Re-quote Check) <!-- sdd-owner: implementation -->
- [x] WU3-09. Extend `src/chatbot-api/application/chatbot-api.service.spec.ts` — `expectedTotalCents` pass-through, re-quote propagation to the wire, replay normalization for legacy rows; extend `src/chatbot-api/presentation/chatbot-api.controller.spec.ts` — DTO → service mapping for `expectedTotalCents`. Run `pnpm test`. <!-- sdd-owner: implementation -->
- [x] WU3-10. Extend `src/shared/filters/domain-exception.filter.spec.ts` — `PROMO_RE_QUOTE → 409` with `details` spread in body. Run `pnpm test`. <!-- sdd-owner: implementation -->

### REFACTOR & VERIFY

- [x] WU3-11. Run full suite `pnpm test` + `pnpm build`; confirm no regression in existing bot replay tests; run scoped lint `pnpm exec eslint src/sales src/chatbot-api src/shared`. (Global success criteria) <!-- sdd-owner: implementation -->

### Review gate

- [ ] Start or reuse bounded review of the WU3 commit (engine re-evaluation + discountCents + docs drift fix). <!-- sdd-owner: parent -->

## Decisions & Flags

- **Delivery (owner, do not override):** three work-unit commits on main, order WU1 → WU2 → WU3; no PRs; each unit independently revertible and reviewable.
- **No decision needed before apply:** all product decisions are resolved (D1–D11); the only open implementation choice (idempotency-key validation mechanism) is resolved in WU2-03 as a dedicated `ParseIdempotencyKeyPipe`.
- **Flag:** parent WU3 summary listed `GET /chatbot-api/payment-details`; the design Work Unit Plan (authoritative) builds it in WU1 — only its docs land in WU3 (see top note).
- **Flag:** WU3-04's outbox change is additive (`subtotalCents`, `discountCents`); downstream consumers ignore unknown keys.
- **Flag:** orphaned `IN_FLIGHT` slots (no `FAILED` marking, D10) and multiple active `PaymentDetail` rows (D2) remain accepted operational risks with manual-cleanup mitigations.

## Review Workload Forecast — per Work Unit

| WU | Scope | Primary files | LOC estimate | 400-line risk | Review effort |
|----|-------|---------------|--------------|---------------|---------------|
| WU1 | Q1 — PaymentDetail schema, admin CRUD, RBAC, filter mappings, bot read endpoint | `prisma/schema.prisma`, migration `add_payment_detail`, `src/admin/payment-details/**` (entity, repo port, prisma repo, service, controller, module, 3 DTOs), `src/admin/admin.module.ts`, `src/auth/authorization/domain/permission.ts`, `src/shared/domain/domain-error.ts`, `src/shared/filters/domain-exception.filter.ts`, `src/chatbot-api/presentation/chatbot-api.controller.ts`, `src/chatbot-api/application/chatbot-api.service.ts`, `src/chatbot-api/presentation/dto/payment-detail.response.ts`, 6 spec files | ~600 | High | Large — model + migration + full nested admin module + RBAC seeding + filter mappings + new bot route (single focused review) |
| WU2 | Q3 — atomic idempotency port + `registerBotSale` refactor + key validation | `src/sales/domain/sale.repository.ts`, `src/sales/infrastructure/prisma-sale.repository.ts`, `src/chatbot-api/application/chatbot-api.service.ts`, `src/chatbot-api/presentation/chatbot-api.controller.ts`, `src/chatbot-api/presentation/pipes/parse-idempotency-key.pipe.ts`, 3 spec files | ~400 | Medium | Medium — helper widening + branching refactor + pipe; replay semantics must stay green |
| WU3 | Q2 — engine re-evaluation + discountCents + expectedTotalCents + outbox + docs drift | `src/sales/sales.service.ts`, `src/chatbot-api/presentation/dto/bot-sale.response.ts`, `src/chatbot-api/presentation/dto/register-bot-sale.request.ts`, `src/chatbot-api/application/chatbot-api.service.ts`, `src/shared/filters/domain-exception.filter.ts`, `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md`, 3 spec files | ~700 | High | Large — engine-integration review (D4/D5 correctness, totals source-of-truth) + docs table reconciliation to 11 endpoints |
| **Whole change** | Q1 + Q2 + Q3 | ~25 files across `prisma/`, `src/admin/`, `src/sales/`, `src/chatbot-api/`, `src/shared/`, `src/auth/`, docs | ~1,700 (1,500–2,000) | High | Three independent review passes, one per commit; each WU revertible on its own |
