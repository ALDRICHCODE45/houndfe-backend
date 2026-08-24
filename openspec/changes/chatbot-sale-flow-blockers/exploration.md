# Exploration: Chatbot Sale Flow Blockers (Q1–Q3)

> Phase: `explore` — read-only. This document validates the prior audit and fills
> the design gaps the proposal phase needs. It does not implement anything.

## Scope

Three blockers block the WhatsApp bot's complete sale flow (source: `houndfe-chatbot/docs/backend-questions-sale-flow.md`, 2026-08-24):

- **Q1 (R11)** — No source of bank details for transfer payments exists in the backend (no table, no config, no endpoint). Owner requires a full CRUD with specific RBAC permissions (not seed-only).
- **Q2 (R13)** — `confirmBotSale` validates `unitPriceCents` against list price only and hardcodes `discountCents: 0`. There is no API path to register a promo-discounted bot sale. Decision: server-side re-evaluation with the real promotions engine, persisting `discountCents`.
- **Q3** — `registerBotSale` reserves the `SaleIdempotency` slot out-of-transaction, never rejects `IN_FLIGHT`, never compares `requestHash`, and its `update: {}` upsert silently absorbs the unique-constraint loss → duplicate sales on concurrent same-key requests. Fix: port the POS atomic idempotency pattern.

## Current State — Per Blocker (evidence)

### Q1 — Bank details for transfer payments

**Finding: no source exists.** Confirmed by targeted grep over `src/` for
`clabe|afirme|iban|accountNumber|bankName|beneficiary|cuenta|bank` (case-insensitive):
the only matches are test fixture strings (`reference: 'BANK-1'`) in
`src/sales/sales.service.spec.ts:477,490,511`. A parallel grep over `prisma/`
matches only the SAT catalog CSV (`prisma/data/sat-clave-prod-serv.csv`) — irrelevant
product/service reference data. `src/shared/config/env.validation.ts` contains **no**
bank/account/beneficiary variables.

The only payment-domain models are:

- `SalePayment` (`prisma/schema.prisma:846`) — `id, saleId, userId, method, amountCents, reference, metadataJson, tenantId, createdAt`. `reference` is a free-text string, not structured bank data.
- `SaleRefund` (`prisma/schema.prisma:869`) — `id, tenantId, saleId, salePaymentId, method, amountCents, reason, createdAt`. No bank fields.

Neither `SalePayment` nor `SaleRefund` carries `bankName`, `beneficiary`, `clabe`, or
`accountNumber`. The transfer flow relies on the human receiving the receipt image via
`ReceiptEvidence` and manually confirming it (`receipt-review` workflow) — there is no
place the bot or a human can read "pay into this account" from the backend.

**Implication:** Q1 is a greenfield bounded concept (new model + migration + admin CRUD +
new RBAC subject), not an extension of an existing table.

### Q2 — Promo price on bot sale

`SalesService.confirmBotSale` (`src/sales/sales.service.ts:2678-2793`):

1. Validates each item against `ProductsService.getApplicablePrices`
   (`src/products/products.service.ts:2361-2410`), which returns **all** price-list
   candidates `{priceListId, priceListName, priceCents}` for the product/variant/quantity
   (list price, tier-aware). It throws `PRICE_OUT_OF_DATE` unless `unitPriceCents` exactly
   equals one of those list prices (`sales.service.ts:2682-2694`). A promo-discounted
   price is therefore **always rejected**.
2. Builds the `Sale` aggregate via `Sale.create` → `assignCustomer(customerId, shippingAddressId?)`
   → `addItem(...)` with the bot-supplied `unitPriceCents`.
3. Persists the charge with `discountCents: 0` hardcoded (`sales.service.ts:2758`), then
   `totalCents = Σ(unitPriceCents·qty)`, `paymentStatus: 'CREDIT'`, `channel: 'ONLINE'`.

The bot request DTO `RegisterBotSaleRequestDto`
(`src/chatbot-api/presentation/dto/register-bot-sale.request.ts`) has **no** discount/promo
field — only `cashierUserId, customerId, shippingAddressId?, items[]` where each item is
`productId, variantId?, productName, variantName?, quantity, unitPriceCents`.

`ConfirmBotSaleResult` (`sales.service.ts:125-134`) and the wire DTO `BotSaleResponse`
(`src/chatbot-api/presentation/dto/bot-sale.response.ts`) do **not** expose `discountCents`.

