# Explore: POS sale "for delivery" at charge time (`pos-sale-delivery`)

Status: exploration complete. Store: `openspec` (Engram DOWN, no `mem_save` attempted).

## Fixed product decisions (do not re-open)
- Moment: at charge time (`chargeDraft` / POS charge endpoint). Cashier flags the sale for delivery during checkout.
- Delivery states: `PENDING → SHIPPED → DELIVERED` (same as ONLINE/bot flow).
- Shipping address REQUIRED to mark as delivery (`shippingAddressId` must be non-null).

---

## 1. POS charge HTTP surface

- Route: `POST /sales/drafts/:id/charge`
- Handler: `SalesController.chargeDraft` — `src/sales/sales.controller.ts:262-275` (the `@Post(':id/charge')` decorator; method spans ~262-275).
- HTTP method: `POST`, default 201 (no explicit `@HttpCode` on this route — differs from the other draft mutations which return 200/204).
- Guards: class-level `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` at `src/sales/sales.controller.ts:39`.
- Permission: `@RequirePermissions(['update', 'Sale'])` at `src/sales/sales.controller.ts:263`.
- Body DTO: `ChargeSaleDto` (`src/sales/dto/charge-sale.dto.ts`).
- Idempotency: `@Headers('idempotency-key')`; controller throws `BadRequestException('IDEMPOTENCY_KEY_REQUIRED')` when blank (`sales.controller.ts:268-270`), then calls `salesService.chargeDraft(id, user.userId, dto, idempotencyKey)`.

The separate `SalesPaymentsController` (`src/sales/sales-payments.controller.ts`) does NOT contain the charge endpoint — it only has `POST /sales/:id/payments` (addPayment) and `PATCH /sales/:saleId/payments/:paymentId/reference`. Both use `@RequirePermissions(['update', 'Sale'])` (`sales-payments.controller.ts:26, 45`). The delivery flag belongs on `ChargeSaleDto` consumed by `SalesController.chargeDraft`.

**Where to validate/authorize the delivery flag:**
- Validation (shape): `ChargeSaleDto` via class-validator (optional boolean; see §2).
- Authorization: reuse the existing `update:Sale` permission already on the route. Flagging delivery is part of the same charge mutation — **no new CASL permission required** (see §4).
- Business rule (shipping address required): service layer inside `chargeDraft`, after `findByIdForUpdate` and before `persistChargeConfirmation`, because it needs the loaded `sale.shippingAddressId`. Best placed alongside the other `chargeValidationError(...)` guards around `sales.service.ts:2540-2560`.

---

## 2. `ChargeSaleDto` current shape + how to extend

File: `src/sales/dto/charge-sale.dto.ts`.

Current fields (`ChargeSaleDto`):
- `method?` — `@IsOptional() @IsIn(['cash','card_credit','card_debit','transfer','credit'])` (`charge-sale.dto.ts:34-36`)
- `amountCents?` — `@IsOptional() @IsInt() @Min(0)` (`:38-41`)
- `paymentMethodId?` — `@IsOptional() @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })` (`:44-46`)
- `payments?` — `@IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({each:true}) @Type(() => ChargePaymentEntryDto)` (`:48-52`)
- `dueDate?` — `@IsOptional() @IsISO8601()` (`:54-56`)

`ChargePaymentEntryDto` (nested): `method`, `amountCents`, `reference?`, `paymentMethodId?` (`charge-sale.dto.ts:16-31`).

**Recommended addition (naming convention follows existing camelCase optional fields):**

```ts
@IsOptional()
@IsBoolean()
delivery?: boolean;
```

- Rationale: the product decision is a binary "flag for delivery at charge", so a boolean is the smallest clean shape (vs. a `deliveryMode: 'delivery' | 'pickup'` union). `IsBoolean` already used elsewhere in the codebase (e.g. `list-sales-query.dto.ts` `@IsBoolean()` with `@Transform`), but here the body is JSON so `@IsBoolean()` alone suffices.
- Add `IsBoolean` to the existing `class-validator` import (`charge-sale.dto.ts:1-12` currently imports `ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Min, ValidateNested`).

---

## 3. `persistChargeConfirmation` — how channel/deliveryStatus are written

Interface: `ISaleRepository.persistChargeConfirmation` — `src/sales/domain/sale.repository.ts:200-237`.
Implementation: `PrismaSaleRepository.persistChargeConfirmation` — `src/sales/infrastructure/prisma-sale.repository.ts:884-1010` (method signature starts ~884; the `channel`/`register`/`deliveryStatus` params at `:895-897`).