**Key structural gap for Q2:** `confirmBotSale` does **not** bind a price list or run the
promotion engine. `Sale.assignCustomer` (`src/sales/domain/sale.entity.ts:652-661`) only sets
`customerId` + `shippingAddressId`; it does **not** auto-seed `globalPriceListId` (that
auto-seed lives in the POS `SalesService.assignCustomer` service method, not the entity
method the bot path calls). Items are added with a flat `unitPriceCents` and no
`appliedPriceListId`, and the sale has no `globalPriceListId`. So the full engine input
build (`recomputePricingAndPromotions` → `buildPosEvalInput`) would fall back to the default
PUBLICO list and has no per-item price-list binding — this reconciliation is the core Q2
design decision (see Open Questions).

### Q3 — Idempotency race in `registerBotSale`

`ChatbotApiService.registerBotSale` (`src/chatbot-api/application/chatbot-api.service.ts:248-318`):

1. `saleIdempotency.findUnique` → replay if `SUCCEEDED && responseJson`.
2. `saleIdempotency.upsert` with `create: { requestHash: input.idempotencyKey, status: 'IN_FLIGHT' }` and `update: {}` (lines 271-284).
3. `salesService.confirmBotSale(...)` — the actual sale creation.
4. `saleIdempotency.update` → `SUCCEEDED` + `responseJson` + `saleId`.

Problems: the reserve is not atomic-with-work, `requestHash` is the raw key and is never
compared, `update: {}` silently absorbs a concurrent unique-constraint loss (two requests
with the same key both proceed to `confirmBotSale` → duplicate sales), and there is no
`IN_FLIGHT` rejection.

**POS reference pattern (already proven in this codebase):**

- `SalesService.chargeDraft` (`sales.service.ts:2265-2360`) computes a SHA-256 `requestHash`
  over the canonical request payload, then calls `saleRepo.acquireChargeIdempotency`.
- `acquireChargeIdempotency` (`src/sales/infrastructure/prisma-sale.repository.ts:1647-1713`)
  does an **atomic `create`**; on `P2002` it re-reads and returns `replay` (SUCCEEDED +
  matching hash), `conflict` (hash mismatch), or `in_flight` (still running). Callers map
  `conflict`/`in_flight` to `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT`.
- The same private `acquireIdempotency` helper (`prisma-sale.repository.ts:1767-1832`) is
  reused by `acquirePaymentIdempotency` (`:1735-1749`) and
  `acquireCancellationIdempotency` (`:1751-1764`).

`SaleIdempotencyStatus` enum = `IN_FLIGHT | SUCCEEDED | FAILED`
(`prisma/schema.prisma:174-178`), but **`FAILED` is never written anywhere** — worth noting
for the proposal (whether to add failure marking or leave it as dead enum surface).

## Patterns Found (for the design)

### RBAC / permission registration

Permissions are CASL `action:Subject` tuples with a single source of truth:

- `src/auth/authorization/domain/permission.ts` defines:
  - `AppActions = 'create' | 'read' | 'update' | 'delete' | 'batch_delete' | 'manage'`
  - `AppSubjects` union (currently 21 subjects incl. `'Quotation'` and `'all'`)
  - `PERMISSION_REGISTRY: readonly PermissionDefinition[]` (the full list).
- `PermissionSeeder` (`src/auth/authorization/infrastructure/permission.seeder.ts`) runs on
  `OnApplicationBootstrap` and **upserts every registry entry** into `Permission`, creates
  the `Super Admin` role, and links `manage:all` to it. Idempotent, safe on restart.

**To add `PaymentDetail` permissions (the exact mechanism):**

1. Add `'PaymentDetail'` to the `AppSubjects` union in `permission.ts`.
2. Append four entries to `PERMISSION_REGISTRY`:
   `{ subject: 'PaymentDetail', action: 'read' }`, `'create'`, `'update'`, `'delete'`
   (optionally `'manage'` / `'batch_delete'` — mirror the `Quotation` shape which used only
   the four CRUD actions).
3. Nothing else — the seeder auto-upserts on next boot.

Guards: `@RequirePermissions(['read', 'PaymentDetail'])` (decorator in
`src/auth/authorization/decorators/require-permissions.decorator.ts`) + `PermissionsGuard`,
combined with `JwtAuthGuard` + `TenantContextGuard` on the controller. Roles are granted via
`PATCH /admin/roles/:id/permissions` (see below). `manage:all` = Super Admin (auto-seeded).

### Admin module structure (to mirror for Q1 CRUD)

`src/admin/` is a leaf module:

- `admin.module.ts` imports `AuthModule` (for repo tokens, guards, ability factory) and
  registers `AdminUserController/AdminRoleController/AdminPermissionController` + their
  services. No exports.
- Example controller `admin-role.controller.ts`:
  `@Controller('admin/roles')` + `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)`,
  each route decorated with `@RequirePermissions(['<action>', 'Role'])`. The permission
  assignment route is `@Patch(':id/permissions')` with `AssignPermissionsDto`.
- Example service `admin-role.service.ts` uses `IRoleRepository`/`IPermissionRepository`
  (symbol-injected) + `TenantPrismaService` + `ClsService<TenantClsStore>`; tenant scoping
  via `isSuperAdmin && tenantId === null ? {} : { tenantId }`.
- DTOs live in `src/admin/dto/` (e.g. `assign-permissions.dto.ts` = `{ permissionIds: string[] }`).

A `PaymentDetail` CRUD should mirror this: `AdminPaymentDetailController`
(`admin/payment-details`), `AdminPaymentDetailService`, DTOs, registered in `admin.module.ts`,
guarded with the new `PaymentDetail` permissions.

### Promotions engine entry points (for Q2)

- The POS charge path re-runs the **same** engine call every draft mutation uses, inside the
  charge transaction: `await this.recomputePricingAndPromotions(sale)` at
  `sales.service.ts:2364` (inside `chargeDraft`).
- `recomputePricingAndPromotions(sale)` (`sales.service.ts:477-634`) does:
  clear PROMO-sourced line discounts → `repriceNonStickyLines` (tier-aware batch reprice) →
  `evaluatePromotionsForSale` (builds `PosEvalInput` + calls `posEvaluatePromotions.evaluate`) →
  apply per-line + order results → prune orphaned MANUAL opt-ins.
- The engine is `PosEvaluatePromotionsUseCase`
  (`src/promotions/application/pos-evaluate-promotions.use-case.ts`), injected into
  `SalesService` via the `POS_EVALUATE_PROMOTIONS_USE_CASE` symbol. It handles
  PRODUCT_DISCOUNT (PRODUCTS/VARIANTS/CATEGORIES/BRANDS), ORDER_DISCOUNT, BUY_X_GET_Y,
  ADVANCED, manual opt-in/veto, date windows, daysOfWeek, customer scope, and price-list
  gating — the "real" engine.

### evaluate-cart vs POS engine (decides the Q2 approach)

- `EvaluateCartPromotionsUseCase`
  (`src/promotions/application/evaluate-cart-promotions.use-case.ts`) is a **separate,
  simplified** engine: only `PRODUCT_DISCOUNT` with `appliesTo='PRODUCTS'` + `AUTOMATIC`,
  no order discount, no tiers/categories/brands/BXGY/ADVANCED, no customer scope, no date
  window, no price-list gate. It returns `promotionEvaluationStatus:
  'fully_evaluated' | 'needs_human_review'`. Input is flat `CartItemForEvaluation`
  (`{productId, variantId, quantity, unitPriceCents}`).
- `PosEvaluatePromotionsUseCase` is the full engine (see above) with input `PosEvalInput`
  (lines carry `appliedGlobalPriceListId`, `categoryId`, `brandId`, `hasManualDiscount`,
  `optedInManualPromotionIds`, `vetoedPromotionIds`, `customerId`, `now`).

**Conclusion for Q2:** re-evaluate inside `confirmBotSale` using the **full POS engine**
(`recomputePricingAndPromotions`/`buildPosEvalInput`), **not** `evaluate-cart`. The proposal's
"server-side re-evaluation with the real promo engine" maps to the POS engine. The open
question is the exact input construction (see below).

### SaleIdempotency model (for Q3)

`prisma/schema.prisma:907-926`:

- Fields: `id` (uuid), `tenantId`, `operation` (string), `key` (string), `requestHash`
  (**String, required — yes, a requestHash column exists**), `status`
  (`SaleIdempotencyStatus`), `responseJson` (`Json?`), `saleId` (`String?`), timestamps.
- Unique constraint: `@@unique([tenantId, operation, key])` → Prisma compound key
  `tenantId_operation_key` (the name the bot service already uses).