Current behavior:
- Optional params: `channel?: 'POS' | 'ONLINE'`, `register?: string`, `deliveryStatus?` (see union note below) at `prisma-sale.repository.ts:895-897`.
- **Defaults when omitted:** the update payload is built conditionally — `if (input.channel !== undefined) data.channel = input.channel;`, `if (input.register !== undefined) data.register = input.register;`, `if (input.deliveryStatus !== undefined) data.deliveryStatus = input.deliveryStatus;` (`prisma-sale.repository.ts:946-947`). So omitted fields are **NOT written** — the confirmed row keeps whatever the DRAFT row already had. The comment at `:920-933` documents this "only write explicitly-provided fields" rule.
- Therefore today `chargeDraft` calls `persistChargeConfirmation` WITHOUT `channel`/`deliveryStatus` (`sales.service.ts:2605-2636`) and the confirmed sale keeps the draft's `deliveryStatus: 'DELIVERED'` (which `Sale.create` seeded and `save` wrote at draft time).

**Important union discrepancy (cite before sdd-apply):**
- Interface allows `deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED'` (`sale.repository.ts:215`).
- Implementation inline type is narrower: `deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE'` (`prisma-sale.repository.ts:896`) — **`SHIPPED` is missing in the impl type**. For this feature we only need `PENDING`, so no widening is strictly required, but the mismatch should be reconciled (or at least not relied upon for a `SHIPPED` write).

`chargeDraft` today passes `customerId`, `sellerUserId`, `dueDate`, `confirmedAt`, `folio`, `items`, `appliedOrderPromotion` (`sales.service.ts:2605-2636`), but **not** `channel` or `deliveryStatus`. `confirmBotSale` explicitly passes `channel: 'ONLINE'` + `deliveryStatus: 'PENDING'` (`sales.service.ts:2976-2978`).

---

## 4. CASL ability / permission factory

- Registry: `src/auth/authorization/domain/permission.ts`. `AppActions` = `create|read|update|delete|batch_delete|manage`; `AppSubjects` includes `'Sale'` and `'DeliveryRoute'` (`permission.ts:22-59`).
- Sale permissions seeded: `create`, `read`, `update`, `delete`, `manage` (`permission.ts:207-211`). There is **no** `charge:Sale` or `deliver:Sale` action.
- The charge route uses `update:Sale` (`sales.controller.ts:263`). Factory `CaslAbilityFactory.createForUser` emits `can(permission.action, permission.subject)` for each granted permission (`casl-ability.factory.ts:88-98`); `manage:Sale` is covered by `manage` action in `AppActions`.
- **Conclusion:** flagging delivery at charge reuses `update:Sale`. **No new permission** and no registry change needed. A new action would require `AppActions` union change, registry entry, seeding, and CASL wiring — unnecessary for this change.

---

## 5. DeliveryRoute create/eligibility path

- Domain guard: `DeliveryRoute.create` iterates `saleIds`, calls `checkSaleEligibility(saleId)` and rejects when:
  `!eligibility || (deliveryStatus !== 'PENDING' && deliveryStatus !== 'SHIPPED') || !shippingAddressId`
  → throws `DeliveryRouteSaleNotEligibleError` with `reason: 'INELIGIBLE_SALE'` (`delivery-route.entity.ts:209-227`).
- Same guard re-checked in `addStop` (`delivery-route.entity.ts:329-346`).
- `SaleEligibilitySnapshot` type: `deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED'` + `shippingAddressId: string | null` (`delivery-route.entity.ts:46-49`).
- Error code: `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` → HTTP 422 (`delivery-route.errors.ts:52-61`).
- Service probe `DeliveryRoutesService.checkSaleEligibility` reads the sale row directly:
  `prisma.sale.findFirst({ where: { id, tenantId }, select: { deliveryStatus: true, shippingAddressId: true } })` (`delivery-routes.service.ts:390-406`).
- **Eligibility consequence:** changing a POS sale from `DELIVERED` to `PENDING` (with a non-null `shippingAddressId`) makes it pass. No delivery-routes code change is required for eligibility itself; the change is entirely in the sale charge path + the persisted sale row.

---

## 6. Every other writer of `deliveryStatus` (regression surface)