- Relations: `tenant` (Cascade), `sale` (`SetNull` on delete).

The POS atomic pattern operates directly on this table; the Q3 fix reuses the exact same
shape for `operation = 'bot_sale_register'` but must add a real `requestHash` (SHA-256 over
the canonical sale payload, matching the POS approach) and return `conflict`/`in_flight`
instead of silently absorbing the unique loss.

## Constraints & Risks

- **Q1 is net-new surface.** New Prisma model + migration, new admin module, new RBAC subject
  + registry entries, and (if the bot must read it) a new `chatbot-api` endpoint + scope.
  RBAC requirement ("CRUD with specific permissions, not seed-only") is mandatory per owner.
- **Q2 engine input reconciliation is the hard part.** The bot quotes a flat
  `unitPriceCents`; `confirmBotSale` currently has no price-list binding and no engine call.
  Reusing `recomputePricingAndPromotions` may reprice non-sticky lines to a tier/default-list
  value that differs from what the bot quoted — risk of the server "correcting" the price the
  customer was shown, or of a promo applying to a different baseline than `evaluate-cart`
  previewed. Design must define: which list binds the bot sale, whether reprice runs or is
  skipped, and how promo `discountCents` is derived from the bot's `unitPriceCents` without
  breaking the existing `PRICE_OUT_OF_DATE` guard.
- **Q3 must preserve replay semantics.** Current tests assert same-key replay returns the
  cached response (`chatbot-api.service.spec.ts:799+`). The atomic fix must keep
  `SUCCEEDED` replay working while adding `conflict`/`in_flight`. `requestHash` must be
  deterministic (canonical ordering of items, e.g. the POS `sortPaymentsForHash` precedent).
- **Response contract ripple.** `BotSaleResponse` and `ConfirmBotSaleResult` do not carry
  `discountCents`; surfacing it changes the documented contract (and the bot client).
- **Docs drift.** `PROGRAM-CONTEXT.md` documents 9 endpoints; code has 10 (the cancel
  endpoint `POST /chatbot-api/sales/:saleId/cancel` is undocumented). Any new Q1 endpoint
  plus the Q2/Q3 behavior changes must update that doc and its idempotency section.
- **`FAILED` enum is dead.** `SaleIdempotencyStatus.FAILED` is never written; decide whether
  the Q3 fix introduces failure marking or leaves it unused.

## Open Questions (for the proposal phase)

1. **Q1 subject/model naming.** Use `PaymentDetail` (per the audit's RBAC target) vs
   `BankAccount`/`BankDetail`? Fields: `bankName`, `beneficiary`, `clabe`, `accountNumber`,
   plus `tenantId` + soft-delete? Is it per-tenant (branch) or global? Single record vs
   list (multiple banks/accounts)?
2. **Q1 chatbot exposure.** Does the bot need a new `chatbot-api` read endpoint (e.g.
   `GET /chatbot-api/payment-details`) with a new scope, or is the admin CRUD alone
   sufficient for this cycle (bot reads from its own config until then)?
3. **Q2 price-list binding.** How does `confirmBotSale` obtain the price list for the engine
   (customer's `globalPriceListId`, default PUBLICO, or per-item)? Does the server run the
   full `repriceNonStickyLines` (risk of re-quoting) or a promotion-only evaluation over the
   bot's `unitPriceCents` as baseline?
4. **Q2 discount source.** Should the bot send the promotion id / a desired discount, or
   should the server **compute** the best auto-promotion with zero bot input? How are MANUAL
   promos handled for bot sales (opt-in set is empty by construction)?
5. **Q2 response surface.** Add `discountCents` to `BotSaleResponse`? Backward-compatible?
6. **Q3 request hash payload.** Exact canonical fields to hash for `bot_sale_register`
   (items order-independent, shipping address, cashier/customer ids)? Should `FAILED` be
   written on engine failure to avoid leaving `IN_FLIGHT` rows permanently?
7. **Q3 idempotency key validation.** The controller passes `idempotencyKey ?? ''` — should
   an empty key be rejected at the DTO/guard layer before reaching the service?

## Ready for Proposal

**Yes.** All three blockers are precisely characterized against code, the reusable patterns
(POS idempotency, admin module shape, permission registration, POS promotions engine) are
identified, and the remaining decisions are scoped as open questions above. Proceed to
`sdd-propose` for `chatbot-sale-flow-blockers`.