1. **`Sale.create`** seeds `channel: 'POS'`, `deliveryStatus: 'DELIVERED'` (`sale.entity.ts:210-227`, esp. `:224`).
2. **`Sale.fromPersistence`** defaults `channel ?? 'POS'`, `deliveryStatus ?? 'DELIVERED'` (`sale.entity.ts:241-243`).
3. **`Sale.confirm`** carries the current `deliveryStatus` forward unchanged (`sale.entity.ts:297`).
4. **`Sale.cancel`** blocks cancelling when `deliveryStatus ∈ {SHIPPED, DELIVERED}` (`sale.entity.ts:336-337`); PENDING cancels are allowed.
5. **`Sale.markDelivered`** — `CONFIRMED`-only, idempotent, flips to `DELIVERED`; throws `SaleNotDeliverableError` (422) otherwise (`sale.entity.ts:676-689`). Used by route check-in via `markSaleDelivered` repo method.
6. **`PrismaSaleRepository.save`** writes `deliveryStatus: sale.deliveryStatus` on every save (`prisma-sale.repository.ts:108`) — this is why the DRAFT row already persists `DELIVERED`.
7. **`PrismaSaleRepository.markSaleDelivered`** — narrow `DELIVERED` mirror write in tx (`prisma-sale.repository.ts:857-866`).
8. **`persistChargeConfirmation`** — conditional `deliveryStatus` write (see §3).
9. **`confirmBotSale`** — passes `channel: 'ONLINE'` + `deliveryStatus: 'PENDING'` (`sales.service.ts:2976-2978`).
10. **Chatbot `setDeliveryMetadata`** — `src/chatbot-api/application/chatbot-api.service.ts:399-432`. Guard: sale must be `CONFIRMED` + `PAID` + `channel === 'ONLINE'` + `deliveryStatus !== 'DELIVERED'`, otherwise throws `SALE_DELIVERY_NOT_READY` (`chatbot-api.service.ts:412-425`); then updates `deliveryStatus: 'SHIPPED'` + carrier metadata (`:427-433`). Controller `PATCH /chatbot-api/sales/:saleId/delivery` with `@RequiredScopes('sales:write')` (`chatbot-api.controller.ts:133-148`).
11. **Listing filter** `ListSalesDeliveryStatus` = `PENDING | DELIVERED | NOT_APPLICABLE` (no `SHIPPED`) — `src/sales/dto/list-sales-query.dto.ts:34-38`. Repository applies `deliveryStatus: { in: input.deliveryStatus }` (`prisma-sale.repository.ts:1387-1388`). POS sales flagged for delivery will be filterable via `PENDING` today, but `SHIPPED` is not a filter value (pre-existing gap, not in scope unless we choose to widen).
12. **`countNotDeliveredConfirmed`** counts `NOT: { deliveryStatus: 'DELIVERED' }` (`prisma-sale.repository.ts:1522`), so PENDING/SHIPPED/NOT_APPLICABLE all count as "not delivered".

**Regression risk:** the chatbot `setDeliveryMetadata` guard requires `channel === 'ONLINE'`. A POS sale flagged for delivery stays `channel: 'POS'` (only its `deliveryStatus` becomes `PENDING`), so the chatbot SHIPPED path will reject it (`SALE_DELIVERY_NOT_READY`). This matches the product decision "consistent with the bot's ONLINE flow" only for the state names — if POS delivery sales must also transition `PENDING → SHIPPED` via some POS/route mechanism later, that's a separate change. Flag this explicitly in the proposal.

---

## 7. Existing tests to extend (RED/GREEN targets)

- **`chargeDraft`**: `src/sales/sales.service.spec.ts` `describe('chargeDraft', ...)` starts at `:1693`. Key assertions on the `persistChargeConfirmation` call shape already exist (e.g. `expect(saleRepo.persistChargeConfirmation).toHaveBeenCalledWith(...)` at `:2308`, `:2606`, `:2661`, `:2742`, `:2896`). Add:
  - delivery flag `true` + `shippingAddressId` present → `persistChargeConfirmation` called with `deliveryStatus: 'PENDING'`.
  - delivery flag `true` + `shippingAddressId` null → throws (new error code) and `persistChargeConfirmation` NOT called.
  - delivery flag omitted/false → current behavior preserved (no `deliveryStatus` arg, or explicit `DELIVERED` depending on chosen impl).
  - idempotency hash must now include the delivery flag (see §8).
- **`confirmBotSale`**: `src/sales/sales.service.spec.ts` `describe('confirmBotSale', ...)` at `:3984`; the existing test asserts `channel: 'ONLINE'` + `deliveryStatus: 'PENDING'` (`:4047-4053`). This is the reference pattern; no change expected unless the shared helper is touched.
- **`persistChargeConfirmation`**: `src/sales/infrastructure/prisma-sale.repository.spec.ts`
  - `describe('charge tenant hardening and idempotency', ...)` at `:2578` (existing `deliveryStatus: 'PENDING'` fixtures around `:2586, :2622, :2694`).
  - `describe('persistChargeConfirmation — Work Unit 5 (W1 + C2 + items param)', ...)` at `:4205` (first test at `:4206`).
- **`Sale` delivery domain behavior**:
  - `src/sales/domain/sale.entity.spec.ts` `describe('setShippingAddress', ...)` at `:645` (guard: shipping address requires customer, draft-only).
  - `describe('cancel - delivery guard', ...)` at `:294` (SHIPPED/DELIVERED cannot cancel).
  - `markDelivered` has **no direct unit test** in `sale.entity.spec.ts`; it is exercised indirectly via repo integration `src/sales/infrastructure/prisma-sale.repository.markSaleDelivered.integration.spec.ts` and service `src/delivery-routes/application/delivery-routes.service.spec.ts` (`markSaleDelivered` mock assertions at `:212, :267, :312, :326`). If we add a new `Sale` domain method (e.g. `markForDelivery`), its unit tests should go in `sale.entity.spec.ts` near `setShippingAddress`/`markDelivered`.

---

## 8. Recommended implementation shape (for sdd-apply; not implemented here)

1. **DTO** — add `@IsOptional() @IsBoolean() delivery?: boolean` to `ChargeSaleDto` (`charge-sale.dto.ts`).
2. **Domain (recommended, mirrors `setShippingAddress`/`markDelivered`)** — add a small draft-only `Sale` mutation, e.g. `markForDelivery()`: `ensureDraft()` then `if (this._shippingAddressId === null) throw BusinessRuleViolationError('SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY', ...)`, then `this._deliveryStatus = 'PENDING'`. This centralizes the guard and keeps persistence (`save`) writing `PENDING`. Alternative (minimal): skip the domain method and pass `deliveryStatus: 'PENDING'` straight to `persistChargeConfirmation` from `chargeDraft` after an inline shipping-address check.
3. **Service `chargeDraft`** (`sales.service.ts:2407+`):
   - Include `delivery` in the idempotency `requestHash` (`sales.service.ts:2416-2424` currently hashes `saleId, actorId, payments, dueDate`). **Without this**, a retry with the same idempotency key but a changed delivery flag would replay the stale non-delivery payload.
   - After loading the sale and confirming DRAFT/ownership, apply the delivery flag: if `dto.delivery === true`, call `sale.markForDelivery()` (or inline guard + set), else leave `DELIVERED`.
   - Pass `deliveryStatus` to `persistChargeConfirmation`: `deliveryStatus: dto.delivery ? 'PENDING' : 'DELIVERED'` (explicit is safer than omitting, and matches how `confirmBotSale` passes `'PENDING'` explicitly).
4. **Repository** — no signature change needed for `PENDING` (already in both union types). Optionally reconcile the impl union at `prisma-sale.repository.ts:896` with the interface union (`sale.repository.ts:215`) to include `'SHIPPED'`.
5. **CASL** — no change.

---

## 9. Risks

1. **Idempotency hash drift** — forgetting to add the delivery flag to `requestHash` (`sales.service.ts:2416-2424`) would silently return a non-delivery result on a replayed key. High impact.
2. **POS-vs-ONLINE SHIPPED gap** — `chatbot-api.service.ts:412-425` requires `channel === 'ONLINE'` to move `PENDING → SHIPPED`. POS delivery sales (still `channel: 'POS'`) have no existing `SHIPPED` writer. Eligibility for routes still works for `PENDING`, but the `PENDING → SHIPPED` leg is currently ONLINE-only. Scope this explicitly.
3. **Repo union mismatch** — impl type lacks `'SHIPPED'` (`prisma-sale.repository.ts:896`). Not blocking for `PENDING`, but a latent trap.
4. **List filter enum** — `ListSalesDeliveryStatus` lacks `SHIPPED` (`list-sales-query.dto.ts:34-38`); POS delivery sales in `SHIPPED` (if/when that leg exists) cannot be filtered. Pre-existing, out of scope.
5. **Cancel semantics** — `Sale.cancel` allows cancelling `PENDING` sales (`sale.entity.ts:336-337` only blocks SHIPPED/DELIVERED). A POS sale flagged for delivery (PENDING) can still be cancelled before a route check-in flips it to DELIVERED — acceptable but worth stating.
